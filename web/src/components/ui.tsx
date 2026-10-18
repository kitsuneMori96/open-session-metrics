import type { ReactNode } from "react";
import clsx from "clsx";

export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={clsx("hairline bg-paper-raised/70 flex flex-col min-h-0", className)}>
      {title && (
        <header className="flex items-center justify-between px-2 h-[18px] border-b border-rule shrink-0">
          <h2 className="micro">{title}</h2>
          {right}
        </header>
      )}
      <div className={clsx("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Readout({
  label,
  value,
  unit,
  tone = "ink",
  size = 48,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "ink" | "danger" | "good" | "warning";
  size?: number;
  hint?: string;
}) {
  const color =
    tone === "danger"
      ? "text-danger"
      : tone === "good"
        ? "text-good"
        : tone === "warning"
          ? "text-warning"
          : "text-ink";
  return (
    <div className="px-2 py-1.5">
      <div className="micro">{label}</div>
      <div className="flex items-baseline gap-1">
        <span
          className={clsx("readout font-mono font-extralight tabular-nums", color)}
          style={{ fontSize: size }}
        >
          {value}
        </span>
        {unit && <span className="tape text-ink-faint">{unit}</span>}
      </div>
      {hint && <div className="tape text-ink-soft mt-0.5">{hint}</div>}
    </div>
  );
}

export function Chip({
  children,
  tone = "ink",
  onClick,
  active,
  title,
}: {
  children: ReactNode;
  tone?: "ink" | "danger" | "warning" | "good";
  onClick?: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={clsx(
        "tape px-1.5 py-0.5 border transition-colors",
        active ? "bg-ink text-paper border-ink" : "border-rule text-ink-soft hover:border-rule-strong",
        tone === "danger" && !active && "text-danger border-danger/40",
        tone === "warning" && !active && "text-warning border-warning/40",
        tone === "good" && !active && "text-good border-good/40"
      )}
    >
      {children}
    </button>
  );
}

/** Tactical crosshair marker used for failures/retries in the probe layer. */
export function Crosshair({ size = 9, color = "var(--color-danger)" }: { size?: number; color?: string }) {
  const r = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="overflow-visible">
      <circle cx={r} cy={r} r={r - 0.5} fill="none" stroke={color} strokeWidth="1" />
      <line x1={r} y1="-2" x2={r} y2={size + 2} stroke={color} strokeWidth="1" />
      <line x1="-2" y1={r} x2={size + 2} y2={r} stroke={color} strokeWidth="1" />
    </svg>
  );
}

export function Spinner({ label = "ACQUIRING" }: { label?: string }) {
  return (
    <div className="h-full grid place-items-center">
      <div className="tape text-ink-faint tracking-[0.3em]">{label}…</div>
    </div>
  );
}
