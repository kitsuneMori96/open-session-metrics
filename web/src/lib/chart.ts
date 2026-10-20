import { ticks } from "d3-array";
import { scaleLinear, scaleLog } from "@visx/scale";

/**
 * Chart conventions.
 *
 * The house style is a printed instrument: hairline rules, no rounded corners, no
 * glow, and colour used only where it encodes something. These helpers hold the parts
 * of that style a chart needs — the categorical order, the tick format per bucket
 * width, and the axis furniture every figure repeats.
 */

/** Categorical order for stacks and legends; `other` is the only neutral fill. */
export const PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
] as const;

export const OTHER = "var(--chart-other)";

/** Stable colour per label: the same model keeps its colour across every figure. */
export function paletteFor(labels: string[]): Map<string, string> {
  const map = new Map<string, string>();
  let i = 0;
  for (const label of labels) {
    map.set(label, label === "other" ? OTHER : PALETTE[i++ % PALETTE.length]);
  }
  return map;
}

/** The four ways a provider bills a turn, in the order they stack. */
export const TOKEN_CLASSES = [
  { key: "input", label: "input", color: "var(--chart-1)" },
  { key: "output", label: "output", color: "var(--chart-2)" },
  { key: "cacheRead", label: "cache read", color: "var(--chart-6)" },
  { key: "cacheWrite", label: "cache write", color: "var(--chart-7)" },
  { key: "reasoning", label: "reasoning", color: "var(--chart-3)" },
] as const;

export type TokenClassKey = (typeof TOKEN_CLASSES)[number]["key"];

export const INK = "var(--color-ink)";
export const RULE = "var(--color-rule)";
export const RULE_STRONG = "var(--color-rule-strong)";
export const FAINT = "var(--color-ink-faint)";
export const SOFT = "var(--color-ink-soft)";
export const DANGER = "var(--color-danger)";
export const GOOD = "var(--color-good)";
export const FLOW = "var(--color-flow)";
export const WARNING = "var(--color-warning)";

export const MARGIN = { top: 10, right: 14, bottom: 20, left: 46 };

/** Y ticks that a printed axis would show: a handful of round numbers. */
export const yTicks = (max: number, count = 4): number[] => {
  if (!(max > 0)) return [0];
  return ticks(0, max, count).filter((t) => t >= 0 && t <= max);
};

export const linear = (domainMax: number, range: [number, number]) =>
  scaleLinear<number>({ domain: [0, Math.max(domainMax, 1)], range });

/** Log axis for the scatter: cost and token counts span six orders of magnitude. */
export const logScale = (domain: [number, number], range: [number, number]) =>
  scaleLog<number>({
    domain: [Math.max(domain[0], 1e-9), Math.max(domain[1], domain[0] * 1.05)],
    range,
    base: 10,
  });

/**
 * The domain a log axis can actually draw: the smallest positive value up to the
 * largest, padded. A measure that is zero everywhere (a slice of free models) has no
 * positive value to anchor on, so the caller gets an order-of-magnitude fallback.
 */
export const logRange = (vals: number[], hi: number): [number, number] => {
  const lo = vals.reduce((min, v) => (v > 0 && v < min ? v : min), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(lo)) return [1, 10];
  return [lo, Math.max(hi, lo * 10) * 1.08];
};

export type GranularityLike = "5m" | "hour" | "day" | "week" | "month" | "quarter" | "year";

/** The word a chart states on the right of its caption. */
export function granLabel(gran: GranularityLike): string {
  if (gran === "5m") return "5-minute";
  if (gran === "hour") return "hourly";
  if (gran === "day") return "daily";
  if (gran === "week") return "weekly";
  if (gran === "month") return "monthly";
  if (gran === "quarter") return "quarterly";
  return "yearly";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Axis label per bucket width — the only place the granularity is visible. */
export function timeTick(ts: number, gran: GranularityLike): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  if (gran === "5m") return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (gran === "hour") return `${p(d.getHours())}:00`;
  if (gran === "year") return String(d.getFullYear());
  if (gran === "quarter") return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
  if (gran === "month") return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function timeTooltip(ts: number, gran: GranularityLike): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (gran === "5m") return `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
  if (gran === "hour") return `${day} ${p(d.getHours())}:00`;
  if (gran === "week") return `week of ${day}`;
  if (gran === "month") return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (gran === "quarter") {
    const q = Math.floor(d.getMonth() / 3);
    return `${d.getFullYear()} Q${q + 1} · ${MONTHS[q * 3]}–${MONTHS[q * 3 + 2]}`;
  }
  if (gran === "year") return `all of ${d.getFullYear()}`;
  return day;
}

/**
 * Pick ~`count` tick positions from a bucket array without ever dropping the first or
 * last one, so the axis always states the window it covers.
 */
export function tickIndices(length: number, count = 6): number[] {
  if (length <= 1) return [0];
  const step = Math.max(1, Math.ceil(length / count));
  const out: number[] = [];
  for (let i = 0; i < length; i += step) out.push(i);
  if (out[out.length - 1] !== length - 1) {
    if (length - 1 - out[out.length - 1] < step / 2) out[out.length - 1] = length - 1;
    else out.push(length - 1);
  }
  return out;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
