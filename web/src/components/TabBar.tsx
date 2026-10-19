import clsx from "clsx";
import type { Status } from "../lib/api";
import { clockSec } from "../lib/format";

export type ScreenId = "sessions" | "tools" | "overview";

export const TABS: { id: ScreenId; label: string; key: string }[] = [
  { id: "sessions", label: "Sessions", key: "1" },
  { id: "tools", label: "Tools", key: "2" },
  { id: "overview", label: "Overview", key: "3" },
];

export default function TabBar({
  screen,
  onScreen,
  status,
  onRefresh,
  refreshing,
}: {
  screen: ScreenId;
  onScreen: (s: ScreenId) => void;
  status: Status | undefined;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <header className="hairline-b flex h-8 shrink-0 items-center gap-2 bg-paper-raised/85 px-2 backdrop-blur-[2px]">
      <span className="tape font-bold tracking-[0.18em]">◆ OSM</span>
      <span className="text-ink-faint">│</span>
      {TABS.map((tab) => {
        const active = tab.id === screen;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onScreen(tab.id)}
            className={clsx(
              "tape px-2 py-[3px]",
              active ? "bg-ink font-bold text-paper" : "text-ink-soft hover:bg-ink/5"
            )}
          >
            {tab.key}:{tab.label}
          </button>
        );
      })}
      <div className="flex-1" />
      {status && (
        <span className="tape text-ink-faint">
          {status.counts.sessions} sessions · {status.counts.turns} turns · {status.counts.tools} tools ·{" "}
          {status.counts.parts} parts
        </span>
      )}
      <button
        type="button"
        title="re-materialize from opencode.db"
        onClick={onRefresh}
        className="tape border border-rule px-1.5 py-[2px] text-ink-soft hover:border-rule-strong"
      >
        {refreshing ? "⟳…" : "⟳ r"}
      </button>
      {status && <span className="tape text-ink-faint">synced {clockSec(status.materializedAt)}</span>}
    </header>
  );
}
