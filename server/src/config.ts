import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A global install lives under `node_modules/`, where writing state is wrong:
 * the next `npm i -g` would delete it, and the directory is not the user's.
 * Keep dev checkouts on `<repo>/.data`, put packaged installs on the XDG data
 * dir. `OSM_DATA_DIR` (and `osm --data`) always wins.
 *
 * The package was renamed from `opencode-session-metrics` in 0.3.0. A fresh
 * install lands on the new name; an existing one keeps reading the old
 * directory, so an upgrade does not look like a wiped history.
 */
const INSTALLED = `${path.sep}node_modules${path.sep}`;
const XDG_DATA_ROOT = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const USER_DATA_DIR = (() => {
  const current = path.join(XDG_DATA_ROOT, "open-session-metrics");
  const legacy = path.join(XDG_DATA_ROOT, "opencode-session-metrics");
  return existsSync(legacy) && !existsSync(current) ? legacy : current;
})();
export const DATA_DIR =
  process.env.OSM_DATA_DIR ??
  (ROOT.includes(INSTALLED) ? USER_DATA_DIR : path.join(ROOT, ".data"));
export const SOURCE_DB =
  process.env.OSM_SOURCE_DB ?? path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

/* ------------------------------------------------------------------ *
 * Qoder CLI
 *
 * Qoder has no session database: transcripts are JSONL under
 * `<home>/projects/<encoded-cwd>/<sessionId>.jsonl`, and the SQLite files
 * beside them are IDE caches. `QODER_PROJECTS` is therefore a directory,
 * not a database path.
 * ------------------------------------------------------------------ */
export const QODER_HOME = process.env.OSM_QODER_HOME ?? path.join(os.homedir(), ".qoder");
export const QODER_PROJECTS = path.join(QODER_HOME, "projects");
export const QODER_LOGS = path.join(QODER_HOME, "logs", "sessions");

export type SourceKind = "opencode" | "qoder";

export const SOURCE_KINDS: readonly SourceKind[] = ["opencode", "qoder"];

/**
 * Which reader to bind. Precedence:
 *   1. `OSM_SOURCE` (explicit, also what tests use)
 *   2. `OSM_SOURCE_DB` — naming a database implies OpenCode
 *   3. auto: an OpenCode db exists, else a Qoder projects dir
 *
 * This is the *default* source. The browser may pick the other one per session
 * (see `x-osm-source` in api.ts) without this process being restarted.
 */
export function resolveSourceKind(): SourceKind {
  const explicit = process.env.OSM_SOURCE?.trim();
  if (explicit === "qoder" || explicit === "opencode") return explicit;
  if (process.env.OSM_SOURCE_DB) return "opencode";
  if (existsSync(SOURCE_DB)) return "opencode";
  if (existsSync(QODER_PROJECTS)) return "qoder";
  return "opencode";
}

export const SOURCE_KIND: SourceKind = resolveSourceKind();

/* ------------------------------------------------------------------ *
 * One store per source
 *
 * Two independent databases live side by side in `DATA_DIR`. The source is a
 * property of the store, never a column: switching never re-materializes, and
 * every query keeps grouping over one tool's sessions only.
 *
 * `metrics.db` keeps its historical name so an existing OpenCode install does
 * not pay for a 232-session rebuild after an upgrade.
 * ------------------------------------------------------------------ */
const METRICS_DB_BY_KIND: Record<SourceKind, string> = {
  opencode: path.join(DATA_DIR, "metrics.db"),
  qoder: path.join(DATA_DIR, "metrics-qoder.db"),
};

export const metricsDbPath = (kind: SourceKind): string => METRICS_DB_BY_KIND[kind];

/** The OpenCode store, for callers that predate the second source (`osm materialize`). */
export const METRICS_DB = METRICS_DB_BY_KIND.opencode;

/** Where this source keeps its raw data — the path the UI prints in the menu. */
export const sourceProbe = (kind: SourceKind): string => (kind === "qoder" ? QODER_PROJECTS : SOURCE_DB);

/** True when this source exists on this machine — an unmaterialized store is still available. */
export const sourceAvailable = (kind: SourceKind): boolean => existsSync(sourceProbe(kind));

export const MODEL_CATALOG = path.join(DATA_DIR, "model-catalog.json");
export const MODEL_OVERRIDES = path.join(DATA_DIR, "model-overrides.json");
/** Bind to loopback by default — the payload contains your raw prompts. */
export const HOST = process.env.OSM_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.OSM_PORT ?? 8787);

/** Minutes per ECG/flow bucket. 5 min keeps the series dense but queryable. */
export const BUCKET_MS = 5 * 60 * 1000;
