export const compact = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
};

export const money = (n: number): string =>
  n === 0 ? "$0.00" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;

export const pct = (n: number, digits = 0): string => `${(n * 100).toFixed(digits)}%`;

export const clock = (ts: number): string => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const dateShort = (ts: number): string => {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

export const duration = (ms: number | null | undefined): string => {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${String(s % 60).padStart(2, "0")}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
};

/** Largest-Triangle-Three-Buckets downsampling for the ECG traces. */
export function lttb<T>(data: T[], threshold: number, x: (d: T) => number, y: (d: T) => number): T[] {
  const n = data.length;
  if (threshold >= n || threshold <= 2) return data;
  const sampled: T[] = [data[0]];
  const bucket = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    let avgX = 0;
    let avgY = 0;
    let avgCount = 0;
    const startNext = Math.floor((i + 1) * bucket) + 1;
    const endNext = Math.min(Math.floor((i + 2) * bucket) + 1, n);
    for (let j = startNext; j < endNext; j++) {
      avgX += x(data[j]);
      avgY += y(data[j]);
      avgCount++;
    }
    avgCount = avgCount || 1;
    avgX /= avgCount;
    avgY /= avgCount;
    const rangeStart = Math.floor(i * bucket) + 1;
    const rangeEnd = Math.floor((i + 1) * bucket) + 1;
    const ax = x(data[a]);
    const ay = y(data[a]);
    let maxArea = -1;
    let chosen = rangeStart;
    for (let j = rangeStart; j < Math.min(rangeEnd, n); j++) {
      const area = Math.abs((ax - avgX) * (y(data[j]) - ay) - (ax - x(data[j])) * (avgY - ay)) / 2;
      if (area > maxArea) {
        maxArea = area;
        chosen = j;
      }
    }
    sampled.push(data[chosen]);
    a = chosen;
  }
  sampled.push(data[n - 1]);
  return sampled;
}

/** Dominant-model colour, kept in sync with the --color-m-* theme tokens. */
const MODEL_HUES: [RegExp, string][] = [
  [/deepseek/i, "oklch(0.58 0.13 190)"],
  [/mimo/i, "oklch(0.66 0.15 75)"],
  [/glm/i, "oklch(0.5 0.19 285)"],
  [/qwen/i, "oklch(0.55 0.16 145)"],
  [/muse|kimi/i, "oklch(0.52 0.2 320)"],
  [/claude|gpt/i, "oklch(0.55 0.14 45)"],
];
export const modelColor = (model: string | null | undefined): string =>
  MODEL_HUES.find(([re]) => re.test(model ?? ""))?.[1] ?? "oklch(0.35 0.04 250)";

export const shortModel = (model: string | null | undefined): string =>
  (model ?? "—").replace(/-free$/, "").replace(/-\d{8}$/, "");
