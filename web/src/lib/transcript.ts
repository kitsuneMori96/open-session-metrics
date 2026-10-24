import type { Part, PromptLine, ToolPart, Turn } from "./api";

/**
 * The transcript as a flat list of rows.
 *
 * opencode-top had to flatten a tool call into individual lines — one row per argument,
 * one per output row — because a terminal row is the only unit it has. A browser can
 * nest, so a tool call stays a single row with a body that opens under it. The list is
 * therefore short enough to virtualize, and "jump to the next match" means scrolling to
 * a row index rather than repainting a viewport.
 *
 * User prompts are rows too, even though they live in their own table: a transcript that
 * starts at the model's first reply is a transcript with the other half of the
 * conversation missing. Each prompt is attached to the assistant turn it opened, so the
 * timeline brush and the cursor behave the same on both halves.
 */

export type RowKind = "turn" | "prompt" | "text" | "reasoning" | "tool" | "gap";

export interface Row {
  id: string;
  kind: RowKind;
  /** Null only for a prompt in a session with no assistant turn yet. */
  turn: Turn | null;
  turnIndex: number;
  text: string;
  part: ToolPart | null;
  /** Present on gap rows: what a folded stretch of prose-less turns contains. */
  gap?: { turns: number; tools: number; tokens: number; cost: number; from: number; to: number };
  /** Cumulative provider tokens through the end of the turn this row belongs to. */
  cumTokens: number;
}

export type LineFilter = "all" | "errors" | "tools" | "text";

export const NEXT_FILTER: Record<LineFilter, LineFilter> = {
  all: "errors",
  errors: "tools",
  tools: "text",
  text: "all",
};

export const FILTERS: LineFilter[] = ["all", "errors", "tools", "text"];

export const toolKey = (turnId: string, p: ToolPart): string => p.callId || `${turnId}:${p.ordinal}`;

export function buildRows(turns: Turn[], prompts: PromptLine[] = []): Row[] {
  const rows: Row[] = [];
  let cum = 0;
  let next = 0;
  /** Prompts that arrived before `until` opened the turn at `turnIndex`. */
  const pushPrompts = (until: number, turnIndex: number) => {
    while (next < prompts.length && prompts[next].created <= until) {
      const p = prompts[next++];
      const text = p.text.trim();
      if (!text) continue;
      rows.push({
        id: `prompt-${p.id}`,
        kind: "prompt",
        turn: turns[turnIndex] ?? null,
        turnIndex,
        text,
        part: null,
        cumTokens: cum,
      });
    }
  };
  turns.forEach((turn, turnIndex) => {
    pushPrompts(turn.created, turnIndex);
    cum += turn.tokens.input + turn.tokens.cacheRead + turn.tokens.output;
    rows.push({ id: `turn-${turn.id}`, kind: "turn", turn, turnIndex, text: "", part: null, cumTokens: cum });
    for (const part of turn.parts as Part[]) {
      if (part.kind === "text") {
        const text = part.text.trim();
        if (text) rows.push({ id: `text-${turn.id}-${part.ordinal}`, kind: "text", turn, turnIndex, text, part: null, cumTokens: cum });
      } else if (part.kind === "reasoning") {
        const text = part.text.trim();
        if (text) rows.push({ id: `reason-${turn.id}-${part.ordinal}`, kind: "reasoning", turn, turnIndex, text, part: null, cumTokens: cum });
      } else {
        rows.push({
          id: `tool-${turn.id}-${part.ordinal}`,
          kind: "tool",
          turn,
          turnIndex,
          text: "",
          part: part as ToolPart,
          cumTokens: cum,
        });
      }
    }
  });
  // A prompt sent after the last reply belongs to that turn: it is the next question,
  // and hiding it would make a session look like it ended with the model talking.
  pushPrompts(Infinity, Math.max(0, turns.length - 1));
  return rows;
}

/**
 * Headers pass every filter here; `foldRows` prunes the ones the filter left empty.
 *
 * A header with no visible row under it is a dangling label: under `errors` it names a
 * turn that did not fail, under `tools` one that called nothing, under `text` one that
 * only thought and ran commands. Under `all` nothing is hidden and every header stays.
 */
export function rowMatches(
  row: Row,
  filter: LineFilter,
  query: string,
  from: number,
  to: number,
  md = false
): boolean {
  if (row.turnIndex < from || row.turnIndex > to) return false;
  if (filter !== "all" && row.kind !== "turn") {
    if (filter === "errors" && !(row.part && row.part.status === "error")) return false;
    if (filter === "tools" && row.kind !== "tool") return false;
    // "text" is the readable conversation: what the user asked and what the model said.
    if (filter === "text" && row.kind !== "text" && row.kind !== "prompt") return false;
  }
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack(row, md).includes(q);
}

/**
 * What the filter searches.
 *
 * A prose row is rendered through the Markdown subset, so the reader sees text without
 * backticks and hashes; searching the stored form would miss the sentence they are
 * looking at. That applies to the human's prompts as much as the model's replies: both
 * are prose, and a prompt is where a pasted spec or a quoted log carries the markers.
 * `plainText` is memoised per row because the rows are stable across keystrokes and the
 * projection costs ~8 ms for the largest transcript.
 */
const projected = new WeakMap<Row, string>();

function haystack(row: Row, md: boolean): string {
  if (!md || (row.kind !== "text" && row.kind !== "prompt")) return searchText(row);
  const hit = projected.get(row);
  if (hit !== undefined) return hit;
  const next = plainText(searchText(row));
  projected.set(row, next);
  return next;
}

/**
 * Fold what a filter leaves empty.
 *
 * The `text` view is a conversation: prompts and replies, nothing else. A turn that
 * produced no prose still happened, and its header would be a line of instrument data
 * between two sentences — twenty of them in a row is what the view used to look like.
 * So consecutive prose-less turns collapse into one summary line (a gap row), which can
 * be unfolded when the numbers are what you came for. `errors` and `tools` simply drop
 * them: a stretch with nothing to show is not worth a row of its own.
 *
 * `expanded` holds the ids of unfolded gap rows, so the row list stays a pure function.
 */
export function foldRows(rows: Row[], filter: LineFilter, expanded: Set<string> = new Set()): Row[] {
  if (filter === "all") return rows;
  const out: Row[] = [];
  /** Headers whose turn has not yet shown a row of its own. */
  let pending: Row[] = [];
  const fold = (run: Row[]) => {
    // `errors` and `tools` do not summarise the silence, they simply drop it: a row
    // saying "nothing to see" is the noise these views exist to remove.
    if (!run.length || filter !== "text") return;
    const id = `gap-${run[0].id}`;
    // The summary line stays when unfolded: it is the only control that can fold the
    // run back, which is the same shape as a reasoning block (label + body).
    out.push(gapOf(run, id), ...(expanded.has(id) ? run : []));
  };
  for (const row of rows) {
    if (row.kind === "turn") {
      pending.push(row);
      continue;
    }
    // A row can only keep the header of its own turn. An opening prompt is inserted
    // before the header it opened, so it does not rescue the header above it.
    const at = pending.findIndex((h) => h.turnIndex === row.turnIndex);
    if (at >= 0) {
      fold(pending.slice(0, at));
      out.push(pending[at]);
      pending = pending.slice(at + 1);
    } else {
      fold(pending);
      pending = [];
    }
    out.push(row);
  }
  fold(pending);
  return out;
}

function gapOf(run: Row[], id: string): Row {
  const first = run[0];
  const last = run[run.length - 1];
  let tokens = 0;
  let tools = 0;
  let cost = 0;
  for (const r of run) {
    const t = r.turn;
    if (!t) continue;
    tokens += t.tokens.input + t.tokens.cacheRead + t.tokens.output;
    tools += t.tools;
    cost += t.cost;
  }
  return {
    id,
    kind: "gap",
    turn: null,
    turnIndex: first.turnIndex,
    text: "",
    part: null,
    gap: {
      turns: run.length,
      tools,
      tokens,
      cost,
      from: first.turn?.created ?? 0,
      to: last.turn?.created ?? 0,
    },
    cumTokens: last.cumTokens,
  };
}

export function searchText(row: Row): string {
  switch (row.kind) {
    case "text":
    case "prompt":
      return row.text.toLowerCase();
    case "reasoning":
      return row.text.toLowerCase();
    case "tool": {
      const p = row.part!;
      return `${p.name} ${p.title ?? ""} ${p.input} ${p.output}`.toLowerCase();
    }
    default:
      return "";
  }
}

export const describeParams = (raw: string): { key: string; value: string }[] => {
  const out: { key: string; value: string }[] = [];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw ? { value: raw } : null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out.push({ key, value: previewValue(value) });
    }
  }
  return out;
};

function previewValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The TUI's 40-row cap on a tool's captured output, kept as a rendering budget. */
export const OUT_ROWS = 40;

/**
 * Status as a mark, in the data face.
 *
 * `✓` and `◌` are two of the sixteen glyphs in the shipped symbol cut (see index.css),
 * so they render from the same mono cell everywhere. The failure mark is `×` — the
 * multiplication sign JetBrains Mono itself carries, and already the project's "n times"
 * notation: the error signatures on the tools screen count in `4×`. `✗` (U+2717) is in
 * neither face and was being drawn by whatever font the OS offered instead.
 */
export const statusGlyph = (status: string): string => (status === "completed" ? "✓" : status === "error" ? "×" : "◌");

/**
 * The text as it is *read*, with the markers gone.
 *
 * Search matches stored text, and the stored text still carries its syntax. With the
 * subset on, a reader who searches for what is on screen — `1. opencode-terminal-progress
 * - 显示` — would otherwise get no row back, because the stored line is
 * ``1. **`opencode-terminal-progress`** - 显示``: the markers sit between the words they
 * typed. So when rendering is on, the filter runs against this projection instead.
 *
 * It never runs on tool input/output: those are not rendered as Markdown, so their
 * pipes, stars and hashes are content, not syntax.
 */
export function plainText(src: string): string {
  return src
    .replace(/^ {0,3}(?:`{3,}|~{3,}).*$/gm, "")
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
    // An unordered marker is drawn as `·`, an ordered one keeps its number, so the
    // projection does the same: searching "1." has to find a numbered item.
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1· ")
    .replace(/^ {0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*\|?[ \t:|-]+\|$/gm, "")
    .replace(/\|/g, " ")
    .replace(/\*\*/g, "")
    .replace(/`/g, "");
}
