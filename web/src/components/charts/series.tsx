import { useMemo, useRef, useState } from "react";
import { Group } from "@visx/group";
import { AreaClosed, AreaStack, LinePath } from "@visx/shape";
import { Brush } from "@visx/brush";
import { curveLinear } from "@visx/curve";
import { scaleLinear } from "@visx/scale";
import type { Bucket } from "../../lib/api";
import { RULE, RULE_STRONG, SOFT, granLabel, tickIndices, timeTick, timeTooltip, yTicks, type GranularityLike } from "../../lib/chart";
import { AxisX, AxisY, Figure, Rows, Tip, TipNote, TipTitle, type Box } from "./base";
import { tok } from "../../lib/format";

export interface SeriesKey {
  key: string;
  label: string;
  color: string;
}

/* ------------------------------------------------------------------ *
 * Sparkline: the shape of a KPI, sized for a tile.
 * ------------------------------------------------------------------ */

export function Sparkline({
  values,
  color = "var(--color-flow)",
  height = 20,
  strokeWidth = 1.25,
}: {
  values: number[];
  color?: string;
  height?: number;
  strokeWidth?: number;
}) {
  if (values.length < 2) return <div style={{ height }} />;
  const w = 100;
  const max = Math.max(...values, 1);
  const x = scaleLinear<number>({ domain: [0, values.length - 1], range: [0, w] });
  const y = scaleLinear<number>({ domain: [0, max], range: [height - 1, 1] });
  const points = values.map((v, i) => [x(i), y(v)] as [number, number]);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden>
      <AreaClosed
        data={points}
        x={(d) => d[0]}
        y={(d) => d[1]}
        yScale={scaleLinear({ domain: [0, height], range: [height, 0] })}
        curve={curveLinear}
        fill={color}
        fillOpacity={0.14}
      />
      <LinePath data={points} x={(d) => d[0]} y={(d) => d[1]} stroke={color} strokeWidth={strokeWidth} curve={curveLinear} />
    </svg>
  );
}

interface Hover {
  /** Pointer position inside the figure container. */
  x: number;
  y: number;
  index: number;
}

/* ------------------------------------------------------------------ *
 * Stacked time series with a brush.
 *
 * The brush is the dashboard's primary gesture: dragging it commits a new window to
 * the URL, so every figure, table and screen re-renders against the range the pointer
 * just described. visx's Brush reports bounds in scale units — bucket indices here —
 * so no timestamp arithmetic and no off-by-one at the bucket edges.
 * ------------------------------------------------------------------ */

const DEFAULT_HEIGHT = 168;

export function TimeArea({
  buckets,
  keys,
  gran,
  onWindow,
  onWindowIndex,
  onPointClick,
  windowLabel,
  onClearWindow,
  height = DEFAULT_HEIGHT,
  tipExtra,
  active,
  format = tok,
  label = "token flow",
  caption,
  xFormat,
}: {
  buckets: Bucket[];
  keys: SeriesKey[];
  gran: GranularityLike;
  /** How a stacked value is printed: tokens, dollars, counts. */
  format?: (v: number) => string;
  /** Commit a brushed window; receives epoch ms snapped outward to bucket edges. */
  onWindow?: (from: number, to: number) => void;
  /**
   * The same gesture in bucket units. A window is the right answer for a time series,
   * but a transcript wants the rows the brush covers, and only the caller knows that.
   */
  onWindowIndex?: (from: number, to: number) => void;
  /** A plain click on the plot, in bucket units. */
  onPointClick?: (index: number) => void;
  windowLabel?: string;
  onClearWindow?: () => void;
  height?: number;
  tipExtra?: (b: Bucket, i: number) => { label: string; value: string }[];
  /** Series the legend has switched off. */
  active?: Set<string>;
  label?: React.ReactNode;
  /** Replaces the granularity word on the right of the caption. */
  caption?: React.ReactNode;
  /**
   * Print a tick from the bucket index instead of the clock. A session's turns all fall
   * inside one hour, so a time axis collapses into a column of identical labels; the row
   * number is the only coordinate the reader actually has.
   */
  xFormat?: (index: number) => string;
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const shown = useMemo(() => keys.filter((k) => !active || active.has(k.key)), [keys, active]);
  const data = useMemo(
    () =>
      buckets.map((b, i) => {
        const row: Record<string, number> = { i, ts: b.ts };
        for (const k of shown) row[k.key] = (b[k.key as keyof Bucket] as number) || 0;
        return row;
      }),
    [buckets, shown]
  );
  const totals = useMemo(
    () => buckets.map((b) => shown.reduce((sum, k) => sum + ((b[k.key as keyof Bucket] as number) || 0), 0)),
    [buckets, shown]
  );
  const peak = Math.max(...totals, 0);

  return (
    <Figure
      label={label}
      height={height}
      right={
        <span className="flex items-center gap-2">
          {windowLabel && onClearWindow && (
            <button type="button" className="btn" onClick={onClearWindow} title="clear the brushed window">
              ✕ {windowLabel}
            </button>
          )}
          <span>{caption ?? granLabel(gran)}</span>
        </span>
      }
      note={peak === 0 ? "no assistant traffic in this window" : undefined}
    >
      {(box: Box) => {
        const { margin, inner, width } = box;
        const plotH = inner.height;
        const x = scaleLinear<number>({ domain: [0, Math.max(1, buckets.length - 1)], range: [0, inner.width] });
        const y = scaleLinear<number>({ domain: [0, Math.max(peak, 1)], range: [plotH, 0] });
        const yt = yTicks(Math.max(peak, 1), 4);
        const labelIdx = tickIndices(buckets.length, Math.max(2, Math.floor(inner.width / 76)));

        /** Bucket under a client x, or null outside the plot. */
        const indexAt = (clientX: number): number | null => {
          const rect = svgRef.current?.getBoundingClientRect();
          if (!rect || buckets.length === 0) return null;
          const px = clientX - rect.left - margin.left;
          const i = Math.round((px / Math.max(1, inner.width)) * (buckets.length - 1));
          return i < 0 || i >= buckets.length ? null : i;
        };

        const move = (e: React.PointerEvent<SVGRectElement>) => {
          const rect = svgRef.current?.getBoundingClientRect();
          const i = indexAt(e.clientX);
          if (!rect || i === null) {
            setHover(null);
            return;
          }
          setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, index: i });
        };

        return (
          <>
            <svg
              ref={svgRef}
              width={width}
              height={box.height}
              role="img"
              onMouseLeave={() => setHover(null)}
              onClick={
                onPointClick && !(onWindow || onWindowIndex)
                  ? (e) => {
                      const i = indexAt(e.clientX);
                      if (i !== null) onPointClick(i);
                    }
                  : undefined
              }
            >
              <Group top={margin.top} left={margin.left}>
                <Rows ticks={yt} y={(v) => y(v)} left={0} width={inner.width} />
                <AreaStack<Record<string, number>>
                  data={data}
                  keys={shown.map((k) => k.key)}
                  x={(d) => x(d.data.i)}
                  y0={(d) => y(d[0])}
                  y1={(d) => y(d[1])}
                  curve={curveLinear}
                >
                  {({ stacks, path }) =>
                    stacks.map((s) => {
                      const key = shown.find((k) => k.key === s.key);
                      return (
                        <path
                          key={s.key}
                          d={path(s) as string}
                          fill={key?.color ?? SOFT}
                          fillOpacity={0.42}
                          stroke={key?.color ?? SOFT}
                          strokeWidth={1}
                        />
                      );
                    })
                  }
                </AreaStack>
                <AxisY top={0} left={0} scale={y} tickValues={yt} format={format} />
                <AxisX
                  top={plotH}
                  left={0}
                  scale={x}
                  tickValues={labelIdx}
                  format={(v) => (xFormat ? xFormat(Math.round(v)) : timeTick(buckets[Math.round(v)]?.ts ?? 0, gran))}
                />
              </Group>
              {hover && (
                <line
                  className="crosshair"
                  x1={margin.left + x(hover.index)}
                  x2={margin.left + x(hover.index)}
                  y1={margin.top}
                  y2={margin.top + plotH}
                />
              )}
              {(onWindow || onWindowIndex) && buckets.length > 1 && (
                <Brush
                  xScale={x}
                  yScale={y}
                  width={width}
                  height={box.height}
                  margin={margin}
                  brushDirection="horizontal"
                  // `xAxis` would place the strip in the axis band *below* the plot, outside
                  // the svg viewport and therefore unclickable; the chart body is the target.
                  brushRegion="chart"
                  resizeTriggerAreas={["left", "right"]}
                  handleSize={6}
                  resetOnEnd={false}
                  useWindowMoveEvents
                  selectedBoxStyle={{
                    fill: "var(--color-ink)",
                    fillOpacity: 0.07,
                    stroke: RULE_STRONG,
                    strokeWidth: 1,
                    strokeDasharray: "2 2",
                  }}
                  onMouseMove={move}
                  onMouseLeave={() => setHover(null)}
                  onClick={(e) => {
                    const i = indexAt(e.clientX);
                    if (i !== null) onPointClick?.(i);
                  }}
                  onBrushEnd={(bounds) => {
                    if (!bounds) return;
                    // A click also reaches this handler with a zero-width box; only a real
                    // drag should be allowed to re-window the page.
                    if (bounds.x1 - bounds.x0 < 1.5) return;
                    const lo = Math.max(0, Math.floor(bounds.x0));
                    const hi = Math.min(buckets.length - 1, Math.ceil(bounds.x1));
                    if (hi <= lo) return;
                    onWindowIndex?.(lo, hi);
                    if (onWindow) {
                      const step = buckets.length > 1 ? buckets[1].ts - buckets[0].ts : 1;
                      onWindow(buckets[lo].ts, buckets[hi].ts + step);
                    }
                  }}
                />
              )}
            </svg>
            <Tip
              tip={
                hover
                  ? {
                      x: hover.x,
                      y: hover.y,
                      node: (
                        <TipBody
                          bucket={buckets[hover.index]}
                          index={hover.index}
                          gran={gran}
                          keys={shown}
                          extra={tipExtra}
                          format={format}
                        />
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

function TipBody({
  bucket,
  index,
  gran,
  keys,
  extra,
  format,
}: {
  bucket: Bucket;
  index: number;
  gran: GranularityLike;
  keys: SeriesKey[];
  extra?: (b: Bucket, i: number) => { label: string; value: string }[];
  format: (v: number) => string;
}) {
  const rows = keys
    .map((k) => ({ k, v: (bucket[k.key as keyof Bucket] as number) || 0 }))
    .filter((r) => r.v > 0)
    .sort((a, b) => b.v - a.v);
  return (
    <>
      <TipTitle>{timeTooltip(bucket.ts, gran)}</TipTitle>
      {rows.map(({ k, v }) => (
        <div key={k.key} className="tip-row">
          <span className="tip-key">
            <i className="tip-swatch" style={{ background: k.color }} />
            {k.label}
          </span>
          <span className="tip-val">{format(v)}</span>
        </div>
      ))}
      <div className="tip-row mt-1" style={{ borderTop: `1px solid ${RULE}`, paddingTop: 3 }}>
        <span className="tip-key">total</span>
        <span className="tip-val">{format(bucket.total)}</span>
      </div>
      <TipNote>
        {bucket.turns} turns · {bucket.tools} calls{bucket.errors > 0 ? ` · ${bucket.errors} errors` : ""}
      </TipNote>
      {extra?.(bucket, index).map((r) => (
        <div key={r.label} className="tip-row">
          <span className="tip-key">{r.label}</span>
          <span className="tip-val">{r.value}</span>
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Composition of a stack, drawn as a single rule inside a table cell.
 * ------------------------------------------------------------------ */

export function StackRule({
  segments,
  width = 62,
  height = 7,
  onHover,
}: {
  segments: { value: number; color: string; label: string }[];
  width?: number;
  height?: number;
  onHover?: (label: string | null) => void;
}) {
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (total <= 0) return <span className="block" style={{ width, height, background: "var(--color-rule)" }} />;
  return (
    <span className="flex overflow-hidden" style={{ width, height }}>
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <i
            key={s.label}
            title={s.label}
            onMouseEnter={onHover ? () => onHover(s.label) : undefined}
            onMouseLeave={onHover ? () => onHover(null) : undefined}
            style={{ background: s.color, width: `${(Math.max(0, s.value) / total) * 100}%` }}
          />
        ))}
    </span>
  );
}
