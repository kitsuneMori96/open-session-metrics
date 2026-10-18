import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, METRICS_DB } from "../config";
import { mkdirSync } from "node:fs";

export type Row = Record<string, string | number | null>;

export function openMetrics(): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(METRICS_DB);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

export const SCHEMA = /* sql */ `
DROP TABLE IF EXISTS models;
CREATE TABLE models (
  id TEXT PRIMARY KEY, provider TEXT, label TEXT,
  context INTEGER DEFAULT 128000,
  cost_input REAL DEFAULT 0, cost_output REAL DEFAULT 0,
  cost_cache_read REAL DEFAULT 0, cost_cache_write REAL DEFAULT 0
);

DROP TABLE IF EXISTS turns;
CREATE TABLE turns (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project TEXT NOT NULL,
  seq INTEGER, created INTEGER, completed INTEGER, dur_ms INTEGER,
  role TEXT, provider TEXT, model TEXT, variant TEXT, agent TEXT,
  input INTEGER, output INTEGER, reasoning INTEGER,
  cache_read INTEGER, cache_write INTEGER, cost REAL,
  prompt_total INTEGER, occupancy INTEGER, context_window INTEGER, fill REAL,
  finish TEXT, has_error INTEGER, tool_calls INTEGER, tool_errors INTEGER,
  additions INTEGER, deletions INTEGER, text TEXT
);
CREATE INDEX turns_session ON turns(session_id);
CREATE INDEX turns_project_time ON turns(project, created);
CREATE INDEX turns_time ON turns(created);

DROP TABLE IF EXISTS tools;
CREATE TABLE tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, turn_id TEXT, call_id TEXT, name TEXT, status TEXT,
  started INTEGER, ended INTEGER, dur_ms INTEGER,
  title TEXT, output_chars INTEGER, additions INTEGER, deletions INTEGER, files INTEGER,
  error TEXT, sig TEXT
);
CREATE INDEX tools_session ON tools(session_id, started);

DROP TABLE IF EXISTS events;
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, turn_id TEXT, type TEXT, at INTEGER, fill REAL, detail TEXT
);
CREATE INDEX events_session ON events(session_id, at);
CREATE INDEX events_time ON events(at);

DROP TABLE IF EXISTS sessions;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project TEXT, directory TEXT, title TEXT,
  agent TEXT, provider TEXT, model TEXT, variant TEXT, parent_id TEXT, depth INTEGER,
  created INTEGER, updated INTEGER,
  t_input INTEGER, t_output INTEGER, t_reasoning INTEGER, t_cache_read INTEGER, t_cache_write INTEGER,
  cost REAL, turns INTEGER, tool_calls INTEGER, tool_errors INTEGER, compactions INTEGER, retries INTEGER,
  additions INTEGER, deletions INTEGER, files_changed INTEGER,
  peak_fill REAL, avg_fill REAL, eff_score REAL, tokens_per_line REAL,
  first_prompt TEXT, duration_ms INTEGER, dominant_model TEXT
);
CREATE INDEX sessions_project ON sessions(project, created);

DROP TABLE IF EXISTS flow;
CREATE TABLE flow (
  project TEXT, bucket INTEGER, tokens INTEGER, cost REAL,
  sessions INTEGER, dominant_model TEXT, peak_fill REAL
);
CREATE INDEX flow_time ON flow(bucket);
CREATE INDEX flow_project ON flow(project, bucket);

DROP TABLE IF EXISTS heat;
CREATE TABLE heat (
  project TEXT, dow INTEGER, hour INTEGER, tokens INTEGER, cost REAL, turns INTEGER
);
CREATE INDEX heat_idx ON heat(dow, hour);

DROP TABLE IF EXISTS meta;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function initSchema(db: DatabaseSync) {
  db.exec(SCHEMA);
}

export function setMeta(db: DatabaseSync, key: string, value: string) {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const r = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
