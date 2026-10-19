import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { scaleLinear, scaleSqrt } from "d3-scale";
import { timeDay, timeHour, timeMinute, type TimeInterval } from "d3-time";
import { useCockpit } from "../state/CockpitContext";
import {
  useEcgOps,
  useMarkers,
  useSessions,
  detailOf,
  DAY,
  type EcgOp,
  type EcgSpan,
  type MarkerRow,
  type SessionRow,
} from "../lib/api";
import { clock, compact, dateShort, shortModel } from "../lib/format";
import { Spinner } from "./ui";

/*
  心电图 · 脉冲序列
  --------------------------------------------------------------------------
  波形不是折线，而是由一次操作一个尖峰构成：
    基线上方 = tool_call（对外动作）；基线下方 = assistant turn（对内生成）
    振幅 ∝ 体量（字符/token 的平方根）；宽度 = 该操作的耗时
  多条尖峰以 multiply 叠色 —— 交叠处自然变深，像仪器屏上的磷光叠加。
*/

const PAD_L = 108;
const PAD_R = 14;
const PAD_T = 14;
const AXIS_H = 22;
const LANE_GAP = 10;
const LANE_MIN_H = 62; // god view: below this a lane collapses into the overflow tally
const BAND_H = 22; // focus 模式下基线下方的上下文带
const MIN_SPAN = 2 * 60_000;
const MAX_SPAN = 120 * DAY;

const INK = "oklch(0.25 0.08 250)";
const INK_40 = "oklch(0.25 0.08 250 / 0.4)";
const INK_25 = "oklch(0.25 0.08 250 / 0.25)";
const INK_10 = "oklch(0.25 0.08 250 / 0.1)";
const CRIMSON = "oklch(0.55 0.22 25)";
const AMBER = "oklch(0.72 0.14 75)";

interface Spike extends EcgOp {
  kind: "tool" | "turn";
  /** render height driver: chars for tools, tokens for turns */
  amp: number;
}

interface LaneRect {
  project: string;
  top: number;
  h: number;
  base: number;
  dim: boolean;
}

interface Hover {
  px: number;
  py: number;
  lane: string;
  spike: Spike | null;
  session: SessionRow | null;
}

/** System 1 — the project ECG stage. */
export default function EcgCanvas() {
  const { window: win, setWindow, openSession } = useCockpit();
  const { data, isLoading } = useEcgOps(win);
  const { data: markers } = useMarkers(win);
  const { data: sessions } = useSessions(win);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 480 });
  const [hover, setHover] = useState<Hover | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [crack, setCrack] = useState<number | null>(null); // hovered compaction marker

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- merged, per-lane spike streams ----
  const laneOps = useMemo(() => {
    const byLane = new Map<string, Spike[]>();
    const push = (o: Spike) => {
      if (!byLane.has(o.project)) byLane.set(o.project, []);
      byLane.get(o.project)!.push(o);
    };
    for (const t of data?.tools ?? []) {
      push({ ...t, kind: "tool", amp: Math.max(1, t.out || (t.add ?? 0) + (t.del ?? 0) || 1) });
    }
    for (const t of data?.turns ?? []) {
      // A turn that generated nothing has no amplitude to plot, yet its recorded span can
      // be hours (a session that slept mid-turn). Drawn as a flat bar it reads as activity
      // along the baseline, so it is left out of the waveform entirely.
      const amp = (t.out ?? 0) + (t.r ?? 0);
      if (amp <= 0) continue;
      push({ ...t, kind: "turn", amp });
    }
    for (const list of byLane.values()) list.sort((a, b) => a.at - b.at);
    return byLane;
  }, [data]);

  const lanes = useMemo(() => {
    // Rank by recent activity, not all-time volume: a project that stopped three
    // weeks ago should not hold a lane while a live one is pushed into the tally.
    // The cut is the later of the last quarter of the window and the last 3 days.
    const cutoff = win.to - Math.max(3 * DAY, (win.to - win.from) * 0.25);
    return [...laneOps.entries()]
      .map(([project, ops]) => {
        let total = 0;
        let recent = 0;
        let tools = 0;
        for (const o of ops) {
          if (o.kind === "turn") {
            total += o.amp;
            if (o.at >= cutoff) recent += o.amp;
          } else {
            tools++;
            if (o.at >= cutoff) recent += 1;
          }
        }
        return { project, total, recent, tools };
      })
      .sort((a, b) => b.recent - a.recent || b.total - a.total);
  }, [laneOps, win.from, win.to]);

  const spansByLane = useMemo(() => {
    const m = new Map<string, EcgSpan[]>();
    for (const s of data?.spans ?? []) {
      if (!m.has(s.project)) m.set(s.project, []);
      m.get(s.project)!.push(s);
    }
    return m;
  }, [data]);

  const markersByLane = useMemo(() => {
    const m = new Map<string, MarkerRow[]>();
    for (const mk of markers ?? []) {
      if (!m.has(mk.project)) m.set(mk.project, []);
      m.get(mk.project)!.push(mk);
    }
    return m;
  }, [markers]);

  const plotW = Math.max(80, size.w - PAD_L - PAD_R);
  const plotH = Math.max(60, size.h - PAD_T - AXIS_H);
  const x = useMemo(
    () => scaleLinear().domain([win.from, win.to]).range([0, plotW]),
    [win.from, win.to, plotW]
  );

  // ---- lane geometry -------------------------------------------------------
  // god view keeps only as many lanes as fit above LANE_MIN_H; the long tail of
  // tiny projects collapses into an overflow tally instead of squashing labels.
  // focus expands one lane and collapses the rest into dim strips.
  const laneRects = useMemo<LaneRect[]>(() => {
    if (!lanes.length) return [];
    if (!focus) {
      const maxLanes = Math.max(1, Math.floor(plotH / LANE_MIN_H));
      const shown = lanes.slice(0, maxLanes);
      const laneH = plotH / shown.length;
      return shown.map((l, i) => {
        const top = PAD_T + i * laneH;
        return { project: l.project, top, h: laneH - LANE_GAP, base: top + (laneH - LANE_GAP) / 2, dim: false };
      });
    }
    const stack = plotH - BAND_H;
    const focusedH = stack * 0.62;
    const others = lanes.filter((l) => l.project !== focus);
    const maxStrips = Math.max(1, Math.floor((stack - focusedH) / 18));
    const stripH = Math.max(14, Math.min(26, (stack - focusedH) / Math.max(1, Math.min(others.length, maxStrips))));
    const rects: LaneRect[] = [];
    const fTop = PAD_T;
    rects.push({ project: focus, top: fTop, h: focusedH - LANE_GAP, base: fTop + (focusedH - LANE_GAP) / 2, dim: false });
    let y = fTop + focusedH;
    for (const l of others.slice(0, maxStrips)) {
      rects.push({ project: l.project, top: y, h: stripH - 4, base: y + (stripH - 4) / 2, dim: true });
      y += stripH;
    }
    return rects;
  }, [lanes, focus, plotH]);

  const hiddenLanes = useMemo(() => {
    const shown = new Set(laneRects.map((r) => r.project));
    return lanes.filter((l) => !shown.has(l.project));
  }, [lanes, laneRects]);

  const rectOf = (project: string) => laneRects.find((r) => r.project === project);

  // ---- canvas paint: baselines, spikes, spans, context band ----
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs || !data) return;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = Math.round(size.w * dpr);
    cvs.height = Math.round(size.h * dpr);
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const px = (t: number) => PAD_L + x(t);

    for (const rect of laneRects) {
      const ops = laneOps.get(rect.project) ?? [];
      const half = rect.h / 2;
      ctx.save();
      ctx.globalAlpha = rect.dim ? 0.28 : 1;

      // amplitude scales — sqrt keeps one loud bash from flattening the quiet reads
      let maxUp = 1;
      let maxDn = 1;
      for (const o of ops) {
        if (o.kind === "tool") maxUp = Math.max(maxUp, o.amp);
        else maxDn = Math.max(maxDn, o.amp);
      }
      const up = scaleSqrt().domain([0, maxUp]).range([1, Math.max(6, half - 4)]);
      const dn = scaleSqrt().domain([0, maxDn]).range([1, Math.max(6, half - 4)]);

      // baseline: one hairline of dashed time
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = INK_25;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD_L, rect.base + 0.5);
      ctx.lineTo(size.w - PAD_R, rect.base + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      // spikes, multiply-composited so overlaps darken like phosphor
      ctx.globalCompositeOperation = "multiply";
      for (const o of ops) {
        const sx = px(o.at);
        if (sx < PAD_L - 2 || sx > size.w) continue;
        const w = Math.max(1, px(o.at + o.d) - sx);
        if (o.kind === "tool") {
          const h = Math.max(1.5, up(o.amp));
          ctx.fillStyle = o.status === "error" ? CRIMSON : INK;
          ctx.fillRect(sx, rect.base - h, w, h);
        } else {
          const h = Math.max(1.5, dn(o.amp));
          ctx.fillStyle = o.err ? CRIMSON : INK;
          ctx.fillRect(sx, rect.base, w, h);
        }
      }
      ctx.globalCompositeOperation = "source-over";

      // sub-agent heartbeat: a parallel hairline under the parent's baseline
      const spans = spansByLane.get(rect.project) ?? [];
      const spanY = Math.round(rect.base + Math.min(half - 3, 9)) + 0.5;
      ctx.strokeStyle = INK_40;
      ctx.lineWidth = 1;
      for (const s of spans) {
        const x1 = px(s.from);
        const x2 = px(s.to);
        if (x2 < PAD_L || x1 > size.w) continue;
        ctx.beginPath();
        ctx.moveTo(Math.max(PAD_L, x1), spanY);
        ctx.lineTo(Math.min(size.w - PAD_R, x2), spanY);
        ctx.moveTo(Math.max(PAD_L, x1) + 0.5, spanY - 2.5);
        ctx.lineTo(Math.max(PAD_L, x1) + 0.5, spanY + 2.5);
        ctx.moveTo(Math.min(size.w - PAD_R, x2) - 0.5, spanY - 2.5);
        ctx.lineTo(Math.min(size.w - PAD_R, x2) - 0.5, spanY + 2.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    // context band under the focused lane — the dissection strip
    const focused = focus ? rectOf(focus) : null;
    if (focused) {
      const ops = (laneOps.get(focus!) ?? []).filter((o) => o.kind === "turn");
      const bandTop = focused.top + focused.h + LANE_GAP;
      ctx.save();
      ctx.strokeStyle = INK_10;
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const gy = bandTop + (BAND_H * i) / 4;
        ctx.beginPath();
        ctx.moveTo(PAD_L, gy + 0.5);
        ctx.lineTo(size.w - PAD_R, gy + 0.5);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "multiply";
      let prevX = PAD_L;
      for (const o of ops) {
        const sx = px(o.at);
        if (sx < PAD_L) continue;
        const h = Math.max(0.5, (o.fill ?? 0) * BAND_H);
        ctx.fillStyle = (o.fill ?? 0) >= 0.8 ? CRIMSON : INK_40;
        ctx.fillRect(prevX, bandTop + BAND_H - h, Math.max(1, sx - prevX), h);
        prevX = sx;
      }
      ctx.restore();
    }
  }, [data, laneOps, laneRects, spansByLane, size, x, focus]);

  // ---- wheel zoom anchored at the cursor ----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = x.invert(Math.max(0, Math.min(plotW, e.clientX - rect.left - PAD_L)));
      const f = e.deltaY > 0 ? 1.4 : 1 / 1.4;
      let from = anchor - (anchor - win.from) * f;
      let to = anchor + (win.to - anchor) * f;
      if (to - from < MIN_SPAN) {
        from = anchor - MIN_SPAN / 2;
        to = anchor + MIN_SPAN / 2;
      }
      if (to - from > MAX_SPAN) {
        from = anchor - (anchor - win.from) * (MAX_SPAN / (win.to - win.from));
        to = from + MAX_SPAN;
      }
      setWindow({ from, to });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [x, win.from, win.to, plotW, setWindow]);

  // ---- hover: scanline + nearest-spike hit test ----
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left - PAD_L;
    const py = e.clientY - rect.top - PAD_T;
    if (px < 0 || px > plotW) return setHover(null);
    const laneRect = laneRects.find((r) => py >= r.top && py <= r.top + r.h);
    if (!laneRect) return setHover(null);
    const ops = laneOps.get(laneRect.project) ?? [];
    let best: Spike | null = null;
    let bestDist = 9;
    for (const o of ops) {
      const dist = Math.abs(x(o.at) - px);
      if (dist < bestDist) ((best = o), (bestDist = dist));
    }
    const session = best ? (sessions ?? []).find((s) => s.id === best!.sid) ?? null : null;
    setHover({ px: px + PAD_L, py: py + PAD_T, lane: laneRect.project, spike: best, session });
  };

  const onLeave = () => setHover(null);

  const onClick = () => {
    if (hover?.spike) {
      if (hover.lane !== focus) setFocus(hover.lane);
      else openSession(hover.spike.sid);
      return;
    }
    if (focus) setFocus(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- time axis: d3-time intervals align to LOCAL midnight/hour, unlike a
  // modulo-from-epoch step which lands on 08:00 in UTC+8 and prints no dates.
  const ticks = useMemo<{ t: number; major: boolean }[]>(() => {
    const span = win.to - win.from;
    let iv: TimeInterval | null;
    let major = false;
    if (span > 60 * DAY) {
      iv = timeDay.every(14);
      major = true;
    } else if (span > 20 * DAY) {
      iv = timeDay.every(3);
      major = true;
    } else if (span > 3 * DAY) {
      iv = timeDay.every(1);
      major = true;
    } else if (span > 8 * 3600_000) {
      iv = timeHour.every(2);
    } else {
      iv = timeMinute.every(15);
    }
    const dates = iv ? iv.range(new Date(win.from), new Date(win.to)) : [];
    return dates.slice(0, 40).map((d) => ({ t: +d, major }));
  }, [win.from, win.to]);

  const focusedRect = focus ? rectOf(focus) : null;
  const pending = isLoading && !data;

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden grid-paper cursor-crosshair"
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onClick={onClick}
    >
      {/* Canvas is a replaced element: `inset-0` alone will not stretch it past its
          intrinsic bitmap size, so the CSS box is pinned to the measured size while
          the bitmap itself is scaled by devicePixelRatio in the paint effect. */}
      <canvas ref={canvasRef} className="absolute left-0 top-0 pointer-events-none" style={{ width: size.w, height: size.h }} />

      <svg
        className="absolute left-0 top-0 pointer-events-none"
        style={{ width: size.w, height: size.h }}
        viewBox={`0 0 ${size.w} ${size.h}`}
      >
        {/* time grid */}
        {ticks.map(({ t, major }) => (
          <line
            key={t}
            x1={PAD_L + x(t)}
            x2={PAD_L + x(t)}
            y1={PAD_T}
            y2={size.h - AXIS_H}
            stroke={major ? "oklch(0.25 0.08 250 / 0.16)" : "oklch(0.25 0.08 250 / 0.05)"}
            strokeWidth={1}
          />
        ))}

        {/* event probes: compaction cracks, retry frames, failure crosses */}
        {laneRects.map((rect) =>
          (markersByLane.get(rect.project) ?? []).map((m, k) => {
            const mx = PAD_L + x(m.at);
            if (mx < PAD_L || mx > size.w - PAD_R) return null;
            if (m.type === "compaction") {
              const d = detailOf(m);
              return (
                <g key={`c${rect.project}${k}`}>
                  <line
                    x1={mx}
                    x2={mx}
                    y1={rect.top}
                    y2={rect.top + rect.h}
                    stroke={AMBER}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  <g
                    transform={`translate(${mx},${Math.max(9, Math.min(rect.top + 7, rect.top + rect.h - 8))})`}
                    style={{ pointerEvents: "auto", cursor: "help" }}
                    onMouseEnter={() => setCrack(m.at)}
                    onMouseLeave={() => setCrack(null)}
                  >
                    <rect x={-7} y={-7} width={14} height={13} fill="none" stroke={AMBER} strokeWidth={1} />
                    <text x={0} y={3.5} textAnchor="middle" fontSize={9} fontFamily="var(--font-mono)" fill={AMBER}>
                      C
                    </text>
                  </g>
                  {crack === m.at && d && (
                    <g transform={`translate(${mx},${rect.top + rect.h / 2})`}>
                      <line x1={-46} x2={46} y1={0} y2={0} stroke={AMBER} strokeWidth={1} strokeDasharray="2 2" />
                      <text x={0} y={-8} textAnchor="middle" fontSize={9} fontFamily="var(--font-mono)" fill={AMBER}>
                        {compact(d.before ?? 0)} → {compact(d.after ?? 0)}
                      </text>
                    </g>
                  )}
                </g>
              );
            }
            if (m.type === "retry" || m.type === "loop") {
              const x2 = Math.max(mx + 3, PAD_L + x(m.end_at ?? m.at));
              return (
                <rect
                  key={`r${rect.project}${k}`}
                  x={mx - 1}
                  y={rect.top}
                  width={Math.min(size.w - PAD_R, x2) - mx + 2}
                  height={rect.h}
                  fill="none"
                  stroke={CRIMSON}
                  strokeWidth={m.type === "loop" ? 1.4 : 1}
                  strokeOpacity={0.75}
                >
                  <title>{`${m.type === "loop" ? "循环" : "重试"} ×${m.count ?? 1} @ ${clock(m.at)}`}</title>
                </rect>
              );
            }
            if (m.type !== "failure") return null;
            const fy = rect.base - Math.min(10, rect.h / 4);
            return (
              <g key={`f${rect.project}${k}`} transform={`translate(${mx},${fy})`}>
                <line x1={-3} y1={-3} x2={3} y2={3} stroke={CRIMSON} strokeWidth={1.3} />
                <line x1={-3} y1={3} x2={3} y2={-3} stroke={CRIMSON} strokeWidth={1.3}>
                  <title>{`失败 @ ${clock(m.at)}`}</title>
                </line>
              </g>
            );
          })
        )}

        {/* scanline */}
        {hover && (
          <>
            <line x1={hover.px} x2={hover.px} y1={PAD_T} y2={size.h - AXIS_H} stroke={INK} strokeWidth={1} />
            <line
              x1={PAD_L}
              x2={size.w - PAD_R}
              y1={hover.py}
              y2={hover.py}
              stroke={INK_25}
              strokeWidth={1}
              strokeDasharray="2 3"
            />
          </>
        )}
      </svg>

      {pending && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <Spinner />
        </div>
      )}

      {/* lane labels */}
      {laneRects.map((rect, i) => {
        const meta = lanes.find((l) => l.project === rect.project);
        return (
          <div
            key={rect.project}
            className={rect.dim ? "absolute left-0 w-[108px] px-2 pt-0.5 pointer-events-none opacity-30" : "absolute left-0 w-[108px] px-2 pt-1 pointer-events-none"}
            style={{ top: rect.top, height: rect.h }}
          >
            <div className="tape leading-tight truncate" title={rect.project}>
              {rect.project}
            </div>
            {!rect.dim && (
              <div className="micro mt-0.5">
                LANE {String(i + 1).padStart(2, "0")} · {meta?.tools ?? 0} CALLS
              </div>
            )}
          </div>
        );
      })}

      {/* overflow tally: projects too small to earn a lane at this zoom */}
      {hiddenLanes.length > 0 && (
        <div className="absolute left-0 bottom-[26px] w-[108px] px-2 pointer-events-none" title={hiddenLanes.map((l) => l.project).join("\n")}>
          <div className="micro text-ink-faint">+{hiddenLanes.length} 项目未显示</div>
        </div>
      )}

      {/* context band label (focus mode) */}
      {focusedRect && (
        <div
          className="absolute left-0 w-[108px] px-2 pointer-events-none"
          style={{ top: focusedRect.top + focusedRect.h + LANE_GAP }}
        >
          <div className="micro">CTX BAND</div>
        </div>
      )}

      {/* axis */}
      <div className="absolute bottom-0 left-[108px] right-0 h-[22px] border-t border-rule bg-paper-raised/80">
        {ticks.map(({ t, major }) => (
          <div
            key={t}
            className="absolute top-[4px] tape text-[8px] text-ink-faint -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${(x(t) / plotW) * 100}%` }}
          >
            {major ? dateShort(t) : clock(t)}
          </div>
        ))}
      </div>

      {/* legend + state */}
      <div className="absolute top-1 right-3 flex items-center gap-3 pointer-events-none">
        {data?.truncated && <span className="micro text-danger">数据已截断 · 滚轮放大看细节</span>}
        {focus ? (
          <span className="micro">
            聚焦 <span className="text-ink">{focus}</span> · 再点波峰进入解剖 · ESC 退出
          </span>
        ) : (
          <span className="micro text-ink-faint">滚轮缩放 · 点击波峰聚焦泳道</span>
        )}
        <span className="micro">▲ TOOL</span>
        <span className="micro">▼ TURN</span>
        <span className="micro" style={{ color: AMBER }}>
          [C] 压缩
        </span>
        <span className="micro text-danger">▢ 重试</span>
      </div>

      {/* 病历卡 — the scanline readout */}
      {hover && (
        <div
          className="absolute z-10 pointer-events-none hairline bg-paper-raised px-2 py-1.5 w-[262px]"
          style={{ left: Math.max(4, Math.min(size.w - 270, hover.px + 10)), top: Math.max(4, Math.min(size.h - 130, hover.py - 10)) }}
        >
          <div className="flex items-baseline justify-between">
            <span className="tape">{hover.lane}</span>
            <span className="tape text-ink-faint shrink-0">
              {dateShort(hover.spike?.at ?? win.from)} {clock(hover.spike?.at ?? win.from)}
            </span>
          </div>
          {hover.spike ? (
            <div className="mt-1 flex items-baseline gap-2">
              <span className="tape uppercase">{hover.spike.kind === "tool" ? hover.spike.name : shortModel(hover.spike.model ?? "")}</span>
              <span className="tape text-ink">
                {hover.spike.kind === "turn" ? `${compact(hover.spike.amp)} TOK` : `${compact(hover.spike.amp)} CHR`}
              </span>
              <span className="tape text-ink-faint ml-auto">
                {hover.spike.d >= 1000 ? `${(hover.spike.d / 1000).toFixed(1)}s` : `${hover.spike.d}ms`}
              </span>
            </div>
          ) : (
            <div className="tape text-ink-faint mt-1">静默 / NO SIGNAL</div>
          )}
          {hover.session && (
            <div className="mt-1 pt-1 border-t border-rule tape text-ink leading-[1.35] line-clamp-2">
              {hover.session.first_prompt ?? hover.session.title ?? "…"}
            </div>
          )}
          <div className="micro mt-1 text-ink-faint">
            {focus === hover.lane ? "CLICK → 解剖此会话" : "CLICK → 聚焦此泳道"}
          </div>
        </div>
      )}
    </div>
  );
}
