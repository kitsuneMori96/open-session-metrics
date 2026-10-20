/**
 * Percentiles answered from fixed histograms instead of sorted samples.
 *
 * The dashboard used to carry every matching row into JS and sort it three times: on a
 * decade of turns that is half a million objects per request — the slowest part of the
 * answer, and the part that cannot be pre-aged. A histogram of the same column is a few
 * hundred integers, it *adds up* across days (which is what lets a rollup answer it), and
 * on the ladders below a quantile estimate sits within half a bin of the exact value.
 *
 * Each metric gets the ladder that matches its range rather than one compromise:
 *
 *   ms     durations and latencies, 1 ms to hours — log, 128 bins per octave (0.54 %)
 *   share  context fill, a 0–1 fraction — linear, one bin per 0.2 points
 *   rate   output speed in tokens/s — linear, one bin per 0.25
 *
 * Bins outlive a request — the day rollups persist them — so changing a ladder is a
 * format change: bump `HIST_VERSION` and let the ETL rebuild.
 */
export const HIST_VERSION = 1;

export interface Ladder {
  readonly name: string;
  /** SQL expression mapping a non-negative column to its bin index. */
  key(col: string): string;
  /** Exact lower edge of a bin. */
  lower(bin: number): number;
}

const logLadder = (name: string, perOctave: number): Ladder => ({
  name,
  key: (col) => `CAST(log2(MAX(${col}, 0) + 1) * ${perOctave} AS INTEGER)`,
  lower: (bin) => Math.max(0, Math.pow(2, bin / perOctave) - 1),
});

const linearLadder = (name: string, step: number): Ladder => ({
  name,
  key: (col) => `CAST(MAX(${col}, 0) / ${step} AS INTEGER)`,
  lower: (bin) => Math.max(0, bin * step),
});

export const ladder = {
  ms: logLadder("ms", 128),
  share: linearLadder("share", 0.002),
  rate: linearLadder("rate", 0.25),
};

/** Sparse bin → count. */
export type Histogram = Map<number, number>;

export interface BinRow {
  bin: number;
  n: number;
}

export function histogramOf(rows: readonly BinRow[]): Histogram {
  const h: Histogram = new Map();
  for (const r of rows) {
    const bin = Number(r.bin) || 0;
    h.set(bin, (h.get(bin) ?? 0) + (Number(r.n) || 0));
  }
  return h;
}

export function histogramCount(h: Histogram): number {
  let n = 0;
  for (const c of h.values()) n += c;
  return n;
}

/** Sum of two histograms — the operation that makes day rollups possible. */
export function mergeHistograms(a: Histogram, b: Histogram): Histogram {
  if (a.size === 0) return new Map(b);
  for (const [bin, n] of b) a.set(bin, (a.get(bin) ?? 0) + n);
  return a;
}

/**
 * Quantile of a histogram.
 *
 * Rank convention matches the sorted-array helper this replaced (`round((n - 1) * p)`),
 * so p50 is the median, p95 is never below it, and a three-sample group still reports its
 * largest value at p95 instead of interpolating across the empty space below it. The
 * estimate lands mid-sample inside the bin — unbiased for a uniform bin — and `ceiling`
 * clamps it to an exact maximum computed separately in SQL, keeping `p95 ≤ max` true.
 */
export function quantile(h: Histogram, p: number, l: Ladder, ceiling = Infinity): number {
  const total = histogramCount(h);
  if (total <= 0) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  const rank = Math.min(total - 1, Math.max(0, Math.round(clamped * (total - 1))));
  let before = 0;
  for (const bin of [...h.keys()].sort((x, y) => x - y)) {
    const n = h.get(bin) ?? 0;
    if (rank < before + n) {
      const inside = n > 0 ? (rank - before + 0.5) / n : 0;
      const lo = l.lower(bin);
      const hi = l.lower(bin + 1);
      const at = lo + (hi - lo) * Math.min(1, Math.max(0, inside));
      return Math.min(ceiling, Math.max(0, at));
    }
    before += n;
  }
  return Math.min(ceiling, l.lower([...h.keys()].sort((x, y) => x - y).pop() ?? 0));
}

/** Median, i.e. the 0.5 quantile. */
export function histMedian(h: Histogram, l: Ladder, ceiling = Infinity): number {
  return quantile(h, 0.5, l, ceiling);
}
