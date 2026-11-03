import type { DatabaseSync } from "node:sqlite";
import { getMeta, setMeta } from "./schema";
import { ladder } from "./histogram";

/**
 * Day-grain rollups.
 *
 * A decade of turns is half a million rows, and every panel above them asks the same
 * question — "sum these columns per bucket, per model, per session". Answering it from
 * `turns` costs ~12 s for one `all` window. Answering it from one row per
 * (session, day, project, model, agent) costs ~40 ms, and the row count grows with
 * *sessions and days*, not with turns.
 *
 * Three tables:
 *
 * - `roll_cell` — the workhorse: sums per session/day/dimension. Totals, KPIs, the
 *   series, the breakdowns, per-bucket distinct sessions and the session grid all read it.
 * - `roll_hour` — (day, hour) turn counts for the heatmap and the hourly strip. Hours
 *   compress well: a decade of turns still lands in ~11k rows.
 * - `roll_tool` / `roll_tool_bin` — tool calls per day (sums + the latency histogram), so
 *   the tools panel never joins half a million turns to read p95.
 *
 * Rollups live outside `SCHEMA` for the same reason the indexes do: they are derived, so
 * a store written by an older version gets them built on open instead of going through a
 * full re-materialization. `rollVersion` is the backfill trigger — bump it when a table
 * changes shape and the next open rebuilds them from `turns` (seconds, not a re-read of
 * the source database).
 *
 * Windows that do not start and end on local midnights are served by combining the
 * interior whole days from the rollup with the two partial edge days read from `turns`.
 * Both halves are exact, so nothing here rounds the numbers.
 */
export const ROLL_VERSION = "9";

const DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS roll_cell (
  session_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  project TEXT NOT NULL,
  model TEXT NOT NULL,
  agent TEXT NOT NULL,
  turns INTEGER NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  reasoning INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cost REAL NOT NULL,
  tools INTEGER NOT NULL,
  tool_errors INTEGER NOT NULL,
  additions INTEGER NOT NULL,
  deletions INTEGER NOT NULL,
  write_lines INTEGER NOT NULL,
  win INTEGER NOT NULL,
  stopped INTEGER NOT NULL,
  first_created INTEGER NOT NULL,
  last_completed INTEGER NOT NULL,
  PRIMARY KEY (session_id, day, project, model, agent)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS roll_cell_day ON roll_cell(day);

CREATE TABLE IF NOT EXISTS roll_hour (
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  project TEXT NOT NULL,
  model TEXT NOT NULL,
  agent TEXT NOT NULL,
  turns INTEGER NOT NULL,
  PRIMARY KEY (day, hour, project, model, agent)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS roll_hour_day ON roll_hour(day);

CREATE TABLE IF NOT EXISTS roll_tool (
  day INTEGER NOT NULL,
  name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  model TEXT NOT NULL,
  agent TEXT NOT NULL,
  calls INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  ms_sum INTEGER NOT NULL,
  ms_max INTEGER NOT NULL,
  PRIMARY KEY (day, name, session_id, project, model, agent)
) WITHOUT ROWID;

-- Day first, then name, then bin: a window is one contiguous range of the b-tree, and
-- the rows arrive nearly grouped the way the panel groups them. With the name first this
-- scan cost twice as much on a decade of calls (400k rows, one bin each).
CREATE TABLE IF NOT EXISTS roll_tool_bin (
  day INTEGER NOT NULL,
  name TEXT NOT NULL,
  bin INTEGER NOT NULL,
  project TEXT NOT NULL,
  model TEXT NOT NULL,
  agent TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, name, bin, project, model, agent)
) WITHOUT ROWID;

-- API wait and output speed, one histogram per day × provider × model. The wait bin
-- falls back to the whole-turn duration when the source could not separate the wait
-- (OpenCode), so the two units never share a group and the screen labels the semantics
-- per provider. Speed is chars/s for Qoder (no output tokens exist) and tok/s elsewhere.
CREATE TABLE IF NOT EXISTS roll_perf (
  day INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  bin INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, provider, model, kind, bin)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS roll_perf_idx ON roll_perf(day);

CREATE TABLE IF NOT EXISTS roll_perf_day (
  day INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL,
  exact_waits INTEGER NOT NULL,
  wait_sum INTEGER NOT NULL,
  output INTEGER NOT NULL,
  chars INTEGER NOT NULL,
  PRIMARY KEY (day, provider, model)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS roll_perf_day_idx ON roll_perf_day(day);
`;

/** The cell columns, in the order every rollup insert and read uses them. */
const CELL_COLS = [
  "session_id",
  "day",
  "project",
  "model",
  "agent",
  "turns",
  "input",
  "output",
  "reasoning",
  "cache_read",
  "cache_write",
  "cost",
  "tools",
  "tool_errors",
  "additions",
  "deletions",
  "write_lines",
  "win",
  "stopped",
  "first_created",
  "last_completed",
];

const CELL_SELECT = `t.session_id, t.day, COALESCE(t.project,'—'), COALESCE(t.model,'unknown'), COALESCE(t.agent,'main'),
  COUNT(*), SUM(t.input), SUM(t.output), SUM(t.reasoning), SUM(t.cache_read), SUM(t.cache_write), SUM(t.cost),
  SUM(COALESCE(t.tool_calls,0)), SUM(COALESCE(t.tool_errors,0)),
  SUM(COALESCE(t.additions,0)), SUM(COALESCE(t.deletions,0)), SUM(COALESCE(t.write_lines,0)),
  MAX(COALESCE(t.context_window,0)),
  SUM(CASE WHEN COALESCE(t.finish,'') <> '' AND t.finish <> 'stop' THEN 1 ELSE 0 END),
  MIN(t.created), MAX(COALESCE(t.completed, t.created))`;

const CELL_GROUP =
  "GROUP BY t.session_id, t.day, COALESCE(t.project,'—'), COALESCE(t.model,'unknown'), COALESCE(t.agent,'main')";

const HOUR_SELECT = `t.day, t.hour, COALESCE(t.project,'—'), COALESCE(t.model,'unknown'), COALESCE(t.agent,'main'), COUNT(*)`;
const HOUR_GROUP =
  "GROUP BY t.day, t.hour, COALESCE(t.project,'—'), COALESCE(t.model,'unknown'), COALESCE(t.agent,'main')";

const TOOL_SELECT = `t.day, tl.name, tl.session_id, COALESCE(t.project,'—'), COALESCE(t.model,'unknown'), COALESCE(t.agent,'main'),
  COUNT(*), SUM(CASE WHEN tl.status = 'error' THEN 1 ELSE 0 END),
  SUM(COALESCE(tl.dur_ms,0)), MAX(COALESCE(tl.dur_ms,0))`;
const TOOL_GROUP =
  "GROUP BY tl.name, t.day, tl.session_id, COALESCE(t.project,'—'), COALESCE(t.model,'unknown'), COALESCE(t.agent,'main')";
const TOOL_FROM = "FROM tools tl JOIN turns t ON t.id = tl.turn_id WHERE t.role = 'assistant'";

/** Wait evidence: the source-level wait when it exists, else the whole-turn duration. */
const WAIT_EXPR = "COALESCE(t.wait_ms, t.dur_ms, 0)";
/** Output rate in tok/s over the *stream* span, not the whole turn: `dur_ms` includes the
 * wait, and dividing by it would charge the model for time it spent queued. `wait_ms` is
 * the source's first-evidence gap, so dur − wait is the response's writing span. That span
 * still contains any in-step tool execution: OpenCode stamps a tool part's creation before
 * the model stops streaming (measured: a 2 715-token response with a tool had the part
 * created 493 ms in, while reasoning ran 11 s), so subtracting it would invent rates of
 * thousands of tok/s. Only sources that persist a stream span may enter — the Qoder JSONL
 * writes one row per response, so its `dur_ms` is ~0 for every turn and its lane stays
 * empty rather than estimated. A response whose only stamp lands at the very end (measured:
 * 2 727 tokens with a tool part created 134 ms before completion) leaves a near-zero span
 * that implies five-digit rates; nothing decodes past 1 000 tok/s, so that row is kept out
 * of the histogram rather than capped — the denominator is broken, not the model. */
const STREAM_EXPR = "MAX(t.dur_ms - COALESCE(t.wait_ms, 0), 0)";
const SPEED_EXPR = `COALESCE(t.output, 0) * 1000.0 / MAX(${STREAM_EXPR}, 1)`;
const SPEED_GATE = `${STREAM_EXPR} > 100 AND ${SPEED_EXPR} <= 1000 AND t.provider <> 'qoder' AND COALESCE(t.output,0) > 0`;

const PERF_WAIT = `INSERT INTO roll_perf(day,provider,model,kind,bin,n)
SELECT t.day, COALESCE(t.provider,'—'), COALESCE(t.model,'unknown'), 'wait',
       ${ladder.ms.key(WAIT_EXPR)}, COUNT(*)
FROM turns t
WHERE t.role = 'assistant' AND ${WAIT_EXPR} > 0{{WHERE}}
GROUP BY 1, 2, 3, 4`;

const PERF_SPEED = `INSERT INTO roll_perf(day,provider,model,kind,bin,n)
SELECT t.day, COALESCE(t.provider,'—'), COALESCE(t.model,'unknown'), 'speed',
       ${ladder.rate.key(SPEED_EXPR)}, COUNT(*)
FROM turns t
WHERE t.role = 'assistant' AND ${SPEED_GATE}{{WHERE}}
GROUP BY 1, 2, 3, 4`;

const PERF_DAY = `INSERT INTO roll_perf_day(day,provider,model,calls,exact_waits,wait_sum,output,chars)
SELECT t.day, COALESCE(t.provider,'—'), COALESCE(t.model,'unknown'),
  COUNT(*),
  SUM(CASE WHEN t.wait_ms IS NOT NULL THEN 1 ELSE 0 END),
  SUM(COALESCE(t.wait_ms,0)),
  SUM(COALESCE(t.output,0)),
  SUM(COALESCE(t.chars,0))
FROM turns t
WHERE t.role = 'assistant' AND ${WAIT_EXPR} > 0{{WHERE}}
GROUP BY 1, 2, 3`;

function perfInserts(dayFilter?: readonly unknown[]): string[] {
  const where = dayFilter?.length ? ` AND t.day IN (${dayFilter.map(() => "?").join(",")})` : "";
  return [PERF_WAIT, PERF_SPEED, PERF_DAY].map((sql) => sql.replace("{{WHERE}}", where));
}

const DROP =
  "DROP TABLE IF EXISTS roll_cell; DROP TABLE IF EXISTS roll_hour; DROP TABLE IF EXISTS roll_tool; DROP TABLE IF EXISTS roll_tool_bin;" +
  " DROP TABLE IF EXISTS roll_perf; DROP TABLE IF EXISTS roll_perf_day;";

const ready = new WeakSet<DatabaseSync>();

/** Local midnight at or after `ts`. */
export function ceilDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime() >= ts ? d.getTime() : d.getTime() + nextDayMs(d);
}

/** Local midnight at or before `ts`. */
export function floorDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Length of the local day starting at midnight `ts` (23 or 25 hours across DST). */
function nextDayMs(midnight: Date): number {
  const next = new Date(midnight.getTime());
  next.setDate(next.getDate() + 1);
  return next.getTime() - midnight.getTime();
}

function hasTurns(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turns'").get();
}

/** Rebuild every rollup row. Seconds of work; only on a new store or a shape bump. */
export function rebuildAll(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM roll_cell; DELETE FROM roll_hour; DELETE FROM roll_tool; DELETE FROM roll_tool_bin");
    db.exec("DELETE FROM roll_perf; DELETE FROM roll_perf_day");
    db.exec(
      `INSERT INTO roll_cell(${CELL_COLS.join(",")}) SELECT ${CELL_SELECT} FROM turns t WHERE t.role = 'assistant' ${CELL_GROUP}`,
    );
    db.exec(
      `INSERT INTO roll_hour(day,hour,project,model,agent,turns) SELECT ${HOUR_SELECT} FROM turns t WHERE t.role = 'assistant' ${HOUR_GROUP}`,
    );
    db.exec(`INSERT INTO roll_tool(day,name,session_id,project,model,agent,calls,errors,ms_sum,ms_max)
             SELECT ${TOOL_SELECT} ${TOOL_FROM} ${TOOL_GROUP}`);
    db.exec(
      `INSERT INTO roll_tool_bin(day,name,bin,project,model,agent,n)
       SELECT t.day, tl.name, ${ladder.ms.key("COALESCE(tl.dur_ms,0)")},
              COALESCE(t.project,'—'), COALESCE(t.model,'unknown'), COALESCE(t.agent,'main'), COUNT(*)
       ${TOOL_FROM}
       GROUP BY 1,2,3,4,5,6`,
    );
    for (const sql of perfInserts()) db.exec(sql);
    setMeta(db, "rollVersion", ROLL_VERSION);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already gone */
    }
    throw e;
  }
  ready.add(db);
}

/**
 * Re-aggregate the rollups for a build. Called inside the build's transaction, so the
 * fact tables and the rollups can never disagree.
 *
 * `sessionIds` narrows the cell and tool rows; `days` covers `roll_hour`, which has no
 * session column and is cheapest to rewrite a day at a time (the old days are passed in
 * so a session whose turns moved off a day does not leave that day's counts behind).
 */
export function refreshRollups(db: DatabaseSync, sessionIds: string[], days: number[], full = false): void {
  if (!hasTurns(db)) return;
  if (full) {
    db.exec("DELETE FROM roll_cell; DELETE FROM roll_hour; DELETE FROM roll_tool; DELETE FROM roll_tool_bin");
    db.exec("DELETE FROM roll_perf; DELETE FROM roll_perf_day");
  }
  if (sessionIds.length) {
    const ph = sessionIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM roll_cell WHERE session_id IN (${ph})`).run(...sessionIds);
    db.prepare(
      `INSERT INTO roll_cell(${CELL_COLS.join(",")})
       SELECT ${CELL_SELECT} FROM turns t WHERE t.role = 'assistant' AND t.session_id IN (${ph}) ${CELL_GROUP}`,
    ).run(...sessionIds);
    db.prepare(`DELETE FROM roll_tool WHERE session_id IN (${ph})`).run(...sessionIds);
    db.prepare(
      `INSERT INTO roll_tool(day,name,session_id,project,model,agent,calls,errors,ms_sum,ms_max)
       SELECT ${TOOL_SELECT} ${TOOL_FROM} AND tl.session_id IN (${ph}) ${TOOL_GROUP}`,
    ).run(...sessionIds);
    // The latency bins are rewritten a day at a time below: a call carries its turn's
    // day, so every day this build wrote is already in `days`.
  }
  if (days.length) {
    const ph = days.map(() => "?").join(",");
    db.prepare(`DELETE FROM roll_hour WHERE day IN (${ph})`).run(...days);
    db.prepare(
      `INSERT INTO roll_hour(day,hour,project,model,agent,turns)
       SELECT ${HOUR_SELECT} FROM turns t WHERE t.role = 'assistant' AND t.day IN (${ph}) ${HOUR_GROUP}`,
    ).run(...days);
    db.prepare(`DELETE FROM roll_tool_bin WHERE day IN (${ph})`).run(...days);
    db.prepare(
      `INSERT INTO roll_tool_bin(day,name,bin,project,model,agent,n)
       SELECT t.day, tl.name, ${ladder.ms.key("COALESCE(tl.dur_ms,0)")},
              COALESCE(t.project,'—'), COALESCE(t.model,'unknown'), COALESCE(t.agent,'main'), COUNT(*)
       ${TOOL_FROM} AND t.day IN (${ph})
       GROUP BY 1,2,3,4,5,6`,
    ).run(...days);
    db.prepare(`DELETE FROM roll_perf WHERE day IN (${ph})`).run(...days);
    db.prepare(`DELETE FROM roll_perf_day WHERE day IN (${ph})`).run(...days);
    for (const sql of perfInserts(days)) db.prepare(sql).run(...days);
  }
  setMeta(db, "rollVersion", ROLL_VERSION);
  ready.add(db);
}

/**
 * Create the rollup tables and backfill them when the shape version moves.
 *
 * Runs on every open, next to `ensureIndexes`, so a store materialized by an older build
 * picks the rollups up without re-reading the source database.
 */
export function ensureRollups(db: DatabaseSync): void {
  if (!hasTurns(db)) return;
  const version = getMeta(db, "rollVersion");
  if (version !== ROLL_VERSION) {
    // `CREATE TABLE IF NOT EXISTS` cannot change a primary key, and the physical order is
    // part of the design here — so a shape bump drops the derived tables and starts over.
    db.exec(DROP);
  }
  db.exec(DDL);
  // A store whose turns were never materialized has nothing to roll up yet — the next
  // build calls this again and the version check backfills then.
  const seeded = db.prepare("SELECT 1 FROM turns WHERE role='assistant' LIMIT 1").get();
  if (version !== ROLL_VERSION && seeded) rebuildAll(db);
  ready.add(db);
}

/** True when this database was opened through `ensureRollups` and the tables are current. */
export function rollupsReady(db: DatabaseSync): boolean {
  return ready.has(db) && getMeta(db, "rollVersion") === ROLL_VERSION;
}

/* ------------------------------------------------------------------ *
 * Window planning
 * ------------------------------------------------------------------ */

export interface RollSpan {
  /** First local midnight strictly inside the window. */
  lo: number;
  /** First local midnight at or after the window end. */
  hi: number;
}

/**
 * The whole-day core of a window, or null when `turns` should answer directly.
 *
 * Only windows at least a day long that contain at least one full day qualify: below
 * that the rollup has nothing to say, and the raw rows are already a handful.
 */
export function rollSpan(db: DatabaseSync, slice: { from: number; to: number }): RollSpan | null {
  if (!rollupsReady(db)) return null;
  const lo = ceilDay(slice.from);
  const hi = floorDay(slice.to);
  if (hi <= lo) return null;
  return { lo, hi };
}

export interface Sql {
  sql: string;
  args: (string | number)[];
}

/** Facet filters against coalesced rollup columns. */
function cellFacet(slice: { project: string | null; model: string | null; agent: string | null }): Sql {
  const parts: string[] = [];
  const args: string[] = [];
  if (slice.project) (parts.push("project = ?"), args.push(slice.project));
  if (slice.model) (parts.push("model = ?"), args.push(slice.model));
  if (slice.agent) (parts.push("agent = ?"), args.push(slice.agent));
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", args };
}

/** The same filters against raw turns, where the dimensions can be NULL. */
function turnFacet(slice: { project: string | null; model: string | null; agent: string | null }): Sql {
  const parts: string[] = [];
  const args: string[] = [];
  if (slice.project) (parts.push("COALESCE(t.project,'—') = ?"), args.push(slice.project));
  if (slice.model) (parts.push("COALESCE(t.model,'unknown') = ?"), args.push(slice.model));
  if (slice.agent) (parts.push("COALESCE(t.agent,'main') = ?"), args.push(slice.agent));
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", args };
}

/** The two partial days at the window edges, read from `turns` because they are cut. */
export function edgeSql(
  slice: { from: number; to: number; project: string | null; model: string | null; agent: string | null },
  span: RollSpan,
): Sql {
  const f = turnFacet(slice);
  return {
    sql: `t.role = 'assistant' AND ((t.created >= ? AND t.created < ?) OR (t.created >= ? AND t.created < ?))${f.sql}`,
    args: [slice.from, span.lo, span.hi, slice.to, ...f.args],
  };
}

/**
 * The column vocabulary every consumer aggregates.
 *
 * A turn is one row: `turns = 1`, the sums are its own numbers, `day` is its local day.
 * A rollup cell is the same shape with `turns` > 1 and the edges collapsed, which is why
 * the panels below can wrap either source in `(…) t` and read the same names.
 */
const TURN_COLUMNS = `t.session_id, COALESCE(t.project,'—') project, COALESCE(t.model,'unknown') model,
  COALESCE(t.agent,'main') agent, t.day, t.bucket, t.created, COALESCE(t.completed,t.created) ended,
  1 turns, t.input, t.output, t.reasoning, t.cache_read, t.cache_write, t.cost,
  COALESCE(t.tool_calls,0) tools, COALESCE(t.tool_errors,0) tool_errors,
  COALESCE(t.additions,0) additions, COALESCE(t.deletions,0) deletions,
  COALESCE(t.write_lines,0) write_lines, COALESCE(t.context_window,0) win,
  CASE WHEN COALESCE(t.finish,'') <> '' AND t.finish <> 'stop' THEN 1 ELSE 0 END stopped`;

// `bucket` exists only for the five-minute axis, which is never served from a cell; a
// cell answers with its day so both sides of the union keep the same column list.
const CELL_TURNS = `session_id, project, model, agent, day, day bucket, first_created created, last_completed ended,
  turns, input, output, reasoning, cache_read, cache_write, cost, tools, tool_errors,
  additions, deletions, write_lines, win, stopped`;

function turnsFrom(where: Sql): string {
  return `SELECT ${TURN_COLUMNS} FROM turns t WHERE ${where.sql}`;
}

/** Every turn in the window, straight from `turns`. */
export function rawCellSource(slice: Shape): Sql {
  const f = turnFacet(slice);
  return {
    sql: turnsFrom({ sql: `t.role = 'assistant' AND t.created >= ? AND t.created < ?${f.sql}`, args: [] }),
    args: [slice.from, slice.to, ...f.args],
  };
}

/**
 * Turn-shaped facts for the window: whole days from the rollup, the cut days from
 * `turns`. Exact on both sides, so a query never has to care which half a row came from.
 */
export function cellSource(slice: Shape, span: RollSpan): Sql {
  const f = cellFacet(slice);
  const e = edgeSql(slice, span);
  return {
    sql: `SELECT ${CELL_TURNS} FROM roll_cell WHERE day >= ? AND day < ?${f.sql}
          UNION ALL ${turnsFrom(e)}`,
    args: [span.lo, span.hi, ...f.args, ...e.args],
  };
}

const TOOL_COLUMNS = `tl.name, tl.session_id, COALESCE(t.agent,'main') agent, t.day,
  1 calls, CASE WHEN tl.status = 'error' THEN 1 ELSE 0 END errors,
  COALESCE(tl.dur_ms,0) ms, COALESCE(tl.dur_ms,0) mx`;

const TOOL_TURNS = "tools tl JOIN turns t ON t.id = tl.turn_id";

export function rawToolSource(slice: Shape): Sql {
  const f = turnFacet(slice);
  return {
    sql: `SELECT ${TOOL_COLUMNS} FROM ${TOOL_TURNS}
           WHERE t.role = 'assistant' AND t.created >= ? AND t.created < ?${f.sql}`,
    args: [slice.from, slice.to, ...f.args],
  };
}

/** Whole-day tool calls plus the edge days' calls. */
export function toolSource(slice: Shape, span: RollSpan): Sql {
  const f = cellFacet(slice);
  const e = edgeSql(slice, span);
  return {
    sql: `SELECT name, session_id, agent, day, calls, errors, ms_sum ms, ms_max mx
            FROM roll_tool WHERE day >= ? AND day < ?${f.sql}
          UNION ALL
          SELECT ${TOOL_COLUMNS} FROM ${TOOL_TURNS} WHERE ${e.sql}`,
    args: [span.lo, span.hi, ...f.args, ...e.args],
  };
}

const LATENCY_BINS = ladder.ms.key("COALESCE(tl.dur_ms,0)");

function turnBins(where: Sql): string {
  return `SELECT tl.name, ${LATENCY_BINS} bin, COUNT(*) n FROM ${TOOL_TURNS}
           WHERE ${where.sql} GROUP BY tl.name, bin`;
}

export function rawToolBins(slice: Shape): Sql {
  const f = turnFacet(slice);
  return {
    sql: turnBins({ sql: `t.role = 'assistant' AND t.created >= ? AND t.created < ?${f.sql}`, args: [] }),
    args: [slice.from, slice.to, ...f.args],
  };
}

/** Whole-day tool latency bins plus the edge days' bins, merged per tool. */
export function toolBins(slice: Shape, span: RollSpan): Sql {
  const f = cellFacet(slice);
  const e = edgeSql(slice, span);
  return {
    sql: `SELECT name, bin, SUM(n) n FROM (
            SELECT name, bin, n FROM roll_tool_bin WHERE day >= ? AND day < ?${f.sql}
            UNION ALL ${turnBins(e)}
          ) GROUP BY name, bin`,
    args: [span.lo, span.hi, ...f.args, ...e.args],
  };
}

/** Whole-day hours plus the edge days' hours, as (day, hour, turns). */
export function hourSource(slice: Shape, span: RollSpan): Sql {
  const f = cellFacet(slice);
  const e = edgeSql(slice, span);
  return {
    sql: `SELECT day, hour, SUM(turns) n FROM roll_hour WHERE day >= ? AND day < ?${f.sql} GROUP BY day, hour
          UNION ALL
          SELECT t.day, t.hour, COUNT(*) FROM turns t WHERE ${e.sql} GROUP BY t.day, t.hour`,
    args: [span.lo, span.hi, ...f.args, ...e.args],
  };
}

/** Raw hours, for windows the rollup declines. */
export function rawHourSource(slice: Shape): Sql {
  const f = turnFacet(slice);
  return {
    sql: `SELECT t.day, t.hour, COUNT(*) n FROM turns t
           WHERE t.role = 'assistant' AND t.created >= ? AND t.created < ?${f.sql}
           GROUP BY t.day, t.hour`,
    args: [slice.from, slice.to, ...f.args],
  };
}

/** Whole-day per-day perf facts plus the edge days' facts. `roll_perf_day` carries no
 * project/agent columns, so the caller only takes this when neither facet is set; the
 * model facet is applied in JS, where per-day rows are already a few per day. */
export function perfDaySource(slice: Shape, span: RollSpan): Sql {
  const e = edgeSql(slice, span);
  return {
    sql: `SELECT day, provider, model, calls, exact_waits, wait_sum, output, chars
            FROM roll_perf_day WHERE day >= ? AND day < ?
          UNION ALL
          SELECT t.day, COALESCE(t.provider,'—') provider, COALESCE(t.model,'unknown') model,
            COUNT(*) calls, SUM(CASE WHEN t.wait_ms IS NOT NULL THEN 1 ELSE 0 END) exact_waits,
            SUM(COALESCE(t.wait_ms,0)) wait_sum,
            SUM(COALESCE(t.output,0)) output, SUM(COALESCE(t.chars,0)) chars
          FROM turns t WHERE ${e.sql} AND ${WAIT_EXPR} > 0
          GROUP BY t.day, 2, 3`,
    args: [span.lo, span.hi, ...e.args],
  };
}

/** Raw per-day perf facts, for windows the rollup declines or facets it can't carry.
 * `key` lets the Speed screen ask for hour or five-minute buckets: those never come from
 * the day rollups, so the bucket key has to be computed here, over `t.created`. */
export function rawPerfDaySource(slice: Shape, key = "t.day"): Sql {
  const f = turnFacet(slice);
  return {
    sql: `SELECT ${key} day, COALESCE(t.provider,'—') provider, COALESCE(t.model,'unknown') model,
            COUNT(*) calls, SUM(CASE WHEN t.wait_ms IS NOT NULL THEN 1 ELSE 0 END) exact_waits,
            SUM(COALESCE(t.wait_ms,0)) wait_sum,
            SUM(COALESCE(t.output,0)) output, SUM(COALESCE(t.chars,0)) chars
          FROM turns t
          WHERE t.role = 'assistant' AND t.created >= ? AND t.created < ?${f.sql} AND ${WAIT_EXPR} > 0
          GROUP BY 1, 2, 3`,
    args: [slice.from, slice.to, ...f.args],
  };
}

/** Two arms, one per kind — so the caller's args are consumed twice: bind them twice. */
function rawPerfBins(where: Sql, key = "t.day"): Sql {
  return {
    args: [...where.args, ...where.args],
    sql: `SELECT ${key} day, COALESCE(t.provider,'—') provider, COALESCE(t.model,'unknown') model,
            'wait' kind, ${ladder.ms.key(WAIT_EXPR)} bin, COUNT(*) n
          FROM turns t WHERE t.role = 'assistant' AND ${WAIT_EXPR} > 0 AND ${where.sql} GROUP BY 1,2,3,4
          UNION ALL
          SELECT ${key} day, COALESCE(t.provider,'—') provider, COALESCE(t.model,'unknown') model,
            'speed' kind, ${ladder.rate.key(SPEED_EXPR)} bin, COUNT(*) n
          FROM turns t WHERE t.role = 'assistant' AND ${SPEED_GATE}
            AND ${where.sql} GROUP BY 1,2,3,4`,
  };
}

/** Whole-day perf bins plus the edge days' bins, merged per day × provider × model. */
export function perfBinsSource(slice: Shape, span: RollSpan): Sql {
  const e = edgeSql(slice, span);
  const raw = rawPerfBins(e);
  return {
    sql: `SELECT day, provider, model, kind, bin, SUM(n) n FROM (
            SELECT day, provider, model, kind, bin, n FROM roll_perf WHERE day >= ? AND day < ?
            UNION ALL ${raw.sql}
          ) GROUP BY 1,2,3,4,5`,
    args: [span.lo, span.hi, ...raw.args],
  };
}

/** Raw perf bins, for windows the rollup declines or facets it can't carry. */
export function rawPerfBinsSource(slice: Shape, key = "t.day"): Sql {
  const f = turnFacet(slice);
  return rawPerfBins(
    {
      sql: `t.created >= ? AND t.created < ?${f.sql}`,
      args: [slice.from, slice.to, ...f.args],
    },
    key,
  );
}

export interface Shape {
  from: number;
  to: number;
  project: string | null;
  model: string | null;
  agent: string | null;
}
