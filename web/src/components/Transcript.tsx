import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import type { Turn } from "../lib/api";
import { clockSec, durInline, int, tok } from "../lib/format";
import { modelColor, shortModel } from "../lib/format";
import {
  buildRows,
  describeParams,
  FILTERS,
  NEXT_FILTER,
  OUT_ROWS,
  rowMatches,
  statusGlyph,
  toolKey,
  type LineFilter,
  type Row,
} from "../lib/transcript";
import { useKeys } from "../lib/useKeys";
import { Chip, Mark } from "./ui";

const ROW_RULE = "var(--color-rule)";

/**
 * The transcript.
 *
 * Same content budget as the TUI's Messages panel — the model header per turn, the
 * assistant's text, a collapsible reasoning block and one row per tool call with its
 * arguments and captured output — but the rows are virtualized, the tool bodies nest
 * instead of being flattened into `input`/`output` lines, and the toolbar carries the
 * count bar the TUI printed as text: which window of rows is on screen, how many match
 * the query, and the cumulative tokens at the cursor.
 */
export default function Transcript({
  turns,
  filter,
  onFilter,
  query,
  onQuery,
  turnRange,
  onTurnRange,
  activeTurn,
  onActiveTurn,
  keyboard = true,
}: {
  turns: Turn[];
  filter: LineFilter;
  onFilter: (f: LineFilter) => void;
  query: string;
  onQuery: (q: string) => void;
  turnRange: [number, number];
  onTurnRange: (r: [number, number]) => void;
  activeTurn?: number | null;
  onActiveTurn?: (i: number | null) => void;
  keyboard?: boolean;
}) {
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => buildRows(turns), [turns]);
  const matched = useMemo(
    () => all.filter((r) => rowMatches(r, filter, query, turnRange[0], turnRange[1])),
    [all, filter, query, turnRange]
  );
  /**
   * A search keeps the header of any turn that still has a hit under it. Without this
   * the result is a column of loose tool rows with no model, no time and no turn number,
   * which is exactly the orientation the header exists to provide.
   */
  const rows = useMemo(() => {
    if (!query.trim()) return matched;
    const survives = new Set(matched.map((r) => r.id));
    const withHit = new Set(matched.filter((r) => r.kind !== "turn").map((r) => r.turnIndex));
    return all.filter((r) => survives.has(r.id) || (r.kind === "turn" && withHit.has(r.turnIndex)));
  }, [all, matched, query]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as number[];
    return rows.map((r, i) => (r.kind === "turn" ? -1 : i)).filter((i) => i >= 0);
  }, [rows, query]);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "tool" || rows[i]?.kind === "reasoning" ? 22 : 34),
    overscan: 16,
  });

  useEffect(() => setCursor(0), [filter, query, turnRange]);

  const toggleReasoning = useCallback((id: string) => {
    setExpandedReasoning((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleTool = useCallback((key: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const move = useCallback(
    (delta: number) => {
      setCursor((c) => {
        const next = Math.max(0, Math.min(rows.length - 1, c + delta));
        virt.scrollToIndex(next, { align: "auto" });
        return next;
      });
    },
    [rows.length, virt]
  );

  const jumpMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches.length === 0) return;
      const at = matches.findIndex((i) => i > cursor);
      const next = dir === 1 ? (at === -1 ? matches[0] : matches[at]) : [...matches].reverse().find((i) => i < cursor) ?? matches[matches.length - 1];
      setCursor(next);
      virt.scrollToIndex(next, { align: "center" });
    },
    [matches, cursor, virt]
  );

  useKeys(
    (e) => {
      if (e.key === "j") return move(1);
      if (e.key === "k") return move(-1);
      if (e.key === "g") return move(-rows.length);
      if (e.key === "G") return move(rows.length);
      if (e.key === "n") return jumpMatch(1);
      if (e.key === "N") return jumpMatch(-1);
      if (e.key === "f") return onFilter(NEXT_FILTER[filter]);
      if (e.key === "Enter") {
        const row = rows[cursor];
        if (row?.kind === "tool" && row.part) return toggleTool(toolKey(row.turn.id, row.part));
        if (row?.kind === "reasoning") return toggleReasoning(row.id);
        return;
      }
      if (e.key === "e" && rows[cursor]?.kind === "turn") {
        onTurnRange([rows[cursor].turnIndex, rows[cursor].turnIndex]);
        return;
      }
      return;
    },
    keyboard
  );

  const setExpandedAll = (open: boolean) => {
    if (!open) {
      setExpandedTools(new Set());
      setExpandedReasoning(new Set());
      return;
    }
    setExpandedTools(new Set(rows.filter((r) => r.kind === "tool" && r.part).map((r) => toolKey(r.turn.id, r.part!))));
    setExpandedReasoning(new Set(rows.filter((r) => r.kind === "reasoning").map((r) => r.id)));
  };

  const cursorRow = rows[Math.min(cursor, rows.length - 1)];
  const first = rows.length ? virt.getVirtualItems()[0]?.index ?? 0 : 0;
  const last = rows.length ? Math.min(rows.length, (virt.getVirtualItems().at(-1)?.index ?? 0) + 1) : 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="hairline-b flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 bg-paper-raised/60 px-2 py-1">
        <span className="micro shrink-0">filter</span>
        {FILTERS.map((f) => (
          <Chip key={f} active={filter === f} onClick={() => onFilter(f)} title={`f cycles filters`}>
            {f}
          </Chip>
        ))}
        <span className="shrink-0 text-rule-strong">│</span>
        <input
          className="field min-w-[140px] flex-1"
          placeholder="search this transcript…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          spellCheck={false}
        />
        {query.trim().length >= 1 && (
          <>
            <span className="tape shrink-0 text-ink-faint">
              {matches.length} match{matches.length === 1 ? "" : "es"} · n/N
            </span>
            <Chip onClick={() => jumpMatch(-1)} title="previous match">
              ▲
            </Chip>
            <Chip onClick={() => jumpMatch(1)} title="next match">
              ▼
            </Chip>
          </>
        )}
        <span className="flex-1" />
        {turnRange[1] - turnRange[0] < turns.length - 1 && (
          <Chip onClick={() => onTurnRange([0, Math.max(0, turns.length - 1)])} title="clear the timeline selection">
            ✕ turns {turnRange[0] + 1}–{turnRange[1] + 1}
          </Chip>
        )}
        <Chip onClick={() => setExpandedAll(true)} title="expand every tool body and reasoning block">
          expand all
        </Chip>
        <Chip onClick={() => setExpandedAll(false)} title="collapse everything">
          collapse
        </Chip>
      </div>

      <div ref={scrollRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="tape p-3 text-ink-faint">no rows match this filter</div>
        ) : (
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={row.id}
                  ref={virt.measureElement}
                  data-index={item.index}
                  className={clsx("absolute left-0 top-0 w-full px-2 py-1", cursor === item.index && "bg-flow/[0.07]")}
                  style={{ transform: `translateY(${item.start}px)`, borderTop: item.index === 0 ? undefined : `1px solid ${ROW_RULE}` }}
                  onClick={() => {
                    setCursor(item.index);
                    if (row.kind === "turn") onActiveTurn?.(row.turnIndex);
                  }}
                >
                  {row.kind === "turn" ? (
                    <TurnHeader row={row} active={activeTurn === row.turnIndex} query={query} />
                  ) : row.kind === "text" ? (
                    <div className="tape max-w-[92ch] whitespace-pre-wrap text-ink">
                      <Mark text={row.text} query={query} />
                    </div>
                  ) : row.kind === "reasoning" ? (
                    <ReasoningRow
                      row={row}
                      open={expandedReasoning.has(row.id)}
                      onToggle={() => toggleReasoning(row.id)}
                      query={query}
                      preview={row.text.slice(0, 120)}
                    />
                  ) : (
                    <ToolRow
                      row={row}
                      open={expandedTools.has(row.part ? toolKey(row.turn.id, row.part) : "")}
                      onToggle={() => row.part && toggleTool(toolKey(row.turn.id, row.part))}
                      query={query}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* the count bar the TUI printed as text, now a live strip */}
      <div className="hairline-t flex h-[22px] shrink-0 items-center gap-3 bg-paper-raised/70 px-2">
        <span className="tape tabular text-ink-faint">
          rows {first + 1}–{last}/{rows.length}
          {rows.length !== all.length && ` of ${all.length}`}
        </span>
        <span className="tape tabular text-ink-faint">Σ {tok(cursorRow?.cumTokens ?? 0)} tok at cursor</span>
        <span className="tape text-ink-faint">filter {filter}</span>
        {query.trim() && (
          <span className="tape text-ink-faint">
            match {matches.filter((i) => i <= cursor).length}/{matches.length}
          </span>
        )}
        <span className="flex-1" />
        <span className="tape text-ink-faint">{turns.length} turns</span>
        <span className="tape text-ink-faint">j/k g/G n/N f ↵</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

function TurnHeader({ row, active, query }: { row: Row; active: boolean; query: string }) {
  const t = row.turn;
  return (
    <div className={clsx("flex flex-wrap items-baseline gap-x-2 gap-y-[2px]", active && "font-semibold")}>
      <span className="tape tabular shrink-0 text-ink-faint">#{row.turnIndex + 1}</span>
      <span className="tape shrink-0 tabular text-ink-soft">{clockSec(t.created)}</span>
      <span className="flex shrink-0 items-center gap-1">
        <i className="block h-[7px] w-[7px]" style={{ background: modelColor(t.model) }} />
        <span className="tape" title={t.model}>
          <Mark text={shortModel(t.model)} query={query} />
        </span>
      </span>
      {t.agent && <span className="tape shrink-0 text-ink-faint">{t.agent}</span>}
      <span className="tape shrink-0 text-ink-faint">{durInline(t.durMs)}</span>
      <span className="tape tabular shrink-0 text-ink-faint" title="prompt tokens (input + cache read)">
        in {tok(t.tokens.input + t.tokens.cacheRead)}
      </span>
      <span className="tape tabular shrink-0 text-ink-faint" title="output tokens">
        out {tok(t.tokens.output)}
      </span>
      {t.tokens.reasoning > 0 && (
        <span className="tape tabular shrink-0 text-ink-faint" title="reasoning tokens">
          think {tok(t.tokens.reasoning)}
        </span>
      )}
      <span className="tape tabular shrink-0 text-ink-faint" title="cumulative input+cache+output">
        Σ {tok(row.cumTokens)}
      </span>
      <span className="tape tabular shrink-0 text-ink-faint">{t.cost > 0 ? `$${t.cost.toFixed(4)}` : ""}</span>
      {t.finish && t.finish !== "stop" && <span className="tape shrink-0 text-warning">{t.finish}</span>}
      {t.errors > 0 && <span className="tape shrink-0 text-danger">{t.errors}×</span>}
      {t.additions + t.deletions > 0 && (
        <span className="tape shrink-0">
          <span className="text-good">+{t.additions}</span> <span className="text-danger">−{t.deletions}</span>
        </span>
      )}
    </div>
  );
}

function ReasoningRow({
  row,
  open,
  onToggle,
  preview,
  query,
}: {
  row: Row;
  open: boolean;
  onToggle: () => void;
  preview: string;
  query: string;
}) {
  return (
    <div className="border-l-2 border-rule pl-2">
      <button type="button" onClick={onToggle} className="flex w-full items-baseline gap-2 text-left hover:bg-ink/5">
        <span className="tape shrink-0 text-ink-faint">{open ? "▾" : "▸"} reasoning</span>
        <span className="tape min-w-0 truncate text-ink-soft">{open ? "" : <Mark text={preview} query={query} />}</span>
        <span className="tape shrink-0 text-ink-faint">{int(row.text.length)} chars</span>
      </button>
      {open && (
        <div className="tape max-w-[92ch] whitespace-pre-wrap pt-1 text-ink-soft">
          <Mark text={row.text} query={query} />
        </div>
      )}
    </div>
  );
}

function ToolRow({ row, open, onToggle, query }: { row: Row; open: boolean; onToggle: () => void; query: string }) {
  if (!row.part) return null;
  const p = row.part;
  const error = p.status === "error";
  const outLines = (p.output ?? "").split("\n");
  const shown = outLines.slice(0, OUT_ROWS);
  const [showAllParams, setShowAllParams] = useState<Record<string, boolean>>({});
  const params = describeParams(p.input);

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 text-left hover:bg-ink/5"
      >
        <span className={clsx("tape shrink-0", error ? "text-danger" : p.status === "completed" ? "text-good" : "text-warning")}>
          {statusGlyph(p.status)} {p.name}
        </span>
        <span className="tape min-w-0 flex-1 truncate text-ink-soft">
          <Mark text={p.title ?? ""} query={query} />
        </span>
        {p.exitCode !== null && p.exitCode !== 0 && <span className="tape shrink-0 text-danger">exit {p.exitCode}</span>}
        {p.started && p.ended && <span className="tape shrink-0 tabular text-ink-faint">{durInline(p.ended - p.started)}</span>}
        <span className="tape shrink-0 tabular text-ink-faint">{int(p.chars)} ch</span>
        <span className="tape shrink-0 text-ink-faint">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-1 ml-3 border-l border-rule pl-2">
          {params.length > 0 && (
            <>
              <div className="micro mb-1">arguments</div>
              <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3">
                {params.map(({ key, value }) => {
                  const long = value.includes("\n") || value.length > 200;
                  const body = showAllParams[key] || !long ? value : `${value.slice(0, 200)}…`;
                  return (
                    <div key={key} className="contents">
                      <span className="tape whitespace-nowrap text-ink-soft">{key}</span>
                      <span className="tape min-w-0 whitespace-pre-wrap break-words text-ink">
                        <Mark text={body} query={query} />
                        {long && (
                          <button
                            type="button"
                            className="tape ml-2 text-flow underline"
                            onClick={() => setShowAllParams((prev) => ({ ...prev, [key]: !prev[key] }))}
                          >
                            {showAllParams[key] ? "less" : `+${int(value.length - 200)} chars`}
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {(p.output ?? "").trim() !== "" && (
            <>
              <div className="micro mt-2 mb-1 flex items-center gap-2">
                output
                <span className="text-ink-faint">
                  {shown.length}/{outLines.length} lines
                  {p.truncated ? " · truncated at capture" : ""}
                </span>
                <button
                  type="button"
                  className="tape text-flow underline"
                  onClick={() => void navigator.clipboard?.writeText(p.output)}
                >
                  copy
                </button>
              </div>
              <pre className="out max-h-[320px] overflow-auto border border-rule bg-paper/60 p-2 text-[10px] leading-[1.45]">
                {shown.join("\n")}
                {outLines.length > shown.length ? `\n… ${int(outLines.length - shown.length)} more lines (capture is capped at ${int(p.chars)} chars)` : ""}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
