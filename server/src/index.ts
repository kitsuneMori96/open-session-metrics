import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { METRICS_DB, PORT, ROOT, HOST } from "./config";
import { createApp } from "./api";
import { current, rebuild, sourceChanged } from "./metrics/store";
import type { BuildReport } from "./metrics/build";

const REFRESH_MS = 120000;
let busy: Promise<BuildReport | undefined> | null = null;

/**
 * Refresh is driven by the *source watermark*, not the wall clock: we only
 * re-materialize when opencode.db actually has newer rows than we stored. The
 * incremental path re-parses just the changed sessions (milliseconds).
 */
async function materializeIfNeeded(force: boolean): Promise<BuildReport | undefined> {
  if (busy) return busy;
  const task = (async () => {
    if (!existsSync(METRICS_DB)) {
      console.log("[holo] no metrics.db yet — materializing…");
      const r = await rebuild({ full: true });
      console.log(`[holo] built: ${r.sessions} sessions / ${r.turns} turns / ${r.tools} tools in ${r.ms}ms`);
      return r;
    }
    if (!force && !sourceChanged()) return undefined;
    const r = await rebuild();
    console.log(
      `[holo] ${r.mode} sync: ${r.sessions} sessions / ${r.turns} turns / ${r.events} events / ${r.flow} flow cells in ${r.ms}ms`
    );
    return r;
  })();
  busy = task;
  try {
    return await task;
  } catch (e) {
    console.error("[holo] refresh failed:", (e as Error).message);
    return undefined;
  } finally {
    busy = null;
  }
}

const app = createApp({ db: current, refresh: () => materializeIfNeeded(true) });

const webDist = path.join(ROOT, "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*splat", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  console.log(`[holo] serving built web from ${webDist}`);
}

app.listen(PORT, HOST, async () => {
  console.log(`[holo] cockpit API on http://${HOST}:${PORT}`);
  await materializeIfNeeded(false);
  setInterval(() => void materializeIfNeeded(false), REFRESH_MS);
});
