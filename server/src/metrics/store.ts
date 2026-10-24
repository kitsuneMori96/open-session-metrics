import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { DATA_DIR, SOURCE_KIND, metricsDbPath, type SourceKind } from "../config";
import { build, type BuildReport } from "./build";
import { openMetrics, getMeta, getMetaNumber, setMeta, SCHEMA_SIG } from "./schema";
import { openSource } from "../source-select";

/**
 * One reader per source.
 *
 * Two stores coexist — `metrics.db` for OpenCode, `metrics-qoder.db` for Qoder —
 * and each keeps its own handle, watermark and build lock. A handle is keyed by
 * source rather than by path so a rebuild in another process (`pnpm materialize`)
 * closes exactly the reader that went stale.
 */
interface Slot {
  handle: DatabaseSync | null;
  stat: string | null;
}

const slots = new Map<SourceKind, Slot>();

function slotOf(kind: SourceKind): Slot {
  let slot = slots.get(kind);
  if (!slot) {
    slot = { handle: null, stat: null };
    slots.set(kind, slot);
  }
  return slot;
}

function fileIdentity(kind: SourceKind): string {
  try {
    const st = statSync(metricsDbPath(kind));
    return `${st.dev}:${st.ino}`;
  } catch {
    return "missing";
  }
}

/** True once a source has been materialized at least once. */
export const hasStore = (kind: SourceKind = SOURCE_KIND): boolean => existsSync(metricsDbPath(kind));

/**
 * The metrics db is opened lazily and *re-validated* on every access: a
 * `pnpm materialize` in another process swaps the file underneath us, and a
 * stale handle would silently serve the previous snapshot (or crash on a new
 * column). If the inode changed, we reopen.
 */
export function current(kind: SourceKind = SOURCE_KIND): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  const slot = slotOf(kind);
  const id = fileIdentity(kind);
  if (slot.handle && slot.stat !== id) {
    closeReader(kind);
  }
  if (!slot.handle) {
    slot.handle = openMetrics(metricsDbPath(kind));
    slot.stat = id;
  }
  return slot.handle;
}

export function closeReader(kind?: SourceKind) {
  const kinds = kind ? [kind] : [...slots.keys()];
  for (const k of kinds) {
    const slot = slotOf(k);
    try {
      slot.handle?.close();
    } catch {
      /* already closed */
    }
    slot.handle = null;
    slot.stat = null;
  }
}

/** True when the source has data we have not materialized yet. */
export function sourceChanged(kind: SourceKind = SOURCE_KIND): boolean {
  if (!hasStore(kind)) return true;
  const prev = getMetaNumber(current(kind), "sourceMaxTime");
  if (prev <= 0) return true;
  const src = openSource(kind);
  try {
    return src.maxMessageTime() > prev;
  } catch {
    return false;
  } finally {
    src.close();
  }
}

/**
 * Rebuild one source's metrics database.
 * - `full`: parse everything into a side file and swap it in atomically, so
 *   readers never see a half-dropped schema.
 * - `incremental` (default when a store already exists): re-materialize only
 *   the sessions touched since the stored watermark, in place (WAL keeps readers
 *   live). A handful of milliseconds instead of a multi-second full parse.
 */
export async function rebuild(
  kind: SourceKind = SOURCE_KIND,
  opts: { full?: boolean } = {}
): Promise<BuildReport> {
  mkdirSync(DATA_DIR, { recursive: true });
  // `full: false` is an explicit request for the incremental path, so the schema check
  // cannot be expressed as a `??` default — a layout change always wins.
  if (opts.full === true || !hasStore(kind) || schemaStale(kind)) return fullRebuild(kind);
  return incrementalRebuild(kind);
}

/** True when the store was written by a build with a different table layout. */
function schemaStale(kind: SourceKind): boolean {
  try {
    return getMeta(current(kind), "schemaSig") !== SCHEMA_SIG;
  } catch {
    return true;
  }
}

/** The side file a full rebuild writes into before it is swapped in. */
const nextFile = (kind: SourceKind) => `${metricsDbPath(kind)}.next`;

async function fullRebuild(kind: SourceKind): Promise<BuildReport> {
  const next = nextFile(kind);
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(next + suffix)) rmSync(next + suffix, { force: true });

  const writer = new DatabaseSync(next);
  writer.exec("PRAGMA journal_mode = WAL");
  let report: BuildReport;
  try {
    report = await build(writer, { mode: "full", kind });
  } finally {
    writer.close();
  }

  closeReader(kind);
  const target = metricsDbPath(kind);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(target + suffix, { force: true });
  renameSync(next, target);
  return report;
}

async function incrementalRebuild(kind: SourceKind): Promise<BuildReport> {
  const db = current(kind);
  const prevWatermark = getMetaNumber(db, "sourceMaxTime");
  const src = openSource(kind);
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
  return build(db, { mode: "incremental", sessionIds: changed, kind });
}
