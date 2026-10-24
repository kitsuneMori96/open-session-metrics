/**
 * Qoder JSONL source tests.
 *
 * A synthetic transcript is written to a temp `~/.qoder` tree and materialized
 * through the same `build()` the server uses. The fixture encodes the two format
 * traps that make a naive parser wrong:
 *
 *   - one response is split across several `assistant` rows and only the last one
 *     carries `usage` (so turns must be grouped by `message.id`);
 *   - a block can repeat across those rows (so tool calls must be deduped by id).
 *
 *   pnpm -F @osm/server test
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let failures = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "osm-qoder-"));
process.env.OSM_DATA_DIR = path.join(dir, "data");
process.env.OSM_QODER_HOME = path.join(dir, "qoder");
process.env.OSM_SOURCE = "qoder";
process.env.OSM_OFFLINE = "1";

const sid = "11111111-2222-3333-4444-555555555555";
const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const iso = (ts: number) => new Date(ts).toISOString();
const sec = 1000;

function seed() {
  const projects = path.join(process.env.OSM_QODER_HOME!, "projects", "-tmp-demo");
  mkdirSync(projects, { recursive: true });
  const lines: string[] = [];
  const push = (e: unknown) => lines.push(JSON.stringify(e));

  const base = { sessionId: sid, cwd: "/tmp/demo", version: "1.1.76" };

  push({ ...base, type: "runtime-config", model: "qfmodel", contextWindow: 200000, timestamp: T0 });
  push({ ...base, type: "ai-title", aiTitle: "Qoder demo" });
  push({ ...base, type: "workspace-directories", directories: ["/tmp/demo"] });

  // prompt
  push({
    ...base, type: "user", uuid: "u1", timestamp: iso(T0 + 1 * sec),
    message: { role: "user", content: "请重构索引" },
  });

  // one response, four rows: thinking / text / tool_use / usage(+duplicate tool_use)
  const m1 = "chatcmpl-m1";
  const assistant = (id: string, at: number, content: unknown[], usage?: unknown) =>
    push({
      ...base, type: "assistant", uuid: `${id}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: iso(at), parentUuid: "u1",
      message: { id, model: "qfmodel", stop_reason: usage ? "tool_use" : null, content, usage },
    });

  assistant(m1, T0 + 10 * sec, [{ type: "thinking", thinking: "先看索引定义" }]);
  assistant(m1, T0 + 10 * sec, [{ type: "text", text: "我先读一下文件。" }]);
  assistant(m1, T0 + 10 * sec, [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/tmp/demo/a.ts" } }]);
  assistant(
    m1, T0 + 10 * sec,
    [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/tmp/demo/a.ts" } }],
    { input_tokens: 0, output_tokens: 0, credits: 0.25, original_credits: 0.25, context_usage_ratio: 0.5, request_id: "r1" }
  );
  push({
    ...base, type: "user", uuid: "u2", timestamp: iso(T0 + 12 * sec),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", is_error: false, content: "1 export const x = 1" }] },
  });

  // second turn: a failing Bash call, and a context drop (0.5 → 0.2) = compaction
  const m2 = "chatcmpl-m2";
  assistant(m2, T0 + 30 * sec, [{ type: "text", text: "跑一下测试。" }]);
  assistant(
    m2, T0 + 30 * sec,
    [{ type: "tool_use", id: "c2", name: "Bash", input: { command: "npm test", description: "run tests" } }],
    { input_tokens: 0, output_tokens: 0, credits: 0.1, original_credits: 0.1, context_usage_ratio: 0.2, request_id: "r2" }
  );
  push({
    ...base, type: "user", uuid: "u3", timestamp: iso(T0 + 31 * sec),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", is_error: true, content: "exit 1" }] },
  });

  // third turn: context climbs again, no compaction
  const m3 = "chatcmpl-m3";
  assistant(
    m3, T0 + 50 * sec,
    [{ type: "text", text: "修好了。" }],
    { input_tokens: 0, output_tokens: 0, credits: 0.05, original_credits: 0.05, context_usage_ratio: 0.6, request_id: "r3" }
  );

  // a `<synthetic>` row: not a model and not a bill, but it is a turn
  push({
    ...base, type: "assistant", uuid: "syn-1", timestamp: iso(T0 + 55 * sec),
    message: { id: "chatcmpl-syn", model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "（压缩提示）" }], usage: null },
  });

  writeFileSync(path.join(projects, `${sid}.jsonl`), lines.join("\n") + "\n", "utf8");

  // A delegated agent writes its own transcript under the parent's id; its rows
  // bill to the parent and must not become a session of their own.
  const subDir = path.join(projects, sid, "subagents");
  mkdirSync(subDir, { recursive: true });
  const sub = [
    JSON.stringify({
      ...base, type: "assistant", uuid: "sub-a1", timestamp: iso(T0 + 70 * sec),
      message: {
        id: "chatcmpl-sub1", model: "qfmodel", stop_reason: "end_turn",
        content: [{ type: "text", text: "子代理完成了检索。" }],
        usage: { input_tokens: 0, output_tokens: 0, credits: 0.1, original_credits: 0.1, context_usage_ratio: 0.3, request_id: "r4" },
      },
    }),
  ];
  writeFileSync(path.join(subDir, "agent-aExplore-abc.jsonl"), sub.join("\n") + "\n", "utf8");
}

async function main() {
  seed();
  const { build } = await import("../metrics/build");
  const { current } = await import("../metrics/store");
  const { QoderSource } = await import("../source-qoder");

  // ---- reader in isolation ----
  const src = new QoderSource(path.join(process.env.OSM_QODER_HOME!, "projects"));
  const sessions = src.sessions();
  ok("one transcript becomes one session", sessions.length === 1, `got ${sessions.length}`);
  const raw = src.turns();
  const assistantRaw = raw.filter((t) => t.role === "assistant");
  ok("split assistant rows collapse into one turn per message.id", assistantRaw.length === 4, `got ${assistantRaw.length}`);
  ok("a <synthetic> notice stays a system turn", raw.some((t) => t.role === "system" && t.text.includes("压缩提示")));
  ok("a subagent transcript merges into its parent session", raw.every((t) => t.sessionId === sid));
  ok("a block repeated across rows is deduped", assistantRaw[0].tools.length === 1, `got ${assistantRaw[0].tools.length}`);
  ok("model alias resolves to the shipped name", sessions[0].model === "Qwen3.8-Flash", String(sessions[0].model));
  ok("a <synthetic> row does not pollute the model name", !sessions[0].model?.includes("synthetic"), String(sessions[0].model));
  ok("credits survive as integer micro-credits", sessions[0].creditsMicro === 500000, String(sessions[0].creditsMicro));
  ok("missing tool results are not errors", assistantRaw[2].tools.length === 0);
  const window = Date.now();
  ok("a stale watermark selects the session", src.changedSessions(T0 - 1000).has(sid), [...src.changedSessions(T0 - 1000)].join(","));
  ok("a fresh watermark selects nothing", src.changedSessions(Date.now() + 60_000).size === 0, String(src.changedSessions(Date.now() + 60_000).size));
  src.close();
  void window;

  // ---- through the same ETL the server runs ----
  const db = current();
  const report = await build(db, { mode: "full" });
  ok("build materializes the session", report.sessions === 1, `got ${report.sessions}`);
  ok("build reports the qoder schema", report.schema === "qoder-jsonl", report.schema);

  const rows = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
  const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;

  ok("turn ids are unique", one("SELECT COUNT(*) c, COUNT(DISTINCT id) d FROM turns").c === one("SELECT COUNT(*) c, COUNT(DISTINCT id) d FROM turns").d);
  ok("prompt and every assistant turn materialize", one("SELECT COUNT(*) c FROM turns").c === 6, String(one("SELECT COUNT(*) c FROM turns").c));

  const first = one("SELECT * FROM turns WHERE id='chatcmpl-m1'");
  ok("context tokens are restored from ratio × window", first.input === 100000, String(first.input));
  ok("fill equals the recorded ratio", Math.abs(first.fill - 0.5) < 1e-9, String(first.fill));
  ok("turn credits are stored both ways", Math.abs(first.cost - 0.25) < 1e-9 && first.credits_micro === 250000,
    JSON.stringify({ cost: first.cost, micro: first.credits_micro }));

  const tools = rows("SELECT * FROM tools ORDER BY call_id");
  ok("tool calls materialize once each", tools.length === 2, `got ${tools.length}`);
  ok("a successful result marks the call completed", tools.find((t) => t.call_id === "c1")?.status === "completed");
  ok("is_error marks the call failed", tools.find((t) => t.call_id === "c2")?.status === "error");
  ok("tool latency comes from the result timestamp", tools.find((t) => t.call_id === "c1")?.dur_ms === 2000,
    String(tools.find((t) => t.call_id === "c1")?.dur_ms));

  const parts = rows("SELECT kind FROM parts WHERE turn_id='chatcmpl-m1' ORDER BY ordinal");
  ok("a turn keeps its content order", parts.map((p) => p.kind).join(",") === "reasoning,text,tool", parts.map((p) => p.kind).join(","));

  const compact = rows("SELECT * FROM events WHERE type='compaction'");
  ok("a context drop becomes a compaction event", compact.length === 1, `got ${compact.length}`);
  const detail = compact[0] ? JSON.parse(compact[0].detail) : {};
  ok("compaction records before/after context", detail.before === 100000 && detail.after === 40000, JSON.stringify(detail));

  const session = one("SELECT * FROM sessions WHERE id=?", sid);
  ok("session aggregates credits, subagents included", session.credits_micro === 500000, String(session.credits_micro));
  ok("session keeps the shipped model name", session.model === "Qwen3.8-Flash", String(session.model));
  ok("session title comes from ai-title", session.title === "Qoder demo", String(session.title));

  ok("unit is declared as credits", one("SELECT value FROM meta WHERE key='unit'")?.value === "credit");
  ok("source kind is recorded", one("SELECT value FROM meta WHERE key='sourceKind'")?.value === "qoder");

  console.log(failures ? `\n${failures} check(s) failed` : "\nall qoder checks passed");
  rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

void main();
