import { useCockpit } from "../state/CockpitContext";
import { useOverview } from "../lib/api";
import { compact, money } from "../lib/format";
import TimeScrubber from "./TimeScrubber";
import clsx from "clsx";

export default function TopBar() {
  const { window, setWindow, mode, setMode, trayOpen, setTrayOpen } = useCockpit();
  const { data } = useOverview(window);
  const totals = data?.totals;

  return (
    <header className="h-[50px] shrink-0 hairline-b bg-paper flex items-stretch">
      <div className="flex items-center gap-3 px-3 border-r border-rule">
        <div className="leading-none">
          <div className="font-mono font-extralight text-[26px] tracking-[-0.03em]">SESSION</div>
          <div className="micro -mt-[3px]">METRICS</div>
        </div>
        <div className="w-px h-7 bg-rule" />
        <div className="leading-none">
          <div className="micro">TOTAL COST</div>
          <div
            className={clsx(
              "font-mono font-extralight text-[26px] leading-[1.05] tabular-nums",
              (totals?.cost ?? 0) > 0 ? "text-ink" : "text-ink-faint"
            )}
          >
            {money(totals?.cost ?? 0)}
          </div>
        </div>
        <div className="leading-none">
          <div className="micro">TOKENS GEN</div>
          <div className="font-mono font-extralight text-[26px] leading-[1.05] tabular-nums text-flow">
            {compact(totals?.generated ?? 0)}
          </div>
        </div>
        <div className="leading-none">
          <div className="micro">CACHE READ</div>
          <div className="font-mono font-extralight text-[26px] leading-[1.05] tabular-nums text-ink-faint">
            {compact(totals?.cache_read ?? 0)}
          </div>
        </div>
      </div>

      <nav className="flex items-end gap-0 px-2 border-r border-rule">
        {(
          [
            ["ecg", "心电图 / ECG"],
            ["anatomy", "会话解剖 / ANATOMY"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className={clsx(
              "tape px-2 py-1 border-b-2 -mb-px transition-colors",
              mode === key ? "border-ink text-ink" : "border-transparent text-ink-faint hover:text-ink-soft"
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="flex-1 flex items-center justify-end pr-3 gap-4">
        <TimeScrubber window={window} onChange={setWindow} />
        <button
          type="button"
          onClick={() => setTrayOpen(!trayOpen)}
          className={clsx(
            "tape px-2 py-1 border h-[26px]",
            trayOpen ? "bg-ink text-paper border-ink" : "border-rule text-ink-soft hover:border-rule-strong"
          )}
        >
          沙盘 / TRAY
        </button>
      </div>
    </header>
  );
}
