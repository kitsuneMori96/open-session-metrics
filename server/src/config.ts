import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A global install lives under `node_modules/`, where writing state is wrong:
 * the next `npm i -g` would delete it, and the directory is not the user's.
 * Keep dev checkouts on `<repo>/.data`, put packaged installs on the XDG data
 * dir. `OSM_DATA_DIR` (and `osm --data`) always wins.
 */
const INSTALLED = `${path.sep}node_modules${path.sep}`;
const USER_DATA_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
  "opencode-session-metrics"
);
export const DATA_DIR =
  process.env.OSM_DATA_DIR ??
  (ROOT.includes(INSTALLED) ? USER_DATA_DIR : path.join(ROOT, ".data"));
export const METRICS_DB = path.join(DATA_DIR, "metrics.db");
export const SOURCE_DB =
  process.env.OSM_SOURCE_DB ?? path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
export const MODEL_CATALOG = path.join(DATA_DIR, "model-catalog.json");
export const MODEL_OVERRIDES = path.join(DATA_DIR, "model-overrides.json");
/** Bind to loopback by default — the payload contains your raw prompts. */
export const HOST = process.env.OSM_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.OSM_PORT ?? 8787);

/** Minutes per ECG/flow bucket. 5 min keeps the series dense but queryable. */
export const BUCKET_MS = 5 * 60 * 1000;
