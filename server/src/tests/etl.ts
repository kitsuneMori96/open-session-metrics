/**
 * Offline ETL tests: a synthetic OpenCode v2 database is materialized and the
 * invariants the cockpit relies on are asserted (no server, no network).
 *
 *   pnpm -F @osm/server test
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "osm-etl-"));
process.env.OSM_DATA_DIR = dir;
process.env.OSM_OFFLINE = "1";
process.env.OSM_SOURCE_DB = path.join(dir, "source.db");

let failures = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const T0 = 1790000000000;
const MIN = 60000;

function seed() {
  const db = new DatabaseSync(process.env.OSM_SOURCE_DB!);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT);
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT,
      agent TEXT, model TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
    CREATE TABLE part (message_id TEXT, session_id TEXT, data TEXT);
    INSERT INTO project VALUES ('p1', null, '/tmp/demo');
    INSERT INTO session_v2 VALUES
      ('ses_parent', 'p1', null, '重构索引', '/tmp/demo', null,
       '{"providerID":"demo","id":"model-a"}', 0, 0,0,0,0,0, null,null,null, ${T0}, ${T0 + 9 * MIN}),
      ('ses_child', 'p1', 'ses_parent', '子代理', '/tmp/demo', 'build',
       '{"providerID":"demo","id":"model-a"}', 0, 0,0,0,0,0, null,null,null, ${T0 + 5 * MIN}, ${T0 + 8 * MIN});
  `);
  const ins = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)");
  let seq = 0;
  const msg = (sid: string, type: string, at: number, data: any) =>
    ins.run(`m${seq}`, sid, type, seq++, at, at, JSON.stringify(data));

  msg("ses_parent", "user", T0, { time: { created: T0 }, text: "帮我重构一下数据库的索引" });

  // turn 1: healthy assistant turn with two distinct tool calls
  msg("ses_parent", "assistant", T0 + MIN, {
    time: { created: T0 + MIN, completed: T0 + MIN + 30000 },
    model: { id: "model-a", providerID: "demo" },
    tokens: { input: 1000, output: 500, reasoning: 100, cache: { read: 50000, write: 0 } },
    finish: "tool-calls",
    content: [
      { type: "tool", id: "c1", name: "read", state: { status: "completed", input: { filePath: "/b.ts" }, time: { start: T0 + MIN, end: T0 + MIN + 1000 } } },
      { type: "tool", id: "c2", name: "bash", state: { status: "completed", input: { command: "ls" }, time: { start: T0 + MIN + 1000, end: T0 + MIN + 2000 } } },
    ],
  });

  // turn 2: identical read repeated 3x in a row → loop probe, but no retry
  // (nothing failed, so it is not a retry)
  for (let i = 0; i < 3; i++) {
    const at = T0 + (2 + i) * MIN;
    msg("ses_parent", "assistant", at, {
      time: { created: at, completed: at + 5000 },
      model: { id: "model-a", providerID: "demo" },
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 60000, write: 0 } },
      finish: "tool-calls",
      content: [{ type: "tool", id: `loop${i}`, name: "read", state: { status: "completed", input: { filePath: "/a.ts" }, time: { start: at, end: at + 1000 } } }],
    });
  }

  // compaction right after the loop
  const atCompaction = T0 + 6 * MIN;
  msg("ses_parent", "compaction", atCompaction, {
    time: { created: atCompaction },
    status: "completed",
    reason: "auto",
    summary: "## Objective\n- keep going",
  });

  // turn 3: after compaction the context must drop
  msg("ses_parent", "assistant", T0 + 7 * MIN, {
    time: { created: T0 + 7 * MIN, completed: T0 + 7 * MIN + 20000 },
    model: { id: "model-a", providerID: "demo" },
    tokens: { input: 800, output: 400, reasoning: 0, cache: { read: 2000, write: 0 } },
    finish: "stop",
    content: [{ type: "tool", id: "c3", name: "edit", state: { status: "completed", input: { filePath: "/a.ts" }, metadata: { files: [{ file: "/a.ts", additions: 12, deletions: 3 }] }, time: { start: T0 + 7 * MIN, end: T0 + 7 * MIN + 900 } } }],
  });

  // turn 4: bash fails, then the same command is re-issued → retry probe
  const atFail = T0 + 8 * MIN;
  msg("ses_parent", "assistant", atFail, {
    time: { created: atFail, completed: atFail + 3000 },
    model: { id: "model-a", providerID: "demo" },
    tokens: { input: 900, output: 200, reasoning: 0, cache: { read: 2000, write: 0 } },
    finish: "tool-calls",
    content: [{ type: "tool", id: "f1", name: "bash", state: { status: "error", input: { command: "npm run build" }, error: { message: "exit 1" }, time: { start: atFail, end: atFail + 2000 } } }],
  });
  const atRetry = T0 + 9 * MIN;
  msg("ses_parent", "assistant", atRetry, {
    time: { created: atRetry, completed: atRetry + 3000 },
    model: { id: "model-a", providerID: "demo" },
    tokens: { input: 900, output: 200, reasoning: 0, cache: { read: 2000, write: 0 } },
    finish: "stop",
    content: [{ type: "tool", id: "f2", name: "bash", state: { status: "completed", input: { command: "npm run build" }, time: { start: atRetry, end: atRetry + 4000 } } }],
  });

  // child session: a task spawn + one healthy turn
  msg("ses_child", "user", T0 + 5 * MIN, { time: { created: T0 + 5 * MIN }, text: "子任务" });
  msg("ses_child", "assistant", T0 + 6 * MIN, {
    time: { created: T0 + 6 * MIN, completed: T0 + 6 * MIN + 10000 },
    model: { id: "model-a", providerID: "demo" },
    tokens: { input: 300, output: 700, reasoning: 0, cache: { read: 100, write: 0 } },
    finish: "stop",
    content: [{ type: "tool", id: "t1", name: "task", state: { status: "completed", input: { sessionID: "ses_child" }, time: { start: T0 + 5 * MIN, end: T0 + 6 * MIN } } }],
  });
  db.close();
}

async function main() {
  seed();
  const { build } = await import("../metrics/build");
  const { current } = await import("../metrics/store");
  const { SourceReader } = await import("../source");

  // ---- full build ----
  const db = current();
  const report = await build(db, { mode: "full" });
  ok("full build materializes both sessions", report.sessions === 2, `got ${report.sessions}`);
  ok("source schema detected as v2", report.schema === "v2");

  const rows = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
  const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;

  const src = new SourceReader(process.env.OSM_SOURCE_DB!);
  const srcCompactions = src.events().filter((e) => e.type === "compaction").length;
  src.close();
  const metricCompactions = rows("SELECT * FROM events WHERE type='compaction'").length;
  ok("compaction events align with the source", srcCompactions === metricCompactions && metricCompactions === 1);

  const fills = rows("SELECT fill, fill_after FROM turns WHERE role='assistant'").map((r) => [r.fill, r.fill_after]);
  ok("fill stays within [0,1]", fills.every(([f, fa]) => f >= 0 && f <= 1 && fa >= f));

  const beforeAfter = one("SELECT detail, fill FROM events WHERE type='compaction'");
  const detail = JSON.parse(beforeAfter.detail);
  ok("compaction carries before/after context", typeof detail.before === "number" && typeof detail.after === "number" && detail.after < detail.before,
    JSON.stringify(detail));
  ok("compaction event carries the fill of the preceding turn", Math.abs(beforeAfter.fill - 61000 / 128000) < 1e-6, `fill=${beforeAfter.fill}`);

  const retries = rows("SELECT * FROM events WHERE type='retry'");
  const loops = rows("SELECT * FROM events WHERE type='loop'");
  ok("identical reads are not counted as retries", retries.length === 1, `got ${retries.length}`);
  ok("failed-then-retried command is one retry", retries.length === 1 && JSON.parse(retries[0].detail).tool === "bash");
  ok("3 identical calls in a row form a loop", loops.length === 1 && JSON.parse(loops[0].detail).repeats === 3, `got ${loops.length}`);

  const failureEvents = rows("SELECT * FROM events WHERE type='failure'");
  ok("tool error becomes a failure probe", failureEvents.length === 1);

  const s1 = one("SELECT * FROM sessions WHERE id='ses_parent'");
  ok("session aggregates retries/loops/compactions", s1.retries === 1 && s1.loops === 1 && s1.compactions === 1,
    JSON.stringify({ retries: s1.retries, loops: s1.loops, compactions: s1.compactions }));
  ok("per-turn diff stats are picked up", s1.additions === 12 && s1.deletions === 3, JSON.stringify({ a: s1.additions, d: s1.deletions }));
  ok("first prompt is captured", /重构/.test(s1.first_prompt ?? ""));

  const flow = rows("SELECT * FROM flow WHERE project='/tmp/demo' OR project='demo'");
  ok("ECG flow cells exist", flow.length > 0, `got ${flow.length}`);
  ok("flow keeps generation and cache separate", flow.every((f) => typeof f.tokens_gen === "number" && typeof f.tokens_cache_read === "number"));
  ok("flow cells carry a dominant model", flow.every((f) => f.dominant_model === "model-a"), flow[0]?.dominant_model);

  const heat = rows("SELECT * FROM heat");
  ok("circadian heat has day+hour keys", heat.length > 0 && heat.every((h) => h.day > 0 && h.hour >= 0 && h.hour < 24), JSON.stringify(heat[0]));

  const tool = one("SELECT * FROM tools WHERE name='task'");
  ok("task tool records its target session", tool.target_session === "ses_child");

  // ---- conversion coverage ----
  const withDiff = rows("SELECT COUNT(*) c FROM sessions WHERE additions+deletions > 0")[0].c;
  const total = rows("SELECT COUNT(*) c FROM sessions")[0].c;
  ok("conversion coverage is countable", total === 2 && withDiff === 1, JSON.stringify({ total, withDiff }));

  // ---- incremental: touch one message, expect only that session re-materialized ----
  const src2 = new SourceReader(process.env.OSM_SOURCE_DB!);
  const watermark = src2.maxMessageTime();
  const changed = src2.changedSessions(watermark);
  ok("no change → no dirty sessions", changed.size === 0, `got ${changed.size}`);
  src2.close();

  const w = new DatabaseSync(process.env.OSM_SOURCE_DB!);
  const at = T0 + 12 * MIN;
  w.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run(
    "m_extra", "ses_child", "assistant", 999, at, at,
    JSON.stringify({
      time: { created: at, completed: at + 4000 },
      model: { id: "model-a", providerID: "demo" },
      tokens: { input: 200, output: 300, reasoning: 0, cache: { read: 50, write: 0 } },
      finish: "stop",
      content: [],
    })
  );
  w.close();

  const src3 = new SourceReader(process.env.OSM_SOURCE_DB!);
  const dirty = src3.changedSessions(watermark);
  const incReport = await build(db, { mode: "incremental", sessionIds: dirty });
  src3.close();
  ok("incremental rebuild touches only the dirty session", incReport.sessions === 1, `got ${incReport.sessions}`);
  ok("incremental rebuild is fast", incReport.ms < 1500, `${incReport.ms}ms`);
  const child = one("SELECT turns FROM sessions WHERE id='ses_child'");
  ok("incremental rebuild updated the child turns", child.turns === 2, `got ${child.turns}`);
  ok("no duplicate turns after incremental", rows("SELECT COUNT(*) c FROM turns")[0].c === 11, `got ${rows("SELECT COUNT(*) c FROM turns")[0].c}`);

  const heatAfter = rows("SELECT SUM(turns) t FROM heat")[0].t;
  ok("heat aggregates the new turn", heatAfter === 9, `got ${heatAfter}`);

  console.log(failures ? `\n${failures} check(s) failed` : "\nall ETL checks passed");
  rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

void main();
