/**
 * Number and time formatting, ported from opencode-top so the readouts print the
 * same strings the TUI prints (1.2K / 3.4M, $0.0012, 3m 20s).
 */

export const tok = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

/** Costs under a cent keep four decimals: a single turn can cost less than $0.01. */
export const usd = (n: number): string => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export const usd3 = (n: number): string => `$${n.toFixed(3)}`;

export const usd4 = (n: number): string => `$${n.toFixed(4)}`;

export const pctInt = (n: number): string => `${Math.round(n * 100)}%`;

/** Details panel: whole seconds, or minutes and seconds past a minute. */
export const durPanel = (ms: number): string => {
  if (!ms || ms <= 0) return "—";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
};

/** Transcript rows: sub-second stays in ms. */
export const durInline = (ms: number): string => {
  if (!ms || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

/** Tools screen: a zero average is a dash, not "0ms". */
export const durTool = (ms: number): string => {
  if (!ms) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const pad = (n: number) => String(n).padStart(2, "0");

export const clock = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const clockSec = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** MM/DD HH:mm — the tree row stamp. */
export const stamp = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const dayStamp = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};

/** Dominant-model colour, kept in sync with the --color-m-* theme tokens. */
const MODEL_HUES: [RegExp, string][] = [
  [/deepseek/i, "var(--color-m-deepseek)"],
  [/mimo/i, "var(--color-m-mimo)"],
  [/glm/i, "var(--color-m-glm)"],
  [/qwen/i, "var(--color-m-qwen)"],
  [/muse|kimi/i, "var(--color-m-muse)"],
  [/claude|gpt/i, "var(--color-m-claude)"],
];
export const modelColor = (model: string | null | undefined): string =>
  MODEL_HUES.find(([re]) => re.test(model ?? ""))?.[1] ?? "var(--color-m-default)";

export const shortModel = (model: string | null | undefined): string =>
  (model ?? "—").replace(/-free$/, "").replace(/-\d{8}$/, "");
