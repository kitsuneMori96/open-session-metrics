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
import { buildRows, rowMatches } from "../src/lib/transcript.ts";

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
  tools: 0,
  errors: 0,
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

/* A session can hold a prompt before its first reply; the panel still shows it. */
const lonely = buildRows([], prompts);
ok("prompts survive a session with no turns", lonely.length === 3 && lonely.every((r) => r.kind === "prompt" && r.turn === null && r.turnIndex === 0));

console.log(failures ? `\ntranscript: ${failures} check(s) failed` : "\ntranscript: row model clean");
process.exit(failures ? 1 : 0);
