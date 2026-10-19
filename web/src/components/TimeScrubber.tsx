import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStatus, DAY, type TimeWindow } from "../lib/api";
import { dateShort } from "../lib/format";

type Drag = { mode: "pan" | "left" | "right"; startX: number; from: number; to: number } | null;

/**
 * The ruler-style time slicer. Everything on screen is derived from the window
 * it publishes, so dragging it re-tunes the ECG, the clock map and the panels
 * at once.
 */
export default function TimeScrubber({
  window: win,
  onChange,
}: {
  window: TimeWindow;
  onChange: (w: TimeWindow) => void;
}) {
  const { data: status } = useStatus();
  const universe = status?.extent;
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>(null);

  const lo = universe?.from ?? win.from - 30 * DAY;
  const hi = universe?.to ?? win.to;
  const span = Math.max(1, hi - lo);

  const xToTime = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return win.to;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return lo + ratio * span;
    },
    [lo, span, win.to]
  );

  const pos = useMemo(
    () => ({
      left: ((win.from - lo) / span) * 100,
      right: ((win.to - lo) / span) * 100,
    }),
    [win.from, win.to, lo, span]
  );

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const t = xToTime(e.clientX);
      const width = win.to - win.from;
      if (drag.mode === "pan") {
        const delta = t - xToTime(drag.startX);
        let from = drag.from + delta;
        let to = from + width;
        if (from < lo) ((from = lo), (to = lo + width));
        if (to > hi) ((to = hi), (from = hi - width));
        onChange({ from, to });
      } else if (drag.mode === "left") {
        onChange({ from: Math.min(t, win.to - DAY / 24), to: win.to });
      } else {
        onChange({ from: win.from, to: Math.max(t, win.from + DAY / 24) });
      }
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, win.from, win.to, lo, hi, onChange, xToTime]);

  const ticks = useMemo(() => {
    const days = span / DAY;
    const step = days > 240 ? 30 : days > 120 ? 14 : days > 45 ? 7 : days > 12 ? 1 : 0.25;
    const ms = step * DAY;
    // Local-midnight anchored, otherwise every label lands on the same clock time.
    const midnight = new Date(lo);
    midnight.setHours(0, 0, 0, 0);
    const out: { at: number; major: boolean }[] = [];
    let t = midnight.getTime();
    while (t < lo) t += ms;
    for (; t <= hi; t += ms) out.push({ at: t, major: new Date(t).getHours() === 0 });
    return out;
  }, [lo, hi, span]);

  const spanMs = win.to - win.from;
  const days = Math.max(1, Math.round(spanMs / DAY));
  // Below a day the rounded day count would read "1D" for a one-hour drill-down.
  const windowLabel = spanMs >= DAY ? `${days}D` : `${Math.max(1, Math.round(spanMs / (DAY / 24)))}H`;

  return (
    <div className="flex items-center gap-3 select-none">
      <div className="flex gap-1">
        {[7, 30, 90, 0].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => {
              const to = universe?.to ?? Date.now();
              onChange(d === 0 ? { from: universe?.from ?? to - 180 * DAY, to } : { from: to - d * DAY, to });
            }}
            className={`tape px-1 border ${
              (d === 0 ? span : d * DAY) <= span * 1.05 && days <= (d === 0 ? 9999 : d) + 1 && days >= (d === 0 ? 0 : d) - 1
                ? "border-ink bg-ink text-paper"
                : "border-rule text-ink-faint hover:border-rule-strong"
            }`}
          >
            {d === 0 ? "ALL" : `${d}D`}
          </button>
        ))}
      </div>

      <div
        ref={trackRef}
        className="relative h-[26px] w-[420px] hairline bg-paper-raised cursor-crosshair"
        onPointerDown={(e) => {
          const t = xToTime(e.clientX);
          const nearLeft = Math.abs(t - win.from) / span < 0.02;
          const nearRight = Math.abs(t - win.to) / span < 0.02;
          const inside = t > win.from && t < win.to;
          setDrag({
            mode: nearLeft ? "left" : nearRight ? "right" : inside ? "pan" : "left",
            startX: e.clientX,
            from: win.from,
            to: win.to,
          });
          if (!inside) onChange({ from: t, to: Math.min(t + (win.to - win.from), hi) });
        }}
      >
        {ticks.map((t) => (
          <div
            key={t.at}
            className="absolute bottom-0 w-px"
            style={{
              left: `${((t.at - lo) / span) * 100}%`,
              height: t.major ? 9 : 5,
              background: t.major ? "oklch(0.2 0.05 250 / 0.5)" : "oklch(0.2 0.05 250 / 0.22)",
            }}
          />
        ))}
        <div
          className="absolute top-0 bottom-0 border-x border-ink"
          style={{
            left: `${pos.left}%`,
            width: `${Math.max(0.3, pos.right - pos.left)}%`,
            background: "oklch(0.2 0.05 250 / 0.1)",
          }}
        >
          <div className="absolute -left-[3px] top-0 h-full w-[6px] cursor-ew-resize" />
          <div className="absolute -right-[3px] top-0 h-full w-[6px] cursor-ew-resize" />
        </div>
        {ticks
          .filter((t) => t.major)
          .slice(-8)
          .map((t) => (
            <div
              key={`l${t.at}`}
              className="absolute top-[1px] tape text-[8px] text-ink-faint -translate-x-1/2"
              style={{ left: `${((t.at - lo) / span) * 100}%` }}
            >
              {dateShort(t.at)}
            </div>
          ))}
      </div>

      <div className="tape text-ink tabular-nums whitespace-nowrap w-[112px]">
        {windowLabel} WINDOW
      </div>
    </div>
  );
}
