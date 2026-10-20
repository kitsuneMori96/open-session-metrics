import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { METRICS_DB, PORT, ROOT, HOST } from "./config";
import { createApp } from "./api";
import { current, rebuild, sourceChanged } from "./metrics/store";

const REFRESH_MS = 120000;
/**
 * Builds are serialized: a full rebuild swaps `metrics.db` by renaming a side
 * file over it, so two overlapping builds would clobber each other's snapshot.
 */
let queue: Promise<unknown> = Promise.resolve();

function materialize(opts: { force?: boolean; full?: boolean } = {}) {
  const run = queue.then(() => doMaterialize(opts), () => doMaterialize(opts));
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Refresh is driven by the *source watermark*, not the wall clock: we only
 * re-materialize when opencode.db actually has newer rows than we stored. The
 * incremental path re-parses just the changed sessions (milliseconds).
 */
async function doMaterialize({ force = false, full = false }: { force?: boolean; full?: boolean }) {
  if (!existsSync(METRICS_DB) || full) {
    console.log(`[osm] ${full ? "full rebuild requested" : "no metrics.db yet"} — materializing…`);
    const r = await rebuild({ full: true });
    console.log(`[osm] built: ${r.sessions} sessions / ${r.turns} turns / ${r.tools} tools / ${r.parts} parts in ${r.ms}ms`);
    return r;
  }
  if (!force && !sourceChanged()) return undefined;
  const r = await rebuild();
  console.log(
    `[osm] ${r.mode} sync: ${r.sessions} sessions / ${r.turns} turns / ${r.parts} parts / ${r.events} events in ${r.ms}ms`
  );
  return r;
}

const app = createApp({ db: current, refresh: (full) => materialize({ force: true, full }) });

const webDist = path.join(ROOT, "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // A missing file is a 404, never the app shell. Answering HTML to a <script> request
  // turns a stale bundle into a blank page: the browser reports a MIME error and no
  // component ever mounts, so there is nothing on screen to explain what happened.
  app.get("*splat", (req, res) => {
    if (path.extname(req.path)) return res.status(404).type("text/plain").send("not found");
    res.sendFile(path.join(webDist, "index.html"));
  });
  console.log(`[osm] serving built web from ${webDist}`);
}

app.listen(PORT, HOST, async () => {
  console.log(`[osm] api on http://${HOST}:${PORT}`);
  await materialize();
  setInterval(() => void materialize().catch((e) => console.error("[osm] refresh failed:", (e as Error).message)), REFRESH_MS);
});
