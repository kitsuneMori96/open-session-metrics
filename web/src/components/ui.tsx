import type { ReactNode } from "react";
import clsx from "clsx";

/** `── TITLE ──────`, the section rule the TUI prints between blocks. */
export function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="mt-3 mb-1 flex items-center gap-2 first:mt-0">
      <span className="micro shrink-0">{title}</span>
      <span className="h-px flex-1 bg-rule" />
      {right && <span className="tape shrink-0 text-ink-faint">{right}</span>}
    </div>
  );
}

/***
 * The TUI's StatRow: the label sits in a fixed column and the value follows it
 * immediately, so the pair stays readable however wide the panel gets.
 */
export function StatRow({
  label,
  value,
  tone = "ink",
  labelWidth = 100,
}: {
  label: string;
  value: ReactNode;
  tone?: "ink" | "soft" | "faint" | "danger" | "warning" | "good" | "flow";
  labelWidth?: number;
}) {
  const color =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "good"
          ? "text-good"
          : tone === "flow"
            ? "text-flow"
            : tone === "soft"
              ? "text-ink-soft"
              : tone === "faint"
                ? "text-ink-faint"
                : "text-ink";
  return (
    <div className="flex items-baseline gap-2 py-px">
      <span className="tape shrink-0 text-ink-soft" style={{ width: labelWidth }}>
        {label}
      </span>
      <span className={clsx("tape min-w-0 truncate", color)}>{value}</span>
    </div>
  );
}

/** Discrete cell bar: cells can be counted, so short bars stay readable. */
export function SegBar({
  filled,
  total,
  tone = "var(--color-ink)",
  cell = 5,
  height = 7,
}: {
  filled: number;
  total: number;
  tone?: string;
  cell?: number;
  height?: number;
}) {
  const n = Math.max(1, total);
  const f = Math.max(0, Math.min(n, filled));
  return (
    <span className="inline-flex shrink-0 items-center gap-[2px]">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className="block" style={{ width: cell, height, background: i < f ? tone : "var(--color-rule)" }} />
      ))}
    </span>
  );
}

/** Two-segment bar: the share that succeeded, then the share that failed. */
export function SplitBar({
  ok,
  total,
  cells = 16,
  toneOk = "var(--color-good)",
  toneBad = "var(--color-danger)",
  cell = 5,
  height = 7,
}: {
  ok: number;
  total: number;
  cells?: number;
  toneOk?: string;
  toneBad?: string;
  cell?: number;
  height?: number;
}) {
  const okFilled = total > 0 ? Math.round((ok / total) * cells) : cells;
  return (
    <span className="inline-flex shrink-0 items-center gap-[2px]">
      {Array.from({ length: cells }, (_, i) => (
        <i
          key={i}
          className="block"
          style={{ width: cell, height, background: i < okFilled ? toneOk : toneBad }}
        />
      ))}
    </span>
  );
}

/** Continuous fill bar for the context readout. */
export function FillBar({ value, tone = "var(--color-ink)", height = 6 }: { value: number; tone?: string; height?: number }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <span className="hairline block w-full" style={{ height }}>
      <i className="block h-full" style={{ width: `${pct * 100}%`, background: tone }} />
    </span>
  );
}

export function Chip({
  children,
  active,
  onClick,
  title,
  tone = "ink",
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  tone?: "ink" | "danger" | "warning" | "good";
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={clsx(
        "tape shrink-0 border px-1.5 py-[2px] transition-colors",
        active ? "border-ink bg-ink text-paper" : "border-rule text-ink-soft hover:border-rule-strong",
        !active && tone === "danger" && "text-danger",
        !active && tone === "warning" && "text-warning",
        !active && tone === "good" && "text-good"
      )}
    >
      {children}
    </button>
  );
}

/** Query highlight; only the first occurrence is marked, as in the TUI. */
export function Mark({ text, query, className }: { text: string; query: string; className?: string }) {
  const q = query.trim().toLowerCase();
  const idx = q ? text.toLowerCase().indexOf(q) : -1;
  if (idx < 0) return <span className={className}>{text}</span>;
  return (
    <span className={className}>
      {text.slice(0, idx)}
      <mark className="mark">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </span>
  );
}

export function Spinner({ label = "acquiring" }: { label?: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="micro animate-pulse">{label}…</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="tape px-3 py-2 text-ink-faint">{children}</div>;
}
