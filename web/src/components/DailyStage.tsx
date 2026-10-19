import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCockpit } from "../state/CockpitContext";
import { DAY, useEcgDaily, type DailyCell, type DailyLane } from "../lib/api";
import { compact, dateShort, money } from "../lib/format";
import { Spinner } from "./ui";

/**
 * Bucketed stage: one lane per project, one column per local day (or hour).
 *
 * Three stacked bands answer three different questions and share one time axis, so
 * "burn went up while output stayed flat" is a shape the eye can read directly:
 *
 *   产出  mirrored around a baseline — up = incremental edit lines, down = full-file writes
 *   消耗  generated tokens as bars; cache reads sit behind on their own scale (~100× larger)
 *   效率  edit lines per 1k generated tokens on a fixed log axis, with the lane's own
 *         interquartile band and median line as the reference
 *
 * The lane header carries the conclusion in words, so the shape is confirmation rather
 * than the only way to get the answer. The same layout covers a 4-day and a 90-day window;
 * only the column width and the axis labels change.
 */

const HOUR = 3_600_000;
const HEAD_W = 210;
const PAD_R = 14;
const LANE_H = 80;
const AXIS_H = 26;
const LEGEND_H = 34;
const MIN_LANE_H = LANE_H;

/** Band geometry inside one lane. */
const PRODUCE = { top: 2, h: 26, mid: 2 + 13 };
const BURN = { top: 32, h: 16 };
const EFF = { top: 52, h: 24 };

/** Bars stop widening past this: with only 7 day-columns a full-width bar reads as a
 *  wall of colour and two adjacent days merge into one block. */
const BAR_MAX = 22;


/** Efficiency axis is fixed across lanes so 1× means the same thing everywhere.
 *  The span is p05…p95 of the real data (~0.09…24 lines/1k); wider would squash every
 *  lane into the middle of the band and read as a flat line. */
const EFF_LO = 0.08;
const EFF_HI = 60;
/** Below this there are too few tokens to judge a ratio; hourly buckets burn far less. */
const minGenFor = (step: number): number => (step >= DAY ? 5000 : 600);

/** Map an efficiency value onto the lane's log axis (top = high). */
const effY = (v: number): number => {
  const t = (Math.log10(Math.min(EFF_HI, Math.max(EFF_LO, v))) - Math.log10(EFF_LO)) / (Math.log10(EFF_HI) - Math.log10(EFF_LO));
  return EFF.top + EFF.h - t * EFF.h;
};

const INK = "var(--color-ink)";
const INK_SOFT = "var(--color-ink-soft)";
const FLOW = "var(--color-flow)";
const DANGER = "var(--color-danger)";
const WARNING = "var(--color-warning)";
const GOOD = "var(--color-good)";

/** Start of the bucket containing `ts`, in wall-clock time (the same frame the API uses). */
const floorLocal = (ts: number, step: number): number => {
  const d = new Date(ts);
  if (step >= DAY) d.setHours(0, 0, 0, 0);
  else d.setMinutes(0, 0, 0);
  return d.getTime();
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Bucket label: a calendar date for days, a wall-clock slot for hours. */
const bucketLabel = (ts: number, step: number): string =>
  step >= DAY ? dateShort(ts) : `${dateShort(ts)} ${pad2(new Date(ts).getHours())}:00`;

const niceMax = (v: number): number => {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const quantile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};

/** Edit lines per 1k generated tokens — null when the bucket burned too little to judge. */
const effOf = (d: DailyCell, minGen: number): number | null => (d.gen >= minGen ? d.add / (d.gen / 1000) : null);

interface Stamp {
  text: string;
  tone: "ink" | "warn" | "danger" | "good";
}

/**
 * Turn the bucket series into a sentence. This is the part that makes the view worth
 * looking at: the user should be able to act on the header without decoding a shape.
 */
function stamps(lane: DailyLane, now: number, step: number): Stamp[] {
  const days = lane.days;
  const out: Stamp[] = [];
  const minGen = minGenFor(step);
  const unit = step >= DAY ? "天" : "小时";
  const effs = days.map((d) => effOf(d, minGen));

  // 1. marginal efficiency trend (last three measurable buckets vs the three before)
  const measured = days.filter((_, i) => effs[i] != null);
  if (measured.length >= 6) {
    const last = measured.slice(-3).reduce((a, d) => a + (effOf(d, minGen) ?? 0), 0) / 3;
    const prev = measured.slice(-6, -3).reduce((a, d) => a + (effOf(d, minGen) ?? 0), 0) / 3;
    if (prev > 0) {
      const ratio = last / prev;
      if (ratio <= 0.7) out.push({ text: `效率 ↓${Math.round((1 - ratio) * 100)}%`, tone: "danger" });
      else if (ratio >= 1.4) out.push({ text: `效率 ↑${Math.round((ratio - 1) * 100)}%`, tone: "good" });
    }
  }

  // 2. expensive buckets that did not convert — the finding this whole dataset revolves around
  const p90 = quantile(days.map((d) => d.gen), 0.9);
  const medEff = median(days.map((d) => effOf(d, minGen)).filter((e): e is number => e != null));
  const hot = days.filter((d) => d.gen >= p90 && d.gen >= minGen && (effOf(d, minGen) ?? Infinity) < medEff).length;
  if (hot > 0 && medEff > 0) out.push({ text: `高烧 ${hot} ${unit}`, tone: "danger" });

  // 3. idle / streak — only meaningful across days, where a gap is a real pause
  if (step >= DAY) {
    const gap = Math.round((now - lane.lastDay) / DAY);
    if (gap >= 3) out.push({ text: `${gap} 天无活动`, tone: "warn" });
    else {
      let streak = 0;
      for (let i = days.length - 1; i >= 0; i--) {
        if (days[i].day === lane.lastDay - (days.length - 1 - i) * DAY) streak++;
        else break;
      }
      if (streak >= 4) out.push({ text: `连更 ${streak} 天`, tone: "ink" });
    }
  }

  // 4. probes
  if (lane.totals.loops > 0) out.push({ text: `循环 ×${lane.totals.loops}`, tone: "danger" });
  else if (lane.totals.compactions > 0) out.push({ text: `压缩 ×${lane.totals.compactions}`, tone: "warn" });

  return out.slice(0, 2);
}

const toneClass: Record<Stamp["tone"], string> = {
  ink: "text-ink-soft",
  warn: "text-warning",
  danger: "text-danger",
  good: "text-good",
};

interface Hover {
  lane: string;
  cell: DailyCell;
  x: number;
  y: number;
}

/** Column geometry shared by every lane so the rows line up exactly. */
interface Geom {
  from: number;
  step: number;
  n: number;
  colW: number;
  x: (i: number) => number;
}

export default function DailyStage() {
  const { window: win, setWindow } = useCockpit();
  // Hour columns while a window is short enough to resolve them, day columns beyond.
  // Both are served by the same endpoint; only the bucket size changes.
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
    // Count the buckets the window actually covers: align the start down, then ceil the
    // remainder, so a 1-day window is 24 hour columns (not 25) yet a mid-day 30-day
    // window still keeps both partial endpoint days.
    const n = Math.max(1, Math.ceil((win.to - from) / step));
    const colW = bandW / n;
    return { from, step, n, colW, x: (i: number) => i * colW + colW / 2 };
  }, [win.from, win.to, bandW, step]);

  const lanes = data?.lanes ?? [];
  const bodyH = Math.max(0, size.h - LEGEND_H - AXIS_H);
  const maxLanes = Math.max(1, Math.floor(bodyH / MIN_LANE_H));
  const shown = lanes.slice(0, maxLanes);
  const hidden = lanes.slice(maxLanes);

  const totals = useMemo(() => {
    const t = { add: 0, write: 0, gen: 0, cache: 0, cost: 0, buckets: 0, sessions: 0 };
    for (const l of lanes) {
      t.add += l.totals.add;
      t.write += l.totals.write;
      t.gen += l.totals.gen;
      t.cache += l.totals.cache;
      t.cost += l.totals.cost;
      t.buckets += l.totals.activeDays;
      t.sessions += l.totals.sessions;
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

  const now = Date.now();
  const tickEvery = Math.max(1, Math.ceil(geom.n / Math.max(1, Math.floor(bandW / 64))));

  // Pointer position is measured against the stage, not the lane SVG, so the readout
  // card lands next to the cursor wherever the lane sits in the scroll body.
  const onHover = useCallback((project: string, cell: DailyCell, clientX: number, clientY: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setHover({ lane: project, cell, x: clientX - r.left, y: clientY - r.top });
  }, []);

  if (isLoading && !data) return <Spinner label="ROLLING UP BUCKETS" />;

  const hourMode = geom.step < DAY;

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden grid-paper flex flex-col">
      {/* legend + window totals */}
      <div className="h-[34px] shrink-0 flex items-center gap-3 px-3 hairline-b bg-paper-raised/70">
        <span className="micro">{hourMode ? "小时级" : "日级"} · 产出/消耗/效率</span>
        <span className="w-px h-4 bg-rule" />
        <span className="micro" style={{ color: INK }}>↑ 改动行</span>
        <span className="micro" style={{ color: FLOW }}>↓ 写入行</span>
        <span className="micro" style={{ color: INK_SOFT }}>▮ 生成 token</span>
        <span className="micro">▨ 缓存读取(独立标尺)</span>
        <span className="micro">— 效率 行/1k (对数 · 中位带)</span>
        <span className="micro" style={{ color: DANGER }}>● 高烧</span>
        <span className="micro">{hourMode ? "夜 00–07" : "周末"}</span>
        <div className="ml-auto flex items-center gap-3">
          <span className="micro">改 {compact(totals.add)}</span>
          <span className="micro">写 {compact(totals.write)}</span>
          <span className="micro">烧 {compact(totals.gen)}</span>
          <span className="micro">{money(totals.cost)}</span>
          <span className="micro">
            {lanes.length} 项目 · {bucketLabel(geom.from, geom.step)} 起 {geom.n}
            {hourMode ? " 小时" : " 天"}
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {shown.map((lane) => (
          <LaneRow
            key={lane.project}
            lane={lane}
            geom={geom}
            bandW={bandW}
            now={now}
            hover={hover}
            onHover={onHover}
            onLeave={() => setHover(null)}
            onZoom={zoomTo}
          />
        ))}
        {hidden.length > 0 && (
          <div className="flex items-center gap-2 px-3 h-[26px] hairline-b">
            <span className="micro">+{hidden.length} 项目未显示</span>
            <span className="micro text-ink-faint">
              合计 改 {compact(hidden.reduce((a, l) => a + l.totals.add, 0))} · 写{" "}
              {compact(hidden.reduce((a, l) => a + l.totals.write, 0))} · 烧{" "}
              {compact(hidden.reduce((a, l) => a + l.totals.gen, 0))}
            </span>
          </div>
        )}
        {!shown.length && <div className="micro px-3 py-6">窗口内没有活动</div>}
      </div>

      {/* shared time axis */}
      <div className="h-[26px] shrink-0 relative hairline-t bg-paper-raised/80">
        <svg width={size.w} height={AXIS_H} className="block">
          {Array.from({ length: geom.n }, (_, i) => i)
            .filter((i) => i % tickEvery === 0)
            .map((i) => {
              const t = geom.from + i * geom.step;
              return (
                <g key={i}>
                  <line x1={HEAD_W + geom.x(i)} y1={0} x2={HEAD_W + geom.x(i)} y2={5} stroke="var(--color-rule-strong)" strokeWidth={1} />
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
  const eff = effOf(d, minGenFor(step));
  const left = Math.min(Math.max(hover.x + 14, 8), Math.max(8, width - 268));
  const cardW = 258;
  const rows: [string, string][] = [
    ["改动", `+${d.add} / -${d.del} 行`],
    ["写入", `${d.write} 行`],
    ["生成", `${compact(d.gen)} tok`],
    ["缓存读取", `${compact(d.cache)} tok`],
    ["效率", eff == null ? "样本不足" : `${eff.toFixed(2)} 行/1k`],
    ["会话/轮次", `${d.sessions} / ${d.turns}`],
    ["工具", `${d.tools} 次${d.errors ? ` · 失败 ${d.errors}` : ""}`],
    ["探针", `压缩 ${d.compactions} · 重试 ${d.retries} · 循环 ${d.loops}`],
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
      <div className="mt-1 grid grid-cols-[72px_1fr] gap-x-2 gap-y-[2px]">
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
  now,
  hover,
  onHover,
  onLeave,
  onZoom,
}: {
  lane: DailyLane;
  geom: Geom;
  bandW: number;
  now: number;
  hover: Hover | null;
  onHover: (project: string, cell: DailyCell, clientX: number, clientY: number) => void;
  onLeave: () => void;
  onZoom: (start: number) => void;
}) {
  const st = useMemo(() => stamps(lane, now, geom.step), [lane, now, geom.step]);
  const minGen = minGenFor(geom.step);
  const unit = geom.step >= DAY ? "天" : "小时";

  /** Column index for a bucket start; the API and the axis share the same wall clock. */
  const idxOf = useCallback((t: number) => Math.round((t - geom.from) / geom.step), [geom]);

  // per-lane scales: volume is normalised inside its own lane (projects differ by ~10×),
  // the absolute numbers live in the header instead.
  const scale = useMemo(() => {
    let editMax = 0;
    let writeMax = 0;
    let genMax = 0;
    let cacheMax = 0;
    const effs: number[] = [];
    for (const d of lane.days) {
      editMax = Math.max(editMax, d.add + d.del);
      writeMax = Math.max(writeMax, d.write);
      genMax = Math.max(genMax, d.gen);
      cacheMax = Math.max(cacheMax, d.cache);
      const e = effOf(d, minGen);
      if (e != null) effs.push(e);
    }
    return {
      edit: niceMax(editMax),
      write: niceMax(writeMax),
      gen: niceMax(genMax),
      cache: niceMax(cacheMax),
      medEff: median(effs),
      q1: quantile(effs, 0.25),
      q3: quantile(effs, 0.75),
    };
  }, [lane, minGen]);

  /** Efficiency only exists on measurable buckets; joining across an idle gap would draw a
   *  flat line through time the project did not exist, so each run is its own segment.
   *  A lone point still breaks the previous run — otherwise a gap of weeks reads as one
   *  continuous line. */
  const eff = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    const runs: { x: number; y: number }[][] = [];
    let run: { x: number; y: number }[] = [];
    let prev = Number.NEGATIVE_INFINITY;
    for (const d of lane.days) {
      const e = effOf(d, minGen);
      if (e == null) continue;
      const i = idxOf(d.day);
      const p = { x: geom.x(i), y: effY(e) };
      pts.push(p);
      if (i - prev > 1.5) {
        if (run.length > 1) runs.push(run);
        run = [];
      }
      run.push(p);
      prev = i;
    }
    if (run.length > 1) runs.push(run);
    return { pts, runs };
  }, [lane, geom, idxOf, minGen]);

  /** The lane's own reference band applies only over the span it was actually active. */
  const activeSpan = useMemo(() => {
    if (!lane.days.length) return null;
    const x0 = geom.x(idxOf(lane.days[0].day)) - geom.colW / 2;
    const x1 = geom.x(idxOf(lane.days[lane.days.length - 1].day)) + geom.colW / 2;
    return { x0, x1, w: Math.max(1, x1 - x0) };
  }, [lane, geom, idxOf]);

  const hotBuckets = useMemo(() => {
    const p90 = quantile(lane.days.map((d) => d.gen), 0.9);
    const set = new Set<number>();
    if (!(scale.medEff > 0)) return set;
    for (const d of lane.days) {
      if (d.gen >= p90 && d.gen >= minGen && (effOf(d, minGen) ?? Infinity) < scale.medEff) set.add(d.day);
    }
    return set;
  }, [lane, scale.medEff, minGen]);

  const hoverIdx = hover?.lane === lane.project ? idxOf(hover.cell.day) : null;

  return (
    <div className="flex hairline-b" style={{ height: LANE_H }} data-lane={lane.project}>
      {/* stat card */}
      <div className="shrink-0 flex flex-col justify-center gap-[3px] px-3" style={{ width: HEAD_W }}>
        <div className="tape truncate text-ink" title={lane.project}>
          {lane.project}
        </div>
        <div className="micro">
          {lane.totals.activeDays} {unit}活跃 · 至 {bucketLabel(lane.lastDay, geom.step)}
        </div>
        <div className="micro tabular-nums">
          改 {compact(lane.totals.add)} · 写 {compact(lane.totals.write)} · 烧 {compact(lane.totals.gen)}
        </div>
        <div className="flex gap-2">
          {st.length ? (
            st.map((s) => (
              <span key={s.text} className={`micro ${toneClass[s.tone]}`}>
                {s.text}
              </span>
            ))
          ) : (
            <span className="micro text-ink-faint">
              效率 {scale.medEff > 0 ? `${scale.medEff.toFixed(2)} 行/1k` : "样本不足"}
            </span>
          )}
        </div>
      </div>

      <svg width={bandW} height={LANE_H} className="block shrink-0">
        {/* shading + column grid: weekends for days, the small hours for hours */}
        {Array.from({ length: geom.n }, (_, i) => i).map((i) => {
          const t = geom.from + i * geom.step;
          const dow = new Date(t).getDay();
          const dim = geom.step >= DAY ? dow === 0 || dow === 6 : new Date(t).getHours() < 7;
          return (
            <g key={i}>
              {dim && <rect x={i * geom.colW} y={0} width={geom.colW} height={LANE_H} fill="oklch(0.2 0.05 250 / 0.045)" />}
              <line x1={i * geom.colW} y1={0} x2={i * geom.colW} y2={LANE_H} stroke="oklch(0.2 0.05 250 / 0.07)" strokeWidth={1} />
            </g>
          );
        })}

        {/* PRODUCE — mirrored around a baseline: edit up, full-file writes down */}
        <line x1={0} y1={PRODUCE.mid} x2={bandW} y2={PRODUCE.mid} stroke="var(--color-rule)" strokeWidth={1} />
        {lane.days.map((d) => {
          const w = Math.min(BAR_MAX, Math.max(1.5, geom.colW - 1.5));
          const upH = (Math.min(d.add + d.del, scale.edit) / scale.edit) * (PRODUCE.h / 2 - 1);
          const downH = (Math.min(d.write, scale.write) / scale.write) * (PRODUCE.h / 2 - 1);
          const x = geom.x(idxOf(d.day)) - w / 2;
          const touched = d.add + d.del > 0;
          return (
            <g key={d.day}>
              <rect x={x} y={PRODUCE.mid - upH} width={w} height={Math.max(touched ? 1 : 0, upH)} fill={INK} />
              {d.del > 0 && upH > 0 && (
                <rect
                  x={x}
                  y={PRODUCE.mid - upH}
                  width={w}
                  height={Math.max(1, (d.del / Math.max(1, d.add + d.del)) * upH)}
                  fill={DANGER}
                  opacity={0.85}
                />
              )}
              <rect x={x} y={PRODUCE.mid + 1} width={w} height={Math.max(d.write > 0 ? 1 : 0, downH)} fill={FLOW} opacity={0.8} />
            </g>
          );
        })}

        {/* BURN — generated tokens; cache reads behind, own scale */}
        {lane.days.map((d) => {
          const w = Math.min(BAR_MAX, Math.max(1.5, geom.colW - 1.5));
          const x = geom.x(idxOf(d.day)) - w / 2;
          const cacheH = (Math.min(d.cache, scale.cache) / scale.cache) * BURN.h;
          const genH = (Math.min(d.gen, scale.gen) / scale.gen) * BURN.h;
          return (
            <g key={d.day}>
              <rect x={x} y={BURN.top + BURN.h - cacheH} width={w} height={cacheH} fill={INK} opacity={0.1} />
              <rect x={x} y={BURN.top + BURN.h - genH} width={w} height={Math.max(d.gen > 0 ? 1 : 0, genH)} fill={INK_SOFT} opacity={0.85} />
            </g>
          );
        })}
        {hotBuckets.size > 0 &&
          lane.days
            .filter((d) => hotBuckets.has(d.day))
            .map((d) => (
              <circle
                key={d.day}
                cx={geom.x(idxOf(d.day))}
                cy={(PRODUCE.top + PRODUCE.h + BURN.top) / 2}
                r={2.6}
                fill={DANGER}
              />
            ))}

        {/* EFFICIENCY — log axis, lane interquartile band, median reference */}
        <line x1={0} y1={EFF.top + EFF.h} x2={bandW} y2={EFF.top + EFF.h} stroke="var(--color-rule)" strokeWidth={1} />
        <line x1={0} y1={effY(1)} x2={bandW} y2={effY(1)} stroke="oklch(0.2 0.05 250 / 0.16)" strokeDasharray="2 5" strokeWidth={1} />
        {activeSpan && scale.q1 > 0 && scale.q3 > 0 && (
          <rect
            x={activeSpan.x0}
            y={effY(scale.q3)}
            width={activeSpan.w}
            height={Math.max(1, effY(scale.q1) - effY(scale.q3))}
            fill={INK}
            opacity={0.07}
          />
        )}
        {activeSpan && scale.medEff > 0 && (
          <line
            x1={activeSpan.x0}
            y1={effY(scale.medEff)}
            x2={activeSpan.x1}
            y2={effY(scale.medEff)}
            stroke={INK_SOFT}
            strokeWidth={1}
            opacity={0.45}
          />
        )}
        {eff.runs.map((run, k) => (
          <polyline
            key={k}
            points={run.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke={INK}
            strokeWidth={1.3}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {eff.pts.map((p, k) => (
          <circle key={k} cx={p.x} cy={p.y} r={1.7} fill={INK} />
        ))}

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
