/**
 * The transcript row model, checked without a browser.
 *
 * `buildRows` merges two sets that live in different tables — the assistant's turns with
 * their parts, and the user's prompts — into one ordered column. The failure mode is
 * silent (a prompt on the wrong side of a header, or a row that the default `text` filter
 * drops), so it is asserted here rather than noticed in a screenshot.
 *
 * Node 24 strips the types; the module only imports types at runtime.
 */
import { buildRows, foldRows, plainText, rowMatches } from "../src/lib/transcript.ts";

let failures = 0;
const ok = (name, cond, detail = "") => {
  if (cond) return console.log(`ok   ${name}`);
  failures++;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

const MIN = 60_000;
const T0 = 1_790_000_000_000;

const turn = (id, created, parts = [], tokens = { input: 1000, cacheRead: 0, output: 200 }) => ({
  id,
  model: "m",
  provider: null,
  agent: null,
  created,
  completed: created + 1000,
  tokens: { ...tokens, reasoning: 0, cacheWrite: 0 },
  cost: 0,
  durMs: 1000,
  finish: "stop",
  tools: parts.filter((p) => p.kind === "tool").length,
  errors: parts.filter((p) => p.kind === "tool" && p.status === "error").length,
  project: "p",
  occupancy: 0,
  contextWindow: 0,
  fill: 0,
  fillAfter: 0,
  additions: 0,
  deletions: 0,
  writeLines: 0,
  hasError: false,
  parts,
});

const text = (ordinal, body) => ({ kind: "text", ordinal, text: body, name: "", callId: "", status: "", title: null, input: "", output: "", exitCode: null, truncated: false, started: null, ended: null, chars: body.length });
const reason = (ordinal, body) => ({ ...text(ordinal, body), kind: "reasoning" });
const tool = (ordinal) => ({ kind: "tool", ordinal, text: "", name: "bash", callId: "c", status: "completed", title: "ls", input: "{}", output: "", exitCode: null, truncated: false, started: null, ended: null, chars: 0 });

const turns = [
  turn("t1", T0 + MIN, [reason(0, "think first"), text(1, "first reply"), tool(2)]),
  turn("t2", T0 + 3 * MIN, [text(0, "second reply")]),
];
const prompts = [
  { id: "p1", created: T0, text: "  first question  " },
  { id: "p2", created: T0 + 2 * MIN, text: "second question" },
  { id: "p3", created: T0 + 4 * MIN, text: "unanswered question" },
  { id: "p4", created: T0 + 2 * MIN + 1, text: "   " },
];

const rows = buildRows(turns, prompts);
const shape = rows.map((r) => r.kind);

/* Ordering: prompt → its header → its content, twice, then the trailing prompt. */
ok(
  "a prompt sits immediately before the turn it opened",
  shape.join(",") === "prompt,turn,reasoning,text,tool,prompt,turn,text,prompt",
  shape.join(",")
);
ok("prompts are trimmed", rows[0].text === "first question", JSON.stringify(rows[0].text));
ok("a blank prompt is not a row", rows.filter((r) => r.kind === "prompt").length === 3);
ok("the trailing prompt joins the last turn", rows.at(-1).kind === "prompt" && rows.at(-1).turnIndex === 1);
ok("turn numbering ignores prompts", rows.filter((r) => r.kind === "turn").map((r) => r.turnIndex).join(",") === "0,1");

/* The default filter is the conversation: prompts + assistant text, nothing else. */
const textOnly = rows.filter((r) => rowMatches(r, "text", "", 0, 1)).map((r) => r.kind);
ok(
  "text keeps prompts, replies and headers only",
  textOnly.join(",") === "prompt,turn,text,prompt,turn,text,prompt",
  textOnly.join(",")
);
ok(
  "all keeps everything",
  rows.filter((r) => rowMatches(r, "all", "", 0, 1)).length === rows.length
);
ok(
  "tools keeps tool rows and headers",
  rows.filter((r) => rowMatches(r, "tools", "", 0, 1)).map((r) => r.kind).join(",") === "turn,tool,turn"
);
ok(
  "search reaches the prompt body",
  rows.filter((r) => rowMatches(r, "text", "second question", 0, 1)).every((r) => r.kind === "turn" || r.text.includes("second question"))
);

/* The timeline brush filters by turn, and a prompt belongs to the turn it opened. */
const onlySecond = rows.filter((r) => rowMatches(r, "all", "", 1, 1)).map((r) => r.kind);
ok("the cursor's turn keeps its prompt and header", onlySecond.join(",") === "prompt,turn,text,prompt", onlySecond.join(","));

/* Cumulative tokens are readings of what came before the row. */
const trailing = rows.at(-1);
ok("a prompt before the first turn carries no tokens", rows[0].cumTokens === 0);
ok("a trailing prompt carries the whole session", trailing.cumTokens === 2 * 1200, String(trailing.cumTokens));

/* A header with nothing under it is a dangling label: every filter drops it. */
const silentTurns = [
  turn("a", T0, [text(0, "hello")]),
  turn("b", T0 + MIN, [tool(0)]),
  turn("c", T0 + 2 * MIN, [reason(0, "hmm"), tool(1)]),
  turn("d", T0 + 3 * MIN, [text(0, "bye")]),
];
const silentRows = buildRows(silentTurns, []);
const pick = (r, f, x = new Set()) => foldRows(r.filter((row) => rowMatches(row, f, "", 0, 3)), f, x).map((row) => row.kind);
ok("tools drops headers of turns that called nothing", pick(silentRows, "tools").join(",") === "turn,tool,turn,tool", pick(silentRows, "tools").join(","));
ok("errors drops headers of turns that did not fail", pick(silentRows, "errors").join(",") === "", pick(silentRows, "errors").join(","));

/* `text` folds a prose-less stretch into one line instead of a header per turn. */
const folded = foldRows(silentRows.filter((r) => rowMatches(r, "text", "", 0, 3)), "text");
ok("text folds prose-less turns into one gap row", folded.map((r) => r.kind).join(",") === "turn,text,gap,turn,text", folded.map((r) => r.kind).join(","));
const gap = folded.find((r) => r.kind === "gap");
ok("the gap row counts what it hides", gap.gap.turns === 2 && gap.gap.tools === 2, JSON.stringify(gap.gap));
ok("the gap row carries the run's own tokens", gap.gap.tokens === 2400, JSON.stringify(gap.gap));
ok("the gap row spans the turns it hides", gap.gap.from < gap.gap.to, JSON.stringify(gap.gap));
const unfolded = foldRows(silentRows.filter((r) => rowMatches(r, "text", "", 0, 3)), "text", new Set([gap.id]));
ok("unfolding keeps the summary and adds the headers", unfolded.map((r) => r.kind).join(",") === "turn,text,gap,turn,turn,turn,text", unfolded.map((r) => r.kind).join(","));

/* An opening prompt is shown above the header it opened, not as that header's content. */
const opened = buildRows([turn("g", T0, [tool(0)])], [{ id: "q", created: T0 - MIN, text: "go" }]);
ok(
  "a prompt does not rescue the header below it",
  foldRows(opened.filter((r) => rowMatches(r, "text", "", 0, 0)), "text").map((r) => r.kind).join(",") === "prompt,gap",
  foldRows(opened.filter((r) => rowMatches(r, "text", "", 0, 0)), "text").map((r) => r.kind).join(",")
);
/* A trailing prompt does sit under its turn's header. */
const tailPrompt = buildRows([turn("h", T0, [tool(0)])], [{ id: "r", created: T0 + MIN, text: "next?" }]);
ok(
  "a trailing prompt keeps its header",
  foldRows(tailPrompt.filter((r) => rowMatches(r, "text", "", 0, 0)), "text").map((r) => r.kind).join(",") === "turn,prompt",
  foldRows(tailPrompt.filter((r) => rowMatches(r, "text", "", 0, 0)), "text").map((r) => r.kind).join(",")
);

/* A failing turn keeps its header under `errors`. */
const withFailure = [turn("e", T0, [{ ...tool(0), status: "error" }]), turn("f", T0 + MIN, [text(0, "ok")])];
const errors = foldRows(buildRows(withFailure, []).filter((r) => rowMatches(r, "errors", "", 0, 1)), "errors").map((r) => r.kind);
ok("errors keeps the header it belongs to", errors.join(",") === "turn,tool", errors.join(","));

/* A session can hold a prompt before its first reply; the panel still shows it. */
const lonely = buildRows([], prompts);
ok("prompts survive a session with no turns", lonely.length === 3 && lonely.every((r) => r.kind === "prompt" && r.turn === null && r.turnIndex === 0));

/* ---- the projection the filter reads when Markdown is rendered ---- */

ok(
  "a prose row is searched without its syntax",
  plainText("## 现有功能\n1. `a` 与 **b**\n- c") === "现有功能\n1. a 与 b\n· c",
  JSON.stringify(plainText("## 现有功能\n1. `a` 与 **b**\n- c"))
);
ok(
  "a table's pipes do not survive into the haystack",
  !plainText("| x | y |\n|---|---|\n| 1 | 2 |").includes("|"),
  JSON.stringify(plainText("| x | y |\n|---|---|\n| 1 | 2 |"))
);
const mdRow = buildRows([turn("md", T0, [text(0, "`a` 与 **b**")])], [], )[1];
ok("the row under test is prose", mdRow.kind === "text", mdRow.kind);
ok(
  "a search for what is on screen finds the row",
  rowMatches(mdRow, "all", "a 与 b", 0, 0, true),
  JSON.stringify(plainText(mdRow.text))
);
ok(
  "the same search misses the stored form",
  !rowMatches(mdRow, "all", "a 与 b", 0, 0, false),
  JSON.stringify(mdRow.text)
);
const mdPrompt = buildRows([], [{ id: "m", created: T0, text: "## 标题\n`a` 与 **b**" }])[0];
ok("a prompt is prose too", mdPrompt.kind === "prompt", mdPrompt.kind);
ok(
  "a search for what is on screen finds the prompt",
  rowMatches(mdPrompt, "all", "a 与 b", 0, 0, true),
  JSON.stringify(plainText(mdPrompt.text))
);
ok(
  "the same prompt search misses the stored form",
  !rowMatches(mdPrompt, "all", "a 与 b", 0, 0, false),
  JSON.stringify(mdPrompt.text)
);

console.log(failures ? `\ntranscript: ${failures} check(s) failed` : "\ntranscript: row model clean");
process.exit(failures ? 1 : 0);
