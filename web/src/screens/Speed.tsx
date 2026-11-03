import { useMemo } from "react";
import { useSpeed, type SpeedPoint, type SpeedRow } from "../lib/api";
import { useSlice } from "../lib/slice";
import { dayStamp, dur, int, modelColor, rate, shortModel } from "../lib/format";
import { DataTable, type Column } from "../components/DataTable";
import { Empty, Panel, Skeleton, Stat } from "../components/ui";
import { BaseHints, StatusBar } from "../components/Chrome";

/**
 * Screen 5: wait and output speed per API call.
 *
 * The Tools screen answers "where did the time go"; this one answers "how long did the
 * model make me wait, and how fast did it write", per provider × model and over time.
 * Wait is the source's own evidence — OpenCode records time to first token, Qoder lands
 * the response in one row, so its wait is the whole round trip. Speed needs a writing
 * span to divide by (first evidence → first tool call); Qoder persists none, so its lane
 * prints — rather than a number divided by nothing.
 */
export default function Speed() {
  const { window, facets, label } = useSlice();
  const { data, isLoading } = useSpeed(window, facets);

  const lanes = useMemo(() => {
    const rows = data?.rows ?? [];
    return { rows, providerCount: new Set(rows.map((r) => r.provider)).size };
  }, [data]);

  const totals = useMemo(() => {
    const rows = lanes.rows;
    return {
      calls: rows.reduce((a, r) => a + r.calls, 0),
      exact: rows.reduce((a, r) => a + r.exactWaits, 0),
      providerCount: lanes.providerCount,
    };
  }, [lanes]);

  const columns = useMemo<Column<SpeedRow>[]>(
    () => [
      {
        id: "model",
        header: "model",
        size: 210,
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
        size: 90,
        accessorKey: "provider",
        cell: ({ row }) => <span className="tape truncate text-ink-soft">{row.original.provider}</span>,
      },
      {
        id: "calls",
        header: "calls",
        size: 66,
        accessorKey: "calls",
        meta: { align: "right" },
        cell: ({ row }) => <span className="tape tabular">{int(row.original.calls)}</span>,
      },
      {
        id: "exact",
        header: "exact",
        size: 64,
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
        size: 76,
        accessorKey: "waitP50",
        meta: { align: "right" },
        cell: ({ row }) => <span className="tape tabular">{dur(row.original.waitP50)}</span>,
      },
      {
        id: "waitP90",
        header: "wait p90",
        size: 76,
        accessorKey: "waitP90",
        meta: { align: "right" },
        cell: ({ row }) => <span className="tape tabular text-ink-soft">{dur(row.original.waitP90)}</span>,
      },
      {
        id: "waitMax",
        header: "wait max",
        size: 80,
        accessorKey: "waitMax",
        meta: { align: "right" },
        cell: ({ row }) => <span className="tape tabular text-ink-faint">{dur(row.original.waitMax)}</span>,
      },
      {
        id: "speedP50",
        header: "speed p50",
        size: 84,
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

  const laneList = lanes.rows;
  const shown = laneList.slice(0, 8);
  const dayRange = daySpan(data.points);
  const waitSeries = shown.map((r) => ({
    key: `${r.provider}\u0000${r.model}`,
    label: shortModel(r.model),
    color: modelColor(r.model),
    points: data.points
      .filter((p) => p.provider === r.provider && p.model === r.model && p.waitP50 != null)
      .map((p) => ({ x: p.day, y: p.waitP50 as number })),
  }));
  const speedSeries = shown.map((r) => ({
    key: `${r.provider}\u0000${r.model}`,
    label: shortModel(r.model),
    color: modelColor(r.model),
    points: data.points
      .filter((p) => p.provider === r.provider && p.model === r.model && p.speedP50 != null)
      .map((p) => ({ x: p.day, y: p.speedP50 as number })),
  }));
  const anySpeed = laneList.some((r) => r.speedP50 != null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="hairline-b flex shrink-0 flex-wrap items-center gap-2 px-2 py-1">
        <span className="micro shrink-0">api speed</span>
        <span className="tape shrink-0 text-ink-faint">
          {laneList.length} lanes · {int(totals.calls)} calls · {totals.providerCount} provider
          {totals.providerCount === 1 ? "" : "s"}
        </span>
        <span className="flex-1" />
        <span className="tape shrink-0 text-ink-faint">window {label}</span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
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
              label="speed"
              value={anySpeed ? `${laneList.filter((r) => r.speedP50 != null).length} measured` : "—"}
              tone="faint"
              labelWidth={44}
            />
          </div>
          <div className="min-h-0 flex-1">
            <DataTable<SpeedRow>
              rows={laneList}
              columns={columns}
              getRowId={(r) => `${r.provider}\u0000${r.model}`}
              rowHeight={24}
              rowClass={(r) => (r.calls < 10 ? "opacity-40" : undefined)}
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
                title="wait p50 per day"
                right={<span className="tape text-ink-faint">{shown.length} lanes</span>}
              >
                <MultiLine
                  series={waitSeries}
                  xMin={dayRange.min}
                  xMax={dayRange.max}
                  format={(v) => dur(v)}
                  height={150}
                  empty="no wait samples in this window"
                />
                <div className="mt-1 tape text-ink-faint">
                  OpenCode: prompt → first output token. Qoder writes one row per response, so its wait is the
                  whole round trip.
                </div>
              </Panel>
              <Panel
                title="output speed p50 per day"
                right={<span className="tape text-ink-faint">tok/s</span>}
              >
                {anySpeed ? (
                  <>
                    <MultiLine
                      series={speedSeries.filter((s) => s.points.length > 0)}
                      xMin={dayRange.min}
                      xMax={dayRange.max}
                      format={(v) => rate(v)}
                      height={150}
                      empty="no stream spans in this window"
                    />
                    <div className="mt-1 tape text-ink-faint">
                      Output tokens over the writing span — from the first evidence to the first tool call, so
                      command time is not billed to the model. Qoder persists no stream timestamps, so its
                      lanes are absent rather than estimated.
                    </div>
                  </>
                ) : (
                  <Empty>
                    this source records no stream span — speed is only measurable where a response&apos;s
                    writing time is persisted
                  </Empty>
                )}
              </Panel>
              <Legend series={[...waitSeries.filter((s) => s.points.length > 0)]} />
            </div>
          )}
        </div>
      </div>

      <StatusBar
        hints={
          <>
            <BaseHints /> · one row per provider × model
          </>
        }
        info={
          <>
            {int(totals.calls)} calls · {laneList.length} lanes · rows under 10 calls are dimmed
          </>
        }
      />
    </div>
  );
}

function daySpan(points: SpeedPoint[]): { min: number; max: number } {
  if (!points.length) return { min: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.day < min) min = p.day;
    if (p.day > max) max = p.day;
  }
  return { min, max };
}

interface LaneSeries {
  key: string;
  label: string;
  color: string;
  points: { x: number; y: number }[];
}

/** A minimal multi-line chart: per-day medians are few points, and a stacked area would lie. */
function MultiLine({
  series,
  xMin,
  xMax,
  format,
  height,
  empty,
}: {
  series: LaneSeries[];
  xMin: number;
  xMax: number;
  format: (v: number) => string;
  height: number;
  empty: string;
}) {
  const W = 600;
  const H = height;
  const padL = 6;
  const padR = 6;
  const padT = 8;
  const padB = 16;
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return <Empty>{empty}</Empty>;
  const yMax = Math.max(...all.map((p) => p.y), 1);
  const xSpan = Math.max(1, xMax - xMin);
  const sx = (x: number) => padL + ((x - xMin) / xSpan) * (W - padL - padR);
  const sy = (y: number) => H - padB - (y / yMax) * (H - padT - padB);
  const ticks = [0, 0.5, 1].map((f) => f * yMax);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-hidden>
        {ticks.map((t) => (
          <line
            key={t}
            x1={padL}
            x2={W - padR}
            y1={sy(t)}
            y2={sy(t)}
            stroke="var(--color-rule)"
            strokeWidth={t === 0 ? 1 : 0.5}
            strokeDasharray={t === 0 ? undefined : "2 3"}
          />
        ))}
        {series.map((s) => {
          if (s.points.length < 2) {
            const p = s.points[0];
            return p ? <circle key={s.key} cx={sx(p.x)} cy={sy(p.y)} r={1.6} fill={s.color} /> : null;
          }
          const d = s.points
            .slice()
            .sort((a, b) => a.x - b.x)
            .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
            .join(" ");
          return <path key={s.key} d={d} fill="none" stroke={s.color} strokeWidth={1.2} />;
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0">
        <span className="absolute left-1 top-0 tape text-ink-faint">{format(yMax)}</span>
        {xMin > 0 && <span className="absolute bottom-0 left-1 tape text-ink-faint">{dayStamp(xMin)}</span>}
        {xMax > 0 && xMax !== xMin && (
          <span className="absolute bottom-0 right-1 tape text-ink-faint">{dayStamp(xMax)}</span>
        )}
      </div>
    </div>
  );
}

function Legend({ series }: { series: LaneSeries[] }) {
  return (
    <Panel title="lanes">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1">
            <i className="block h-[7px] w-[7px]" style={{ background: s.color }} />
            <span className="tape text-ink-soft">{s.label}</span>
          </span>
        ))}
      </div>
    </Panel>
  );
}
