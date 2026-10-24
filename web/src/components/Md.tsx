import clsx from "clsx";
import type { ReactNode } from "react";
import { numericColumn, parseInline, parseMd, type Block, type Inline } from "../lib/md";

/**
 * The Markdown subset, as pixels.
 *
 * Every class below is either already in the app (`.tape`, `.micro`, `.out`, `.mark`,
 * `text-ink-faint`, `border-rule`, the 5% ink tint) or a plain layout utility. No new
 * colour, no new type size, no new surface, no new container: if a construct cannot be
 * said in those terms, `lib/md.ts` never produces it and the text stays literal.
 */
export type TableMode = "auto" | "grid" | "stack" | "raw";

export default function Md({
  text,
  query,
  tables = "auto",
}: {
  text: string;
  query: string;
  tables?: TableMode;
}) {
  return (
    <>
      {parseMd(text).map((b, i) => (
        <BlockView key={i} block={b} query={query} tables={tables} />
      ))}
    </>
  );
}

function InlineView({ src, query }: { src: string; query: string }) {
  const tokens = parseInline(src);
  const hits = findHits(src, query);
  return (
    <>
      {tokens.map((t, i) => (
        <InlineToken key={i} token={t} hits={hits} query={query} />
      ))}
    </>
  );
}

function InlineToken({ token, hits, query }: { token: Inline; hits: Hit[]; query: string }) {
  switch (token.kind) {
    case "code":
      // 5% ink, no border, no radius: the app's existing tint, at inline scale.
      // Code is terminal: whatever is inside it is content, never syntax.
      return <span className="bg-ink/5 px-[2px] text-ink">{marked(token, hits)}</span>;
    case "strong":
      // One level of nesting, because the corpus writes ``**`tool.name`**`` often
      // enough that literal backticks inside a bold run would be a visible bug.
      return (
        <span className="font-semibold text-ink">
          {token.text.includes("`") || token.text.includes("[") ? (
            <InlineView src={token.text} query={query} />
          ) : (
            marked(token, hits)
          )}
        </span>
      );
    case "link":
      // Ink, not blue: `flow` means "the cursor is here" and nothing else.
      return (
        <a
          href={token.href}
          target="_blank"
          rel="noreferrer noopener"
          title={token.href}
          className="text-ink underline decoration-[color:var(--color-rule-strong)] underline-offset-2"
        >
          {marked(token, hits)}
        </a>
      );
    default:
      return marked(token, hits);
  }
}

/* ------------------------------------------------------------------ *
 * Search
 *
 * The query is matched against the *source* string and the hits are then clipped per
 * token (each token carries its offset). Matching per token instead — the obvious way —
 * fails exactly where the markdown matters: searching `使用现有插件` inside
 * `方案 \`插件\` 使用` would match the visible sentence but highlight nothing, because
 * the string handed to the highlighter never contained the whole phrase.
 * ------------------------------------------------------------------ */

type Hit = readonly [number, number];

function findHits(src: string, query: string): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hay = src.toLowerCase();
  const out: Hit[] = [];
  for (let at = 0; ; ) {
    const i = hay.indexOf(q, at);
    if (i < 0) return out;
    out.push([i, i + q.length]);
    at = i + q.length;
  }
}

function marked(token: Inline, hits: Hit[]): ReactNode {
  const { text, at } = token;
  if (hits.length === 0 || text.length === 0) return text;
  const end = at + text.length;
  const parts: ReactNode[] = [];
  let cursor = at;
  for (const [from, to] of hits) {
    const s = Math.max(from, at);
    const e = Math.min(to, end);
    if (e <= s) continue;
    if (s > cursor) parts.push(text.slice(cursor - at, s - at));
    parts.push(
      <mark className="mark" key={s}>
        {text.slice(s - at, e - at)}
      </mark>
    );
    cursor = e;
  }
  if (cursor < end) parts.push(text.slice(cursor - at));
  return parts.length ? <>{parts}</> : text;
}

function BlockView({ block, query, tables }: { block: Block; query: string; tables: TableMode }) {
  switch (block.kind) {
    case "heading":
      // One body size, one weight: the column has exactly one of each, and a heading
      // that got *smaller* than its paragraph (the `.micro` alternative) reads as a
      // caption, not a head. So the level is carried by air above it — 8 px for a
      // section, 3 px for a subsection — and the hashes go, since they said "heading"
      // twice.
      return (
        <div className={clsx("whitespace-pre-wrap", block.level <= 2 ? "mt-2" : "mt-[3px]")}>
          <span className="font-semibold text-ink">
            <InlineView src={block.text} query={query} />
          </span>
        </div>
      );

    case "item":
      return (
        <div className="flex whitespace-pre-wrap">
          <span className="shrink-0 whitespace-pre">{"  ".repeat(block.depth)}</span>
          <span className={clsx("w-[3ch] shrink-0 text-ink-faint", block.ordered && "tabular")}>
            {block.ordered ? `${block.marker}.` : "·"}
          </span>
          <span className="min-w-0 flex-1">
            <InlineView src={block.text} query={query} />
          </span>
        </div>
      );

    case "fence":
      // No fill and no box: one hairline in the margin says "verbatim", which is
      // the same thing `.out` says on a tool row without borrowing its container.
      return (
        <pre className="out my-1 max-w-full overflow-x-auto border-l border-rule pl-2 text-ink-soft">
          {marked({ kind: "text", text: block.code, at: 0 }, findHits(block.code, query))}
        </pre>
      );

    case "quote":
      return (
        <div className="flex whitespace-pre-wrap text-ink-soft">
          <span className="w-[2ch] shrink-0 text-ink-faint">│</span>
          <span className="min-w-0 flex-1">
            <InlineView src={block.text} query={query} />
          </span>
        </div>
      );

    case "table":
      return tables === "grid" ? (
        <GridView block={block} query={query} />
      ) : tables === "raw" ? (
        <RawView block={block} />
      ) : tables === "stack" || !isMatrix(block) ? (
        <StackView block={block} query={query} />
      ) : (
        <GridView block={block} query={query} />
      );

    case "rule":
      return <div className="my-2 border-t border-rule" />;

    default:
      return (
        <div className="whitespace-pre-wrap">
          <InlineView src={block.text} query={query} />
        </div>
      );
  }
}

/**
 * A table is only a matrix when it has numbers in it.
 *
 * In this corpus 748 tables, 95 carry a numeric column, 407 carry a cell longer than
 * 40 characters, and 608 have two or three columns: they are *records* — a decision and
 * its landing place, a symptom and its cause. Drawn as a grid, a record table is wider
 * than the 92ch column and clipped, and its column widths come from whichever cell
 * happened to be long. Drawn as lines, it reads the way the rest of the tape does.
 */
function isMatrix(block: Block & { kind: "table" }): boolean {
  return block.head.some((_, c) => numericColumn(block.rows, c));
}

/** Records: one line per row, the key in ink, the rest a step softer. */
function StackView({ block, query }: { block: Block & { kind: "table" }; query: string }) {
  return (
    <div className="my-1">
      {block.head.some((h) => h.trim()) && (
        <div className="text-ink-faint">
          <InlineView src={block.head.join(" · ")} query={query} />
        </div>
      )}
      {block.rows.map((row, r) => (
        <div key={r} className="whitespace-pre-wrap">
          <span className="text-ink">
            <InlineView src={row[0] ?? ""} query={query} />
          </span>
          {row.length > 1 && (
            <>
              <span className="text-ink-faint"> · </span>
              <span className="text-ink-soft">
                <InlineView src={row.slice(1).join(" · ")} query={query} />
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** The table exactly as written — the control group for the verdict. */
function RawView({ block }: { block: Block & { kind: "table" } }) {
  const lines = [
    `| ${block.head.join(" | ")} |`,
    `|${block.head.map((_, c) => (block.align[c] === "r" ? "--:" : block.align[c] === "c" ? ":-:" : "---")).join("|")}|`,
    ...block.rows.map((r) => `| ${r.join(" | ")} |`),
  ];
  return <div className="whitespace-pre-wrap">{lines.join("\n")}</div>;
}

/**
 * A matrix, in the app's own table language: hairline rules, right-aligned tabular
 * numbers, no cell borders, no zebra, no radius.
 */
function GridView({ block, query }: { block: Block & { kind: "table" }; query: string }) {
  const numeric = block.head.map((_, c) => numericColumn(block.rows, c));
  return (
    <div className="my-1 max-w-full overflow-x-auto">
      <table className="border-collapse">
        <thead>
          <tr className="border-b border-rule">
            {block.head.map((h, c) => (
              <th key={c} className={clsx("micro pr-3 pb-[2px] font-normal", side(block.align[c], numeric[c]))}>
                <InlineView src={h} query={query} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className="border-b border-rule/40">
              {block.head.map((_, c) => (
                <td key={c} className={clsx("pr-3 align-top", side(block.align[c], numeric[c]))}>
                  <InlineView src={row[c] ?? ""} query={query} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function side(align: "l" | "r" | "c", numeric: boolean): string {
  if (align === "c") return "text-center tabular";
  if (align === "r" || numeric) return "text-right tabular";
  return "text-left";
}
