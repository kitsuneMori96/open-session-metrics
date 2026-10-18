import { useEffect, useMemo, useRef, useState } from "react";
import { scaleLinear, scaleSqrt } from "d3-scale";
import { useCockpit } from "../state/CockpitContext";
import { useEcg, useSessions, DAY, type FlowPoint, type SessionRow } from "../lib/api";
import { clock, compact, dateShort, modelColor, money, shortModel } from "../lib/format";
import { Spinner } from "./ui";

const PAD_L = 108;
const PAD_R = 14;
const PAD_T = 10;
const LANE_GAP = 8;
const AXIS_H = 22;
const LANE_MIN_H = 58;

interface Hover {
  x: number;
  y: number;
  lane: string;
  point: FlowPoint | null;
  sessions: SessionRow[];
}

/** System 1 — the project ECG: one lane per project, waveform = token flow rate. */
export default function EcgCanvas() {
  const { window, openSession } = useCockpit();
  const { data: ecg } = useEcg(window);
  const { data: sessions } = useSessions(window);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 460 });
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const grouped = useMemo(() => {
    const byLane = new Map<string, FlowPoint[]>();
    for (const p of ecg?.points ?? []) {
      if (!byLane.has(p.project)) byLane.set(p.project, []);
      byLane.get(p.project)!.push(p);
    }
    for (const list of byLane.values()) list.sort((a, b) => a.bucket - b.bucket);
    return byLane;
  }, [ecg]);

  const lanes = useMemo(
    () =>
      [...grouped.entries()]
        .map(([project, pts]) => ({ project, total: pts.reduce((a, p) => a + p.tokens, 0) }))
        .sort((a, b) => b.total - a.total)
        .map((l) => l.project),
    [grouped]
  );

  const plotW = Math.max(80, size.w - PAD_L - PAD_R);
  const plotH = Math.max(60, size.h - PAD_T - AXIS_H);
  const laneH = lanes.length ? Math.max(LANE_MIN_H, plotH / lanes.length) : plotH;
  const usableH = laneH - LANE_GAP;
  const x = useMemo(
    () => scaleLinear().domain([window.from, window.to]).range([0, plotW]),
    [window.from, window.to, plotW]
  );
  const maxY = useMemo(() => {
    let m = 1;
    for (const list of grouped.values()) for (const p of list) m = Math.max(m, p.tokens);
    return m;
  }, [grouped]);
  const yFlow = useMemo(() => scaleSqrt().domain([0, maxY]).range([0, usableH]), [maxY, usableH]);

  const laneTop = (i: number) => PAD_T + i * laneH;
  const laneBase = (i: number) => laneTop(i) + usableH;
  const yOf = (i: number, tokens: number) => laneBase(i) - yFlow(tokens);

  const dayTicks = useMemo(() => {
    const days = (window.to - window.from) / DAY;
    const step = days > 120 ? 14 : days > 60 ? 7 : days > 20 ? 3 : days > 8 ? 1 : 0.25;
    const out: number[] = [];
    const start = Math.ceil(window.from / (step * DAY)) * step * DAY;
    for (let t = start; t <= window.to; t += step * DAY) out.push(t);
    return out;
  }, [window.from, window.to]);

  const height = PAD_T + laneH * lanes.length + AXIS_H;

  const onMove = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left - PAD_L;
    const py = e.clientY - rect.top - PAD_T;
    if (px < 0 || px > plotW || !ecg) return setHover(null);
    const t = x.invert(px);
    const i = Math.min(lanes.length - 1, Math.max(0, Math.floor(py / laneH)));
    const lane = lanes[i];
    const step = ecg.step;
    const wanted = Math.round(t / step) * step;
    const list = grouped.get(lane) ?? [];
    let point: FlowPoint | null = null;
    for (const p of list) if (!point || Math.abs(p.bucket - wanted) < Math.abs(point.bucket - wanted)) point = p;
    const base = point?.bucket ?? wanted;
    const near = (sessions ?? [])
      .filter((s) => s.project === lane && Math.abs(s.created - base) <= step * 1.5)
      .sort((a, b) => b.turns - a.turns)
      .slice(0, 2);
    setHover({ x: px + PAD_L, y: py + PAD_T, lane, point, sessions: near });
  };

  const commit = () => {
    if (!hover) return;
    const pick =
      hover.sessions[0] ?? (sessions ?? []).filter((s) => s.project === hover.lane).sort((a, b) => b.turns - a.turns)[0];
    if (pick) openSession(pick.id);
  };

  if (!ecg) return <Spinner />;

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden grid-paper cursor-crosshair"
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
      onClick={commit}
    >
      <svg className="absolute inset-0 pointer-events-none" width={size.w} height={height}>
        {dayTicks.map((t) => (
          <line
            key={t}
            x1={PAD_L + x(t)}
            x2={PAD_L + x(t)}
            y1={PAD_T}
            y2={PAD_T + laneH * lanes.length}
            stroke={new Date(t).getHours() === 0 ? "oklch(0.2 0.05 250 / 0.15)" : "oklch(0.2 0.05 250 / 0.06)"}
            strokeWidth={1}
          />
        ))}

        {lanes.map((lane, i) => {
          const pts = grouped.get(lane) ?? [];
          return (
            <g key={lane}>
              <line x1={0} x2={size.w} y1={laneBase(i)} y2={laneBase(i)} stroke="oklch(0.2 0.05 250 / 0.35)" strokeWidth={1} />
              {pts.length > 1 && (
                <path
                  d={`M ${PAD_L + x(pts[0].bucket)},${laneBase(i)} ${pts
                    .map((p) => `L ${PAD_L + x(p.bucket)},${yOf(i, p.tokens)}`)
                    .join(" ")} L ${PAD_L + x(pts[pts.length - 1].bucket)},${laneBase(i)} Z`}
                  fill="oklch(0.2 0.05 250 / 0.06)"
                />
              )}
              {pts.slice(1).map((p, j) => (
                <line
                  key={p.bucket}
                  x1={PAD_L + x(pts[j].bucket)}
                  y1={yOf(i, pts[j].tokens)}
                  x2={PAD_L + x(p.bucket)}
                  y2={yOf(i, p.tokens)}
                  stroke={modelColor(p.dominant_model)}
                  strokeWidth={1}
                />
              ))}
              {pts
                .filter((p) => p.tokens > maxY * 0.6)
                .map((p) => (
                  <circle
                    key={`pk${lane}${p.bucket}`}
                    cx={PAD_L + x(p.bucket)}
                    cy={yOf(i, p.tokens)}
                    r={2.2}
                    fill={modelColor(p.dominant_model)}
                    stroke="var(--color-paper)"
                    strokeWidth={0.7}
                  />
                ))}
              {pts.filter((p) => p.peak_fill > 0.85).map((p) => (
                <rect
                  key={`ov${lane}${p.bucket}`}
                  x={PAD_L + x(p.bucket) - 1.5}
                  y={laneBase(i) - usableH}
                  width={3}
                  height={usableH}
                  fill="oklch(0.55 0.22 25 / 0.5)"
                />
              ))}
            </g>
          );
        })}

        {hover && (
          <>
            <line x1={hover.x} x2={hover.x} y1={PAD_T} y2={PAD_T + laneH * lanes.length} stroke="var(--color-ink)" strokeWidth={1} />
            <line x1={PAD_L} x2={size.w - PAD_R} y1={hover.y} y2={hover.y} stroke="oklch(0.2 0.05 250 / 0.25)" strokeWidth={1} strokeDasharray="2 3" />
          </>
        )}
      </svg>

      {lanes.map((lane, i) => (
        <div
          key={lane}
          className="absolute left-0 w-[108px] border-r border-rule bg-paper-raised/75 px-2 pt-1 pointer-events-none"
          style={{ top: laneTop(i), height: laneH }}
        >
          <div className="tape text-ink leading-tight break-all" style={{ wordBreak: "break-all" }}>
            {lane}
          </div>
          <div className="micro mt-0.5">LANE {String(i + 1).padStart(2, "0")}</div>
        </div>
      ))}

      <div className="absolute bottom-0 left-[108px] right-0 h-[22px] border-t border-rule bg-paper-raised/80">
        {dayTicks.map((t) => (
          <div
            key={t}
            className="absolute top-[4px] tape text-[8px] text-ink-faint -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${(x(t) / plotW) * 100}%` }}
          >
            {new Date(t).getHours() === 0 ? dateShort(t) : clock(t)}
          </div>
        ))}
      </div>

      {hover && (
        <div
          className="absolute z-10 pointer-events-none hairline bg-paper-raised px-2 py-1.5 w-[272px]"
          style={{ left: Math.max(4, Math.min(size.w - 280, hover.x + 12)), top: Math.max(4, Math.min(size.h - 150, hover.y - 12)) }}
        >
          <div className="flex items-baseline justify-between">
            <span className="tape text-ink break-all">{hover.lane}</span>
            <span className="tape text-ink-faint shrink-0">
              {dateShort(hover.point?.bucket ?? 0)} {clock(hover.point?.bucket ?? 0)}
            </span>
          </div>
          {hover.point ? (
            <>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="font-mono font-extralight text-[22px] leading-none tabular-nums">
                  {compact(hover.point.tokens)}
                </span>
                <span className="micro">TK/桶</span>
                <span className="tape text-flow ml-auto">{money(hover.point.cost)}</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="w-2 h-2 inline-block" style={{ background: modelColor(hover.point.dominant_model) }} />
                <span className="tape">{shortModel(hover.point.dominant_model)}</span>
                <span className="tape text-ink-faint ml-auto">CTX {(hover.point.peak_fill * 100).toFixed(0)}%</span>
              </div>
            </>
          ) : (
            <div className="tape text-ink-faint mt-1">静默时段 / NO FLOW</div>
          )}
          {hover.sessions.map((s) => (
            <div key={s.id} className="mt-1.5 pt-1.5 border-t border-rule">
              <div className="micro">
                {clock(s.created)} 开启会话 · {s.turns} TURNS · {s.tool_calls} TOOLS
              </div>
              <div className="tape text-ink leading-[1.35] line-clamp-3">“{s.first_prompt ?? s.title ?? "…"}”</div>
            </div>
          ))}
          <div className="micro mt-1.5 text-ink-faint">CLICK → 解剖此波峰</div>
        </div>
      )}
    </div>
  );
}
