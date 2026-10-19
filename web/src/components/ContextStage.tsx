import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCockpit } from "../state/CockpitContext";
import { DAY, useEcgDaily, useStatus, type DailyCell, type DailyLane } from "../lib/api";
import { compact, dateShort, money } from "../lib/format";
import { Spinner } from "./ui";

/**
 * Wide-window stage: one lane per project, one column per local day or hour, and a
 * single curve — how full the context window was.
 *
 * Why occupancy is the only signal worth a line here: it is a ratio bounded by 0–100%,
 * so the same axis means the same thing in every project, every month. Token counts and
 * cost span orders of magnitude and need per-lane scales, which makes lanes impossible to
 * compare and turns the chart into decoration. Occupancy also has a natural story:
 *
 *   the curve climbs as a session accumulates, and drops when the context is compacted.
 *
 * Everything else — tokens, cost, edits — is a number in the lane header or the readout.
 * Events are sparse marks on the curve: a ring where a compaction reset the window, a
 * square for a retry loop, a tick for a retry. A mark you can't explain is noise, so
 * there are only three.
 */

const HOUR = 3_600_000;
const HEAD_W = 210;
const PAD_R = 14;
const LANE_H = 72;
const AXIS_H = 26;
const LEGEND_H = 34;

/** Plot box inside one lane: 0% sits on `BASE`, 100% on `PLOT.top`. */
const PLOT = { top: 16, h: 46 };
const BASE = PLOT.top + PLOT.h;
/** Event marks ride in the strip above 100%, so a bucket pinned at the ceiling
 *  still shows its marks instead of burying them under the frame. */
const GUTTER_Y = 10.5;
/** Levels drawn as guides: the compaction threshold and the midpoint. */
const WARN = 0.85;

const INK = "var(--color-ink)";
const INK_SOFT = "var(--color-ink-soft)";
const DANGER = "var(--color-danger)";
const WARNING = "var(--color-warning)";

/** Occupancy 0…1 → y inside the plot box. */
const yOf = (v: number): number => PLOT.top + PLOT.h * (1 - Math.min(1, Math.max(0, v)));

/** Start of the bucket containing `ts`, in wall clock (the same frame the API buckets in). */
const floorLocal = (ts: number, step: number): number => {
  const d = new Date(ts);
  if (step >= DAY) d.setHours(0, 0, 0, 0);
  else d.setMinutes(0, 0, 0);
  return d.getTime();
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

const bucketLabel = (ts: number, step: number): string =>
  step >= DAY ? dateShort(ts) : `${dateShort(ts)} ${pad2(new Date(ts).getHours())}:00`;

const pct = (v: number | null): string => (v == null ? "—" : `${Math.round(v * 100)}%`);

interface Stamp {
  text: string;
  tone: "ink" | "warn" | "danger";
}

/**
 * The lane header states the conclusion, so the curve is confirmation rather than a
 * puzzle: how close this project runs to the window limit, and how often it got reset.
 */
function stamps(lane: DailyLane, step: number): Stamp[] {
  const out: Stamp[] = [];
  const worst = lane.days.reduce((m, d) => Math.max(m, d.peak ?? 0), 0);
  if (worst > 0) {
    out.push({
      text: `峰值 ${Math.round(worst * 100)}%`,
      tone: worst >= 0.95 ? "danger" : worst >= WARN ? "warn" : "ink",
    });
  }
  if (lane.totals.compactions > 0) {
    out.push({ text: `压缩 ×${lane.totals.compactions}`, tone: "warn" });
  } else if (lane.totals.loops > 0) {
    out.push({ text: `循环 ×${lane.totals.loops}`, tone: "danger" });
  }
  if (step >= DAY) {
    const gap = Math.round((Date.now() - lane.lastDay) / DAY);
    if (gap >= 3) out.push({ text: `${gap} 天无活动`, tone: "ink" });
  }
  return out.slice(0, 2);
}

const toneClass: Record<Stamp["tone"], string> = {
  ink: "text-ink-soft",
  warn: "text-warning",
  danger: "text-danger",
};

interface Hover {
  lane: string;
  cell: DailyCell;
  x: number;
  y: number;
}

/** Column geometry shared by every lane so rows line up exactly. */
interface Geom {
  from: number;
  step: number;
  n: number;
  colW: number;
  x: (i: number) => number;
}

export default function ContextStage() {
  const { window: win, setWindow } = useCockpit();
  const { data: status } = useStatus();
  // Hours are the useful bucket from 12h to 4 days; beyond that they would be sub-pixel.
  const bucket: "day" | "hour" = win.to - win.from <= 4 * DAY ? "hour" : "day";
  const { data, isLoading } = useEcgDaily(win, bucket);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isLoading]);

  const bandW = Math.max(120, size.w - HEAD_W - PAD_R);
  const step = data?.bucketMs ?? DAY;

  const geom: Geom = useMemo(() => {
    const from = floorLocal(win.from, step);
    // Count the buckets the window covers: align the start down, then ceil the remainder,
    // so a 1-day window is 24 hour columns (not 25) while a mid-day 30-day window keeps
    // both partial endpoint days.
    const n = Math.max(1, Math.ceil((win.to - from) / step));
    const colW = bandW / n;
    return { from, step, n, colW, x: (i: number) => i * colW + colW / 2 };
  }, [win.from, win.to, bandW, step]);

  const lanes = data?.lanes ?? [];
  const hourMode = geom.step < DAY;

  const totals = useMemo(() => {
    const t = { gen: 0, add: 0, cost: 0, compactions: 0 };
    for (const l of lanes) {
      t.gen += l.totals.gen;
      t.add += l.totals.add;
      t.cost += l.totals.cost;
      t.compactions += l.totals.compactions;
    }
    return t;
  }, [lanes]);

  const zoomTo = useCallback(
    (start: number) => {
      setWindow({ from: start, to: start + step });
      setHover(null);
    },
    [setWindow, step]
  );

  /**
   * Shift+wheel (or a horizontal trackpad swipe) pans the window instead of scrolling
   * lanes, which is the one gesture that was missing: the axis is the thing you want to
   * move once the lanes themselves are a scrollable list.
   */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX);
      const dy = Math.abs(e.deltaY);
      const horizontal = dx > dy && dx > 0;
      if (!e.shiftKey && !horizontal) return;
      const raw = horizontal ? e.deltaX : e.deltaY;
      if (!raw) return;
      e.preventDefault();
      const span = win.to - win.from;
      const delta = Math.sign(raw) * Math.max(span * 0.15, 60_000);
      // Snap to the bucket grid, otherwise every pan leaves a sliver column at one edge
      // and the axis reads 25 hours for a 1-day window.
      const grid = span <= 4 * DAY ? HOUR : DAY;
      let from = floorLocal(win.from + delta, grid);
      let to = from + span;
      const ext = status?.extent;
      if (ext) {
        if (from < ext.from) {
          from = ext.from;
          to = from + span;
        }
        if (to > ext.to) {
          to = ext.to;
          from = to - span;
        }
      }
      setWindow({ from, to });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // `isLoading` is a dependency because the stage replaces itself with the spinner
    // while the first payload is in flight; without it the listener attaches to a ref
    // that was still null and the gesture silently does nothing.
  }, [win.from, win.to, setWindow, status?.extent?.from, status?.extent?.to, isLoading]);

  // A readout pinned to a bucket that has scrolled out of the window would be a lie.
  useEffect(() => setHover(null), [win.from, win.to]);

  const tickEvery = Math.max(1, Math.ceil(geom.n / Math.max(1, Math.floor(bandW / 64))));

  // Pointer position is measured against the stage, not the lane SVG, so the readout card
  // lands next to the cursor wherever the lane sits in the scrolled body.
  const onHover = useCallback((project: string, cell: DailyCell, clientX: number, clientY: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setHover({ lane: project, cell, x: clientX - r.left, y: clientY - r.top });
  }, []);

  if (isLoading && !data) return <Spinner label="ROLLING UP BUCKETS" />;

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden grid-paper flex flex-col">
      <div className="h-[34px] shrink-0 flex items-center gap-3 px-3 hairline-b bg-paper-raised/70 overflow-hidden">
        <span className="micro text-ink">上下文窗口占用 0–100%</span>
        <span className="w-px h-4 bg-rule" />
        <span className="micro" style={{ color: INK }}>
          — 桶内均值
        </span>
        <span className="micro">○ 压缩</span>
        <span className="micro" style={{ color: DANGER }}>
          ■ 循环
        </span>
        <span className="micro" style={{ color: WARNING }}>
          ▍重试
        </span>
        <span className="micro">┄ 85% 告警线</span>
        <span className="micro text-ink-faint">事件标在曲线上方</span>
        <div className="ml-auto flex items-center gap-3 whitespace-nowrap">
          <span className="micro">压缩 {totals.compactions}</span>
          <span className="micro">生成 {compact(totals.gen)}</span>
          <span className="micro">{money(totals.cost)}</span>
          <span className="micro">
            {lanes.length} 项目 · {bucketLabel(geom.from, geom.step)} 起 {geom.n}
            {hourMode ? " 小时" : " 天"}
          </span>
          <span className="micro text-ink-faint">Shift+滚轮 平移</span>
        </div>
      </div>

      {/* Every lane is rendered; the body is the scroll container. */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {lanes.map((lane) => (
          <LaneRow
            key={lane.project}
            lane={lane}
            geom={geom}
            bandW={bandW}
            hover={hover}
            onHover={onHover}
            onLeave={() => setHover(null)}
            onZoom={zoomTo}
          />
        ))}
        {!lanes.length && <div className="micro px-3 py-6">窗口内没有活动</div>}
      </div>

      <div className="h-[26px] shrink-0 relative hairline-t bg-paper-raised/80 overflow-hidden">
        <svg width={size.w} height={AXIS_H} className="block">
          {Array.from({ length: geom.n }, (_, i) => i)
            .filter((i) => i % tickEvery === 0)
            .map((i) => {
              const t = geom.from + i * geom.step;
              return (
                <g key={i}>
                  <line
                    x1={HEAD_W + geom.x(i)}
                    y1={0}
                    x2={HEAD_W + geom.x(i)}
                    y2={5}
                    stroke="var(--color-rule-strong)"
                    strokeWidth={1}
                  />
                  <text
                    x={HEAD_W + geom.x(i)}
                    y={17}
                    textAnchor="middle"
                    style={{ font: "9px var(--font-mono)", fill: INK_SOFT, letterSpacing: "0.08em" }}
                  >
                    {hourMode ? `${pad2(new Date(t).getHours())}:00` : dateShort(t)}
                  </text>
                </g>
              );
            })}
        </svg>
      </div>

      {hover && <HoverCard hover={hover} width={size.w} step={geom.step} />}
    </div>
  );
}

function HoverCard({ hover, width, step }: { hover: Hover; width: number; step: number }) {
  const d = hover.cell;
  const cardW = 250;
  const left = Math.min(Math.max(hover.x + 14, 8), Math.max(8, width - cardW - 8));
  const rows: [string, string][] = [
    ["占用均值/峰值", `${pct(d.fillAvg)} / ${pct(d.peak)}`],
    ["轮次", `${d.turns}`],
    ["生成", `${compact(d.gen)} tok`],
    ["改动/写入", `+${d.add} / ${d.write} 行`],
    ["成本", money(d.cost)],
    ["压缩/重试/循环", `${d.compactions} / ${d.retries} / ${d.loops}`],
    ["工具失败", `${d.errors}`],
  ];
  return (
    <div
      className="absolute z-20 pointer-events-none hairline bg-paper-raised px-2 py-1.5"
      style={{ left, top: Math.max(4, hover.y - 60), width: cardW }}
    >
      <div className="flex items-baseline justify-between tape">
        <span>{bucketLabel(d.day, step)}</span>
        <span className="micro">{step < DAY ? "点击看该时段" : "点击看当天"}</span>
      </div>
      <div className="mt-1 grid grid-cols-[88px_1fr] gap-x-2 gap-y-[2px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <span className="micro">{k}</span>
            <span className="tape tabular-nums">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LaneRow({
  lane,
  geom,
  bandW,
  hover,
  onHover,
  onLeave,
  onZoom,
}: {
  lane: DailyLane;
  geom: Geom;
  bandW: number;
  hover: Hover | null;
  onHover: (project: string, cell: DailyCell, clientX: number, clientY: number) => void;
  onLeave: () => void;
  onZoom: (start: number) => void;
}) {
  const st = useMemo(() => stamps(lane, geom.step), [lane, geom.step]);
  const unit = geom.step >= DAY ? "天" : "小时";

  /** Column index for a bucket start; both sides bucket on the local wall clock. */
  const idxOf = useCallback((t: number) => Math.round((t - geom.from) / geom.step), [geom]);

  /**
   * Only buckets where a turn actually reported an occupancy get a point. A gap means
   * "no measurement", not "empty window", so runs are drawn separately instead of
   * joining across it and inventing a straight line through time that did not exist.
   */
  const curve = useMemo(() => {
    const pts: { i: number; avg: number }[] = lane.days
      .filter((d) => d.fillAvg != null)
      .map((d) => ({ i: idxOf(d.day), avg: d.fillAvg as number }));
    const runs: (typeof pts)[] = [];
    let run: typeof pts = [];
    let prev = Number.NEGATIVE_INFINITY;
    for (const p of pts) {
      if (p.i - prev > 1.5) {
        if (run.length) runs.push(run);
        run = [];
      }
      run.push(p);
      prev = p.i;
    }
    if (run.length) runs.push(run);
    return { runs };
  }, [lane, idxOf]);

  const marks = useMemo(
    () => lane.days.filter((d) => d.compactions > 0 || d.loops > 0 || d.retries > 0),
    [lane]
  );

  const hoverIdx = hover?.lane === lane.project ? idxOf(hover.cell.day) : null;

  return (
    <div className="flex hairline-b" style={{ height: LANE_H }} data-lane={lane.project}>
      <div className="shrink-0 flex flex-col justify-center gap-[2px] px-3" style={{ width: HEAD_W }}>
        <div className="tape truncate text-ink" title={lane.project}>
          {lane.project}
        </div>
        <div className="micro">
          {lane.totals.activeDays} {unit}活跃 · 至 {bucketLabel(lane.lastDay, geom.step)}
        </div>
        <div className="micro tabular-nums">
          生成 {compact(lane.totals.gen)} · 改动 {compact(lane.totals.add)}
        </div>
        <div className="flex gap-2">
          {st.map((s) => (
            <span key={s.text} className={`micro ${toneClass[s.tone]}`}>
              {s.text}
            </span>
          ))}
        </div>
      </div>

      <svg width={bandW} height={LANE_H} className="block shrink-0">
        {/* weekends for days, the small hours for hours */}
        {Array.from({ length: geom.n }, (_, i) => i).map((i) => {
          const t = geom.from + i * geom.step;
          const d = new Date(t);
          const dim = geom.step >= DAY ? d.getDay() === 0 || d.getDay() === 6 : d.getHours() < 7;
          return (
            <g key={i}>
              {dim && (
                <rect x={i * geom.colW} y={0} width={geom.colW} height={LANE_H} fill="oklch(0.2 0.05 250 / 0.045)" />
              )}
              <line
                x1={i * geom.colW}
                y1={0}
                x2={i * geom.colW}
                y2={LANE_H}
                stroke="oklch(0.2 0.05 250 / 0.07)"
                strokeWidth={1}
              />
            </g>
          );
        })}

        {/* reference levels — 0 and 100 frame the window, 85 is where compaction starts */}
        <line x1={0} y1={BASE} x2={bandW} y2={BASE} stroke="var(--color-rule)" strokeWidth={1} />
        <line x1={0} y1={yOf(0.5)} x2={bandW} y2={yOf(0.5)} stroke="oklch(0.2 0.05 250 / 0.1)" strokeWidth={1} />
        <line x1={0} y1={PLOT.top} x2={bandW} y2={PLOT.top} stroke="oklch(0.2 0.05 250 / 0.1)" strokeWidth={1} />
        <line
          x1={0}
          y1={yOf(WARN)}
          x2={bandW}
          y2={yOf(WARN)}
          stroke="oklch(0.55 0.22 25 / 0.35)"
          strokeDasharray="2 4"
          strokeWidth={1}
        />

        {/* occupancy curve: mean as the line, peak as the faint ceiling above it */}
        {curve.runs.map((run, k) => {
          const first = run[0];
          const last = run[run.length - 1];
          // A lone measured bucket is still a reading: draw it as a thin column so it
          // reads as "one day at this level" rather than a speck on the paper.
          if (run.length === 1) {
            const x = geom.x(first.i);
            return (
              <g key={k}>
                <rect
                  x={x - 1.25}
                  y={yOf(first.avg)}
                  width={2.5}
                  height={Math.max(0.8, BASE - yOf(first.avg))}
                  fill={INK}
                  opacity={0.7}
                />
                <circle cx={x} cy={yOf(first.avg)} r={2} fill={INK} />
              </g>
            );
          }
          const area =
            `M ${geom.x(first.i)},${BASE} ` +
            run.map((p) => `L ${geom.x(p.i)},${yOf(p.avg)}`).join(" ") +
            ` L ${geom.x(last.i)},${BASE} Z`;
          return (
            <g key={k}>
              <path d={area} fill={INK} opacity={0.11} />
              <polyline
                points={run.map((p) => `${geom.x(p.i)},${yOf(p.avg)}`).join(" ")}
                fill="none"
                stroke={INK}
                strokeWidth={1.4}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {run.map((p) => (
                <circle key={p.i} cx={geom.x(p.i)} cy={yOf(p.avg)} r={1.7} fill={INK} />
              ))}
            </g>
          );
        })}

        {/* events ride the gutter above the plot, one column of alignment with the curve */}
        {marks.map((d) => {
          const x = geom.x(idxOf(d.day));
          return (
            <g key={`m${d.day}`}>
              {d.compactions > 0 && <circle cx={x} cy={GUTTER_Y} r={2.6} fill="none" stroke={INK} strokeWidth={1} />}
              {d.loops > 0 && <rect x={x + 4.5} y={GUTTER_Y - 1.6} width={3.2} height={3.2} fill={DANGER} />}
              {d.retries > 0 && <rect x={x - 6.5} y={GUTTER_Y - 1.8} width={1.6} height={3.6} fill={WARNING} />}
            </g>
          );
        })}

        {/* transparent hit layer: hover readout + click-to-zoom */}
        {lane.days.map((d) => (
          <rect
            key={d.day}
            x={idxOf(d.day) * geom.colW}
            y={0}
            width={geom.colW}
            height={LANE_H}
            fill="transparent"
            style={{ cursor: "pointer" }}
            onMouseMove={(e) => onHover(lane.project, d, e.clientX, e.clientY)}
            onMouseLeave={onLeave}
            onClick={() => onZoom(d.day)}
          />
        ))}

        {hoverIdx != null && (
          <line
            x1={geom.x(hoverIdx)}
            y1={0}
            x2={geom.x(hoverIdx)}
            y2={LANE_H}
            stroke="var(--color-rule-strong)"
            strokeWidth={1}
          />
        )}
      </svg>
    </div>
  );
}
