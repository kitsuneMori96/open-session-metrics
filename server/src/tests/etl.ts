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
      { type: "reasoning", text: "先确认索引现在的定义" },
      { type: "text", text: "我先看一下索引定义。" },
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

  // turn 5: the v2-native shape — the diff lives in `metadata.filediff.patch`, and a
  // full-file `write` carries its body in `input.content` (counted as lines, not a diff).
  const atPatch = T0 + 10 * MIN;
  msg("ses_parent", "assistant", atPatch, {
    time: { created: atPatch, completed: atPatch + 4000 },
    model: { id: "model-a", providerID: "demo" },
    tokens: { input: 500, output: 150, reasoning: 0, cache: { read: 2000, write: 0 } },
    finish: "tool-calls",
    content: [
      {
        type: "tool", id: "v1", name: "edit",
        state: {
          status: "completed",
          input: { filePath: "/b.ts", oldString: "old line", newString: "new line" },
          metadata: {
            filediff: {
              file: "/b.ts",
              patch: [
                "Index: /b.ts",
                "===================================================================",
                "--- /b.ts",
                "+++ /b.ts",
                "@@ -1,4 +1,6 @@",
                " context",
                "-old line",
                "-old line 2",
                "+new line",
                "+new line 2",
                "+extra",
                "+extra2",
              ].join("\n"),
            },
          },
        },
      },
      { type: "tool", id: "v2", name: "write", state: { status: "completed", input: { filePath: "/c.ts", content: "a\nb\nc" } } },
    ],
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

  // A layout change must force a full rebuild: `CREATE TABLE IF NOT EXISTS` cannot add a
  // column, so silently incremental-building into an old file would throw on insert.
  const { SCHEMA_SIG } = await import("../metrics/schema");
  ok("schema signature is recorded", one("SELECT value FROM meta WHERE key='schemaSig'")?.value === SCHEMA_SIG);

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
  const legacyEdit = one("SELECT additions, deletions FROM tools WHERE call_id='c3'");
  ok("legacy `metadata.files` diffs still parse", legacyEdit.additions === 12 && legacyEdit.deletions === 3, JSON.stringify(legacyEdit));
  ok("first prompt is captured", /重构/.test(s1.first_prompt ?? ""));

  // ---- v2 patch shape (the bug that made every output metric read as zero) ----
  const patchedTurn = one("SELECT additions, deletions, write_lines FROM turns WHERE id=(SELECT turn_id FROM tools WHERE call_id='v1')");
  ok("unified diff in metadata.filediff.patch yields additions/deletions", patchedTurn.additions === 4 && patchedTurn.deletions === 2,
    JSON.stringify(patchedTurn));
  ok("full-file write is counted in lines, never as a diff", patchedTurn.write_lines === 3, JSON.stringify(patchedTurn));
  ok("v2 edit/write sum into the session without double counting", s1.additions === 16 && s1.deletions === 5,
    JSON.stringify({ a: s1.additions, d: s1.deletions }));
  const writeTool = one("SELECT * FROM tools WHERE name='write'");
  ok("tool row keeps write lines separate from additions", writeTool.write_lines === 3 && writeTool.additions === 0,
    JSON.stringify({ w: writeTool.write_lines, a: writeTool.additions }));

  // ---- transcript parts: what the messages panel walks ----
  const allParts = rows("SELECT * FROM parts ORDER BY id");
  ok("transcript parts materialize", allParts.length > 0, `got ${allParts.length}`);
  const partKinds = new Set(allParts.map((p) => p.kind));
  ok("parts keep all three content kinds", partKinds.has("tool") && partKinds.has("text") && partKinds.has("reasoning"),
    [...partKinds].join(","));
  const firstTurn = one("SELECT id FROM turns WHERE session_id='ses_parent' AND role='assistant' ORDER BY created LIMIT 1");
  const firstTurnParts = rows("SELECT * FROM parts WHERE turn_id=? ORDER BY ordinal", firstTurn.id);
  ok("a turn's parts keep their content order", firstTurnParts.map((p) => p.kind).join(",") === "reasoning,text,tool,tool",
    firstTurnParts.map((p) => p.kind).join(","));
  const failPart = one("SELECT * FROM parts WHERE kind='tool' AND name='bash' AND status='error'");
  ok("a failed tool part carries its output", /exit 1/.test(failPart?.output ?? ""), JSON.stringify(failPart));
  const editPart = one("SELECT * FROM parts WHERE kind='tool' AND name='edit' AND input LIKE '%oldString%'");
  ok("a tool part keeps its input JSON", !!editPart, JSON.stringify(editPart));
  ok("session records a median output rate", s1.output_rate > 0, `got ${s1.output_rate}`);

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
  ok("no duplicate turns after incremental", rows("SELECT COUNT(*) c FROM turns")[0].c === 12, `got ${rows("SELECT COUNT(*) c FROM turns")[0].c}`);

  const heatAfter = rows("SELECT SUM(turns) t FROM heat")[0].t;
  ok("heat aggregates the new turn", heatAfter === 10, `got ${heatAfter}`);

  // ---- distribution machinery (S0): indexes and binned quantiles ----
  const toolIdx = one("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='tools_turn'");
  ok("tools are indexed by turn, so a time-filtered join never scans the tool table", toolIdx.c === 1);

  const { ladder, histogramOf, quantile, mergeHistograms, histogramCount } = await import("../metrics/histogram");
  const values = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765, 10946];
  const binned = histogramOf(values.map((v) => ({ bin: Number((Math.log2(v + 1) * 128) | 0), n: 1 })));
  ok("every binned value is counted", histogramCount(binned) === values.length);
  const p50 = quantile(binned, 0.5, ladder.ms);
  const truth = values[Math.round(0.5 * (values.length - 1))];
  ok("binned median is within 1% of the exact median", Math.abs(p50 - truth) / truth < 0.01, `${p50} vs ${truth}`);
  const p95 = quantile(binned, 0.95, ladder.ms);
  ok("binned p95 sits between the median and the maximum", p95 >= p50 && p95 <= values[values.length - 1] * 1.01,
    `${p95}`);
  ok("a quantile never exceeds an exact maximum", quantile(binned, 1, ladder.ms, 5) === 5);

  const joined = mergeHistograms(new Map([[1, 2]]), new Map([[1, 3], [2, 1]]));
  ok("histograms add up, which is what a day rollup needs", joined.get(1) === 5 && joined.get(2) === 1);
  ok("fill uses a share ladder, not milliseconds",
    ladder.share.key("fill").includes("/ 0.002") && ladder.ms.key("dur").includes("log2"));

  // ---- the axis ladder (S1): bounded columns, real calendar edges ----
  const {
    MAX_COLS, GRANULARITIES, pickGranularity, bucketCount, bucketStarts,
    bucketKeySql, bucketIndexer, bucketStart, calendarKey,
  } = await import("../metrics/buckets");
  const HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
  const decadeFrom = new Date(2016, 0, 15, 12, 0, 0).getTime();
  const decadeTo = new Date(2026, 9, 20, 12, 0, 0).getTime();

  const fit = (g: string) => bucketCount(decadeFrom, decadeTo, g as never) <= MAX_COLS;
  ok("a decade cannot be drawn weekly within the column budget", !fit("week"));
  ok("auto answers a decade monthly", pickGranularity(decadeFrom, decadeTo) === "month");
  ok("every auto answer fits the budget",
    GRANULARITIES.every((g) => g !== pickGranularity(decadeFrom, decadeTo) || fit(g)));
  ok("auto keeps hourly for three days", pickGranularity(decadeTo - 3 * DAY_MS, decadeTo) === "hour");
  ok("auto keeps daily up to half a year", pickGranularity(decadeTo - 180 * DAY_MS, decadeTo) === "day");
  ok("an explicit five minutes is honoured when it fits",
    pickGranularity(decadeTo - 6 * HOUR_MS, decadeTo, "5m") === "5m");
  ok("an explicit five minutes over a decade is coarsened, never shipped",
    pickGranularity(decadeFrom, decadeTo, "5m") === "month");
  ok("an explicit year is honoured when coarser than auto",
    pickGranularity(decadeFrom, decadeTo, "year") === "year");

  ok("months start on the first, not on 30-day steps",
    new Date(bucketStart(new Date(2024, 1, 10, 23, 0).getTime(), "month")).getDate() === 1);
  ok("quarters start in Jan/Apr/Jul/Oct",
    [0, 3, 6, 9].every((m) => new Date(bucketStart(new Date(2024, m + 1, 5).getTime(), "quarter")).getMonth() === m));
  ok("a month column maps back to itself",
    bucketStarts(decadeFrom, decadeTo, "month").every((ts, i) =>
      bucketIndexer("month", bucketStarts(decadeFrom, decadeTo, "month"))(calendarKey(ts, "month")) === i));

  // The SQL key and the JS axis must name the same bucket for every unit, or a column
  // would silently receive another column's totals.
  const probe = new DatabaseSync(":memory:");
  probe.exec("CREATE TABLE turns (created INTEGER, day INTEGER, bucket INTEGER)");
  const stamps = [
    new Date(2024, 4, 15, 13, 42).getTime(),
    new Date(2024, 1, 29, 23, 59).getTime(),
    new Date(2023, 11, 31, 0, 3).getTime(),
  ];
  for (const ts of stamps) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    probe.prepare("INSERT INTO turns VALUES (?,?,?)").run(ts, d.getTime(), Math.floor(ts / 300000) * 300000);
  }
  for (const g of GRANULARITIES) {
    const keys = probe.prepare(`SELECT ${bucketKeySql(g)} k FROM turns t`).all() as { k: number | string }[];
    const calendar = g === "month" || g === "quarter" || g === "year";
    const same = keys.every((row, i) => {
      const start = bucketStart(stamps[i], g);
      return calendar ? String(row.k) === calendarKey(start, g) : Number(row.k) === start;
    });
    ok(`${g}: the SQL bucket key agrees with the axis`, same, JSON.stringify(keys));
  }

  // ---- session paging (S2): the grid's page must be a forest, exact and cheap ----
  //
  // sessions() carries a bounded sample to the dashboard; the Sessions screen walks the
  // rest here. What makes that honest is that a page is never a flat slice of rows: it
  // carries whole subtrees, and a text filter keeps the ancestors of a match.
  const { sessionsPage, sessionContext } = await import("../metrics/analytics");
  const pg = new DatabaseSync(":memory:");
  pg.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, project TEXT, agent TEXT, model TEXT,
      created INTEGER, updated INTEGER, first_prompt TEXT, peak_fill REAL
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY, session_id TEXT, role TEXT, created INTEGER, completed INTEGER,
      input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL,
      tool_calls INTEGER, tool_errors INTEGER, context_window INTEGER
    );
  `);
  const put = (id: string, parent: string | null, title: string, tokens: number, turns = 1) => {
    pg.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      id, parent, title, "demo", "main", "model-a", T0, T0 + tokens, title, 0
    );
    for (let i = 0; i < turns; i++) {
      pg.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        `${id}_t${i}`, id, "assistant", T0 + i, T0 + i + 500, tokens, 0, 0, 0, 0, 1, 0, 128000
      );
    }
  };
  put("A", null, "root alpha", 100, 3);   // 3 turns, 300 tokens
  put("A1", "A", "child of alpha", 900);
  put("A1g", "A1", "grandchild", 50);
  put("B", null, "root beta", 500);
  put("C", "ghost", "parent outside the slice", 10);
  put("D", null, "root delta", 20);
  put("E", null, "root epsilon", 5);

  const all = { from: T0 - 1, to: T0 + 10000, project: null, model: null, agent: null };
  const p1 = sessionsPage(pg, all, { limit: 2 });
  const seen = new Set(p1.rows.map((r) => r.id));
  const rootOrder = () => {
    const ids = new Set(p1.rows.map((r) => r.id));
    return p1.rows.filter((r) => !r.parentId || !ids.has(r.parentId)).map((r) => r.id);
  };
  ok("a page carries the subtree under each of its roots", seen.has("A") && seen.has("A1") && seen.has("A1g"),
    [...seen].join(","));
  ok("paging walks roots, not rows", p1.roots === 5 && p1.rows.length === 4, `roots=${p1.roots} rows=${p1.rows.length}`);

  const p2 = sessionsPage(pg, all, { limit: 2, cursor: p1.next });
  const two = [...p1.rows, ...p2.rows];
  const twoIds = new Set(two.map((r) => r.id));
  const twoRoots = two.filter((r) => !r.parentId || !twoIds.has(r.parentId)).map((r) => r.id);
  ok("a session whose parent is outside the slice is a root", twoRoots.includes("C"), twoRoots.join(","));
  const overlap = p2.rows.filter((r) => seen.has(r.id));
  ok("the cursor resumes where the page stopped", overlap.length === 0, `overlap=${overlap.length}`);
  // Five roots at two per page: the second page is full *and* there is a root after it,
  // so the server has to look one root ahead to know the difference.
  ok("a full page with more behind it keeps the cursor", p2.next !== null && p2.rows.map((r) => r.id).sort().join(",") === "C,D",
    `rows=${p2.rows.map((r) => r.id).join(",")} next=${p2.next}`);
  const p3 = sessionsPage(pg, all, { limit: 2, cursor: p2.next });
  ok("the probe root is the next page, not part of this one", p3.rows.map((r) => r.id).join(",") === "E",
    p3.rows.map((r) => r.id).join(","));
  ok("the last page ends the walk instead of promising an empty one", p3.next === null, `next=${p3.next}`);
  const every = new Set([...two, ...p3.rows].map((r) => r.id));
  ok("three pages cover every session exactly once", every.size === 7, [...every].join(","));

  const heavy = sessionsPage(pg, all, { limit: 4 });
  ok("a page can be sorted by an aggregate", heavy.rows[0].id === "A1", heavy.rows[0].id);

  const hit = sessionsPage(pg, all, { limit: 10, q: "grandchild" });
  ok("a text filter keeps the ancestors of a match",
    hit.rows.map((r) => r.id).sort().join(",") === "A,A1,A1g", hit.rows.map((r) => r.id).join(","));
  ok("the filter reports what it matched, ancestors included", hit.matching === 3 && hit.roots === 1,
    `matching=${hit.matching} roots=${hit.roots}`);
  ok("totals describe the filtered set, not the visible page",
    hit.totals.sessions === 3 && hit.totals.tokens === 1250, JSON.stringify(hit.totals));

  const tiny = sessionsPage(pg, all, { limit: 0 });
  ok("a page is never empty by request", tiny.rows.length >= 1 && tiny.rows.length <= 2, String(tiny.rows.length));

  const fam = sessionContext(pg, all, "A1g");
  ok("a session's context is itself plus its family",
    fam.map((r) => r.id).sort().join(",") === "A,A1,A1g", fam.map((r) => r.id).join(","));
  pg.close();

  // ---- day rollups (S3): the fast path has to answer exactly like the raw one ----
  //
  // Every panel above a wide window can be summed from (session, day) cells instead of
  // from half a million turns. That is only allowed to be a faster *route* to the same
  // numbers, so this builds a small multi-day store, renders the dashboard twice — once
  // from the cells, once with the cells disabled (no version key) — and diffs the JSON.
  const { ensureRollups } = await import("../metrics/rollup");
  const { dashboard } = await import("../metrics/analytics");
  const rr = new DatabaseSync(":memory:");
  rr.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
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
  `);
  const D0 = new Date(2024, 4, 6).getTime(); // a Monday, local midnight
  const HOUR = 3600000;
  let toolId = 0;
  const addTurn = (sid: string, at: number, model: string, project: string, agent: string, dur: number, out: number) => {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    const turnId = `${sid}_${at}`;
    rr.prepare(
      `INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      turnId, sid, "assistant", at, at + dur, dur, project, model, agent,
      out * 4, out, 0, out * 2, 0, 0.01, at % 3 === 0 ? "length" : "stop",
      0.42, 128000, 1, at % 5 === 0 ? 1 : 0, 2, 1, 0, d.getTime(), d.getHours(), Math.floor(at / 300000) * 300000
    );
    for (let k = 0; k < 2; k++) {
      rr.prepare("INSERT INTO tools VALUES (?,?,?,?,?,?)").run(++toolId, sid, turnId, k ? "bash" : "read", k ? "error" : "ok", dur * (k + 1));
    }
  };
  const addSession = (sid: string, parent: string | null, project: string, model: string, agent: string, created: number) => {
    rr.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      sid, parent, `session ${sid}`, project, agent, model, created, created + 3 * HOUR, `first prompt ${sid}`, 0.5
    );
  };
  const MODELS = ["model-a", "model-b"];
  const PROJECTS = ["alpha", "beta"];
  const AGENTS = ["build", "explore"];
  for (const [si, sid] of ["s1", "s2", "s3", "s4"].entries()) {
    addSession(sid, si === 3 ? "s1" : null, PROJECTS[si % 2], MODELS[si % 2], AGENTS[si % 2], D0 + si * HOUR);
    for (let day = 0; day < 4; day++) {
      for (let h = 0; h < 6; h++) {
        addTurn(sid, D0 + day * 24 * HOUR + (7 + h) * HOUR + si * 60000, MODELS[si % 2], PROJECTS[si % 2], AGENTS[si % 2], 1000 + day * 200 + h, 100 + h);
      }
    }
  }
  ensureRollups(rr);

  const strip = (o: unknown): string => JSON.stringify(o, (k, v) => (k === "generatedAt" ? 0 : v));
  const windows: [string, { from: number; to: number; project: string | null; model: string | null; agent: string | null }][] = [
    ["all time", { from: 0, to: D0 + 4 * 24 * HOUR, project: null, model: null, agent: null }],
    ["whole days", { from: D0, to: D0 + 3 * 24 * HOUR, project: null, model: null, agent: null }],
    ["cut at both ends", { from: D0 + 9 * HOUR, to: D0 + 2 * 24 * HOUR + 15 * HOUR, project: null, model: null, agent: null }],
    ["one project", { from: 0, to: D0 + 4 * 24 * HOUR, project: "alpha", model: null, agent: null }],
    ["one model on a sub-agent", { from: 0, to: D0 + 4 * 24 * HOUR, project: null, model: "model-b", agent: "explore" }],
  ];
  const fast = windows.map(([, w]) => strip(dashboard(rr, w)));
  // Deleting the version key makes `rollupsReady` false; the same queries then run on turns.
  rr.exec("DELETE FROM meta WHERE key = 'rollVersion'");
  const slow = windows.map(([, w]) => strip(dashboard(rr, w)));
  for (const [i, [label]] of windows.entries()) {
    ok(`rollups agree with the raw scan (${label})`, fast[i] === slow[i],
      fast[i] === slow[i] ? "" : `${fast[i]?.length} vs ${slow[i]?.length} chars`);
  }
  const freq = (json: string) => JSON.parse(json);
  const rolled = freq(fast[0]);
  ok("a rolled-up window still counts sessions once", rolled.totals.sessions === 4, String(rolled.totals.sessions));
  const daySeries = freq(strip(dashboard(rr, { from: 0, to: D0 + 4 * 24 * HOUR, project: null, model: null, agent: null })));
  ok("every day column receives its turns", daySeries.series.buckets.reduce((a: number, b: any) => a + b.turns, 0) === 96,
    String(daySeries.series.buckets.reduce((a: number, b: any) => a + b.turns, 0)));
  ok("the heatmap sums to the same turns", daySeries.series.heat.flat().reduce((a: number, b: number) => a + b, 0) === 96,
    String(daySeries.series.heat.flat().reduce((a: number, b: number) => a + b, 0)));
  ok("tool percentiles survive the rollup", daySeries.tools.every((t: any) => t.p50Ms > 0 && t.p95Ms >= t.p50Ms), JSON.stringify(daySeries.tools[0]));
  rr.close();

  console.log(failures ? `\n${failures} check(s) failed` : "\nall ETL checks passed");
  rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

void main();
