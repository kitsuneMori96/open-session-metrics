import type { ReactNode } from "react";
import clsx from "clsx";
import { signed } from "../lib/format";
import { Roll } from "./Roll";

/* ------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------ */

/** A bordered box with a ruled title. The unit every screen is built from. */
export function Panel({
  title,
  right,
  children,
  className,
  bodyClass,
  tone,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  tone?: "plain";
}) {
  return (
    <section className={clsx("panel flex min-w-0 flex-col", tone === "plain" && "border-transparent bg-transparent", className)}>
      {title !== undefined && (
        <header className="panel-head">
          <span className="micro shrink-0">{title}</span>
          <span className="h-px min-w-2 flex-1 bg-rule" />
          {right && <span className="shrink-0">{right}</span>}
        </header>
      )}
      <div className={clsx("min-w-0 flex-1", bodyClass ?? "p-2")}>{children}</div>
    </section>
  );
}

/** `── TITLE ──────`, the section rule the TUI printed between blocks. */
export function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="mt-3 mb-1 flex items-baseline gap-2 first:mt-0">
      <span className="micro shrink-0">{title}</span>
      <span className="h-px min-w-2 flex-1 bg-rule" />
      {right && <span className="tape shrink-0 text-ink-faint">{right}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Readouts
 * ------------------------------------------------------------------ */

type Tone = "ink" | "soft" | "faint" | "danger" | "warning" | "good" | "flow";

const TONE: Record<Tone, string> = {
  ink: "text-ink",
  soft: "text-ink-soft",
  faint: "text-ink-faint",
  danger: "text-danger",
  warning: "text-warning",
  good: "text-good",
  flow: "text-flow",
};

export const toneColor = (tone: Tone): string =>
  tone === "danger"
    ? "var(--color-danger)"
    : tone === "warning"
      ? "var(--color-warning)"
      : tone === "good"
        ? "var(--color-good)"
        : tone === "flow"
          ? "var(--color-flow)"
          : tone === "faint"
            ? "var(--color-ink-faint)"
            : tone === "soft"
              ? "var(--color-ink-soft)"
              : "var(--color-ink)";

/** Label in a fixed column, value right after it. */
export function Stat({
  label,
  value,
  tone = "ink",
  labelWidth = 108,
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
  labelWidth?: number;
  title?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 py-[2px]" title={title}>
      <span className="tape shrink-0 text-ink-soft" style={{ width: labelWidth }}>
        {label}
      </span>
      <span className={clsx("tape tabular min-w-0 truncate", TONE[tone])}>{value}</span>
    </div>
  );
}

/**
 * A KPI tile: the number, the change against the previous window of equal length, and
 * a sparkline of the series it came from. The comparison is the point — a dashboard
 * without a baseline is decoration.
 */
export function Tile({
  label,
  value,
  delta,
  prev,
  spark,
  tone = "ink",
  note,
  onClick,
  lowerIsBetter,
}: {
  label: string;
  value: string;
  delta?: number | null;
  prev?: string;
  spark?: ReactNode;
  tone?: Tone;
  note?: string;
  onClick?: () => void;
  /** Metrics where growth is the bad news (errors, spend): a fall is what we want. */
  lowerIsBetter?: boolean;
}) {
  const known = delta !== undefined && delta !== null;
  const flat = known && Math.abs(delta) < 0.005;
  const good = lowerIsBetter ? (delta ?? 0) < 0 : (delta ?? 0) > 0;
  return (
    <div
      className={clsx(
        "hairline relative flex min-w-0 flex-col gap-1 px-2 pt-1.5 pb-1",
        onClick && "cursor-pointer hover:bg-ink/5"
      )}
      onClick={onClick}
      title={note}
    >
      <div className="flex items-baseline gap-2">
        <span className="micro truncate">{label}</span>
        <span className="flex-1" />
        {delta !== undefined && (
          <span
            className={clsx(
              "tape tabular shrink-0",
              !known || flat ? "text-ink-faint" : good ? "text-good" : "text-danger"
            )}
            title={
              known
                ? `previous window: ${prev ?? "—"}`
                : prev !== undefined
                  ? `previous window: ${prev} — nothing to compare against`
                  : "no earlier window to compare"
            }
          >
            {!known ? "—" : flat ? "±0" : signed(delta)}
          </span>
        )}
      </div>
      <div className={clsx("tabular text-[19px] leading-none font-semibold tracking-tight", TONE[tone])}>
        <Roll text={value} />
      </div>
      {spark ? <div className="h-[20px]">{spark}</div> : <div className="h-[20px]" />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

export function Chip({
  children,
  active,
  onClick,
  title,
  tone,
  className,
  disabled,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  tone?: Tone;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={clsx("btn", active && "btn-on", !active && tone && TONE[tone], disabled && "opacity-40", className)}
    >
      {children}
    </button>
  );
}

export function KeyCap({ children }: { children: ReactNode }) {
  return (
    <kbd className="hairline inline-block px-1 font-mono text-[9px] leading-[14px] text-ink-soft">{children}</kbd>
  );
}

export function Spinner({ label = "loading" }: { label?: string }) {
  return <div className="micro px-1 py-3">{label}…</div>;
}

/**
 * A first read.
 *
 * Placeholders are the page's own hairlines, dimmed and breathing, rather than
 * gray boxes: a skeleton in a different material promises a different screen.
 * Only the first read of a screen gets this — a filter that keeps the previous
 * frame on screen (`keepPreviousData`) has nothing to hide.
 */
export function Skeleton({ tiles = 6, rows = 2 }: { tiles?: number; rows?: number }) {
  return (
    <div className="pulse flex-1 px-3 pt-3" aria-busy="true" aria-label="reading the store">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: tiles }, (_, i) => (
          <div key={i} className="panel px-2 py-2">
            <div className="skel h-[6px]" style={{ width: `${52 + (i % 3) * 13}%` }} />
            <div className="skel mt-2 h-[14px]" style={{ width: `${40 + (i % 2) * 18}%` }} />
            <div className="skel mt-3 h-px w-full" />
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="panel p-2">
            <div className="flex items-center gap-2">
              <div className="skel h-[6px] w-24" />
              <span className="h-px flex-1 bg-rule" />
              <div className="skel h-[6px] w-12" />
            </div>
            {[86, 64, 42].map((w, k) => (
              <div key={k} className="skel mt-2 h-px" style={{ width: `${w}%` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="tape px-1 py-2 text-ink-faint">{children}</div>;
}

/** A number with its unit in a lighter face, for dense headers. */
export function Num({ value, unit, tone = "ink" }: { value: string; unit?: string; tone?: Tone }) {
  return (
    <span className={clsx("tabular", TONE[tone])}>
      {value}
      {unit && <span className="text-ink-faint"> {unit}</span>}
    </span>
  );
}

/** Query highlight inside a transcript. */
export function Mark({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  let key = 0;
  for (;;) {
    const idx = lower.indexOf(q, at);
    if (idx < 0) break;
    if (idx > at) parts.push(text.slice(at, idx));
    parts.push(
      <mark className="mark" key={key++}>
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    at = idx + q.length;
  }
  if (parts.length === 0) return <>{text}</>;
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** Continuous fill bar for a ratio readout. */
export function FillBar({ value, tone = "var(--color-ink)", height = 6 }: { value: number; tone?: string; height?: number }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <span className="hairline block w-full" style={{ height }}>
      <i className="block h-full" style={{ width: `${pct * 100}%`, background: tone }} />
    </span>
  );
}

/** The share of calls that failed, as a rule whose length is the rate. */
export function RateBar({ rate, width = 44, tone }: { rate: number; width?: number; tone?: string }) {
  const v = Math.max(0, Math.min(1, rate));
  return (
    <span className="relative inline-block align-middle" style={{ width, height: 5, background: "var(--color-rule)" }}>
      <i className="absolute inset-y-0 left-0 block" style={{ width: `${v * 100}%`, background: tone ?? (v > 0.1 ? "var(--color-danger)" : "var(--color-warning)") }} />
    </span>
  );
}
