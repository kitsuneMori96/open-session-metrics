import { useMemo, useState } from "react";
import { Group } from "@visx/group";
import { Circle } from "@visx/shape";
import { scaleLinear } from "@visx/scale";
import { extent } from "d3-array";
import type { SessionRow } from "../../lib/api";
import { FAINT, logRange, logScale, paletteFor, tickIndices, yTicks } from "../../lib/chart";
import { AxisX, AxisY, Figure, Legend, Rows, Tip, TipNote, TipRow, TipTitle } from "./base";
import { dayStamp, dur, int, shortModel, stamp, tok, usd } from "../../lib/format";
import { sessionTitle } from "../../lib/format";

export interface ScatterField {
  key: string;
  label: string;
  get: (s: SessionRow) => number;
  fmt: (v: number) => string;
  /** A wall-clock axis; ticks become dates and log is disabled. */
  time?: boolean;
}

export const FIELDS: ScatterField[] = [
  { key: "tokens", label: "tokens", get: (s) => s.tokens, fmt: tok },
  { key: "cost", label: "cost", get: (s) => s.cost, fmt: (v) => (v > 0 ? usd(v) : "free") },
  { key: "turns", label: "turns", get: (s) => s.turns, fmt: (v) => `${int(v)}` },
  { key: "span", label: "duration", get: (s) => s.spanMs / 1000, fmt: (v) => dur(v * 1000) },
  { key: "rate", label: "output rate", get: (s) => s.outputRate, fmt: (v) => `${v.toFixed(1)} tok/s` },
  { key: "ctx", label: "context", get: (s) => s.contextPct, fmt: (v) => `${(v * 100).toFixed(0)}%` },
  { key: "errors", label: "errors", get: (s) => s.errors, fmt: (v) => `${int(v)}` },
  { key: "updated", label: "updated", get: (s) => s.updated, fmt: (v) => stamp(v), time: true },
];

const field = (key: string): ScatterField => FIELDS.find((f) => f.key === key) ?? FIELDS[0];

/**
 * Sessions plotted as points.
 *
 * The table answers "which session cost the most"; this answers "what kind of session
 * is the outlier" — a question about *shape* that only exists once two measures share a
 * plane. Colour is a third dimension (project or model), and a click is a drill-down.
 */
export function SessionScatter({
  sessions,
  url,
  xKey,
  yKey,
  onAxes,
  onPick,
  highlightId,
  onHighlight,
}: {
  sessions: SessionRow[];
  /** Carries the current axis choice so it survives a reload, like the slice does. */
  url: URLSearchParams;
  xKey: string;
  yKey: string;
  onAxes: (x: string, y: string) => void;
  onPick: (id: string) => void;
  highlightId?: string | null;
  onHighlight?: (id: string | null) => void;
}) {
  // Token counts and costs span six orders of magnitude, so the log axis is the honest
  // default; the button is right there for the linear view.
  const [log, setLog] = useState(true);
  const [colorBy, setColorBy] = useState<"project" | "model" | "agent">("project");
  const [hover, setHover] = useState<{ x: number; y: number; s: SessionRow } | null>(null);
  void url;

  const fx = field(xKey);
  const fy = field(yKey);

  const groups = useMemo(() => {
    const byLabel = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const label = colorBy === "project" ? s.project : colorBy === "model" ? shortModel(s.model) : s.agent ?? "main";
      const list = byLabel.get(label) ?? [];
      list.push(s);
      byLabel.set(label, list);
    }
    const ranked = [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length);
    const top = ranked.slice(0, 7);
    const rest = ranked.slice(7);
    const colors = paletteFor([...top.map(([l]) => l), "other"]);
    const out = top.map(([label, rows]) => ({ label, rows, color: colors.get(label)! }));
    if (rest.length) out.push({ label: "other", rows: rest.flatMap(([, r]) => r), color: colors.get("other")! });
    return out;
  }, [sessions, colorBy]);

  const usableLog = log && !fx.time && !fy.time;

  return (
    <Figure
      label="sessions"
      height={250}
      right={
        <span className="flex items-center gap-1">
          <select className="field" value={xKey} onChange={(e) => onAxes(e.target.value, yKey)} title="x axis">
            {FIELDS.map((f) => (
              <option key={f.key} value={f.key}>
                x: {f.label}
              </option>
            ))}
          </select>
          <select className="field" value={yKey} onChange={(e) => onAxes(xKey, e.target.value)} title="y axis">
            {FIELDS.map((f) => (
              <option key={f.key} value={f.key}>
                y: {f.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={usableLog ? "btn btn-on" : "btn"}
            onClick={() => setLog((v) => !v)}
            title="logarithmic axes — cost and token counts span six orders of magnitude; a zero reading rests on the axis floor"
          >
            log
          </button>
          <select className="field" value={colorBy} onChange={(e) => setColorBy(e.target.value as typeof colorBy)} title="colour">
            <option value="project">by project</option>
            <option value="model">by model</option>
            <option value="agent">by agent</option>
          </select>
        </span>
      }
      note={
        <>
          {sessions.length} sessions active in the window ·{" "}
          <span style={{ color: FAINT }}>{hover ? "" : "hover a point to read it, click to open"}</span>
        </>
      }
    >
      {(box) => {
        const { margin, inner, width } = box;
        const plotH = inner.height;

        const xs = sessions.map((s) => fx.get(s));
        const ys = sessions.map((s) => fy.get(s));
        // `extent([])` is `[undefined, undefined]`, and a scale built on NaN turns every
        // tick and every point into NaN; an empty slice has to fall back to a real domain.
        const span = (vals: number[]): [number, number] => {
          if (vals.length === 0) return [0, 0];
          const [lo, hi] = extent(vals) as [number, number];
          return [lo ?? 0, hi ?? 0];
        };
        const [x0, x1] = span(xs);
        const [y0, y1] = span(ys);
        const grow = (lo: number, hi: number, floor: number) => (hi > lo ? hi : Math.max(floor, lo + 1));

        const xR = usableLog ? logRange(xs, x1) : null;
        const yR = usableLog ? logRange(ys, y1) : null;

        const xScale = fx.time
          ? scaleLinear<number>({ domain: [x0, grow(x0, x1, x0 + 86_400_000)], range: [0, inner.width] })
          : xR
            ? logScale(xR, [0, inner.width])
            : scaleLinear<number>({ domain: [Math.min(0, x0), grow(x0, x1, 1)], range: [0, inner.width] });
        const yScale = fy.time
          ? scaleLinear<number>({ domain: [y0, grow(y0, y1, y0 + 86_400_000)], range: [plotH, 0] })
          : yR
            ? logScale(yR, [plotH, 0])
            : scaleLinear<number>({ domain: [Math.min(0, y0), grow(y0, y1, 1)], range: [plotH, 0] });

        const xTicks = fx.time
          ? tickValuesFor(x0, x1, 4)
          : xR
            ? logTicks(xR[0], xR[1])
            : yTicks(grow(x0, x1, 1), 4);
        const yTicksV = fy.time ? tickValuesFor(y0, y1, 4) : yR ? logTicks(yR[0], yR[1]) : yTicks(grow(y0, y1, 1), 4);
        const fmtX = (v: number) => (fx.time ? dayStamp(v) : fx.fmt(v));
        const fmtY = (v: number) => (fy.time ? dayStamp(v) : fy.fmt(v));
        // Zero and near-zero readings cannot sit on a log axis; they rest on its floor.
        const place = (v: number, r: [number, number] | null) => (r ? Math.max(v, r[0]) : v);

        return (
          <>
            <div className="mb-1 flex justify-end">
              <Legend items={groups.map((g) => ({ key: g.label, label: g.label, color: g.color }))} />
            </div>
            <svg width={width} height={box.height - 16} onMouseLeave={() => setHover(null)}>
              <Group top={margin.top} left={margin.left}>
                <Rows ticks={yTicksV.map((t) => (fy.time ? yScale(t) : t))} y={(v) => (fy.time ? v : yScale(v))} left={0} width={inner.width} />
                <AxisY top={0} left={0} scale={yScale} tickValues={yTicksV} format={fmtY} />
                <AxisX top={plotH} left={0} scale={xScale} tickValues={xTicks} format={fmtX} />
                {groups.map((g) =>
                  g.rows.map((s) => {
                    const on = highlightId ? highlightId === s.id : true;
                    const hovering = hover?.s.id === s.id;
                    return (
                      <Circle
                        key={s.id}
                        cx={xScale(place(fx.get(s), xR))}
                        cy={yScale(place(fy.get(s), yR))}
                        r={hovering ? 5 : 3}
                        fill={g.color}
                        fillOpacity={on ? (hovering ? 0.95 : 0.62) : 0.1}
                        stroke="var(--color-paper-raised)"
                        strokeWidth={hovering ? 1.5 : 0.75}
                        style={{ cursor: "pointer" }}
                        onMouseEnter={(e) => {
                          const rect = (e.target as SVGCircleElement).ownerSVGElement!.getBoundingClientRect();
                          setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, s });
                          onHighlight?.(s.id);
                        }}
                        onClick={() => onPick(s.id)}
                      />
                    );
                  })
                )}
                {sessions.length === 0 && (
                  <text x={inner.width / 2} y={plotH / 2} textAnchor="middle" fill={FAINT} fontSize={10} fontFamily="JetBrains Mono, monospace">
                    no sessions in this window
                  </text>
                )}
              </Group>
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
                          <TipTitle>{sessionTitle(hover.s.title, hover.s.firstPrompt)}</TipTitle>
                          <TipRow label="project" value={hover.s.project} />
                          <TipRow label="agent" value={hover.s.agent ?? "main"} />
                          <TipRow label="model" value={shortModel(hover.s.model)} />
                          <TipNote>
                            {fx.label} {fx.fmt(fx.get(hover.s))} · {fy.label} {fy.fmt(fy.get(hover.s))}
                          </TipNote>
                          <TipNote>
                            {tok(hover.s.tokens)} tok · {usd(hover.s.cost)} · {hover.s.turns} turns ·{" "}
                            {hover.s.errors} errors
                          </TipNote>
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

/** Round-ish tick values inside a non-zero domain (log axes never reach zero). */
function tickValuesFor(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo)) return [lo];
  const step = (hi - lo) / count;
  return Array.from({ length: count + 1 }, (_, i) => lo + i * step);
}

/** Base-10 ticks a log axis wants, with a light fallback for a narrow span. */
function logTicks(lo: number, hi: number): number[] {
  const a = Math.max(lo, 1e-9);
  const b = Math.max(hi, a * 10);
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(a)); e <= Math.ceil(Math.log10(b)); e++) {
    const v = 10 ** e;
    if (v >= a * 0.99 && v <= b * 1.01) out.push(v);
  }
  if (out.length < 2) out.push(a, b);
  return out;
}
