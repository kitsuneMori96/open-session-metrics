import { useCallback, useMemo, useState } from "react";
import clsx from "clsx";
import { useTools } from "../lib/api";
import { durTool } from "../lib/format";
import { useKeys } from "../lib/useKeys";
import StatusBar from "../components/StatusBar";
import { Empty, SectionHeader, SegBar, StatRow } from "../components/ui";

type SortKey = "calls" | "failures" | "avgTime";
const SORTS: { id: SortKey; label: string }[] = [
  { id: "calls", label: "calls" },
  { id: "failures", label: "failures" },
  { id: "avgTime", label: "avg-time" },
];

/**
 * Screen 2. Every tool the agent has ever called, aggregated over all sessions:
 * how often it is used, how often it fails, how long it takes, and the newest
 * errors it produced.
 */
export default function ToolsScreen({ active }: { active: boolean }) {
  const { data, isLoading } = useTools();
  const tools = useMemo(() => data?.tools ?? [], [data]);
  const [sortKey, setSortKey] = useState<SortKey>("calls");
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const copy = [...tools];
    if (sortKey === "failures") return copy.sort((a, b) => b.failures - a.failures || b.calls - a.calls);
    if (sortKey === "avgTime") return copy.sort((a, b) => b.avgDurationMs - a.avgDurationMs);
    return copy.sort((a, b) => b.calls - a.calls);
  }, [tools, sortKey]);

  const selectedIndex = Math.max(0, sorted.findIndex((t) => t.name === selectedName));
  const selected = sorted[selectedIndex] ?? null;

  const move = useCallback(
    (delta: number) => {
      const next = sorted[Math.max(0, Math.min(sorted.length - 1, selectedIndex + delta))];
      if (next) setSelectedName(next.name);
    },
    [sorted, selectedIndex]
  );

  useKeys(
    (e) => {
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        return move(1);
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        return move(-1);
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setSortKey((k) => (k === "calls" ? "failures" : k === "failures" ? "avgTime" : "calls"));
        return;
      }
      if (e.key === "g") return setSelectedName(sorted[0]?.name ?? null);
      if (e.key === "G") return setSelectedName(sorted[sorted.length - 1]?.name ?? null);
      return;
    },
    active
  );

  if (isLoading && tools.length === 0) return <Empty>Loading tools…</Empty>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="hairline-b flex h-[26px] shrink-0 items-center gap-2 px-2">
        <span className="tape font-bold tracking-[0.1em]">◆ TOOLS</span>
        <span className="flex-1" />
        <span className="tape text-ink-faint">sort:</span>
        {SORTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSortKey(s.id)}
            className={clsx("tape px-1", sortKey === s.id ? "bg-ink font-bold text-paper" : "text-ink-faint hover:text-ink")}
          >
            {s.label}
          </button>
        ))}
        <span className="tape text-ink-faint">Tab:cycle</span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="hairline-r flex min-h-0 w-[320px] shrink-0 flex-col">
          <div className="hairline-b flex shrink-0 items-center gap-2 px-2 py-[3px]">
            <span className="micro flex-1">tool</span>
            <span className="micro w-[54px] text-right">calls</span>
            <span className="micro w-[40px] text-right">err</span>
          </div>
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto pb-2">
            {sorted.map((t) => {
              const sel = t.name === selected?.name;
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => setSelectedName(t.name)}
                  className={clsx(
                    "flex w-full items-baseline gap-2 px-2 py-[3px] text-left",
                    sel ? "bg-ink text-paper" : "text-ink hover:bg-ink/[0.045]"
                  )}
                >
                  <span className={clsx("tape w-[10px] shrink-0", sel ? "text-paper" : "text-ink-faint")}>
                    {sel ? "▶" : ""}
                  </span>
                  <span className={clsx("tape min-w-0 flex-1 truncate", sel && "font-bold")}>{t.name}</span>
                  <span className={clsx("tape w-[54px] shrink-0 text-right", sel ? "text-paper" : "text-ink-soft")}>
                    {t.calls}
                  </span>
                  <span
                    className={clsx(
                      "tape w-[40px] shrink-0 text-right",
                      sel ? "text-paper" : t.failures > 0 ? "text-danger" : "text-ink-faint"
                    )}
                  >
                    {t.failures}
                  </span>
                </button>
              );
            })}
            {sorted.length === 0 && <Empty>No tool data yet</Empty>}
          </div>
        </div>

        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {selected ? (
            <div className="max-w-[620px]">
              <div className="tape truncate font-bold">{selected.name}</div>

              <SectionHeader title="stats" />
              <StatRow label="Total calls" value={selected.calls} />
              <StatRow label="Successes" value={selected.successes} tone="good" />
              <StatRow
                label="Failures"
                value={selected.failures}
                tone={selected.failures > 0 ? "danger" : "faint"}
              />
              <StatRow label="Avg time" value={durTool(selected.avgDurationMs)} tone="flow" />

              <div className="mt-2 flex items-baseline gap-2">
                <span className="tape text-ink-soft">success rate</span>
                <SuccessBar successes={selected.successes} calls={selected.calls} />
              </div>

              {selected.recentErrors.length > 0 && (
                <>
                  <SectionHeader title="recent errors" />
                  {selected.recentErrors.map((err, i) => (
                    <div key={i} className="flex items-baseline gap-2 py-px">
                      <span className="tape shrink-0 text-danger">✗</span>
                      <span className="tape min-w-0 flex-1 break-words text-ink-soft">{err}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          ) : (
            <Empty>No tools found. Run some OpenCode sessions first.</Empty>
          )}
        </div>
      </div>

      <StatusBar hints="j/k:nav  Tab:cycle-sort  1:sessions  3:overview" info={`${tools.length} tools`} />
    </div>
  );
}

/** Success ratio in cells: green through 90 %, amber through 70 %, red below. */
function SuccessBar({ successes, calls, total = 12 }: { successes: number; calls: number; total?: number }) {
  const ratio = calls > 0 ? successes / calls : 0;
  const tone = ratio >= 0.9 ? "var(--color-good)" : ratio >= 0.7 ? "var(--color-warning)" : "var(--color-danger)";
  return (
    <span className="flex items-baseline gap-2">
      <SegBar filled={Math.round(ratio * total)} total={total} tone={tone} />
      <span className="tape text-ink-faint">{Math.round(ratio * 100)}%</span>
    </span>
  );
}
