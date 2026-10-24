/**
 * Number, time and money formatting.
 *
 * The readouts keep opencode-top's vocabulary where it already fit (`1.2K`, `3m 20s`),
 * and add the two things a dashboard needs that a terminal column could not afford:
 * exact integers for tooltips, and compact durations that stay legible from a
 * millisecond to a month.
 */

export const int = (n: number): string => Math.round(n).toLocaleString("en-US");

/** 1.2K / 3.4M / 1.1B — the token magnitude at a glance. */
export const tok = (n: number): string => {
  const v = Math.abs(n);
  if (v >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};

/**
 * Costs under a cent keep four decimals: a single turn can cost less than $0.01.
 *
 * A Qoder store bills in credits instead of dollars, and the unit is a property
 * of the whole database (`meta.unit`), not of a row. The server announces it in
 * `/api/status`; `setMoneyUnit` is called once at boot, which keeps every existing
 * `usd()` call site honest without threading a unit through 60 components.
 */
export type MoneyUnit = "usd" | "credit";
let MONEY_UNIT: MoneyUnit = "usd";

export const setMoneyUnit = (unit: string | null | undefined) => {
  MONEY_UNIT = unit === "credit" ? "credit" : "usd";
};
export const moneyUnit = (): MoneyUnit => MONEY_UNIT;

const usdFmt = (n: number): string => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** Credits have no cents: sub-1 values need four decimals, aggregates do not. */
const creditFmt = (n: number): string => {
  const v = Math.abs(n);
  if (v === 0) return "0 cr";
  if (v < 1) return `${n.toFixed(4)} cr`;
  if (v < 1000) return `${n.toFixed(2)} cr`;
  return `${Math.round(n).toLocaleString("en-US")} cr`;
};

export const usd = (n: number): string => (MONEY_UNIT === "credit" ? creditFmt(n) : usdFmt(n));

export const usd3 = (n: number): string => (MONEY_UNIT === "credit" ? creditFmt(n) : `$${n.toFixed(3)}`);

/** Cost per million tokens — the only way to compare models of different sizes. */
export const usdPerM = (cost: number, tokens: number): string => {
  if (tokens <= 0) return "—";
  const value = (cost / tokens) * 1e6;
  return MONEY_UNIT === "credit" ? `${value.toFixed(2)} cr` : `$${value.toFixed(2)}`;
};

/** Exact money for a single row: four decimals, never rounded away. */
export const usd4 = (n: number): string => (MONEY_UNIT === "credit" ? `${n.toFixed(4)} cr` : `$${n.toFixed(4)}`);

/** A cost-per-volume figure whose amount is already normalised (per Mtok / per Mctx). */
export const perMRate = (v: number): string => (MONEY_UNIT === "credit" ? `${v.toFixed(2)} cr` : `$${v.toFixed(2)}`);

/** Axis/panel captions that name the unit (they cannot be formatted numbers). */
export const perMLabel = (): string => (MONEY_UNIT === "credit" ? "cr/Mctx" : "$/Mtok");
export const perMPhrase = (): string => (MONEY_UNIT === "credit" ? "per Mctx" : "per Mtok");
export const spendLabel = (): string => (MONEY_UNIT === "credit" ? "credits" : "spend");
export const costLabel = (): string => (MONEY_UNIT === "credit" ? "credits" : "billed cost");

export const pct = (ratio: number, digits = 1): string => `${(ratio * 100).toFixed(digits)}%`;

export const pctInt = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/** `+12.4%` / `−3.1%`, with the sign a comparison needs. */
export const signed = (ratio: number, digits = 1): string => `${ratio >= 0 ? "+" : "−"}${(Math.abs(ratio) * 100).toFixed(digits)}%`;

const pad = (n: number) => String(n).padStart(2, "0");

/** Elapsed time, from a millisecond to a month. */
export const dur = (ms: number): string => {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(Math.floor(s % 60))}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${pad(h % 24)}h`;
};

/** Same, but fractions of a second are noise when the unit is minutes. */
export const durPanel = (ms: number): string => dur(ms);

/** Transcript rows: sub-second stays in ms. */
export const durInline = (ms: number): string => {
  if (!ms || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

export const rate = (tokensPerSecond: number): string =>
  tokensPerSecond >= 100 ? `${Math.round(tokensPerSecond)} tok/s` : tokensPerSecond > 0 ? `${tokensPerSecond.toFixed(1)} tok/s` : "—";

export const clockSec = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const clockMin = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** `08-19 14:03` — the timestamp a session row prints. */
export const stamp = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const dayStamp = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const fullStamp = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "3 days ago" — how stale a session is reads better as a distance. */
export const ago = (ts: number, now = Date.now()): string => {
  const d = Math.max(0, now - ts);
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  const days = Math.floor(d / 86_400_000);
  if (days < 31) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
};

/** Model ids share long suffixes that carry no meaning in a table cell. */
export const shortModel = (model: string | null | undefined): string =>
  (model ?? "—")
    .replace(/^[a-z-]+\//, "")
    .replace(/-free$/, "")
    .replace(/-\d{8}$/, "");

/** A title is optional on a session; fall back to the first thing the user typed. */
export const sessionTitle = (title: string | null, prompt: string | null): string => {
  if (title) return title;
  const line = (prompt ?? "").split("\n").find((l) => l.trim());
  return line ? line.trim().slice(0, 120) : "(untitled session)";
};

/** Dominant-model colour, kept in sync with the --color-m-* theme tokens. */
const MODEL_HUES: [RegExp, string][] = [
  [/deepseek/i, "var(--color-m-deepseek)"],
  [/mimo/i, "var(--color-m-mimo)"],
  [/glm/i, "var(--color-m-glm)"],
  [/qwen/i, "var(--color-m-qwen)"],
  [/muse|kimi/i, "var(--color-m-muse)"],
  [/claude|gpt|oss|nemotron|preview/i, "var(--color-m-claude)"],
];
export const modelColor = (model: string | null | undefined): string =>
  MODEL_HUES.find(([re]) => re.test(model ?? ""))?.[1] ?? "var(--color-m-default)";
