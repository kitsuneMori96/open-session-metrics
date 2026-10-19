const DAY = 86400000;
const HOUR = 3600000;

export interface TrendSeries {
  labels: string[];
  values: number[];
  mode: "hour" | "day" | "week";
  spanText: string;
}

/**
 * Adaptive trend buckets, ported from opencode-top's `buildTrendBuckets` so the
 * Overview charts keep the same bucket widths, label thinning and span caption:
 *
 * - filter starting at local midnight today → 24 hourly buckets
 * - any other explicit cutoff → one bucket per local day
 * - no cutoff → from the first data point (or today), weekly past 120 days
 */
export function buildTrendBuckets(points: [number, number][], cutoff: number, now: number): TrendSeries {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const today = todayStart.getTime();

  let start: number;
  let mode: "hour" | "day" | "week";
  if (cutoff > 0 && cutoff === today) {
    start = cutoff;
    mode = "hour";
  } else if (cutoff > 0) {
    start = cutoff;
    mode = "day";
  } else {
    let min = now;
    for (const [ts] of points) if (ts && ts < min) min = ts;
    const d = new Date(min);
    d.setHours(0, 0, 0, 0);
    start = Math.min(d.getTime(), today);
    mode = "day";
  }

  const days = Math.max(1, Math.floor((now - start) / DAY) + 1);
  let count: number;
  let bucketMs: number;
  if (mode === "hour") {
    count = 24;
    bucketMs = HOUR;
  } else if (days <= 120) {
    count = days;
    bucketMs = DAY;
  } else {
    mode = "week";
    count = Math.ceil(days / 7);
    bucketMs = 7 * DAY;
  }

  const buckets = new Array(count).fill(0);
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start + i * bucketMs);
    if (mode === "hour") labels.push(String(d.getHours()).padStart(2, "0"));
    else if (mode === "week") labels.push(`${d.toLocaleDateString("en", { month: "short" })} ${d.getDate()}`);
    else labels.push(`${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }

  for (const [ts, val] of points) {
    if (ts < start) continue;
    let idx = Math.floor((ts - start) / bucketMs);
    if (idx < 0) idx = 0;
    if (idx >= count) idx = count - 1;
    buckets[idx] += val;
  }

  // Thin labels: first, last, and roughly every eighth in between.
  const thinned: string[] = [];
  const step = Math.max(1, Math.ceil(count / 8));
  for (let i = 0; i < count; i++) {
    thinned.push(i === 0 || i === count - 1 || i % step === 0 ? labels[i] : "");
  }

  return { labels: thinned, values: buckets, mode, spanText: mode === "hour" ? "today" : `${days}d` };
}
