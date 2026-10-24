import { DatabaseSync } from "node:sqlite";
import { ensureRollups } from "./rollup";
import { DATA_DIR, METRICS_DB } from "../config";
import { mkdirSync } from "node:fs";

export type Row = Record<string, string | number | null>;

/** Open one store's database. Each source owns its own file; nothing is shared. */
export function openMetrics(file: string = METRICS_DB): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = OFF");
  ensureIndexes(db);
  ensureRollups(db);
  return db;
}

/** Fact tables are rebuilt per session; they may be dropped on a full rebuild only. */
const FACT_TABLES = ["turns", "tools", "parts", "events", "sessions", "flow", "heat"];

export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY, provider TEXT, label TEXT,
  context INTEGER DEFAULT 128000,
  cost_input REAL DEFAULT 0, cost_output REAL DEFAULT 0,
  cost_cache_read REAL DEFAULT 0, cost_cache_write REAL DEFAULT 0,
  source TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project TEXT NOT NULL,
  seq INTEGER, created INTEGER, completed INTEGER, dur_ms INTEGER,
  role TEXT, provider TEXT, model TEXT, variant TEXT, agent TEXT,
  input INTEGER, output INTEGER, reasoning INTEGER,
  cache_read INTEGER, cache_write INTEGER, cost REAL,
  credits_micro INTEGER DEFAULT 0,
  prompt_total INTEGER, occupancy INTEGER, context_window INTEGER,
  fill REAL, fill_after REAL,
  bucket INTEGER, day INTEGER, hour INTEGER,
  finish TEXT, has_error INTEGER, tool_calls INTEGER, tool_errors INTEGER,
  additions INTEGER, deletions INTEGER, write_lines INTEGER, text TEXT
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS turns_project_time ON turns(project, created);
CREATE INDEX IF NOT EXISTS turns_time ON turns(created);
CREATE INDEX IF NOT EXISTS turns_bucket ON turns(bucket);

CREATE TABLE IF NOT EXISTS tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, turn_id TEXT, call_id TEXT, name TEXT, status TEXT,
  started INTEGER, ended INTEGER, dur_ms INTEGER,
  title TEXT, output_chars INTEGER, additions INTEGER, deletions INTEGER, files INTEGER, write_lines INTEGER,
  error TEXT, sig TEXT, input_preview TEXT, target_session TEXT
);
CREATE INDEX IF NOT EXISTS tools_session ON tools(session_id, started);
CREATE INDEX IF NOT EXISTS tools_target ON tools(target_session);

-- The ordered content stream of every assistant turn: the text it wrote, the
-- reasoning it produced, and each tool call with its input and output. This is the
-- one table that is a transcript rather than a metric, so bodies are capped (see
-- PARTS_CAP in build.ts) — the UI renders at most 40 output lines and one input row
-- per key, and the caps keep a 234 MB source from becoming a 234 MB copy.
CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, turn_id TEXT NOT NULL, ordinal INTEGER,
  kind TEXT NOT NULL,              -- text | reasoning | tool
  text TEXT,                       -- body for text/reasoning
  name TEXT, call_id TEXT, status TEXT, title TEXT,
  input TEXT, output TEXT, exit_code INTEGER, truncated INTEGER,
  started INTEGER, ended INTEGER, chars INTEGER
);
CREATE INDEX IF NOT EXISTS parts_turn ON parts(turn_id);
CREATE INDEX IF NOT EXISTS parts_session ON parts(session_id, id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, turn_id TEXT, type TEXT, at INTEGER, end_at INTEGER, count INTEGER,
  fill REAL, detail TEXT
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, at);
CREATE INDEX IF NOT EXISTS events_time ON events(at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project TEXT, directory TEXT, title TEXT,
  agent TEXT, provider TEXT, model TEXT, variant TEXT, parent_id TEXT, depth INTEGER,
  created INTEGER, updated INTEGER,
  t_input INTEGER, t_output INTEGER, t_reasoning INTEGER, t_cache_read INTEGER, t_cache_write INTEGER,
  cost REAL, credits_micro INTEGER DEFAULT 0, turns INTEGER, tool_calls INTEGER, tool_errors INTEGER,
  compactions INTEGER, retries INTEGER, loops INTEGER,
  additions INTEGER, deletions INTEGER, files_changed INTEGER,
  peak_fill REAL, avg_fill REAL, eff_score REAL, tokens_per_line REAL,
  first_prompt TEXT, duration_ms INTEGER, dominant_model TEXT, output_rate REAL
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project, created);
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id);

-- ECG substrate: token flow per (project, 5-min bucket). tokens_gen is the
-- generation signal (input+output+reasoning); cache_read is kept separate because
-- it is ~14x larger and would otherwise drown the waveform.
CREATE TABLE IF NOT EXISTS flow (
  project TEXT, bucket INTEGER,
  tokens_gen INTEGER, tokens_cache_read INTEGER, cost REAL,
  sessions INTEGER, dominant_model TEXT, peak_fill REAL,
  PRIMARY KEY (project, bucket)
);
CREATE INDEX IF NOT EXISTS flow_time ON flow(bucket);
CREATE INDEX IF NOT EXISTS flow_project ON flow(project, bucket);

-- Circadian spectrogram: kept per local day so the time scrubber can re-slice it.
CREATE TABLE IF NOT EXISTS heat (
  project TEXT, day INTEGER, hour INTEGER,
  tokens_gen INTEGER, tokens_cache_read INTEGER, cost REAL, turns INTEGER,
  PRIMARY KEY (project, day, hour)
);
CREATE INDEX IF NOT EXISTS heat_idx ON heat(day, hour);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function initSchema(db: DatabaseSync, opts: { drop?: boolean } = {}) {
  if (opts.drop) {
    for (const t of FACT_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  db.exec(SCHEMA);
  ensureIndexes(db);
  ensureRollups(db);
  setMeta(db, "schemaSig", SCHEMA_SIG);
}

/**
 * Indexes deliberately live outside `SCHEMA`. The signature covers the table layout, and
 * a missing index is additive: `IF NOT EXISTS` runs on every open and on every build, so
 * an older store picks it up without re-materializing anything. Folding an index into the
 * DDL above would send every existing store through a full rebuild for no reason.
 *
 * `tools_turn` is the one that matters: without it a query filtered by turn time drives
 * from `tools` and scans every tool call ever recorded — measured at 620 ms for a 24-hour
 * window on a decade of history, against 2 ms once the join can start from `turns`.
 */
const INDEXES = /* sql */ `
CREATE INDEX IF NOT EXISTS tools_turn ON tools(turn_id);
`;

export function ensureIndexes(db: DatabaseSync) {
  // A store that has not been materialized yet has no tables; the build creates them and
  // calls this again.
  const built = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tools'").get();
  if (!built) return;
  db.exec(INDEXES);
}

/**
 * Short signature of the DDL above. `CREATE TABLE IF NOT EXISTS` cannot add a column
 * to an existing table, so an incremental build against a database written by an older
 * version would fail on the new column. The signature lets the rebuild detect that and
 * fall back to a full rebuild instead.
 */
export const SCHEMA_SIG = fingerprint(SCHEMA);

function fingerprint(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function setMeta(db: DatabaseSync, key: string, value: string) {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const r = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function getMetaNumber(db: DatabaseSync, key: string): number {
  return Number(getMeta(db, key) ?? 0) || 0;
}
