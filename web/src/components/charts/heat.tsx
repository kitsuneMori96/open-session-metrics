import { useState } from "react";
import { int } from "../../lib/format";
import { Figure, Tip, TipTitle } from "./base";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Weekday × hour activity.
 *
 * This is the one figure that needs the browser: a 7×24 grid of measures has nowhere
 * to live in a terminal, and it answers a question no table does — when do I actually
 * work? Rows are weekdays, columns are local hours, and the cell is shaded by traffic.
 */
export function ActivityHeatmap({
  heat,
  label = "when the work happens",
  right,
  height = 152,
  measure = (v: number) => `${int(v)} turns`,
}: {
  heat: number[][];
  label?: string;
  right?: React.ReactNode;
  height?: number;
  measure?: (v: number) => string;
}) {
  const [hover, setHover] = useState<{ x: number; y: number; d: number; h: number } | null>(null);
  const peak = Math.max(1, ...heat.flat());
  const maxByHour = Array.from({ length: 24 }, (_, h) => Math.max(0, ...heat.map((row) => row[h] ?? 0)));

  return (
    <Figure
      label={label}
      height={height}
      right={right}
      note={
        <>
          peak {int(peak)} turns in one weekday-hour · column shading is per hour, so a
          quiet evening hour still shows its own shape
        </>
      }
    >
      {(box) => {
        const { margin, inner, width } = box;
        const rowH = inner.height / 7;
        const colW = inner.width / 24;
        return (
          <>
            <svg width={width} height={box.height} onMouseLeave={() => setHover(null)}>
              {heat.map((row, d) =>
                row.map((v, h) => {
                  const top = Math.max(0, maxByHour[h]);
                  const t = top > 0 ? v / top : 0;
                  const on = hover?.d === d && hover?.h === h;
                  return (
                    <rect
                      key={`${d}-${h}`}
                      x={margin.left + h * colW + 0.5}
                      y={margin.top + d * rowH + 0.5}
                      width={Math.max(1, colW - 1)}
                      height={Math.max(1, rowH - 1)}
                      fill={v > 0 ? "var(--color-flow)" : "var(--color-rule)"}
                      fillOpacity={v > 0 ? 0.14 + t * 0.78 : 0.5}
                      stroke={on ? "var(--color-ink)" : "transparent"}
                      strokeWidth={1}
                      onMouseEnter={(e) => {
                        const rect = (e.target as SVGRectElement).ownerSVGElement!.getBoundingClientRect();
                        setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, d, h });
                      }}
                    />
                  );
                })
              )}
              {DAYS.map((d, i) => (
                <text
                  key={d}
                  x={margin.left - 6}
                  y={margin.top + i * rowH + rowH / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={8}
                  fontFamily="JetBrains Mono, monospace"
                  fill="var(--color-ink-faint)"
                >
                  {d}
                </text>
              ))}
              {[0, 3, 6, 9, 12, 15, 18, 21, 23].map((h) => (
                <text
                  key={h}
                  x={margin.left + h * colW + colW / 2}
                  y={margin.top + 7 * rowH + 10}
                  textAnchor="middle"
                  fontSize={8}
                  fontFamily="JetBrains Mono, monospace"
                  fill="var(--color-ink-faint)"
                >
                  {String(h).padStart(2, "0")}
                </text>
              ))}
            </svg>
            <Tip
              width={width}
              tip={
                hover
                  ? {
                      x: hover.x,
                      y: hover.y,
                      node: (
                        <>
                          <TipTitle>
                            {DAYS[hover.d]} {String(hover.h).padStart(2, "0")}:00
                          </TipTitle>
                          <div className="tip-row">
                            <span className="tip-key">traffic</span>
                            <span className="tip-val">{measure(heat[hover.d][hover.h])}</span>
                          </div>
                          <div className="tip-row">
                            <span className="tip-key">share of week</span>
                            <span className="tip-val">
                              {peak > 0 ? ((heat[hover.d][hover.h] / heat.flat().reduce((a, b) => a + b, 0)) * 100).toFixed(1) : "0.0"}%
                            </span>
                          </div>
                        </>
                      ),
                    }
                  : null
              }
            />
          </>
        );
      }}
    </Figure>
  );
}

/** 24-hour profile as a single row of columns, for the corner of a panel. */
export function HourStrip({ hourly, color = "var(--color-good)", height = 34 }: { hourly: number[]; color?: string; height?: number }) {
  const peak = Math.max(1, ...hourly);
  return (
    <div className="flex items-end gap-px" style={{ height }}>
      {hourly.map((v, h) => (
        <i
          key={h}
          title={`${String(h).padStart(2, "0")}:00 — ${int(v)} turns`}
          className="flex-1"
          style={{ height: `${Math.max(v > 0 ? 4 : 0, (v / peak) * 100)}%`, background: v > 0 ? color : "var(--color-rule)" }}
        />
      ))}
    </div>
  );
}
