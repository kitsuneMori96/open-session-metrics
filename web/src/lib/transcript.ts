import type { Part, ToolPart, Turn } from "./api";

/**
 * The transcript as a flat list of rows.
 *
 * opencode-top had to flatten a tool call into individual lines — one row per argument,
 * one per output row — because a terminal row is the only unit it has. A browser can
 * nest, so a tool call stays a single row with a body that opens under it. The list is
 * therefore short enough to virtualize, and "jump to the next match" means scrolling to
 * a row index rather than repainting a viewport.
 */

export type RowKind = "turn" | "text" | "reasoning" | "tool";

export interface Row {
  id: string;
  kind: RowKind;
  turn: Turn;
  turnIndex: number;
  text: string;
  part: ToolPart | null;
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

export function buildRows(turns: Turn[]): Row[] {
  const rows: Row[] = [];
  let cum = 0;
  turns.forEach((turn, turnIndex) => {
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
  return rows;
}

/** A turn header always survives a filter, the way the TUI kept its headers. */
export function rowMatches(row: Row, filter: LineFilter, query: string, from: number, to: number): boolean {
  if (row.turnIndex < from || row.turnIndex > to) return false;
  if (filter !== "all" && row.kind !== "turn") {
    if (filter === "errors" && !(row.part && row.part.status === "error")) return false;
    if (filter === "tools" && row.kind !== "tool") return false;
    if (filter === "text" && row.kind !== "text") return false;
  }
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return searchText(row).includes(q);
}

export function searchText(row: Row): string {
  switch (row.kind) {
    case "text":
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
 * These are text glyphs, so only glyphs the shipped mono cut actually carries may be
 * used: JetBrains Mono has no U+2713/U+2717/U+25CC, and a browser that cannot find a
 * glyph silently substitutes another typeface — on one machine a mono fallback, on
 * another a proportional symbol face, mid-line. `✓` and `◌` come from that font stack
 * too, but `×` (U+00D7) is in the cut, so the failure mark is a real multiplication
 * sign rather than a substituted ballot X.
 */
export const statusGlyph = (status: string): string => (status === "completed" ? "✓" : status === "error" ? "×" : "◌");
