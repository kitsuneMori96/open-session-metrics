/**
 * The `all` window's contract: the answer is bounded by *sessions and columns*, never by
 * how much history is behind it.
 *
 * Two synthetic stores are built with the same daily volume but two very different
 * lengths — a quarter and a decade. Everything here is generated in memory (no prompts,
 * no real project names), so the test can assert the shapes the UI depends on:
 *
 *   - the time axis never exceeds `MAX_COLS` columns, whatever the range;
 *   - the session sample is capped at `SESSION_SAMPLE` rows;
 *   - bytes per column are flat, so the JSON is the same size for 90 days and 3,650 days;
 *   - the long window is answered from thousands of rollup cells, not from its rows.
 *
 * The percentile panels are the one part still linear in turns (a histogram fine enough
 * to be exact does not compress), so the decade is a second or two, not milliseconds —
 * the ceiling below says "not minutes", not "constant time".
 *
 *   pnpm -F @osm/server test:invariants
 */
import { DatabaseSync } from "node:sqlite";

const MIN = 60000;
const HOUR = 3600000;

let failures = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const MODELS = ["alpha-small", "alpha-large"];
const PROJECTS = ["proj-a", "proj-b"];
const AGENTS = ["build", "explore"];
const TOOLS = ["read", "bash"];
const SESSIONS = 12;

const LOCATION = /* sql */ `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE models (
  id TEXT PRIMARY KEY, provider TEXT, label TEXT, context INTEGER DEFAULT 128000,
  cost_input REAL DEFAULT 0, cost_output REAL DEFAULT 0,
  cost_cache_read REAL DEFAULT 0, cost_cache_write REAL DEFAULT 0
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, project TEXT, agent TEXT, model TEXT,
  created INTEGER, updated INTEGER, first_prompt TEXT, peak_fill REAL
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY, session_id TEXT, role TEXT, created INTEGER, completed INTEGER,
  dur_ms INTEGER, project TEXT, model TEXT, agent TEXT, input INTEGER, output INTEGER,
  reasoning INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL, finish TEXT,
  fill REAL, context_window INTEGER, tool_calls INTEGER, tool_errors INTEGER,
  additions INTEGER, deletions INTEGER, write_lines INTEGER, day INTEGER, hour INTEGER, bucket INTEGER
);
CREATE TABLE tools (
  id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT, name TEXT, status TEXT, dur_ms INTEGER
);
`;

const midnight = (back: number): number => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
};

/** `days` of history at `perDay` turns a day, across a fixed cast of sessions. */
function store(days: number, perDay: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(LOCATION);
  const first = midnight(days - 1);
  const insertSession = db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < SESSIONS; i++) {
    // One parent per quarter of the cast, so the grid sees a real forest, not a flat list.
    const parent = i >= 6 && i % 3 === 0 ? `gen-s${i - 6}` : null;
    insertSession.run(
      `gen-s${i}`,
      parent,
      `generated session ${i}`,
      PROJECTS[i % 2],
      AGENTS[i % 2],
      MODELS[i % 2],
      first + i * HOUR,
      first + days * 86400000,
      `generated prompt ${i}`,
      0.5
    );
  }
  const insertTurn = db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insertTool = db.prepare("INSERT INTO tools VALUES (?,?,?,?,?,?)");
  let toolId = 0;
  for (let back = days - 1; back >= 0; back--) {
    const day = midnight(back);
    for (let k = 0; k < perDay; k++) {
      const hour = 8 + (k % 12);
      const at = day + hour * HOUR + (k % 6) * 7 * MIN;
      const si = k % SESSIONS;
      const sid = `gen-s${si}`;
      const dur = 800 + ((back * 37 + k * 11) % 9000);
      const out = 60 + ((back * 13 + k * 7) % 900);
      const turnId = `${sid}-${back}-${k}`;
      insertTurn.run(
        turnId, sid, "assistant", at, at + dur, dur,
        PROJECTS[si % 2], MODELS[si % 2], AGENTS[si % 2],
        out * 5, out, 0, out * 3, 0, 0.002 + k * 0.0001,
        k % 7 === 0 ? "length" : "stop",
        0.2 + ((back + k) % 60) / 100, 128000,
        TOOLS.length, k % 11 === 0 ? 1 : 0,
        k % 4, k % 3, 0, day, hour, Math.floor(at / 300000) * 300000
      );
      for (const name of TOOLS) {
        insertTool.run(++toolId, sid, turnId, name, toolId % 23 === 0 ? "error" : "ok", dur / 2);
      }
    }
  }
  return db;
}

async function measure(days: number, perDay: number) {
  const { ensureIndexes } = await import("../metrics/schema");
  const { ensureRollups } = await import("../metrics/rollup");
  const { dashboard, sessionsPage } = await import("../metrics/analytics");
  const { MAX_COLS } = await import("../metrics/buckets");

  const db = store(days, perDay);
  // The real store is opened through `openMetrics`, which also lays down the indexes the
  // time-filtered queries lean on; a test store without them measures the wrong thing.
  ensureIndexes(db);
  ensureRollups(db);

  const now = Date.now();
  const slice = { from: 0, to: now, project: null, model: null, agent: null };
  // One warm run, then the median of three: the first call pays SQLite's statement cache.
  dashboard(db, slice);
  const times: number[] = [];
  let data: Awaited<ReturnType<typeof dashboard>> | null = null;
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    data = dashboard(db, slice);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const ms = times.sort((a, b) => a - b)[1];
  const bytes = Buffer.byteLength(JSON.stringify(data));
  const page = sessionsPage(db, slice, { limit: 100 });
  db.close();
  return { days, perDay, ms, bytes, data: data!, maxCols: MAX_COLS, rows: page.rows.length, roots: page.roots };
}

async function main() {
  const long = await measure(3650, 24);
  const short = await measure(90, 24);

  const { SESSION_SAMPLE } = await import("../metrics/analytics");

  ok(
    "a decade of history still fits the column budget",
    long.data.series.buckets.length <= long.maxCols,
    `${long.data.series.buckets.length} > ${long.maxCols}`
  );
  ok(
    "the axis is at its coarsest, not the data's finest",
    long.data.series.gran === "week" || long.data.series.gran === "month",
    long.data.series.gran
  );
  ok(
    "the session sample stays bounded",
    long.data.sessions.length <= SESSION_SAMPLE,
    `${long.data.sessions.length} > ${SESSION_SAMPLE}`
  );
  // Size tracks the number of *columns* (which is capped), not the number of days: the
  // decade has 121 weekly columns and the quarter 90 daily ones, and each column costs
  // the same handful of numbers either way.
  const perCol = (m: { bytes: number; data: { series: { buckets: unknown[] } } }) =>
    m.bytes / m.data.series.buckets.length;
  ok(
    "the payload grows with columns, not with history",
    perCol(long) <= perCol(short) * 1.2,
    `${perCol(long).toFixed(0)}B/column vs ${perCol(short).toFixed(0)}B/column`
  );
  ok(
    "the response stays small in absolute terms",
    long.bytes < 200 * 1024,
    `${(long.bytes / 1024).toFixed(0)}KB`
  );
  const total = long.data.totals.turns;
  ok(
    "no turns are silently dropped by the coarser axis",
    Math.abs(total - long.days * long.perDay) <= long.perDay,
    `${total} of ${long.days * long.perDay}`
  );

  // The page is over sessions, not days: 40x the history, the same 12 sessions.
  ok(
    "paging a decade still returns the same sessions",
    long.rows === short.rows && long.roots === short.roots,
    `${long.rows}/${long.roots} vs ${short.rows}/${short.roots}`
  );

  // Percentiles still walk the window's turns, so this is a ceiling rather than a
  // comparison: a decade must not turn one page load into a coffee break.
  ok(
    "a decade answers in seconds, not in proportion to its rows",
    long.ms < 3000,
    `${long.ms.toFixed(0)}ms for ${(long.days * long.perDay).toLocaleString()} turns (a quarter: ${short.ms.toFixed(0)}ms)`
  );
  console.log(
    `\n  ${(long.days / 365).toFixed(1)} years · ${(long.days * long.perDay).toLocaleString()} turns · ` +
      `${long.data.series.buckets.length} columns · ${(long.bytes / 1024).toFixed(0)}KB · ${long.ms.toFixed(0)}ms`
  );
  console.log(
    `  ${(short.days / 30).toFixed(0)} months · ${(short.days * short.perDay).toLocaleString()} turns · ` +
      `${short.data.series.buckets.length} columns · ${(short.bytes / 1024).toFixed(0)}KB · ${short.ms.toFixed(0)}ms`
  );

  console.log(failures ? `\n${failures} check(s) failed` : "\nall invariant checks passed");
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
