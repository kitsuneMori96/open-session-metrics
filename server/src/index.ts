import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { METRICS_DB, PORT, ROOT } from "./config";
import { createApp } from "./api";
import { current, rebuild } from "./metrics/store";
import type { BuildReport } from "./metrics/build";

const REFRESH_MS = 120000;
let busy: Promise<BuildReport | undefined> | null = null;

async function materializeIfNeeded(force: boolean): Promise<BuildReport | undefined> {
  if (busy) return busy;
  const task = (async () => {
    if (!existsSync(METRICS_DB)) {
      console.log("[holo] no metrics.db yet — materializing…");
      const r = await rebuild();
      console.log(`[holo] built: ${r.turns} turns / ${r.sessions} sessions / ${r.tools} tools in ${r.ms}ms`);
      return r;
    }
    const rows = current().prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    const meta = Object.fromEntries(rows.map((m) => [m.key, m.value]));
    const srcMax = Number(meta.sourceMaxTime ?? 0);
    if (!force && Date.now() - srcMax < 60000) return undefined; // no recent OpenCode activity
    const r = await rebuild();
    console.log(`[holo] re-materialized: ${r.turns} turns / ${r.sessions} sessions in ${r.ms}ms`);
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

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[holo] cockpit API on http://0.0.0.0:${PORT}`);
  await materializeIfNeeded(false);
  setInterval(() => void materializeIfNeeded(false), REFRESH_MS);
});
