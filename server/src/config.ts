import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = process.env.HOLO_DATA_DIR ?? path.join(ROOT, ".data");
export const METRICS_DB = path.join(DATA_DIR, "metrics.db");
export const SOURCE_DB =
  process.env.HOLO_SOURCE_DB ?? path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
export const MODEL_CATALOG = path.join(DATA_DIR, "model-catalog.json");
export const MODEL_OVERRIDES = path.join(DATA_DIR, "model-overrides.json");
/** Bind to loopback by default — the payload contains your raw prompts. */
export const HOST = process.env.HOLO_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.HOLO_PORT ?? 8787);

/** Minutes per ECG/flow bucket. 5 min keeps the series dense but queryable. */
export const BUCKET_MS = 5 * 60 * 1000;
