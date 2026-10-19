import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { DATA_DIR, METRICS_DB, SOURCE_DB } from "../config";
import { build, type BuildReport } from "./build";
import { openMetrics, getMeta, getMetaNumber, setMeta, SCHEMA_SIG } from "./schema";
import { SourceReader } from "../source";

const NEXT = METRICS_DB + ".next";
let handle: DatabaseSync | null = null;
let handleStat: string | null = null;

function fileIdentity(): string {
  try {
    const st = statSync(METRICS_DB);
    return `${st.dev}:${st.ino}`;
  } catch {
    return "missing";
  }
}

/**
 * The metrics db is opened lazily and *re-validated* on every access: a
 * `pnpm materialize` in another process swaps the file underneath us, and a
 * stale handle would silently serve the previous snapshot (or crash on a new
 * column). If the inode changed, we reopen.
 */
export function current(): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  const id = fileIdentity();
  if (handle && handleStat !== id) {
    closeReader();
  }
  if (!handle) {
    handle = openMetrics();
    handleStat = id;
  }
  return handle;
}

export function closeReader() {
  try {
    handle?.close();
  } catch {
    /* already closed */
  }
  handle = null;
  handleStat = null;
}

/** True when the source database has data we have not materialized yet. */
export function sourceChanged(): boolean {
  if (!existsSync(METRICS_DB) || !existsSync(SOURCE_DB)) return true;
  const prev = getMetaNumber(current(), "sourceMaxTime");
  if (prev <= 0) return true;
  const src = new SourceReader(SOURCE_DB);
  try {
    return src.maxMessageTime() > prev;
  } catch {
    return false;
  } finally {
    src.close();
  }
}

/**
 * Rebuild the metrics database.
 * - `full`: parse everything into a side file and swap it in atomically, so
 *   readers never see a half-dropped schema.
 * - `incremental` (default when a metrics db already exists): re-materialize only
 *   the sessions touched since the stored watermark, in place (WAL keeps readers
 *   live). A handful of milliseconds instead of a multi-second full parse.
 */
export async function rebuild(opts: { full?: boolean } = {}): Promise<BuildReport> {
  mkdirSync(DATA_DIR, { recursive: true });
  // `full: false` is an explicit request for the incremental path, so the schema check
  // cannot be expressed as a `??` default — a layout change always wins.
  if (opts.full === true || !existsSync(METRICS_DB) || schemaStale()) return fullRebuild();
  return incrementalRebuild();
}

/** True when the metrics db was written by a build with a different table layout. */
function schemaStale(): boolean {
  try {
    return getMeta(current(), "schemaSig") !== SCHEMA_SIG;
  } catch {
    return true;
  }
}

async function fullRebuild(): Promise<BuildReport> {
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(NEXT + suffix)) rmSync(NEXT + suffix, { force: true });

  const writer = new DatabaseSync(NEXT);
  writer.exec("PRAGMA journal_mode = WAL");
  let report: BuildReport;
  try {
    report = await build(writer, { mode: "full" });
  } finally {
    writer.close();
  }

  closeReader();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(METRICS_DB + suffix, { force: true });
  renameSync(NEXT, METRICS_DB);
  return report;
}

async function incrementalRebuild(): Promise<BuildReport> {
  const db = current();
  const prevWatermark = getMetaNumber(db, "sourceMaxTime");
  const src = new SourceReader(SOURCE_DB);
  let changed: Set<string>;
  try {
    changed = prevWatermark > 0 ? src.changedSessions(prevWatermark) : new Set<string>();
  } finally {
    src.close();
  }

  if (changed.size === 0) {
    setMeta(db, "materializedAt", String(Date.now()));
    return {
      mode: "incremental",
      schema: getMeta(db, "sourceSchema") ?? "v2",
      sessions: 0, turns: 0, tools: 0, parts: 0, events: 0, flow: 0, heat: 0,
      models: 0, ms: 0,
    };
  }
  return build(db, { mode: "incremental", sessionIds: changed });
}
