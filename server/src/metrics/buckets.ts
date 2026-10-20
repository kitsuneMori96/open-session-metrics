/**
 * The time axis: how wide a column is, and how many of them a window may have.
 *
 * A window can be as long as the whole history, so the unit cannot be fixed: it climbs a
 * ladder from five minutes to a year, and stops at the first unit whose column count still
 * fits `MAX_COLS`. That single rule is what keeps the response flat — a decade of turns
 * and a quarter of an hour produce the same order of magnitude of columns.
 *
 * `month`, `quarter` and `year` are real calendar boundaries, not 30/91/365-day
 * approximations: the axis labels them as months, so drifting two days into the next
 * month would be a lie. They are also the units whose width is not constant, which is why
 * buckets are built from a start list rather than from a step size.
 */
export type Granularity = "5m" | "hour" | "day" | "week" | "month" | "quarter" | "year";

/** Finest to coarsest — the order `pickGranularity` climbs. */
export const GRANULARITIES: readonly Granularity[] = ["5m", "hour", "day", "week", "month", "quarter", "year"];

/** Hard ceiling on columns in one series. 200 keeps a 30 h window readable at 1 h … */
export const MAX_COLS = 200;

const MINUTE = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Local midnight of the day containing `ts`. */
export function localDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday 00:00 of the week containing `ts`. */
export function localWeek(ts: number): number {
  const d = new Date(localDay(ts));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** Start of the bucket containing `ts`. */
export function bucketStart(ts: number, gran: Granularity): number {
  switch (gran) {
    case "5m":
      return Math.floor(ts / (5 * MINUTE)) * 5 * MINUTE;
    case "hour":
      return Math.floor(ts / HOUR_MS) * HOUR_MS;
    case "day":
      return localDay(ts);
    case "week":
      return localWeek(ts);
    case "month": {
      const d = new Date(ts);
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    }
    case "quarter": {
      const d = new Date(ts);
      return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1).getTime();
    }
    case "year": {
      const d = new Date(ts);
      return new Date(d.getFullYear(), 0, 1).getTime();
    }
  }
}

/** Start of the bucket after the one starting at `ts`. */
export function nextBucket(ts: number, gran: Granularity): number {
  switch (gran) {
    case "5m":
      return ts + 5 * MINUTE;
    case "hour":
      return ts + HOUR_MS;
    case "day":
      return ts + DAY_MS;
    case "week":
      return ts + WEEK_MS;
    case "month": {
      const d = new Date(ts);
      return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    }
    case "quarter": {
      const d = new Date(ts);
      return new Date(d.getFullYear(), d.getMonth() + 3, 1).getTime();
    }
    case "year": {
      const d = new Date(ts);
      return new Date(d.getFullYear() + 1, 0, 1).getTime();
    }
  }
}

const monthsBetween = (a: number, b: number): number => {
  const da = new Date(a);
  const db = new Date(b);
  return (db.getFullYear() - da.getFullYear()) * 12 + (db.getMonth() - da.getMonth());
};

/** How many columns `[from, to]` needs at this unit. O(1) for every unit. */
export function bucketCount(from: number, to: number, gran: Granularity): number {
  if (!(to >= from)) return 1;
  const first = bucketStart(from, gran);
  switch (gran) {
    case "5m":
      return Math.floor((to - first) / (5 * MINUTE)) + 1;
    case "hour":
      return Math.floor((to - first) / HOUR_MS) + 1;
    case "day":
      return Math.floor((to - first) / DAY_MS) + 1;
    case "week":
      return Math.round((localWeek(to) - first) / WEEK_MS) + 1;
    case "month":
      return monthsBetween(first, to) + 1;
    case "quarter":
      return Math.floor(monthsBetween(first, to) / 3) + 1;
    case "year":
      return new Date(to).getFullYear() - new Date(first).getFullYear() + 1;
  }
}

/**
 * Column starts covering `[from, to]`.
 *
 * Callers go through `pickGranularity`, which guarantees the count stays within
 * `MAX_COLS`; the hard cap here is a guard against a caller that skipped that step, not a
 * truncation the axis would ever show.
 */
export function bucketStarts(from: number, to: number, gran: Granularity): number[] {
  const count = Math.min(bucketCount(from, to, gran), MAX_COLS * 4);
  const out: number[] = [];
  let ts = bucketStart(from, gran);
  for (let i = 0; i < count; i++) {
    out.push(ts);
    ts = nextBucket(ts, gran);
  }
  return out;
}

/**
 * SQL expression for a bucket's key, over `turns t`.
 *
 * Fixed-width units return the bucket's start in milliseconds. Calendar units return the
 * calendar label instead (`2026-10`, `2026-Q3`, `2026`): computing a month start in local
 * time inside SQLite means combining `'localtime'` with `'start of month'`, which treats
 * the local timestamp as UTC and lands an hour off — the label is exact, and mapping it
 * back to a start is a table lookup on the client side of the query.
 */
export function bucketKeySql(gran: Granularity): string {
  switch (gran) {
    case "5m":
      return "t.bucket";
    case "hour":
      return "(t.bucket - (t.bucket % 3600000))";
    case "day":
      return "t.day";
    // `t.day` is a local midnight, so its weekday has to be read in local time too —
    // reading it as UTC gives the previous day's weekday west of Greenwich and lands the
    // whole week a day early.
    case "week":
      return "(t.day - ((CAST(strftime('%w', t.day / 1000, 'unixepoch', 'localtime') AS INTEGER) + 6) % 7) * 86400000)";
    case "month":
      return "strftime('%Y-%m', t.created / 1000, 'unixepoch', 'localtime')";
    case "quarter":
      return "strftime('%Y', t.created / 1000, 'unixepoch', 'localtime') || '-Q' || " +
        "CAST((CAST(strftime('%m', t.created / 1000, 'unixepoch', 'localtime') AS INTEGER) - 1) / 3 AS INTEGER)";
    case "year":
      return "strftime('%Y', t.created / 1000, 'unixepoch', 'localtime')";
  }
}

/** The label `bucketKeySql` produces for a calendar bucket start. */
export function calendarKey(ts: number, gran: Granularity): string {
  const d = new Date(ts);
  const year = String(d.getFullYear()).padStart(4, "0");
  if (gran === "year") return year;
  if (gran === "quarter") return `${year}-Q${Math.floor(d.getMonth() / 3)}`;
  return `${year}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Maps a `bucketKeySql` value to a column index, clamped into the axis. Calendar units
 * resolve through a label table; fixed-width units are arithmetic.
 */
export function bucketIndexer(gran: Granularity, starts: number[]): (key: unknown) => number {
  const last = Math.max(0, starts.length - 1);
  if (gran === "month" || gran === "quarter" || gran === "year") {
    const table = new Map<string, number>();
    starts.forEach((ts, i) => table.set(calendarKey(ts, gran), i));
    return (key) => table.get(String(key)) ?? -1;
  }
  const step = gran === "5m" ? 5 * MINUTE : gran === "hour" ? HOUR_MS : gran === "day" ? DAY_MS : WEEK_MS;
  const first = starts[0] ?? 0;
  return (key) => {
    const i = Math.floor((Number(key) - first) / step);
    return i < 0 ? 0 : i > last ? last : i;
  };
}

/**
 * The unit for a window.
 *
 * Without an explicit request the axis stays at the unit a human would pick for that span
 * (five minutes inside half a day, hourly up to three days, daily up to half a year,
 * weekly beyond) and only coarsens when that would overflow `MAX_COLS`. An explicit
 * request may be finer or coarser, but it is still capped, so `gran=5m` over a decade
 * answers monthly instead of shipping a million columns.
 *
 * The five-minute floor is what makes a click on the series a drill-down: zoom into one
 * day and the axis is hourly, zoom into one hour and it is five-minute — a two-column
 * "hourly" answer to a one-hour question would be a dead end.
 */
export function pickGranularity(from: number, to: number, requested: Granularity | null = null): Granularity {
  const span = Math.max(0, to - from);
  const natural: Granularity =
    span <= 12 * HOUR_MS ? "5m" : span <= 3 * DAY_MS ? "hour" : span <= 180 * DAY_MS ? "day" : "week";
  let unit = requested ?? natural;
  while (bucketCount(from, to, unit) > MAX_COLS) {
    const next = GRANULARITIES[GRANULARITIES.indexOf(unit) + 1];
    if (!next) break;
    unit = next;
  }
  return unit;
}

/** True when `value` names a unit on the ladder. */
export function isGranularity(value: unknown): value is Granularity {
  return typeof value === "string" && (GRANULARITIES as readonly string[]).includes(value);
}
