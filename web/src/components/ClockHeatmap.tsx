import { useMemo } from "react";
import { useCockpit } from "../state/CockpitContext";
import { useHeatmap } from "../lib/api";
import { compact } from "../lib/format";

const DOW = ["一", "二", "三", "四", "五", "六", "日"];

/** System 3 — circadian spectrogram: 7×24 matrix, depth = generated tokens. */
export default function ClockHeatmap() {
  const { window } = useCockpit();
  const { data } = useHeatmap(window);

  const { grid, max, cacheMax, insight } = useMemo(() => {
    const g: { gen: number; cache: number }[][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => ({ gen: 0, cache: 0 }))
    );
    let m = 1;
    let cm = 1;
    for (const c of data?.cells ?? []) {
      const cell = g[c.dow]?.[c.hour];
      if (!cell) continue;
      cell.gen = c.gen;
      cell.cache = c.cache;
      m = Math.max(m, c.gen);
      cm = Math.max(cm, c.cache);
    }
    return { grid: g, max: m, cacheMax: cm, insight: data?.insight ?? "窗口内无生成活动" };
  }, [data]);

  return (
    <div className="p-2">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="micro">7 × 24 生物钟</span>
        <span className="tape text-ink-faint tabular-nums">
          {data ? `${data.days}D · ${compact(data.totalTokens)} GEN` : "…"}
        </span>
      </div>
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: `14px repeat(24, 1fr)` }}>
        {grid.map((row, dow) => (
          <div key={dow} className="contents">
            <div className="tape text-[8px] text-ink-faint leading-[10px]">{DOW[dow]}</div>
            {row.map((cell, hour) => {
              // A single huge peak flattens everything else under a linear ramp,
              // so burn depth is read on a gamma curve.
              const r = Math.pow(Math.min(1, cell.gen / max), 0.45);
              const active = cell.gen > 0;
              const night = hour >= 22 || hour < 2;
              return (
                <div
                  key={hour}
                  title={`${DOW[dow]} ${String(hour).padStart(2, "0")}:00 · 生成 ${compact(cell.gen)} TK · 缓存 ${compact(cell.cache)} TK`}
                  className="h-[10px]"
                  style={{
                    background: active
                      ? `oklch(${0.94 - r * 0.72} ${0.02 + r * 0.1} ${250 - r * 20})`
                      : night
                        ? "oklch(0.9 0.012 270)"
                        : "oklch(0.93 0.008 240)",
                    boxShadow:
                      active && cell.cache / cacheMax > 0.8 ? "inset 0 0 0 1px oklch(0.55 0.22 25 / 0.55)" : undefined,
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
          <span
            key={v}
            className="w-3 h-[6px]"
            style={{
              background: `oklch(${0.94 - Math.pow(v, 0.45) * 0.72} ${0.02 + Math.pow(v, 0.45) * 0.1} 240)`,
            }}
          />
        ))}
        <span className="micro">HIGH</span>
      </div>
      <p className="tape text-ink leading-[1.4] mt-2 border-t border-rule pt-1.5">{insight}</p>
      <p className="micro mt-1 opacity-70">红框 = 该时段缓存读也接近峰值</p>
    </div>
  );
}
