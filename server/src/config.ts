import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = path.join(ROOT, ".data");
export const METRICS_DB = path.join(DATA_DIR, "metrics.db");
export const SOURCE_DB =
  process.env.HOLO_SOURCE_DB ?? path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
export const MODEL_CATALOG = path.join(DATA_DIR, "model-catalog.json");
export const PORT = Number(process.env.HOLO_PORT ?? 8787);

/** Minutes per ECG/flow bucket. 5 min keeps the series dense but queryable. */
export const BUCKET_MS = 5 * 60 * 1000;
