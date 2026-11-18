import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, QODER_DESKTOP_DBS } from "./config";

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
 * The international and CN builds each keep their own store, so every store on
 * the machine is read and the rows merge; a session id lives in exactly one.
 *
 * The databases sit on a DrvFs mount under WSL where the WAL lock cannot be
 * taken, so each is read through a private snapshot copy. Results are cached by
 * the stores' mtime/size, which keeps a per-request `openSource` cheap.
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

function index(dbs: readonly string[] = QODER_DESKTOP_DBS): DesktopIndex {
  const stores = dbs.filter((db) => existsSync(db));
  if (!stores.length) return EMPTY;
  const sig = stores.map(signature).join("||");
  if (cached?.sig === sig) return cached.index;

  const merged: DesktopIndex = { titles: new Map(), forks: new Map() };
  for (const db of stores) {
    const windowsMount = process.platform === "linux" && /^\/mnt\/[a-z]\//i.test(db);
    const one = windowsMount ? readSnapshot(db) : readRows(db);
    for (const [id, title] of one.titles) if (!merged.titles.has(id)) merged.titles.set(id, title);
    for (const [id, at] of one.forks) if (!merged.forks.has(id)) merged.forks.set(id, at);
  }
  cached = { sig, index: merged };
  return merged;
}

/** `db` narrows the read to one store; omitted means every store on the machine. */
export function qoderDesktopTitles(db?: string | readonly string[]): Map<string, string> {
  return index(db === undefined ? QODER_DESKTOP_DBS : typeof db === "string" ? [db] : db).titles;
}

/** Side-chat session id → first own message timestamp; inherited copies precede it. */
export function qoderDesktopForks(db?: string | readonly string[]): Map<string, number> {
  return index(db === undefined ? QODER_DESKTOP_DBS : typeof db === "string" ? [db] : db).forks;
}

/** Tests swap the store between assertions. */
export function resetQoderDesktopTitles(): void {
  cached = null;
}
