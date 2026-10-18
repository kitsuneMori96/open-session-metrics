import { useMemo } from "react";
import { useCockpit } from "../state/CockpitContext";
import { useHeatmap } from "../lib/api";
import { compact } from "../lib/format";

const DOW = ["日", "一", "二", "三", "四", "五", "六"];

/** System 3 — circadian spectrogram: dark matrix, depth = token burn. */
export default function ClockHeatmap() {
  const { window } = useCockpit();
  const { data } = useHeatmap(window);

  const { grid, max, insight } = useMemo(() => {
    const g: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    let m = 1;
    for (const c of data?.cells ?? []) {
      g[c.dow][c.hour] = c.tokens;
      m = Math.max(m, c.tokens);
    }
    const share = data?.nightShare ?? 0;
    const peak = data?.peak;
    const insight = peak
      ? `${String(peak.hour).padStart(2, "0")}:00–${String((peak.hour + 1) % 24).padStart(2, "0")}:00 是消耗巅峰 · ${compact(peak.tokens)} TK${
          share > 0.25 ? ` · 夜间占 ${(share * 100).toFixed(0)}%` : ""
        }`
      : "窗口内无活动";
    return { grid: g, max: m, insight };
  }, [data]);

  return (
    <div className="p-2">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="micro">7 × 24 生物钟</span>
        <span className="tape text-ink-faint tabular-nums">{data ? `${data.days}D` : "…"}</span>
      </div>
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: `14px repeat(24, 1fr)` }}>
        {grid.map((row, dow) => (
          <div key={dow} className="contents">
            <div className="tape text-[8px] text-ink-faint leading-[10px]">{DOW[dow]}</div>
            {row.map((v, hour) => {
              const r = Math.min(1, v / max);
              const active = v > 0;
              return (
                <div
                  key={hour}
                  title={`${DOW[dow]} ${String(hour).padStart(2, "0")}:00 · ${compact(v)} TK`}
                  className="h-[10px]"
                  style={{
                    background: active
                      ? `oklch(${0.94 - r * 0.72} ${0.02 + r * 0.1} ${250 - r * 20})`
                      : "oklch(0.93 0.008 240)",
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <span className="micro">LOW</span>
        {[0.08, 0.28, 0.5, 0.72, 0.94].map((v) => (
          <span key={v} className="w-3 h-[6px]" style={{ background: `oklch(${0.94 - v * 0.72} ${0.02 + v * 0.1} 240)` }} />
        ))}
        <span className="micro">HIGH</span>
      </div>
      <p className="tape text-ink leading-[1.4] mt-2 border-t border-rule pt-1.5">{insight}</p>
    </div>
  );
}
