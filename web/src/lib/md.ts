/**
 * A Markdown subset, sized to the transcript.
 *
 * The transcript is read as an instrument tape, not as a document: one 10 px mono
 * column, hierarchy expressed by ink weight and hairline rules, never by a type
 * scale. Full Markdown would import a *document* grammar — six heading sizes, cell
 * borders, blockquote bars, a fill behind every code block — and those have no
 * counterpart here.
 *
 * So this parser only recognises what can be rendered with the vocabulary the app
 * already owns: colour (ink / soft / faint), weight, one hairline, one 6% tint.
 * Everything else stays literal text, which is the same thing as staying readable.
 *
 *     recognised            rendered as
 *     # heading             faint hashes + bold ink (no size change)
 *     - / 1. list           · or the number in faint, 2ch indent per level
 *     ``` fence             pre-wrap, one hairline on the left, no fill
 *     | table |             a real grid: hairline rows, numbers right-aligned
 *     > quote               │ in faint, text a step softer
 *     ---                   one hairline
 *     `code` **bold** [x](y) inline tint / weight / underlined ink
 *
 * Deliberately absent: images, italics (the app has none), escaped syntax,
 * reference links, footnotes, and HTML — HTML is never interpreted anywhere.
 */

export type Align = "l" | "r" | "c";

export type Block =
  | { kind: "para"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "item"; depth: number; ordered: boolean; marker: string; text: string }
  | { kind: "fence"; lang: string; code: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; head: string[]; align: Align[]; rows: string[][] }
  | { kind: "rule" };

/**
 * `at` is the token's offset in the source string `parseInline` was handed.
 *
 * It exists for one reason: search. `Mark` matches inside a single string, so a query
 * that runs from plain text into a code span (`插件 \`git`\`) used to lose its
 * highlight on both sides. With offsets the highlighter finds hits in source
 * coordinates and clips them per token, so the mark crosses the boundary correctly.
 */
export type Inline =
  | { kind: "text"; text: string; at: number }
  | { kind: "code"; text: string; at: number }
  | { kind: "strong"; text: string; at: number }
  | { kind: "link"; text: string; href: string; at: number };

/* ------------------------------------------------------------------ *
 * Inline
 * ------------------------------------------------------------------ */

const SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/** Backticks, `**bold**`, `[label](href)`. Nothing nests; nothing recurses. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  let bufAt = 0;
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf, at: bufAt });
    buf = "";
  };

  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "code", text: src.slice(i + 1, end), at: i + 1 });
        i = end + 1;
        continue;
      }
    }
    if (c === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "strong", text: src.slice(i + 2, end), at: i + 2 });
        i = end + 2;
        continue;
      }
    }
    if (c === "[") {
      const close = src.indexOf("](", i + 1);
      const paren = close > 0 ? src.indexOf(")", close + 2) : -1;
      if (close > i + 1 && paren > close + 2) {
        const href = src.slice(close + 2, paren);
        if (SCHEME.test(href)) {
          flush();
          out.push({ kind: "link", text: src.slice(i + 1, close), href, at: i + 1 });
          i = paren + 1;
          continue;
        }
      }
    }
    if (!buf) bufAt = i;
    buf += c;
    i++;
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const DELIM_CELL = /^:?-{2,}:?$/;

/** A row of a pipe table, split on unescaped pipes. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isDelimRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}

function alignOf(cell: string): Align {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  return l && r ? "c" : r ? "r" : "l";
}

export function parseMd(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n");
  const out: Block[] = [];
  const para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "para", text: para.join("\n") });
    para.length = 0;
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const mark = fence[1];
      const close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
      const code: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (close.test(lines[j])) break;
        code.push(lines[j]);
      }
      // A fence the transcript window cut in half (PART_CAP) simply runs to the end:
      // the code is still code, and a closing marker would be a lie.
      out.push({ kind: "fence", lang: fence[2] ?? "", code: code.join("\n") });
      i = j < lines.length ? j + 1 : lines.length;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length) {
      const head = splitRow(line);
      const delim = splitRow(lines[i + 1]);
      if (head.length > 1 && delim.length === head.length && isDelimRow(delim)) {
        flush();
        const rows: string[][] = [];
        let j = i + 2;
        for (; j < lines.length; j++) {
          const t = lines[j];
          if (!t.trim() || !t.includes("|")) break;
          const cells = splitRow(t);
          if (isDelimRow(cells)) break;
          rows.push(head.map((_, k) => cells[k] ?? ""));
        }
        out.push({ kind: "table", head, align: delim.map(alignOf), rows });
        i = j;
        continue;
      }
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      flush();
      out.push({ kind: "rule" });
      i++;
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      flush();
      const marker = item[2];
      out.push({
        kind: "item",
        // Four levels is as far as 10 px mono can indent before the column is gone.
        depth: Math.min(4, Math.floor(item[1].length / 2)),
        ordered: /\d/.test(marker),
        marker: marker.replace(/[.)]$/, ""),
        text: item[3],
      });
      i++;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const body: string[] = [quote[1]];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const q = QUOTE.exec(lines[j]);
        if (!q) break;
        body.push(q[1]);
      }
      out.push({ kind: "quote", text: body.join("\n") });
      i = j;
      continue;
    }

    para.push(line);
    i++;
  }

  flush();
  return out;
}

/** A column is numeric when every filled body cell parses as a number. */
export function numericColumn(rows: string[][], col: number): boolean {
  const cells = rows.map((r) => (r[col] ?? "").trim()).filter(Boolean);
  return cells.length > 0 && cells.every((c) => /^[-+]?[\d.,]+\s*(?:%|×|x|k|M|K|B|tok|cr)?$/i.test(c));
}
