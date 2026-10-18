import { useMemo } from "react";
import { scaleLinear, scaleLog } from "d3-scale";
import { line } from "d3-shape";
import { useFocus, type TimeWindow } from "../lib/api";
import { duration } from "../lib/format";

const W = 244;
const H = 58;

/** Attention focus: gap between two consecutive tool calls (心率仪 style). */
export default function FocusTrace({ window: win }: { window: TimeWindow }) {
  const { data } = useFocus(win);

  const { path, last } = useMemo(() => {
    const series = data?.series ?? [];
    if (series.length < 2) return { path: "", last: null as null | { at: number; gap: number } };
    const x = scaleLinear().domain([series[0].at, series[series.length - 1].at]).range([0, W]);
    const y = scaleLog().domain([0.5, Math.max(60, data!.max)]).range([H - 4, 2]).clamp(true);
    const gen = line<{ at: number; gap: number }>()
      .x((d) => x(d.at))
      .y((d) => y(Math.max(0.5, d.gap)));
    return { path: gen(series) ?? "", last: series[series.length - 1] };
  }, [data]);

  return (
    <div className="p-2">
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block">
        <line x1="0" x2={W} y1={H - 4} y2={H - 4} stroke="oklch(0.2 0.05 250 / 0.3)" />
        <line x1="0" x2={W} y1={15} y2={15} stroke="oklch(0.2 0.05 250 / 0.1)" strokeDasharray="2 3" />
        {path && (
          <path d={path} fill="none" stroke="var(--color-ink)" strokeWidth="1" className="trace-in" style={{ ["--len" as string]: 2400 }} />
        )}
      </svg>
      <div className="grid grid-cols-3 gap-1 mt-1.5 tabular-nums">
        <Stat k="P50" v={duration((data?.p50 ?? 0) * 1000)} />
        <Stat k="P90" v={duration((data?.p90 ?? 0) * 1000)} />
        <Stat k="MAX" v={duration((data?.max ?? 0) * 1000)} />
      </div>
      <div className="flex items-baseline justify-between mt-1.5">
        <span className="tape text-good">专注 {((data?.deepFocusShare ?? 0) * 100).toFixed(0)}%</span>
        <span className="tape text-warning">打断 {((data?.interruptionShare ?? 0) * 100).toFixed(0)}%</span>
        <span className="micro">{data?.count ?? 0} GAPS</span>
      </div>
      {last && (
        <p className="tape text-ink-soft mt-1.5 border-t border-rule pt-1.5 leading-[1.4]">
          最近一次间隔 {duration(last.gap * 1000)} —{" "}
          {last.gap < 15 ? "AI 全自动执行中" : last.gap > 120 ? "你在审查或离开了屏幕" : "人类介入节奏"}
        </p>
      )}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="micro">{k}</div>
      <div className="font-mono font-extralight text-[16px] leading-none">{v}</div>
    </div>
  );
}
