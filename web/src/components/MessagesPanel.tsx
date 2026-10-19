import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { Transcript } from "../lib/api";
import { NEXT_FILTER, buildLines, filterLines, lineMatchesQuery, type LineFilter, type MsgLine } from "../lib/derive";
import { tok } from "../lib/format";
import { useKeys } from "../lib/useKeys";
import { Empty, Mark } from "./ui";

/**
 * The right panel of the Sessions screen in "Messages" mode: the selected session's
 * assistant turns, one row per content item. Tools and reasoning blocks fold out,
 * the filter mirrors the TUI's `f` cycle, and the counter row reports where the
 * viewport sits in the whole transcript.
 */
export default function MessagesPanel({
  transcript,
  isLoading,
  searchQuery,
  active,
}: {
  transcript: Transcript | undefined;
  isLoading: boolean;
  searchQuery: string;
  active: boolean;
}) {
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<LineFilter>("all");
  const [cursor, setCursor] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 0 });

  const scroller = useRef<HTMLDivElement>(null);
  const offsets = useRef<number[]>([]);

  const sessionId = transcript?.session.id;
  useEffect(() => {
    setExpandedTools(new Set());
    setExpandedReasoning(new Set());
    setFilter("all");
    setCursor(0);
    scroller.current?.scrollTo({ top: 0 });
  }, [sessionId]);

  const turns = useMemo(() => transcript?.turns ?? [], [transcript]);
  const allLines = useMemo(
    () => buildLines(turns, expandedTools, expandedReasoning),
    [turns, expandedTools, expandedReasoning]
  );
  const lines = useMemo(() => filterLines(allLines, filter), [allLines, filter]);

  const matches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return lines.reduce<number[]>((acc, line, i) => {
      if (lineMatchesQuery(line, q)) acc.push(i);
      return acc;
    }, []);
  }, [lines, searchQuery]);

  const clampedCursor = Math.min(cursor, Math.max(0, lines.length - 1));
  const cursorLine = lines[clampedCursor];
  const cumTokens = cursorLine?.cumTokens ?? 0;
  const totalTokens = lines[lines.length - 1]?.cumTokens ?? 0;

  /* ---- viewport measurement: the counter row needs the visible span ---- */
  const computeRange = useCallback(() => {
    const el = scroller.current;
    const arr = offsets.current;
    if (!el || arr.length === 0) return setRange({ start: 0, end: 0 });
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    let start = 0;
    let end = arr.length - 1;
    for (let i = 0; i < arr.length; i++) {
      const next = i + 1 < arr.length ? arr[i + 1] : el.scrollHeight;
      if (next > top) {
        start = i;
        break;
      }
    }
    for (let i = start; i < arr.length; i++) {
      if (arr[i] > bottom) break;
      end = i;
    }
    setRange({ start, end });
  }, []);

  /** Line offsets are cached because the counter row needs them on every scroll. */
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const arr: number[] = [];
    for (const node of el.querySelectorAll<HTMLElement>("[data-ln]")) {
      arr[Number(node.dataset.ln)] = node.offsetTop;
    }
    offsets.current = arr;
    computeRange();
  }, [computeRange]);

  useLayoutEffect(() => {
    measure();
  }, [lines, measure]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const onScroll = useCallback(() => {
    requestAnimationFrame(computeRange);
  }, [computeRange]);

  const toggleTool = useCallback((key: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleReasoning = useCallback((id: string) => {
    setExpandedReasoning((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Keep the cursor on screen. */
  const reveal = useCallback((index: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-ln="${index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, []);

  const move = useCallback(
    (next: number) => {
      const target = Math.max(0, Math.min(lines.length - 1, next));
      setCursor(target);
      requestAnimationFrame(() => reveal(target));
    },
    [lines.length, reveal]
  );

  // A query confirmed in the tree lands on the first hit of this transcript; moving
  // the cursor afterwards is not yanked back, because `matches` only changes when the
  // query or the transcript does.
  useEffect(() => {
    if (matches.length === 0) return;
    if (matches.includes(clampedCursor)) return;
    const target = matches[0];
    setCursor(target);
    requestAnimationFrame(() => reveal(target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  const viewHeight = scroller.current?.clientHeight ?? 400;

  useKeys(
    (e) => {
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          return move(clampedCursor + 1);
        case "k":
        case "ArrowUp":
          e.preventDefault();
          return move(clampedCursor - 1);
        case "d":
        case "PageDown":
          e.preventDefault();
          return move(clampedCursor + Math.floor(viewHeight / 2));
        case "u":
        case "PageUp":
          e.preventDefault();
          return move(clampedCursor - Math.floor(viewHeight / 2));
        case "g":
          return move(0);
        case "G":
          return move(lines.length - 1);
        case "f":
          setFilter((prev) => NEXT_FILTER[prev]);
          setCursor(0);
          scroller.current?.scrollTo({ top: 0 });
          return;
        case "Enter":
          if (cursorLine?.kind === "tool") return toggleTool(cursorLine.callId);
          if (cursorLine?.kind === "reasoning-header") return toggleReasoning(cursorLine.reasoningId);
          return;
        default:
          return;
      }
    },
    active && !isLoading
  );

  if (isLoading) return <Empty>Loading transcript…</Empty>;
  if (!transcript) return <Empty>Select a session</Empty>;
  if (lines.length === 0) return <Empty>No messages</Empty>;

  const q = searchQuery.trim().toLowerCase();
  const matchPos = matches.indexOf(clampedCursor);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Counter row, sticky like the TUI's first row */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-1">
        <span className="tape text-ink-faint">
          {range.start + 1}–{Math.min(range.end + 1, lines.length)}/{lines.length}
        </span>
        {totalTokens > 0 && (
          <span className="tape text-ink-faint">
            · <span className="text-flow">{tok(cumTokens)}</span>/{tok(totalTokens)} tok
          </span>
        )}
        {filter !== "all" && <span className="tape text-warning">· {filter}</span>}
        {matches.length > 0 && (
          <span className="tape text-good">
            · {matchPos >= 0 ? `match ${matchPos + 1}/${matches.length}` : `${matches.length} matches`}
          </span>
        )}
        <span className="flex-1" />
        <span className="tape text-ink-faint">{turns.length} turns</span>
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-1 pb-4"
      >
        {lines.map((line, i) => (
          <Row
            key={line.id}
            line={line}
            index={i}
            cursor={active && i === clampedCursor}
            match={q !== "" && matches.includes(i)}
            query={q}
            onSelect={() => {
              setCursor(i);
              if (line.kind === "tool") toggleTool(line.callId);
              else if (line.kind === "reasoning-header") toggleReasoning(line.reasoningId);
            }}
          />
        ))}
      </div>
    </div>
  );
}

const MARKER = (cursor: boolean, match: boolean) => (cursor ? "›" : match ? "◈" : " ");

function Row({
  line,
  index,
  cursor,
  match,
  query,
  onSelect,
}: {
  line: MsgLine;
  index: number;
  cursor: boolean;
  match: boolean;
  query: string;
  onSelect: () => void;
}) {
  const base = clsx("tape flex items-baseline gap-1 px-2", cursor && "bg-ink/[0.055]");
  const marker = (
    <span className={clsx("w-[9px] shrink-0", cursor ? "text-flow" : match ? "text-good" : "text-ink-faint")}>
      {MARKER(cursor, match)}
    </span>
  );

  switch (line.kind) {
    case "header":
      return (
        <div data-ln={index} className={clsx(base, "border-t border-rule/60 mt-2 pt-px")}>
          {marker}
          <span className="shrink-0 text-ink-faint">◆</span>
          <span className={clsx("shrink-0", cursor ? "text-ink" : "text-flow")}>{line.modelId}</span>
          {line.agent && <span className="shrink-0 text-good">[{line.agent}]</span>}
          <span className="flex-1" />
          {line.tokensIn > 0 && (
            <span className="shrink-0 text-ink-faint">
              ↓<span className="text-warning">{tok(line.tokensIn)}</span>
            </span>
          )}
          {line.tokensOut > 0 && (
            <span className="shrink-0 text-ink-faint">
              ↑<span className="text-good">{tok(line.tokensOut)}</span>
            </span>
          )}
          {line.duration && <span className="shrink-0 text-flow">{line.duration}</span>}
          <span className="shrink-0 text-ink-faint">{line.time}</span>
        </div>
      );

    case "tool":
      return (
        <button
          type="button"
          data-ln={index}
          onClick={onSelect}
          className={clsx(base, "w-full text-left hover:bg-ink/[0.03]")}
        >
          {marker}
          <span
            className={clsx(
              "shrink-0",
              line.status === "completed" ? "text-good" : line.status === "error" ? "text-danger" : "text-warning"
            )}
          >
            {line.icon}
          </span>
          <Mark text={line.name} query={query} className={clsx("shrink-0", cursor ? "font-bold text-ink" : "text-ink")} />
          {line.title && (
            <Mark text={line.title} query={query} className="min-w-0 flex-1 truncate text-ink-faint" />
          )}
          <span className="flex-1" />
          {line.truncated && <span className="shrink-0 text-warning">✂</span>}
          <span className="shrink-0 text-ink-faint">{line.expanded ? "▼" : "▶"}</span>
          {line.right && <span className="shrink-0 text-ink-faint">{line.right}</span>}
        </button>
      );

    case "tool-detail":
      if (line.isSection) {
        return (
          <div data-ln={index} className={clsx(base, "pl-6")}>
            {marker}
            <span className="text-ink-soft">── {line.label}</span>
          </div>
        );
      }
      return (
        <div data-ln={index} className={clsx(base, "pl-8")}>
          {marker}
          {line.label ? (
            <>
              <span className="shrink-0 text-flow">{line.label}</span>
              <span className="shrink-0 text-ink-faint">:</span>
              <Mark text={line.value} query={query} className="out min-w-0 flex-1 text-ink" />
            </>
          ) : (
            <Mark text={line.value} query={query} className="out min-w-0 flex-1 text-ink-soft" />
          )}
        </div>
      );

    case "text":
      return (
        <div data-ln={index} className={clsx(base, "items-start")}>
          {marker}
          <Mark text={line.text} query={query} className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink" />
        </div>
      );

    case "reasoning-header":
      return (
        <button
          type="button"
          data-ln={index}
          onClick={onSelect}
          className={clsx(base, "w-full text-left hover:bg-ink/[0.03]")}
        >
          {marker}
          <span className="shrink-0 text-warning">⚡ [reasoning] {line.expanded ? "▼" : "▶"}</span>
          <Mark text={line.preview} query={query} className="min-w-0 flex-1 truncate text-ink-soft" />
          <span className="shrink-0 text-ink-faint">({line.charCount}c)</span>
        </button>
      );

    case "reasoning":
      return (
        <div data-ln={index} className={clsx(base, "items-start", "pl-6")}>
          {marker}
          <span className="shrink-0 text-warning">⚡</span>
          <Mark text={line.text} query={query} className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink-soft" />
        </div>
      );
  }
}
