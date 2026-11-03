import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readdirSync } from "node:fs";
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
  process.env.OSM_DATA_DIR ?? (ROOT.includes(INSTALLED) ? USER_DATA_DIR : path.join(ROOT, ".data"));
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

/* ------------------------------------------------------------------ *
 * Qoder Desktop title index
 *
 * Desktop is an Electron shell around the same qodercli runtime, so its
 * sessions are already in the transcript tree and must not become a second
 * source. Its SQLite store (`main.sqlite`) is read only for the titles that the
 * app generates before qodercli writes an `ai-title` row. On WSL the app runs
 * on Windows, so the path can live on any drive and under a relocated profile
 * (`D:\Administrator\...`, not `C:\Users\...`). Discovery therefore asks the
 * standard locations first, then scans the Windows mount roots once.
 * ------------------------------------------------------------------ */
const QODER_APP_DIR = "com.qoder.app.stable";

const appDirUnder = (base: string | null | undefined): string | null =>
  base ? path.join(base, QODER_APP_DIR) : null;

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Mount points such as `/mnt/c`, `/mnt/d` — never `/mnt/wsl` or a file. */
function windowsMounts(): string[] {
  try {
    return readdirSync("/mnt", { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[a-z]$/i.test(d.name))
      .map((d) => path.join("/mnt", d.name));
  } catch {
    return [];
  }
}

function* desktopCandidates(): Generator<string> {
  const home = os.homedir();
  if (process.platform === "win32") {
    for (const dir of [appDirUnder(process.env.APPDATA), appDirUnder(path.join(home, "AppData", "Roaming"))])
      if (dir) yield dir;
  } else if (process.platform === "darwin") {
    yield appDirUnder(path.join(home, "Library", "Application Support"))!;
  } else {
    yield appDirUnder(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"))!;
  }

  const wsl = process.platform === "linux" && (!!process.env.WSL_DISTRO_NAME || existsSync("/mnt/c/Windows"));
  if (!wsl) return;
  for (const root of windowsMounts()) {
    for (const user of safeDirs(path.join(root, "Users"))) {
      yield appDirUnder(path.join(root, "Users", user, "AppData", "Roaming"))!;
    }
    // A relocated Windows profile or a portable install can sit anywhere one
    // or two levels under the drive root, so `C:\Users` alone is not enough.
    for (const top of safeDirs(root)) {
      if (top === "Users") continue;
      yield appDirUnder(path.join(root, top, "AppData", "Roaming"))!;
      for (const mid of safeDirs(path.join(root, top))) {
        yield appDirUnder(path.join(root, top, mid, "AppData", "Roaming"))!;
      }
    }
  }
}

/** The first app-data directory that actually holds a store, else the expected one. */
function discoverDesktopHome(): string {
  let first: string | null = null;
  for (const dir of desktopCandidates()) {
    first ??= dir;
    if (existsSync(path.join(dir, "main.sqlite"))) return dir;
  }
  return first ?? path.join(os.homedir(), ".config", QODER_APP_DIR);
}

export const QODER_DESKTOP_HOME = process.env.OSM_QODER_DESKTOP_HOME ?? discoverDesktopHome();
export const QODER_DESKTOP_DB =
  process.env.OSM_QODER_DESKTOP_DB ?? path.join(QODER_DESKTOP_HOME, "main.sqlite");

/* ------------------------------------------------------------------ *
 * Qoder transcript roots
 *
 * qodercli writes under the OS it runs on, so one account can own several
 * trees: the WSL home plus each Windows profile under `/mnt/<drive>`. Same
 * product, same credit pool, same JSONL schema — one source, several roots.
 *
 * An explicit `OSM_QODER_HOME` means "this tree only": tests and single-machine
 * installs must not pick up a stray `/mnt/c`.
 * ------------------------------------------------------------------ */

/** A projects tree only counts when some encoded-cwd inside holds a transcript. */
function isTranscriptRoot(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (readdirSync(path.join(dir, entry.name)).some((f) => f.endsWith(".jsonl"))) return true;
    }
  } catch {
    /* unreadable, so not a root */
  }
  return false;
}

function discoverProjectRoots(): string[] {
  const out = [QODER_PROJECTS];
  if (process.env.OSM_QODER_HOME || process.platform !== "linux") return out;
  if (!process.env.WSL_DISTRO_NAME && !existsSync("/mnt/c/Windows")) return out;
  for (const mount of windowsMounts()) {
    // A Windows profile sits one level deep: `C:\Users\<name>`, or a relocated
    // `D:\Administrator`. Anything further down is not a profile.
    for (const parent of [path.join(mount, "Users"), mount]) {
      for (const name of safeDirs(parent)) {
        const dir = path.join(parent, name, ".qoder", "projects");
        if (!out.includes(dir) && isTranscriptRoot(dir)) out.push(dir);
      }
    }
  }
  return out;
}

export const QODER_PROJECT_ROOTS: readonly string[] = process.env.OSM_QODER_PROJECT_ROOTS
  ? process.env.OSM_QODER_PROJECT_ROOTS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : discoverProjectRoots();

export type SourceKind = "opencode" | "qoder";

export const SOURCE_KINDS: readonly SourceKind[] = ["opencode", "qoder"];

export const SOURCE_LABELS: Record<SourceKind, string> = {
  opencode: "opencode",
  qoder: "qoder cli",
};

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
  if ((SOURCE_KINDS as readonly string[]).includes(explicit ?? "")) return explicit as SourceKind;
  if (process.env.OSM_SOURCE_DB) return "opencode";
  if (existsSync(SOURCE_DB)) return "opencode";
  if (existsSync(QODER_PROJECTS)) return "qoder";
  return "opencode";
}

export const SOURCE_KIND: SourceKind = resolveSourceKind();

/* ------------------------------------------------------------------ *
 * One store per source
 *
 * One database per source lives side by side in `DATA_DIR`. The source is a
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

/** Every tree this source reads. Qoder has one per OS that ran it. */
export const sourceRoots = (kind: SourceKind): string[] =>
  kind === "qoder" ? [...QODER_PROJECT_ROOTS] : [SOURCE_DB];

/** True when this source exists on this machine — an unmaterialized store is still available. */
export const sourceAvailable = (kind: SourceKind): boolean => sourceRoots(kind).some((p) => existsSync(p));

export const MODEL_CATALOG = path.join(DATA_DIR, "model-catalog.json");
export const MODEL_OVERRIDES = path.join(DATA_DIR, "model-overrides.json");
/** Bind to loopback by default — the payload contains your raw prompts. */
export const HOST = process.env.OSM_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.OSM_PORT ?? 8787);

/** Minutes per ECG/flow bucket. 5 min keeps the series dense but queryable. */
export const BUCKET_MS = 5 * 60 * 1000;
