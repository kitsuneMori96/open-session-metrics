import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ParentSize } from "@visx/responsive";
import { AxisBottom, AxisLeft } from "@visx/axis";
import type { AxisScale } from "@visx/axis";
import clsx from "clsx";
import { FAINT, MARGIN, RULE_STRONG } from "../../lib/chart";

/* ------------------------------------------------------------------ *
 * Figure furniture
 * ------------------------------------------------------------------ */

export interface Box {
  width: number;
  height: number;
  /** Plot area inside the margins. */
  inner: { width: number; height: number };
  margin: typeof MARGIN;
}

/**
 * A captioned plot area. The caption is a `.micro` label with a hairline running to
 * the right edge — the same rule the rest of the panel uses — so a figure reads as
 * part of the instrument rather than as an embedded widget.
 */
export function Figure({
  label,
  right,
  height,
  note,
  children,
  className,
}: {
  label: ReactNode;
  right?: ReactNode;
  height: number;
  note?: ReactNode;
  children: (box: Box) => ReactNode;
  className?: string;
}) {
  const margin = MARGIN;
  return (
    <div className={clsx("figure min-w-0", className)}>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="micro shrink-0">{label}</span>
        <span className="h-px min-w-2 flex-1 bg-rule" />
        {right && <span className="tape shrink-0 text-ink-faint">{right}</span>}
      </div>
      <div className="relative" style={{ height }}>
        <ParentSize debounceTime={0}>
          {({ width, height: h }) =>
            width > 0 && h > 0 ? (
              children({
                width,
                height: h,
                margin,
                inner: { width: Math.max(10, width - margin.left - margin.right), height: Math.max(10, h - margin.top - margin.bottom - 6) },
              })
            ) : null
          }
        </ParentSize>
      </div>
      {note && <div className="micro mt-1 leading-relaxed">{note}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tooltips: hand-rolled, because every one of them is a small table of
 * numbers rather than a single label.
 * ------------------------------------------------------------------ */

export interface TipState {
  x: number;
  y: number;
  node: ReactNode;
}

export function useTip() {
  const [tip, setTip] = useState<TipState | null>(null);
  return {
    tip,
    show: (x: number, y: number, node: ReactNode) => setTip({ x, y, node }),
    hide: () => setTip(null),
  };
}

const TIP_X = 10;
const TIP_Y = 8;
const TIP_PAD = 6;

/** The box a tooltip may occupy: the pane that scrolls under the charts, else the window.
 *  Decorative clipping (`overflow: hidden` on a plot wrapper) is not a viewport: the
 *  tooltip is portalled out of it, so only real scroll containers bound it. */
function visibleBox(from: HTMLElement | null): DOMRect {
  for (let p = from?.parentElement ?? null; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflowY === "auto" || s.overflowY === "scroll") {
      const r = p.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return r;
    }
  }
  return new DOMRect(0, 0, document.documentElement.clientWidth, document.documentElement.clientHeight);
}

/**
 * Beside the pointer, then pushed back inside what is actually visible.
 *
 * Three things were wrong before: the flip threshold was a guessed 160px, so a tooltip
 * wider than that (a session title, four series) still ran off the edge; nothing looked at
 * the vertical edges at all; and the tooltip lived inside the plot's clipping wrapper, so
 * wherever it landed it could be cut by a box the user cannot see. Now it is placed by an
 * invisible anchor in chart coordinates, portalled to the body, measured, and clamped to
 * the scrolling pane — flipping sides when it can, sliding when it cannot.
 */
export function Tip({ tip }: { tip: TipState | null }) {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const place = useCallback(() => {
    const a = anchor.current;
    const el = box.current;
    if (!a || !el) return;
    const at = a.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const view = visibleBox(a);
    // the pointer's right and below by default; the other side when that overflows
    const preferredLeft = at.left + TIP_X;
    const preferredTop = at.top + TIP_Y;
    const left = preferredLeft + w > view.right - TIP_PAD ? at.left - TIP_X - w : preferredLeft;
    const top = preferredTop + h > view.bottom - TIP_PAD ? at.top - TIP_Y - h : preferredTop;
    const next = {
      left: Math.round(Math.min(Math.max(left, view.left + TIP_PAD), view.right - TIP_PAD - w)),
      top: Math.round(Math.min(Math.max(top, view.top + TIP_PAD), view.bottom - TIP_PAD - h)),
    };
    // the effect runs after every render; only a real move may schedule another one
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, []);

  useLayoutEffect(() => {
    place();
  });

  // A portalled box does not travel with the content it describes, so re-place on scroll.
  useEffect(() => {
    if (!tip) return;
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [tip, place]);

  if (!tip) return null;
  return (
    <>
      <span ref={anchor} aria-hidden className="absolute" style={{ left: tip.x, top: tip.y, width: 0, height: 0 }} />
      {createPortal(
        <div
          ref={box}
          className="tip"
          style={{
            position: "fixed",
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            visibility: pos ? undefined : "hidden",
          }}
        >
          {tip.node}
        </div>,
        document.body
      )}
    </>
  );
}

export function TipTitle({ children }: { children: ReactNode }) {
  return (
    <div className="tip-row mb-1" style={{ color: "var(--color-ink)", fontWeight: 600 }}>
      {children}
    </div>
  );
}

export function TipRow({ color, label, value }: { color?: string; label: ReactNode; value: ReactNode }) {
  return (
    <div className="tip-row">
      <span className="tip-key">
        {color && <i className="tip-swatch" style={{ background: color }} />}
        {label}
      </span>
      <span className="tip-val">{value}</span>
    </div>
  );
}

export function TipNote({ children }: { children: ReactNode }) {
  return (
    <div className="tip-row mt-1" style={{ color: FAINT }}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A legend in the same voice as the caption.
 * ------------------------------------------------------------------ */

export function Legend({
  items,
  active,
  onToggle,
}: {
  items: { key: string; label: string; color: string }[];
  active?: Set<string>;
  onToggle?: (key: string) => void;
}) {
  return (
    <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-[2px]">
      {items.map((item) => {
        const on = !active || active.has(item.key);
        return (
          <button
            key={item.key}
            type="button"
            onClick={onToggle ? () => onToggle(item.key) : undefined}
            className={clsx("flex items-center gap-1 font-mono text-[9px] tracking-[0.06em]", onToggle && "cursor-pointer")}
            style={{ color: on ? "var(--color-ink-soft)" : "var(--color-ink-faint)", opacity: on ? 1 : 0.55 }}
            title={onToggle ? "toggle series" : undefined}
          >
            <i className="block h-[7px] w-[7px]" style={{ background: item.color }} />
            {item.label}
          </button>
        );
      })}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Shared chart geometry
 * ------------------------------------------------------------------ */

/** Evenly spaced vertical hairlines; the only grid a chart in this theme gets. */
export function Rows({ ticks, y, left, width }: { ticks: number[]; y: (v: number) => number; left: number; width: number }) {
  return (
    <g>
      {ticks.map((t) => (
        <line key={t} x1={left} x2={left + width} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------ *
 * Axes
 * ------------------------------------------------------------------ */

const TICK_LABEL = {
  fill: FAINT,
  fontSize: 9,
  fontFamily: "JetBrains Mono, monospace",
  letterSpacing: "0.05em",
} as const;

/** A horizontal axis: one rule, short ticks, labels under it. */
export function AxisX({
  top,
  left,
  scale,
  tickValues,
  format,
}: {
  top: number;
  left: number;
  scale: AxisScale;
  tickValues: number[];
  format: (v: number) => string;
}) {
  // The end labels sit on the plot's edges, so centring them pushes half a label outside
  // the figure — invisible on `10-20`, obvious on `2026-10`. Anchor the extremes inward.
  const first = tickValues[0];
  const last = tickValues[tickValues.length - 1];
  return (
    <AxisBottom
      top={top}
      left={left}
      scale={scale}
      tickValues={tickValues}
      tickFormat={(v) => format(Number(v))}
      stroke={RULE_STRONG}
      tickStroke={RULE_STRONG}
      tickLength={3}
      tickLabelProps={(v) => ({
        ...TICK_LABEL,
        textAnchor: first === last ? "middle" : v === last ? "end" : v === first ? "start" : "middle",
        dy: "0.35em",
      })}
    />
  );
}

/** A vertical axis on the left edge, values right-aligned against the tick. */
export function AxisY({
  top,
  left,
  scale,
  tickValues,
  format,
  label,
}: {
  top: number;
  left: number;
  scale: AxisScale;
  tickValues: number[];
  format: (v: number) => string;
  label?: string;
}) {
  return (
    <AxisLeft
      top={top}
      left={left}
      scale={scale}
      tickValues={tickValues}
      tickFormat={(v) => format(Number(v))}
      stroke={RULE_STRONG}
      tickStroke={RULE_STRONG}
      tickLength={3}
      tickLabelProps={() => ({ ...TICK_LABEL, textAnchor: "end", dx: "-0.4em", dy: "0.3em" })}
      label={label}
      labelProps={{ ...TICK_LABEL, textAnchor: "middle", fontSize: 8 }}
      labelOffset={32}
    />
  );
}
