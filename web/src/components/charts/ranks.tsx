import { Group } from "@visx/group";
import { Bar as VisxBar } from "@visx/shape";
import { scaleLinear } from "@visx/scale";
import { useState } from "react";
import clsx from "clsx";
import { DANGER, tickIndices, timeTick, timeTooltip, yTicks } from "../../lib/chart";
import { AxisX, AxisY, Figure, Rows, Tip, TipNote, TipTitle, useTip } from "./base";
import { int, tok } from "../../lib/format";
import type { GranularityLike } from "../../lib/chart";

/* ------------------------------------------------------------------ *
 * Ranked bars.
 *
 * The list is the figure: every row's rule is drawn against one shared maximum, so
 * two rows can be compared by eye and the header states the value that fills the
 * track. HTML rather than SVG because the rows are also links — this is the gesture a
 * terminal could not offer at all (click a project, filter the dashboard).
 * ------------------------------------------------------------------ */

const RIGHT2_TONE = { danger: "text-danger", warning: "text-warning" } as const;

export interface RankRow {
  key: string;
  label: string;
  value: number;
  /** Right-aligned readout; defaults to `format(value)`. */
  right?: string;
  /** Right-aligned second readout. It gets a column of its own — see below. */
  right2?: string;
  /** When the second readout is a failure count rather than a value. */
  right2Tone?: "danger" | "warning";
  sub?: string;
  color?: string;
  onClick?: () => void;
  active?: boolean;
}

export function RankBars({
  rows,
  format = (v) => int(v),
  max,
  empty = "no data in this window",
  track = 96,
}: {
  rows: RankRow[];
  format?: (v: number) => string;
  max?: number;
  empty?: string;
  track?: number;
}) {
  const tip = useTip();
  const peak = Math.max(max ?? 0, ...rows.map((r) => r.value), 1);
  if (rows.length === 0) return <div className="tape py-px text-ink-faint">{empty}</div>;

  // Every row is its own grid element, so the tracks have to be spelled out: a
  // `max-content` column is measured per row, which starts the bar at a different x on
  // every line and shifts the readout with it. The data face is monospaced, so `ch` is
  // an exact column width, and a second readout gets a column of its own with the
  // separator between them — otherwise "2,407 · 17s" and "949 · 8.5s" never line up.
  const readout = (r: RankRow) => r.right ?? format(r.value);
  const w1 = Math.max(...rows.map((r) => readout(r).length), 1);
  const split = rows.some((r) => r.right2 !== undefined);
  const w2 = split ? Math.max(...rows.map((r) => r.right2?.length ?? 0), 1) : 0;
  const cols = `minmax(0,1fr) ${track}px ${w1}ch${split ? ` 1ch ${w2}ch` : ""}`;

  return (
    <div className="relative" onMouseLeave={tip.hide}>
      {rows.map((r) => {
        const pct = Math.max(r.value > 0 ? 2 : 0, (r.value / peak) * 100);
        return (
          <button
            key={r.key}
            type="button"
            onClick={r.onClick}
            // Not `disabled`: a disabled control swallows the pointer, and the row's
            // subtitle would then only ever be reachable on rows that happen to be links.
            tabIndex={r.onClick ? undefined : -1}
            aria-disabled={r.onClick ? undefined : true}
            onMouseEnter={
              r.sub
                ? (e) => {
                    const host = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                    tip.show(e.clientX - host.left, e.clientY - host.top, (
                      <>
                        <TipTitle>{r.label}</TipTitle>
                        <TipNote>{r.sub}</TipNote>
                      </>
                    ));
                  }
                : undefined
            }
            className={clsx(
              "grid w-full items-center gap-x-1.5 py-[3px] text-left",
              r.onClick && "cursor-pointer hover:bg-ink/5",
              r.active && "bg-flow/10"
            )}
            style={{ gridTemplateColumns: cols }}
          >
            <span className="tape truncate" style={{ color: r.active ? "var(--color-flow)" : undefined }}>
              {r.label}
            </span>
            <span className="relative block h-[9px] w-full bg-ink/10">
              <i className="absolute inset-y-0 left-0 block" style={{ width: `${pct}%`, background: r.color ?? "var(--color-ink)" }} />
            </span>
            <span className="tape tabular whitespace-nowrap text-right text-ink-soft">{readout(r)}</span>
            {split && <span className="tape text-center text-ink-faint">·</span>}
            {split && (
              <span
                className={clsx(
                  "tape tabular whitespace-nowrap text-right",
                  r.right2Tone ? RIGHT2_TONE[r.right2Tone] : "text-ink-soft"
                )}
              >
                {r.right2 ?? ""}
              </span>
            )}
          </button>
        );
      })}
      <Tip tip={tip.tip} />
    </div>
  );
}

/** States the scale a rank list is drawn against. */
export function RankScale({ label, right }: { label: string; right: string }) {
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <span className="micro">{label}</span>
      <span className="h-px flex-1 bg-rule" />
      <span className="tape text-ink-faint">{right}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Bucketed bars / line over a time axis.
 * ------------------------------------------------------------------ */

export interface TimeValue {
  ts: number;
  value: number;
}

export function TimeBars({
  label,
  values,
  gran,
  color = "var(--color-ink)",
  height = 92,
  mode = "bar",
  format = (v) => tok(v),
  right,
  note,
  xFormat,
}: {
  label: string;
  values: TimeValue[];
  gran: GranularityLike;
  color?: string;
  height?: number;
  mode?: "bar" | "line";
  format?: (v: number) => string;
  right?: React.ReactNode;
  note?: React.ReactNode;
  /**
   * Print a tick from the bucket index instead of the clock. A session's turns all fall
   * inside one hour, so a time axis collapses into a column of identical labels; the row
   * number is the only coordinate the reader actually has.
   */
  xFormat?: (index: number) => string;
}) {
  const [hover, setHover] = useState<{ x: number; y: number; i: number } | null>(null);
  const peak = Math.max(...values.map((v) => v.value), 1);

  return (
    <Figure label={label} height={height} right={right} note={note}>
      {(box) => {
        const { margin, inner, width } = box;
        const plotH = inner.height;
        const n = values.length;
        const x = scaleLinear<number>({ domain: [0, Math.max(1, n - 1)], range: [0, inner.width] });
        const y = scaleLinear<number>({ domain: [0, peak], range: [plotH, 0] });
        const yt = yTicks(peak, 3);
        const labelIdx = tickIndices(n, Math.max(2, Math.floor(inner.width / 76)));
        const step = n > 1 ? inner.width / (n - 1) : inner.width;
        const barW = Math.max(1, Math.min(step * 0.72, 18));

        return (
          <>
            <svg
              width={width}
              height={box.height}
              onMouseLeave={() => setHover(null)}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const px = e.clientX - rect.left - margin.left;
                const i = Math.round((px / Math.max(1, inner.width)) * (n - 1));
                if (i >= 0 && i < n) setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, i });
              }}
            >
              <Group top={margin.top} left={margin.left}>
                <Rows ticks={yt} y={(v) => y(v)} left={0} width={inner.width} />
                {mode === "line" && (
                  <polyline
                    points={values.map((v, i) => `${x(i)},${y(v.value)}`).join(" ")}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                  />
                )}
                {mode === "bar"
                  ? values.map((v, i) => (
                      <VisxBar
                        key={i}
                        x={x(i) - barW / 2}
                        y={y(v.value)}
                        width={barW}
                        height={Math.max(v.value > 0 ? 1 : 0, plotH - y(v.value))}
                        fill={color}
                        fillOpacity={v.value > 0 ? 0.85 : 0}
                      />
                    ))
                  : null}
                <AxisY top={0} left={0} scale={y} tickValues={yt} format={format} />
                <AxisX
                  top={plotH}
                  left={0}
                  scale={x}
                  tickValues={labelIdx}
                  format={(v) => (xFormat ? xFormat(Math.round(v)) : timeTick(values[Math.round(v)]?.ts ?? 0, gran))}
                />
                {hover && (
                  <line className="crosshair" x1={margin.left + x(hover.i)} x2={margin.left + x(hover.i)} y1={margin.top} y2={margin.top + plotH} />
                )}
              </Group>
            </svg>
            <Tip
              tip={
                hover
                  ? {
                      x: hover.x,
                      y: hover.y,
                      node: (
                        <>
                          <TipTitle>{xFormat ? xFormat(hover.i) : timeTooltip(values[hover.i].ts, gran)}</TipTitle>
                          <div className="tip-row">
                            <span className="tip-key">{label}</span>
                            <span className="tip-val">{format(values[hover.i].value)}</span>
                          </div>
                          <TipNote>{n} buckets</TipNote>
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

/* ------------------------------------------------------------------ *
 * Histogram: a distribution, which is the one thing a mean can never show.
 * ------------------------------------------------------------------ */

export function Histogram({
  label,
  bins,
  color = "var(--color-warning)",
  height = 110,
  right,
  note,
}: {
  label: string;
  bins: { label: string; count: number }[];
  color?: string;
  height?: number;
  right?: React.ReactNode;
  note?: React.ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(...bins.map((b) => b.count), 1);
  const total = bins.reduce((a, b) => a + b.count, 0);
  return (
    <Figure label={label} height={height} right={right} note={note}>
      {(box) => {
        const { margin, inner, width } = box;
        const plotH = inner.height - 12;
        const band = inner.width / Math.max(1, bins.length);
        const bw = Math.max(2, band * 0.7);
        const y = scaleLinear<number>({ domain: [0, peak], range: [plotH, 0] });
        return (
          <svg width={width} height={box.height}>
            <Group top={margin.top} left={margin.left}>
              <Rows ticks={yTicks(peak, 2)} y={(v) => y(v)} left={0} width={inner.width} />
              {bins.map((b, i) => (
                <VisxBar
                  key={b.label}
                  x={i * band + (band - bw) / 2}
                  y={y(b.count)}
                  width={bw}
                  height={Math.max(b.count > 0 ? 1 : 0, plotH - y(b.count))}
                  fill={color}
                  fillOpacity={hover === null || hover === i ? 0.85 : 0.3}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              ))}
              <line x1={0} x2={inner.width} y1={plotH} y2={plotH} stroke="var(--color-rule-strong)" strokeWidth={1} />
              {bins.map((b, i) => (
                <text
                  key={b.label}
                  x={i * band + band / 2}
                  y={plotH + 10}
                  textAnchor="middle"
                  fill={hover === i ? "var(--color-ink)" : "var(--color-ink-faint)"}
                  fontSize={8}
                  fontFamily="JetBrains Mono, monospace"
                >
                  {b.label}
                </text>
              ))}
            </Group>
            <Tip
              tip={
                hover === null
                  ? null
                  : {
                      x: margin.left + hover * band + band / 2,
                      y: margin.top + y(bins[hover].count),
                      node: (
                        <>
                          <TipTitle>{bins[hover].label}</TipTitle>
                          <div className="tip-row">
                            <span className="tip-key">calls</span>
                            <span className="tip-val">{int(bins[hover].count)}</span>
                          </div>
                          <div className="tip-row">
                            <span className="tip-key">share</span>
                            <span className="tip-val">{total > 0 ? ((bins[hover].count / total) * 100).toFixed(1) : "0.0"}%</span>
                          </div>
                        </>
                      ),
                    }
              }
            />
          </svg>
        );
      }}
    </Figure>
  );
}

/* ------------------------------------------------------------------ *
 * A change against the previous window, drawn diverging from zero.
 * ------------------------------------------------------------------ */

export function DeltaBar({ delta, width = 46 }: { delta: number; width?: number }) {
  const pct = Math.min(1, Math.abs(delta) / 1);
  const good = delta >= 0;
  return (
    <span className="relative block h-[5px]" style={{ width }}>
      <i className="absolute inset-y-0 left-1/2 w-px" style={{ background: "var(--color-rule-strong)" }} />
      <i
        className="absolute inset-y-0"
        style={{
          background: good ? "var(--color-good)" : DANGER,
          left: good ? "50%" : `${50 - (pct * 50)}%`,
          width: `${pct * 50}%`,
        }}
      />
    </span>
  );
}
