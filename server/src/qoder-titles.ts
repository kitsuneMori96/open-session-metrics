import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, QODER_DESKTOP_DB } from "./config";

/**
 * Session titles from the Qoder Desktop index, keyed by session id.
 *
 * Desktop is an Electron shell around the same qodercli runtime, so its
 * sessions are already in the JSONL transcript tree. The one thing the
 * transcript does not always carry is a title: qodercli writes `ai-title` when
 * it generates one, but a session started from the desktop app keeps its title
 * in `chat_sessions.title` instead. Those rows are merged into the CLI source
 * as a title fallback — no separate source, and no extra turns or credits.
 *
 * The database sits on a DrvFs mount under WSL where the WAL lock cannot be
 * taken, so it is read through a private snapshot copy. Results are cached by
 * the store's mtime/size, which keeps a per-request `openSource` cheap.
 */

const SUFFIXES = ["", "-wal", "-shm"] as const;

let cached: { sig: string; titles: Map<string, string> } | null = null;

function signature(db: string): string {
  return SUFFIXES.map((suffix) => {
    try {
      const st = statSync(db + suffix);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "-";
    }
  }).join("|");
}

function readRows(file: string): Map<string, string> {
  const out = new Map<string, string>();
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT session_id, title FROM chat_sessions WHERE deleted_at IS NULL AND title IS NOT NULL AND title <> ''",
      )
      .all() as { session_id: string; title: string }[];
    for (const row of rows) if (row.session_id && row.title) out.set(row.session_id, row.title);
  } catch {
    /* a missing or half-written store simply contributes no titles */
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
  return out;
}

/** Copy the store (and its WAL) somewhere the lock protocol can work. */
function readSnapshot(db: string): Map<string, string> {
  const dir = path.join(DATA_DIR, "qoder-title-snapshot");
  mkdirSync(dir, { recursive: true });
  const snapshot = path.join(dir, `main.${process.pid}.${Date.now()}.sqlite`);
  try {
    for (const suffix of SUFFIXES) {
      const from = db + suffix;
      if (existsSync(from)) copyFileSync(from, snapshot + suffix);
    }
    return readRows(snapshot);
  } catch {
    return new Map();
  } finally {
    for (const suffix of SUFFIXES) rmSync(snapshot + suffix, { force: true });
  }
}

export function qoderDesktopTitles(db = QODER_DESKTOP_DB): Map<string, string> {
  if (!existsSync(db)) return new Map();
  const sig = signature(db);
  if (cached?.sig === sig) return cached.titles;

  const windowsMount = process.platform === "linux" && /^\/mnt\/[a-z]\//i.test(db);
  const titles = windowsMount ? readSnapshot(db) : readRows(db);
  cached = { sig, titles };
  return titles;
}

/** Tests swap the store between assertions. */
export function resetQoderDesktopTitles(): void {
  cached = null;
}
