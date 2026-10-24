import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { HOST, PORT, ROOT, SOURCE_KIND, SOURCE_KINDS, type SourceKind } from "./config";
import { createApp } from "./api";
import { current, hasStore, rebuild, sourceChanged } from "./metrics/store";

const REFRESH_MS = 120000;
/**
 * Builds are serialized: a full rebuild swaps a store by renaming a side file over
 * it, so two overlapping builds would clobber each other's snapshot. One queue for
 * both sources is the simplest correct answer — a build takes seconds, and a
 * user-visible switch never waits on a *different* store than the one it asked for.
 */
let queue: Promise<unknown> = Promise.resolve();

function materialize(kind: SourceKind, opts: { force?: boolean; full?: boolean } = {}) {
  const run = queue.then(() => doMaterialize(kind, opts), () => doMaterialize(kind, opts));
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Refresh is driven by the *source watermark*, not the wall clock: we only
 * re-materialize when the tool that owns it actually has newer rows than we
 * stored. The incremental path re-parses just the changed sessions (milliseconds).
 */
async function doMaterialize(kind: SourceKind, { force = false, full = false }: { force?: boolean; full?: boolean }) {
  if (!hasStore(kind) || full) {
    console.log(`[osm] ${kind}: ${full ? "full rebuild requested" : "no store yet"} — materializing…`);
    const r = await rebuild(kind, { full: true });
    console.log(
      `[osm] ${kind}: built ${r.sessions} sessions / ${r.turns} turns / ${r.tools} tools / ${r.parts} parts in ${r.ms}ms`
    );
    return r;
  }
  if (!force && !sourceChanged(kind)) return undefined;
  const r = await rebuild(kind);
  console.log(
    `[osm] ${kind}: ${r.mode} sync ${r.sessions} sessions / ${r.turns} turns / ${r.parts} parts / ${r.events} events in ${r.ms}ms`
  );
  return r;
}

const app = createApp({
  db: (kind) => current(kind),
  hasStore: (kind) => hasStore(kind),
  refresh: (kind, full) => materialize(kind, { force: true, full }),
});

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
  console.log(`[osm] api on http://${HOST}:${PORT} (default source: ${SOURCE_KIND})`);
  // Only the default source is built at boot: a user who never opens the other
  // store should not pay seconds of parsing for it on every start.
  await materialize(SOURCE_KIND);
  setInterval(() => {
    // ...and the timer only keeps *existing* stores fresh, so "never built" stays
    // a deliberate act (the browser asks for it when you switch to it).
    for (const kind of SOURCE_KINDS) {
      if (!hasStore(kind)) continue;
      void materialize(kind).catch((e) => console.error(`[osm] ${kind} refresh failed:`, (e as Error).message));
    }
  }, REFRESH_MS);
});
