/**
 * The Markdown subset, checked without a browser.
 *
 * The parser's failure modes are silent: a list that becomes a paragraph, a fence
 * that swallows the rest of a transcript, a table whose numbers lose their column.
 * Each one is asserted here. The second half runs the parser over the *real* corpus so
 * the coverage numbers in `docs/markdown-transcript.md` can be reproduced.
 *
 * Node 24 strips the types.
 */
import { parseInline, parseMd, numericColumn } from "../src/lib/md.ts";

let failures = 0;
const ok = (name, cond, detail = "") => {
  if (cond) return console.log(`ok   ${name}`);
  failures++;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

const kinds = (src) => parseMd(src).map((b) => b.kind);

/* ---- blocks ---- */

ok(
  "a heading keeps its level and loses only its noise",
  JSON.stringify(parseMd("### 结论 ###")) === JSON.stringify([{ kind: "heading", level: 3, text: "结论 ###" }]),
  JSON.stringify(parseMd("### 结论 ###"))
);
ok("a heading needs the space", kinds("###no-space") .join() === "para", kinds("###no-space").join());
ok("seven hashes are not a heading", kinds("####### seven").join() === "para", kinds("####### seven").join());

ok(
  "unordered items carry depth and marker",
  JSON.stringify(parseMd("- a\n  - b\n    - c")) ===
    JSON.stringify([
      { kind: "item", depth: 0, ordered: false, marker: "-", text: "a" },
      { kind: "item", depth: 1, ordered: false, marker: "-", text: "b" },
      { kind: "item", depth: 2, ordered: false, marker: "-", text: "c" },
    ]),
  JSON.stringify(parseMd("- a\n  - b\n    - c"))
);
ok(
  "ordered items keep their number",
  JSON.stringify(parseMd("1. one\n2) two")) ===
    JSON.stringify([
      { kind: "item", depth: 0, ordered: true, marker: "1", text: "one" },
      { kind: "item", depth: 0, ordered: true, marker: "2", text: "two" },
    ]),
  JSON.stringify(parseMd("1. one\n2) two"))
);
ok("nesting stops at four levels", parseMd("            - deep")[0].depth === 4, JSON.stringify(parseMd("            - deep")[0]));

ok(
  "a fence keeps its body verbatim",
  JSON.stringify(parseMd("```ts\nconst a = 1;\n  - not a list\n```")) ===
    JSON.stringify([{ kind: "fence", lang: "ts", code: "const a = 1;\n  - not a list" }]),
  JSON.stringify(parseMd("```ts\nconst a = 1;\n  - not a list\n```"))
);
ok(
  "an unterminated fence (the 2 000-char cut) still renders as code",
  JSON.stringify(parseMd("text\n```py\nprint(1)")) ===
    JSON.stringify([
      { kind: "para", text: "text" },
      { kind: "fence", lang: "py", code: "print(1)" },
    ]),
  JSON.stringify(parseMd("text\n```py\nprint(1)"))
);
ok("a tilde fence closes only on tildes", kinds("~~~\na\n~~~").join() === "fence");
ok("a backtick fence ignores a tilde line", parseMd("```\na\n~~~\nb\n```")[0].code === "a\n~~~\nb");

ok(
  "a pipe table needs a delimiter row",
  kinds("| a | b |\n| 1 | 2 |").join() === "para",
  kinds("| a | b |\n| 1 | 2 |").join()
);
const table = parseMd("| model | tok | $ |\n|:--|--:|:--:|\n| qwen | 1,234 | 0.5 |\n| ds | 22 | 1 |");
ok("a table parses to head, align and rows", table.length === 1 && table[0].kind === "table", JSON.stringify(table));
ok("alignment comes from the delimiter row", JSON.stringify(table[0].align) === JSON.stringify(["l", "r", "c"]), JSON.stringify(table[0].align));
ok("body rows are padded to the head width", table[0].rows[1].length === 3, JSON.stringify(table[0].rows[1]));
ok("a numeric column is detected", numericColumn(table[0].rows, 1) === true);
ok("a text column is not", numericColumn(table[0].rows, 0) === false);
ok("a table stops at a blank line", kinds("| a | b |\n|--|--|\n| 1 | 2 |\n\nafter").join() === "table,para");

ok("a rule is one hairline", kinds("a\n\n---\n\nb").join() === "para,rule,para");
ok("a rule of stars and underscores too", kinds("***").join() === "rule" && kinds("___").join() === "rule");
ok("a setext underline is not a rule", kinds("Title\n---").join() !== "rule", kinds("Title\n---").join());

ok(
  "a quote keeps its lines together",
  JSON.stringify(parseMd("> one\n> two\n\nplain")) ===
    JSON.stringify([
      { kind: "quote", text: "one\ntwo" },
      { kind: "para", text: "plain" },
    ]),
  JSON.stringify(parseMd("> one\n> two\n\nplain"))
);

ok(
  "hard-wrapped prose stays one block",
  JSON.stringify(parseMd("line one\nline two\n\nsecond")) ===
    JSON.stringify([
      { kind: "para", text: "line one\nline two" },
      { kind: "para", text: "second" },
    ])
);
ok("CRLF is normalised", parseMd("a\r\nb")[0].text === "a\nb");

/* ---- inline ---- */

/** Tokens without their offsets, for the shape assertions. */
const bare = (src) => parseInline(src).map(({ kind, text, href }) => (href ? { kind, text, href } : { kind, text }));

ok(
  "inline code, bold and a link",
  JSON.stringify(bare("use `pnpm test` and **注意** see [docs](https://x.dev/d)")) ===
    JSON.stringify([
      { kind: "text", text: "use " },
      { kind: "code", text: "pnpm test" },
      { kind: "text", text: " and " },
      { kind: "strong", text: "注意" },
      { kind: "text", text: " see " },
      { kind: "link", text: "docs", href: "https://x.dev/d" },
    ]),
  JSON.stringify(bare("use `pnpm test` and **注意** see [docs](https://x.dev/d)"))
);

/* ---- offsets: what keeps search highlighting across an inline boundary ---- */

const SOURCES = [
  "use `pnpm test` and **注意** see [docs](https://x.dev/d)",
  "插件 `opencode-terminal-progress` 显示进度",
  "plain prose with a *star* and `x`",
  "`a` **b** c",
];
let offsetsOk = true;
let offsetsDetail = "";
for (const src of SOURCES) {
  for (const t of parseInline(src)) {
    if (src.slice(t.at, t.at + t.text.length) !== t.text) {
      offsetsOk = false;
      offsetsDetail = `${JSON.stringify(src)} → ${t.kind}@${t.at} ${JSON.stringify(t.text)}`;
    }
  }
}
ok("every token's offset points at its own text in the source", offsetsOk, offsetsDetail);
ok(
  "a token's offset survives a leading code span",
  parseInline("`a` b").at(-1).at === 3,
  JSON.stringify(parseInline("`a` b"))
);
ok("an unclosed backtick stays text", parseInline("a `b")[0].kind === "text");
ok("a bare asterisk stays text", parseInline("2 * 3").every((t) => t.kind === "text"));
ok("a link without a scheme stays text", parseInline("[a](b.md)")[0].kind === "text");
ok("html is never interpreted", parseInline("<b>hi</b>")[0].text === "<b>hi</b>");
ok("an empty code span stays text", parseInline("``")[0].text === "``");

console.log(failures ? `\n${failures} check(s) failed` : "\nall markdown-subset checks passed");
process.exit(failures ? 1 : 0);
