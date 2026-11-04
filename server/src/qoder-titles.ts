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

/**
 * The desktop index, read once per store change: the titles a transcript may
 * lack, and where each side chat stops copying its owner.
 */
export interface DesktopIndex {
  titles: Map<string, string>;
  /**
   * Side-chat session id → timestamp of its first own message (ms). A side chat's
   * transcript starts with a verbatim copy of its owner's messages — same ids,
   * same timestamps — so everything before this instant is inherited history, not
   * a second billed response. Absent when the index has no message rows yet.
   */
  forks: Map<string, number>;
}

const EMPTY: DesktopIndex = { titles: new Map(), forks: new Map() };

const SUFFIXES = ["", "-wal", "-shm"] as const;

let cached: { sig: string; index: DesktopIndex } | null = null;

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

function readRows(file: string): DesktopIndex {
  const titles = new Map<string, string>();
  const forks = new Map<string, number>();
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    // Column sets differ across app versions, so each read stands alone: a store
    // without the side-chat columns still yields titles.
    try {
      const rows = db
        .prepare(
          "SELECT session_id, title FROM chat_sessions WHERE deleted_at IS NULL AND title IS NOT NULL AND title <> ''",
        )
        .all() as { session_id: string; title: string }[];
      for (const row of rows) if (row.session_id && row.title) titles.set(row.session_id, row.title);
    } catch {
      /* no title index */
    }
    try {
      const rows = db
        .prepare(
          `SELECT s.session_id AS id, MIN(m.created_at) AS first_at
           FROM chat_sessions s JOIN chat_session_messages m ON m.session_id = s.session_id
           WHERE s.deleted_at IS NULL
             AND (s.session_kind = 'sideChat' OR s.owner_session_id IS NOT NULL)
           GROUP BY s.session_id`,
        )
        .all() as { id: string; first_at: number }[];
      for (const row of rows) if (row.id && Number(row.first_at) > 0) forks.set(row.id, Number(row.first_at));
    } catch {
      /* no side-chat index */
    }
  } catch {
    /* a missing or half-written store simply contributes nothing */
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
  return { titles, forks };
}

/** Copy the store (and its WAL) somewhere the lock protocol can work. */
function readSnapshot(db: string): DesktopIndex {
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
    return EMPTY;
  } finally {
    for (const suffix of SUFFIXES) rmSync(snapshot + suffix, { force: true });
  }
}

function index(db = QODER_DESKTOP_DB): DesktopIndex {
  if (!existsSync(db)) return EMPTY;
  const sig = signature(db);
  if (cached?.sig === sig) return cached.index;

  const windowsMount = process.platform === "linux" && /^\/mnt\/[a-z]\//i.test(db);
  const next = windowsMount ? readSnapshot(db) : readRows(db);
  cached = { sig, index: next };
  return next;
}

export function qoderDesktopTitles(db = QODER_DESKTOP_DB): Map<string, string> {
  return index(db).titles;
}

/** Side-chat session id → first own message timestamp; inherited copies precede it. */
export function qoderDesktopForks(db = QODER_DESKTOP_DB): Map<string, number> {
  return index(db).forks;
}

/** Tests swap the store between assertions. */
export function resetQoderDesktopTitles(): void {
  cached = null;
}
