import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useSpeed, type Granularity, type SpeedPoint, type SpeedRow } from "../lib/api";
import { useSlice } from "../lib/slice";
import { dur, int, modelColor, rate, shortModel } from "../lib/format";
import { granLabel, MARGIN, timeTick, timeTooltip, tickIndices, yTicks } from "../lib/chart";
import { Figure, Tip, TipNote, TipRow, TipTitle, useTip } from "../components/charts/base";
import { fingerprint } from "../lib/motion";
import { DataTable, type Column } from "../components/DataTable";
import { Chip, Empty, Panel, Skeleton, Stat } from "../components/ui";
import { BaseHints, StatusBar } from "../components/Chrome";

/**
 * Screen 5: wait and output speed per API call.
 *
 * The Tools screen answers "where did the time go"; this one answers "how long did the
 * model make me wait, and how fast did it write", per provider × model and over time.
 *
 * Nineteen lanes × a hundred buckets as overlaid lines is a knot, not a chart: every lane
 * crosses every other, and a shared linear y-axis lets one slow night flatten the rest.
 * The shape of this data is a matrix — lane × time — so that is what it is drawn as.
 * Colour carries the bucket median, a blank cell says "this lane ran nothing in this
 * bucket", and the second figure answers the one question the matrix cannot: what the
 * spread inside a bucket looked like (p25–p75), for the lane you clicked.
 */
export default function Speed() {
  const { window, facets, label, gran, setView } = useSlice();
  const { data, isLoading } = useSpeed(window, facets, gran);
  const [metric, setMetric] = useState<MetricId>("wait");
  const [picked, setPicked] = useState<string | null>(null);

  const laneList = data?.rows ?? [];
  const axis = data?.axis ?? [];
  const anySpeed = laneList.some((r) => r.speedP50 != null);
  const shown: MetricId = anySpeed ? metric : "wait";
  const m = METRIC[shown];

  const focus = laneList.find((r) => laneKey(r) === picked) ?? laneList[0] ?? null;

  // A lane with no stream span cannot answer a speed question, so moving the toggle
  // moves the focus to the first lane that can.
  useEffect(() => {
    if (shown !== "speed" || !data) return;
    const current = data.rows.find((r) => laneKey(r) === picked);
    if (current && current.speedP50 != null) return;
    const first = data.rows.find((r) => r.speedP50 != null);
    if (first) setPicked(laneKey(first));
  }, [shown, data, picked]);

  const heat = useMemo(() => {
    const by = new Map<string, SpeedPoint>();
    const medians: number[] = [];
    for (const p of data?.points ?? []) {
      by.set(`${p.at}\u0000${laneKey(p)}`, p);
      const v = p[m.p50];
      if (v != null) medians.push(v);
    }
    medians.sort((a, b) => a - b);
    // One 90-second response should not make every other cell look instant: shade
    // saturates at the p95, and the tooltip still prints the true value above it.
    const ceiling = medians.length
      ? Math.max(1e-6, medians[Math.min(medians.length - 1, Math.floor(medians.length * 0.95))])
      : 1;
    // Waits run from a second to ten minutes; a linear ramp would leave every ordinary
    // cell in the pale end of the scale, so the dark end is log-spaced above the p10.
    const floor = medians.length ? Math.max(1e-6, medians[Math.floor(medians.length * 0.1)]) : 1;
    return { by, ceiling, floor };
  }, [data, m.p50]);

  const totals = useMemo(
    () => ({
      calls: laneList.reduce((a, r) => a + r.calls, 0),
      exact: laneList.reduce((a, r) => a + r.exactWaits, 0),
      providerCount: new Set(laneList.map((r) => r.provider)).size,
    }),
    [laneList],
  );

  const columns = useMemo<Column<SpeedRow>[]>(
    () => [
      {
        id: "model",
        header: "model",
        size: 172,
        accessorKey: "model",
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1">
            <i
              className="block h-[7px] w-[7px] shrink-0"
              style={{ background: modelColor(row.original.model) }}
            />
            <span className="tape truncate" title={row.original.model}>
              {shortModel(row.original.model)}
            </span>
          </span>
        ),
      },
      {
        id: "provider",
        header: "provider",
        size: 76,
        accessorKey: "provider",
        cell: ({ row }) => <span className="tape truncate text-ink-soft">{row.original.provider}</span>,
      },
      {
        id: "calls",
        header: "calls",
        size: 58,
        accessorKey: "calls",
        meta: { align: "right" },
        cell: ({ row }) => <span className="tape tabular">{int(row.original.calls)}</span>,
      },
      {
        id: "exact",
        header: "exact",
        size: 56,
        accessorKey: "exactWaits",
        meta: { align: "right" },
        cell: ({ row }) => {
          const r = row.original;
          const pct = r.calls > 0 ? r.exactWaits / r.calls : 0;
          return (
            <span
              className={`tape tabular ${pct >= 0.99 ? "text-good" : "text-warning"}`}
              title={`${int(r.exactWaits)} waits from the source, the rest are whole-turn fallback`}
            >
              {Math.round(pct * 100)}%
            </span>
          );
        },
      },
      {
        id: "waitP50",
        header: "wait p50",
        size: 68,
        accessorKey: "waitP50",
        meta: { align: "right" },
        cell: ({ row }) => <span className="tape tabular">{dur(row.original.waitP50)}</span>,
      },
      {
        id: "waitP90",
        header: "wait p90",
        size: 68,
        accessorKey: "waitP90",
        meta: { align: "right" },
        cell: ({ row }) => <span className="tape tabular text-ink-soft">{dur(row.original.waitP90)}</span>,
      },
      {
        id: "speedP50",
        header: "speed p50",
        size: 76,
        accessorKey: "speedP50",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="tape tabular">
            {row.original.speedP50 == null ? (
              <span className="text-ink-faint" title="this source persists no stream span">
                —
              </span>
            ) : (
              rate(row.original.speedP50)
            )}
          </span>
        ),
      },
    ],
    [],
  );

  if (isLoading || !data) return <Skeleton tiles={4} rows={1} />;

  // A zoomed window is one bucket wide, so the axis has to drop a rung or it draws a
  // single column: an hour shows minutes, a day shows hours, a week shows days.
  const zoom = (at: number) => {
    const i = axis.indexOf(at);
    const to = axis[i + 1] ?? nextAt(at, data.gran);
    setView(at, to, zoomUnit(to - at));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="hairline-b flex shrink-0 flex-wrap items-center gap-2 px-2 py-1">
        <span className="micro shrink-0">api speed</span>
        <span className="tape shrink-0 text-ink-faint">
          {laneList.length} lanes · {int(totals.calls)} calls · {totals.providerCount} provider
          {totals.providerCount === 1 ? "" : "s"}
        </span>
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-0">
          {(Object.keys(METRIC) as MetricId[]).map((id) => (
            <Chip
              key={id}
              active={shown === id}
              onClick={() => setMetric(id)}
              disabled={id === "speed" && !anySpeed}
              className="border-r-0 last:border-r"
              title={id === "speed" && !anySpeed ? "this source persists no stream span" : METRIC[id].what}
            >
              {METRIC[id].label}
            </Chip>
          ))}
        </span>
        <span className="tape shrink-0 text-ink-faint">window {label}</span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 xl:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
        <div className="flex min-h-0 min-w-0 flex-col xl:hairline-r">
          <div className="grid shrink-0 grid-cols-2 gap-x-4 px-3 py-2 sm:grid-cols-4">
            <Stat label="calls" value={int(totals.calls)} labelWidth={44} />
            <Stat
              label="exact"
              value={totals.calls > 0 ? `${Math.round((totals.exact / totals.calls) * 100)}%` : "—"}
              tone={totals.calls > 0 && totals.exact / totals.calls >= 0.99 ? "good" : "warning"}
              labelWidth={44}
            />
            <Stat label="lanes" value={String(laneList.length)} tone="faint" labelWidth={44} />
            <Stat
              label="buckets"
              value={`${axis.length} · ${granLabel(data.gran)}`}
              tone="faint"
              labelWidth={44}
            />
          </div>
          <div className="min-h-0 flex-1">
            <DataTable<SpeedRow>
              rows={laneList}
              columns={columns}
              getRowId={laneKey}
              rowHeight={24}
              rowClass={(r) => clsx(r.calls < 10 && "opacity-40", laneKey(r) === picked && "text-ink")}
              onRowClick={(r) => setPicked(laneKey(r))}
              activeId={focus ? laneKey(focus) : null}
              empty="no API calls in this slice"
            />
          </div>
        </div>

        <div className="no-scrollbar min-h-0 min-w-0 overflow-y-auto p-3">
          {laneList.length === 0 ? (
            <Empty>no API calls in this slice — widen the window or clear the filter</Empty>
          ) : (
            <div className="flex flex-col gap-3">
              <Panel
                title={`${m.label} heatmap`}
                right={
                  <span className="tape text-ink-faint">
                    {granLabel(data.gran)} · shade saturates at p95 {m.fmt(heat.ceiling)}
                  </span>
                }
              >
                <LaneGrid
                  lanes={laneList}
                  axis={axis}
                  by={heat.by}
                  ceiling={heat.ceiling}
                  floor={heat.floor}
                  m={m}
                  gran={data.gran}
                  focusKey={focus ? laneKey(focus) : null}
                  onFocus={(r) => setPicked(laneKey(r))}
                  onZoom={(at, r) => {
                    setPicked(laneKey(r));
                    zoom(at);
                  }}
                />
                <div className="mt-2 tape leading-relaxed text-ink-faint">
                  One cell per lane × {granLabel(data.gran)} bucket, shaded by the bucket median. A blank cell
                  means the lane ran nothing then — it is not a zero. Click a cell to zoom into that bucket;
                  click a lane name to focus its band.
                </div>
              </Panel>

              {focus ? (
                <Panel
                  title={`focus · ${m.label}`}
                  right={
                    <span className="tape text-ink-faint">
                      {focus.provider} · {int(focus.calls)} calls
                    </span>
                  }
                >
                  <FocusBand
                    lane={focus}
                    points={data.points}
                    axis={axis}
                    m={m}
                    gran={data.gran}
                    height={160}
                  />
                  <div className="mt-1 tape leading-relaxed text-ink-faint">{m.what}</div>
                </Panel>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <StatusBar
        hints={
          <>
            <BaseHints /> · click a cell to zoom · click a lane to focus
          </>
        }
        info={
          <>
            {int(totals.calls)} calls · {laneList.length} lanes · {granLabel(data.gran)} buckets · rows under
            10 calls are dimmed
          </>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

type MetricId = "wait" | "speed";
type MetricKey = "waitP25" | "waitP50" | "waitP75" | "speedP25" | "speedP50" | "speedP75";

interface Metric {
  label: string;
  color: string;
  p25: MetricKey;
  p50: MetricKey;
  p75: MetricKey;
  /** The readout everywhere a number is printed. */
  fmt: (v: number) => string;
  /** A short tick label for a y-axis, where "1.2s" would collide with its neighbour. */
  axisFmt: (v: number) => string;
  what: string;
}

const METRIC: Record<MetricId, Metric> = {
  wait: {
    label: "wait",
    color: "var(--color-flow)",
    p25: "waitP25",
    p50: "waitP50",
    p75: "waitP75",
    fmt: dur,
    axisFmt: (v) => (v > 0 ? dur(v) : "0"),
    what: "OpenCode: prompt → first output evidence. Qoder writes one row per response, so its wait is the whole round trip.",
  },
  speed: {
    label: "speed",
    color: "var(--color-good)",
    p25: "speedP25",
    p50: "speedP50",
    p75: "speedP75",
    fmt: rate,
    axisFmt: (v) => String(Math.round(v)),
    what: "Output tokens over the response after the wait. In-step tool execution is included, so this is a floor on model throughput; Qoder persists no stream span, so its lanes stay blank.",
  },
};

const laneKey = (r: { provider: string; model: string }): string => `${r.provider}\u0000${r.model}`;

const DAY_MS = 86_400_000;

/** The bucket unit a zoomed window is wide enough to show detail in. */
function zoomUnit(span: number): Granularity {
  if (span <= 3 * 3_600_000) return "5m";
  if (span <= 3 * DAY_MS) return "hour";
  if (span <= 180 * DAY_MS) return "day";
  return "week";
}

/** 0–1 on a log ramp between the p10 and p95 of the medians. */
function shade(v: number, lo: number, hi: number): number {
  if (!(v > 0)) return 0;
  const a = Math.log(Math.max(v, lo));
  const bottom = Math.log(lo);
  const top = Math.log(Math.max(hi, lo * 2));
  return Math.max(0, Math.min(1, (a - bottom) / (top - bottom)));
}

function nextAt(at: number, g: Granularity): number {
  if (g === "5m") return at + 300_000;
  if (g === "hour") return at + 3_600_000;
  if (g === "day") return at + 86_400_000;
  if (g === "week") return at + 7 * 86_400_000;
  const d = new Date(at);
  if (g === "month") d.setMonth(d.getMonth() + 1);
  else if (g === "quarter") d.setMonth(d.getMonth() + 3);
  else d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

/* ------------------------------------------------------------------ *
 * The matrix
 * ------------------------------------------------------------------ */

const GUTTER = 148;

/**
 * Rows are lanes, columns are buckets, and the fill is the bucket median.
 *
 * A line per lane cannot answer "which provider went slow last Tuesday" — every series
 * crosses the others and the y-axis is shared by nineteen of them. A matrix answers it
 * by position: a hot column is a night, a hot row is a model, and a blank is a lane
 * that was not running. The lane name is the row header rather than a colour key, so
 * the same model keeps its colour on every figure without the reader learning the key.
 */
function LaneGrid({
  lanes,
  axis,
  by,
  ceiling,
  floor,
  m,
  gran,
  focusKey,
  onFocus,
  onZoom,
}: {
  lanes: SpeedRow[];
  axis: number[];
  by: Map<string, SpeedPoint>;
  ceiling: number;
  floor: number;
  m: Metric;
  gran: Granularity;
  focusKey: string | null;
  onFocus: (lane: SpeedRow) => void;
  onZoom: (at: number, lane: SpeedRow) => void;
}) {
  const tip = useTip();
  const host = useRef<HTMLDivElement | null>(null);
  const n = axis.length;
  if (n === 0) return <Empty>no buckets in this window</Empty>;

  const gap = n <= 80 ? 1 : 0;
  const template = `${GUTTER}px repeat(${n}, minmax(0, 1fr))`;
  const marks = new Set(tickIndices(n, 7));

  return (
    <div ref={host} className="relative min-w-0" onMouseLeave={tip.hide}>
      <div className="grid" style={{ gridTemplateColumns: template, columnGap: gap, rowGap: 1 }}>
        {lanes.map((lane) => {
          const key = laneKey(lane);
          const on = key === focusKey;
          return (
            <div key={key} className="contents">
              <button
                type="button"
                onClick={() => onFocus(lane)}
                title={`${lane.provider}/${lane.model} · ${int(lane.calls)} calls${on ? " · focused" : ""}`}
                className={clsx(
                  "flex h-[13px] min-w-0 items-center gap-1 pr-1 text-left",
                  on ? "text-ink" : "text-ink-soft",
                )}
              >
                <i
                  className="block h-[6px] w-[6px] shrink-0"
                  style={{ background: modelColor(lane.model) }}
                />
                <span className="tape min-w-0 flex-1 truncate">{shortModel(lane.model)}</span>
                <span className="tape shrink-0 text-ink-faint">{lane.provider}</span>
              </button>
              {axis.map((at) => {
                const p = by.get(`${at}\u0000${key}`);
                const v = p ? p[m.p50] : null;
                const t = v == null ? 0 : shade(v, floor, ceiling);
                return (
                  <button
                    key={at}
                    type="button"
                    aria-label={`${timeTooltip(at, gran)} ${m.label}`}
                    onClick={() => onZoom(at, lane)}
                    onMouseEnter={(e) => {
                      const r = host.current?.getBoundingClientRect();
                      if (!r) return;
                      tip.show(
                        e.clientX - r.left,
                        e.clientY - r.top,
                        p ? (
                          <>
                            <TipTitle>{timeTooltip(at, gran)}</TipTitle>
                            <TipRow label="lane" value={`${lane.provider}/${shortModel(lane.model)}`} />
                            <TipRow label="calls" value={int(p.calls)} />
                            <TipRow
                              color={m.color}
                              label={`${m.label} p50`}
                              value={v == null ? "—" : m.fmt(v)}
                            />
                            <TipRow
                              label="p25–p75"
                              value={
                                p[m.p25] == null && p[m.p75] == null
                                  ? "—"
                                  : `${p[m.p25] == null ? "—" : m.fmt(p[m.p25]!)} – ${
                                      p[m.p75] == null ? "—" : m.fmt(p[m.p75]!)
                                    }`
                              }
                            />
                            <TipNote>click to zoom into {granLabel(gran)}</TipNote>
                          </>
                        ) : (
                          <>
                            <TipTitle>{timeTooltip(at, gran)}</TipTitle>
                            <TipRow label={shortModel(lane.model)} value="no calls" />
                          </>
                        ),
                      );
                    }}
                    className="block h-[13px] w-full p-0"
                    style={{
                      background: v == null ? "var(--color-rule)" : m.color,
                      opacity: v == null ? 0.28 : 0.14 + t * 0.78,
                    }}
                  />
                );
              })}
            </div>
          );
        })}
        <span />
        {axis.map((at, i) => (
          <span key={at} className="relative h-[12px]">
            {marks.has(i) && (
              <span
                className="tape absolute top-0 whitespace-nowrap text-ink-faint"
                style={
                  i === 0
                    ? { left: 0 }
                    : i === n - 1
                      ? { right: 0 }
                      : { left: 0, transform: "translateX(-50%)" }
                }
              >
                {timeTick(at, gran)}
              </span>
            )}
          </span>
        ))}
      </div>
      <Tip tip={tip.tip} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The focus band
 * ------------------------------------------------------------------ */

/**
 * One lane, one metric, p25–p75 as a band and p50 as the line inside it.
 *
 * The band is what a median cannot show: a lane whose p50 held steady while its p75
 * doubled is degrading, and only the spread says so. Runs are separate paths, so a
 * bucket with no calls becomes a visible break rather than a segment interpolated
 * across time the lane was not running.
 */
function FocusBand({
  lane,
  points,
  axis,
  m,
  gran,
  height,
}: {
  lane: SpeedRow;
  points: SpeedPoint[];
  axis: number[];
  m: Metric;
  gran: Granularity;
  height: number;
}) {
  const tip = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  const byAt = useMemo(() => {
    const map = new Map<number, SpeedPoint>();
    for (const p of points) {
      if (p.provider === lane.provider && p.model === lane.model) map.set(p.at, p);
    }
    return map;
  }, [points, lane.provider, lane.model]);

  const values = axis.map((at) => byAt.get(at) ?? null);
  const n = axis.length;
  const yMax = Math.max(1, ...values.map((p) => (p ? (p[m.p75] ?? p[m.p50] ?? 0) : 0)));
  const maxCalls = Math.max(1, ...values.map((p) => p?.calls ?? 0));

  return (
    <>
      <Figure
        label={
          <span className="flex items-center gap-1">
            <i className="block h-[7px] w-[7px]" style={{ background: modelColor(lane.model) }} />
            {shortModel(lane.model)}
          </span>
        }
        right={`${m.label} · p25–p75 band`}
        height={height}
        wipeKey={fingerprint(values.map((p) => p?.[m.p50] ?? 0))}
      >
        {(box) => {
          const { width, height: h, margin, inner } = box;
          const x = (i: number) => margin.left + ((i + 0.5) / n) * inner.width;
          const y = (v: number) => margin.top + inner.height - (Math.max(0, v) / yMax) * inner.height;
          const yLines = yTicks(yMax, 3);
          const xMarks = new Set(tickIndices(n, 7));

          const runs: number[][] = [];
          let run: number[] = [];
          values.forEach((p, i) => {
            if (p && p[m.p50] != null) run.push(i);
            else if (run.length) {
              runs.push(run);
              run = [];
            }
          });
          if (run.length) runs.push(run);

          const half = Math.max(1, inner.width / n / 3);
          const band = (r: number[]): string => {
            if (r.length === 1) {
              const i = r[0];
              const xx = x(i);
              const hi = y(values[i]![m.p75] ?? values[i]![m.p50] ?? 0);
              const lo = y(values[i]![m.p25] ?? values[i]![m.p50] ?? 0);
              return `M${(xx - half).toFixed(1)},${hi.toFixed(1)} L${(xx + half).toFixed(1)},${hi.toFixed(1)} L${(xx + half).toFixed(1)},${lo.toFixed(1)} L${(xx - half).toFixed(1)},${lo.toFixed(1)} Z`;
            }
            const hi = r.map(
              (i) => `${x(i).toFixed(1)},${y(values[i]![m.p75] ?? values[i]![m.p50] ?? 0).toFixed(1)}`,
            );
            const lo = [...r]
              .reverse()
              .map((i) => `${x(i).toFixed(1)},${y(values[i]![m.p25] ?? values[i]![m.p50] ?? 0).toFixed(1)}`);
            return `M${hi.join(" L")} L${lo.join(" L")} Z`;
          };
          const line = (r: number[]): string =>
            r
              .map(
                (i, k) => `${k === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(values[i]![m.p50] ?? 0).toFixed(1)}`,
              )
              .join(" ");

          return (
            <>
              <svg
                ref={svg}
                width={width}
                height={h}
                onMouseLeave={() => {
                  setHover(null);
                  tip.hide();
                }}
              >
                {yLines.map((t) => (
                  <g key={t}>
                    <line
                      x1={margin.left}
                      x2={margin.left + inner.width}
                      y1={y(t)}
                      y2={y(t)}
                      stroke="var(--chart-grid)"
                    />
                    <text
                      x={margin.left - 4}
                      y={y(t)}
                      textAnchor="end"
                      dominantBaseline="middle"
                      fontSize={8}
                      fill="var(--color-ink-faint)"
                    >
                      {m.axisFmt(t)}
                    </text>
                  </g>
                ))}
                {hover != null && (
                  <line
                    x1={x(hover)}
                    x2={x(hover)}
                    y1={margin.top}
                    y2={margin.top + inner.height}
                    stroke="var(--color-ink-faint)"
                    strokeDasharray="2 3"
                  />
                )}
                {runs.map((r, k) => (
                  <path
                    key={`b${k}`}
                    d={band(r)}
                    fill={m.color}
                    fillOpacity={0.24}
                    stroke={m.color}
                    strokeOpacity={0.35}
                    strokeWidth={0.8}
                  />
                ))}
                {runs.map((r, k) =>
                  r.length === 1 ? (
                    <circle
                      key={`p${k}`}
                      cx={x(r[0])}
                      cy={y(values[r[0]]![m.p50] ?? 0)}
                      r={1.8}
                      fill={m.color}
                    />
                  ) : (
                    <path
                      key={`l${k}`}
                      d={line(r)}
                      fill="none"
                      stroke={m.color}
                      strokeWidth={1.4}
                      strokeLinecap="round"
                    />
                  ),
                )}
                {axis.map((at, i) => (
                  <rect
                    key={at}
                    x={x(i) - inner.width / n / 2}
                    y={margin.top}
                    width={Math.max(1, inner.width / n)}
                    height={inner.height}
                    fill="transparent"
                    onMouseEnter={(e) => {
                      setHover(i);
                      const p = values[i];
                      const r = svg.current?.getBoundingClientRect();
                      if (!r || !p) return;
                      tip.show(
                        e.clientX - r.left,
                        e.clientY - r.top,
                        <>
                          <TipTitle>{timeTooltip(at, gran)}</TipTitle>
                          <TipRow label="calls" value={int(p.calls)} />
                          <TipRow color={m.color} label="p50" value={m.fmt(p[m.p50] ?? 0)} />
                          <TipRow
                            label="p25–p75"
                            value={
                              p[m.p25] == null && p[m.p75] == null
                                ? "—"
                                : `${p[m.p25] == null ? "—" : m.fmt(p[m.p25]!)} – ${
                                    p[m.p75] == null ? "—" : m.fmt(p[m.p75]!)
                                  }`
                            }
                          />
                        </>,
                      );
                    }}
                  />
                ))}
                {axis.map((at, i) =>
                  xMarks.has(i) ? (
                    <text
                      key={at}
                      x={x(i)}
                      y={h - 6}
                      textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                      fontSize={8}
                      fill="var(--color-ink-faint)"
                    >
                      {timeTick(at, gran)}
                    </text>
                  ) : null,
                )}
              </svg>
              <Tip tip={tip.tip} />
            </>
          );
        }}
      </Figure>
      <div
        className="mt-1 flex items-end gap-px"
        style={{ height: 18, paddingLeft: MARGIN.left, paddingRight: MARGIN.right }}
        title="calls per bucket"
      >
        {values.map((p, i) => (
          <span key={axis[i]} className="flex h-full flex-1 items-end">
            <i
              className="w-full"
              style={{
                height: p ? `${Math.max(8, ((p.calls ?? 0) / maxCalls) * 100)}%` : 0,
                background: "var(--color-rule-strong)",
                opacity: hover === i ? 0.9 : 0.55,
              }}
            />
          </span>
        ))}
      </div>
      <div className="tape text-ink-faint" style={{ paddingLeft: MARGIN.left }}>
        calls per {granLabel(gran)} · band is p25–p75
      </div>
    </>
  );
}
