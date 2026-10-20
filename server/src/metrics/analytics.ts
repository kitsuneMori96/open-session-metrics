import type { DatabaseSync } from "node:sqlite";
import { bucketIndexer, bucketKeySql, bucketStart, bucketStarts, calendarKey, pickGranularity, type Granularity } from "./buckets";
import { histogramOf, histMedian, ladder, quantile, type BinRow, type Histogram } from "./histogram";
import {
  cellSource,
  hourSource,
  rawCellSource,
  rawHourSource,
  rawToolBins,
  rawToolSource,
  rollSpan,
  toolBins,
  toolSource,
} from "./rollup";

export type { Granularity };
export { MAX_COLS } from "./buckets";

/**
 * Web-native analytics.
 *
 * The TUI endpoints answer questions shaped like a terminal screen: one pre-bucketed
 * array per chart, one flat aggregate row per entity. A dashboard can ask better
 * questions — "does this hold when I narrow to one project?", "what did the previous
 * window look like?", "which session is the outlier?" — so this module answers them
 * server-side, over the same materialized tables:
 *
 * - one *slice* (`from`/`to`/`project`/`model`/`agent`) is accepted by everything, so
 *   the UI can cross-filter without shipping the store to the browser;
 * - one grouped scan of `turns` by (day, hour, model) feeds the time series, the model
 *   stack, the weekday × hour heatmap and the 24-hour profile, so they can never tell
 *   three different stories;
 * - distribution questions (median output rate, latency percentiles) are answered with
 *   real percentiles rather than a mean.
 *
 * Semantics differ from `buildTrendBuckets` on purpose: a slice counts the assistant
 * turns whose *own* `created` falls in the window and whose own `project`/`model`/`agent`
 * match, rather than "roots updated in the window, then every descendant, then their
 * in-window turns". Filtering by model or agent has no meaning in the ancestor rule, and
 * a cross-filtered dashboard needs additive totals.
 */

export interface Slice {
  from: number;
  to: number;
  project: string | null;
  model: string | null;
  agent: string | null;
  /** Explicit axis unit; omitted means "pick the unit the span deserves". */
  gran?: Granularity | null;
}

export interface Totals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  turns: number;
  tools: number;
  errors: number;
  sessions: number;
  additions: number;
  deletions: number;
  writeLines: number;
}

export interface Bucket extends Totals {
  ts: number;
}

const ZERO: Totals = {
  input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0,
  turns: 0, tools: 0, errors: 0, sessions: 0, additions: 0, deletions: 0, writeLines: 0,
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The `turns` predicate every aggregate shares. Aliased as `t`, so callers that join
 * `tools` can reuse it verbatim.
 */
function turnWhere(slice: Slice): { sql: string; args: (string | number)[] } {
  const parts = ["t.role = 'assistant'", "t.created >= ?", "t.created < ?"];
  const args: (string | number)[] = [slice.from, slice.to];
  if (slice.project) {
    parts.push("COALESCE(t.project,'—') = ?");
    args.push(slice.project);
  }
  if (slice.model) {
    parts.push("COALESCE(t.model,'unknown') = ?");
    args.push(slice.model);
  }
  if (slice.agent) {
    parts.push("COALESCE(t.agent,'main') = ?");
    args.push(slice.agent);
  }
  return { sql: parts.join(" AND "), args };
}

function granularityOf(db: DatabaseSync, slice: Slice): { gran: Granularity; from: number; requested: Granularity | null } {
  const row = db
    .prepare("SELECT MIN(created) a FROM turns WHERE role='assistant'")
    .get() as { a: number | null } | undefined;
  const dataFrom = num(row?.a) || slice.to;
  const from = slice.from > 0 ? slice.from : dataFrom;
  const requested = slice.gran ?? null;
  return { gran: pickGranularity(from, slice.to, requested), from, requested };
}

/** Resolve `from = 0` ("all time") to the first turn, so deltas have a real window. */
export function resolveSlice(db: DatabaseSync, slice: Slice): { slice: Slice; gran: Granularity } {
  const { gran, from } = granularityOf(db, slice);
  return { slice: { ...slice, from }, gran };
}

/* ------------------------------------------------------------------ *
 * Scalar aggregates
 * ------------------------------------------------------------------ */

function totalsOf(db: DatabaseSync, slice: Slice): Totals {
  const span = rollSpan(db, slice);
  const src = span ? cellSource(slice, span) : rawCellSource(slice);
  const r = db
    .prepare(
      `SELECT SUM(input) i, SUM(output) o, SUM(reasoning) r,
              SUM(cache_read) cr, SUM(cache_write) cw, SUM(cost) cost,
              SUM(turns) calls, SUM(tools) tools, SUM(tool_errors) errors,
              COUNT(DISTINCT session_id) sessions,
              SUM(additions) adds, SUM(deletions) dels, SUM(write_lines) writes
         FROM (${src.sql})`
    )
    .get(...(src.args as never[])) as Record<string, unknown> | undefined;

  const input = num(r?.i);
  const output = num(r?.o);
  const cacheRead = num(r?.cr);
  const cacheWrite = num(r?.cw);
  return {
    input,
    output,
    reasoning: num(r?.r),
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost: num(r?.cost),
    turns: num(r?.calls),
    tools: num(r?.tools),
    errors: num(r?.errors),
    sessions: num(r?.sessions),
    additions: num(r?.adds),
    deletions: num(r?.dels),
    writeLines: num(r?.writes),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

export interface Efficiency {
  /** Median tokens/second over assistant turns that produced output. */
  outputRate: number;
  /** Percentiles of assistant turn wall time, ms. */
  turnMs: { p50: number; p90: number; p99: number };
  /** Share of context tokens that came from the prompt cache. */
  cacheHit: number;
  /** Median and peak context occupancy (0–1+ of the model window). */
  fill: { p50: number; p90: number; max: number };
  /** Turns that finished with an error / did not complete. */
  stopped: number;
}

/**
 * Distributions come from binned aggregates, not from carrying rows into JS.
 *
 * The old version selected (dur, out, fill, finish) for every matching turn and sorted
 * three arrays: on a decade of history that is 500k row objects and three sorts per
 * request. Here the slice is materialized once and each channel is a small group-by over
 * it, so JS sees a few hundred integers. Maxima stay exact (`MAX`); only the quantiles
 * are interpolated inside their bin, to within ~1%.
 */
function efficiencyOf(db: DatabaseSync, slice: Slice, totals: Totals): Efficiency {
  const w = turnWhere(slice);
  const rows = db
    .prepare(
      `WITH x AS MATERIALIZED (
         SELECT COALESCE(t.dur_ms,0) dur, COALESCE(t.output,0) out,
                COALESCE(t.fill,0) fill, COALESCE(t.finish,'') finish
         FROM turns t WHERE ${w.sql}
       )
       SELECT 'dur' kind, ${ladder.ms.key("dur")} bin, COUNT(*) n FROM x WHERE dur > 0 GROUP BY 2
       UNION ALL
       SELECT 'rate', ${ladder.rate.key("out * 1000.0 / dur")}, COUNT(*) FROM x WHERE dur > 0 AND out > 0 GROUP BY 2
       UNION ALL
       SELECT 'fill', ${ladder.share.key("fill")}, COUNT(*) FROM x WHERE fill > 0 GROUP BY 2
       UNION ALL
       SELECT 'durmax', 0, MAX(dur) FROM x
       UNION ALL
       SELECT 'peak', 0, MAX(fill) FROM x
       UNION ALL
       SELECT 'stopped', 0, SUM(CASE WHEN finish <> '' AND finish <> 'stop' THEN 1 ELSE 0 END) FROM x`
    )
    .all(...w.args) as unknown as (BinRow & { kind: string })[];

  const channel = (kind: string) => histogramOf(rows.filter((r) => String(r.kind) === kind));
  const scalar = (kind: string) => num(rows.find((r) => String(r.kind) === kind)?.n);

  const durs = channel("dur");
  const rates = channel("rate");
  const fills = channel("fill");
  const durMax = scalar("durmax");
  const peak = scalar("peak");

  return {
    outputRate: histMedian(rates, ladder.rate),
    turnMs: {
      p50: quantile(durs, 0.5, ladder.ms, durMax),
      p90: quantile(durs, 0.9, ladder.ms, durMax),
      p99: quantile(durs, 0.99, ladder.ms, durMax),
    },
    cacheHit: totals.cacheRead + totals.input > 0 ? totals.cacheRead / (totals.cacheRead + totals.input) : 0,
    fill: {
      p50: quantile(fills, 0.5, ladder.share, peak),
      p90: quantile(fills, 0.9, ladder.share, peak),
      max: peak,
    },
    stopped: scalar("stopped"),
  };
}

/* ------------------------------------------------------------------ *
 * Time series, model stack, activity heatmap
 * ------------------------------------------------------------------ */

interface Cell {
  k: string | number;
  model: string;
  i: number; o: number; r: number; cr: number; cw: number;
  cost: number; calls: number; tools: number; errors: number;
  adds: number; dels: number; writes: number;
}

export interface Series {
  gran: Granularity;
  buckets: Bucket[];
  /** Token-richest models, in stack order (bottom first). */
  models: string[];
  /** `modelTokens[k][i]`; the last row is `"other"` when more than eight models matched. */
  modelTokens: number[][];
  /** `[weekday 0=Mon][hour]` turn counts. */
  heat: number[][];
  /** Turn counts per local hour, 24 entries. */
  hourly: number[];
}

const MODEL_STACK = 8;

/**
 * Three queries, each bounded by the column count.
 *
 * The old version grouped by day × hour × model *before* the axis unit was applied: 10,967
 * cells on a decade of history to draw 527 columns, with every session id concatenated
 * into the same rows. Bucketing inside SQL makes the intermediate the shape of the answer
 * — at most `MAX_COLS` × models cells — and the session count and the weekday × hour heat
 * become their own small aggregates. The heat stays hourly on purpose: it is the one chart
 * that must keep reading when the axis has gone monthly.
 */
function seriesOf(db: DatabaseSync, slice: Slice, gran: Granularity): Series {
  // The rollup knows days, not hours: a sub-day axis has to bucket from `turns` itself.
  const span = gran === "5m" || gran === "hour" ? null : rollSpan(db, slice);
  const src = span ? cellSource(slice, span) : rawCellSource(slice);
  const hours = span ? hourSource(slice, span) : rawHourSource(slice);
  const starts = bucketStarts(slice.from, slice.to, gran);
  const indexOf = bucketIndexer(gran, starts);
  const key = bucketKeySql(gran);
  const count = starts.length;

  const cells = db
    .prepare(
      `SELECT ${key} k, model,
              SUM(input) i, SUM(output) o, SUM(reasoning) r,
              SUM(cache_read) cr, SUM(cache_write) cw, SUM(cost) cost,
              SUM(turns) calls, SUM(tools) tools, SUM(tool_errors) errors,
              SUM(additions) adds, SUM(deletions) dels, SUM(write_lines) writes
       FROM (${src.sql}) t
       GROUP BY k, model`
    )
    .all(...(src.args as never[])) as unknown as Cell[];

  const sessionRows = db
    .prepare(`SELECT ${key} k, COUNT(DISTINCT session_id) n FROM (${src.sql}) t GROUP BY k`)
    .all(...(src.args as never[])) as unknown as { k: string | number; n: number }[];

  // Hours come as (day, hour, turns) from either source; the weekday is read off the
  // local day so both paths land on the same cell of the heatmap.
  const heatRows = db.prepare(hours.sql).all(...(hours.args as never[])) as unknown as {
    day: number;
    hour: number;
    n: number;
  }[];

  const buckets: Bucket[] = starts.map((ts) => ({ ts, ...ZERO }));
  const modelTotals = new Map<string, number>();
  const perModel = new Map<string, number[]>();

  for (const c of cells) {
    const i = indexOf(c.k);
    if (i < 0) continue;
    const b = buckets[i];
    const input = num(c.i);
    const output = num(c.o);
    const cacheRead = num(c.cr);
    const cacheWrite = num(c.cw);
    const total = input + output + cacheRead + cacheWrite;

    b.input += input;
    b.output += output;
    b.reasoning += num(c.r);
    b.cacheRead += cacheRead;
    b.cacheWrite += cacheWrite;
    b.total += total;
    b.cost += num(c.cost);
    b.turns += num(c.calls);
    b.tools += num(c.tools);
    b.errors += num(c.errors);
    b.additions += num(c.adds);
    b.deletions += num(c.dels);
    b.writeLines += num(c.writes);

    const row = perModel.get(c.model) ?? new Array(count).fill(0);
    row[i] += total;
    perModel.set(c.model, row);
    modelTotals.set(c.model, (modelTotals.get(c.model) ?? 0) + total);
  }

  for (const s of sessionRows) {
    const i = indexOf(s.k);
    if (i >= 0) buckets[i].sessions = num(s.n);
  }

  const heat: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const hourly = new Array(24).fill(0);
  for (const r of heatRows) {
    const hour = Math.max(0, Math.min(23, num(r.hour)));
    const weekday = (new Date(num(r.day)).getDay() + 6) % 7;
    heat[weekday][hour] += num(r.n);
    hourly[hour] += num(r.n);
  }

  const ranked = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  const models = ranked.slice(0, MODEL_STACK);
  const rest = ranked.slice(MODEL_STACK);
  const modelTokens = models.map((m) => perModel.get(m) ?? new Array(count).fill(0));
  if (rest.length) {
    const other = new Array(count).fill(0);
    for (const m of rest) {
      const row = perModel.get(m)!;
      for (let i = 0; i < count; i++) other[i] += row[i];
    }
    models.push("other");
    modelTokens.push(other);
  }

  return { gran, buckets, models, modelTokens, heat, hourly };
}

/* ------------------------------------------------------------------ *
 * Breakdowns
 * ------------------------------------------------------------------ */

export interface ModelRow {
  id: string;
  calls: number;
  tokens: number;
  input: number;
  output: number;
  cost: number;
  sessions: number;
}

function modelsOf(db: DatabaseSync, slice: Slice): ModelRow[] {
  const span = rollSpan(db, slice);
  const src = span ? cellSource(slice, span) : rawCellSource(slice);
  const rows = db
    .prepare(
      `SELECT model id, SUM(turns) calls,
              SUM(input+output+cache_read+cache_write) tokens,
              SUM(input) input, SUM(output) output, SUM(cost) cost,
              COUNT(DISTINCT session_id) sessions
       FROM (${src.sql}) t GROUP BY model ORDER BY tokens DESC`
    )
    .all(...(src.args as never[])) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    calls: num(r.calls),
    tokens: num(r.tokens),
    input: num(r.input),
    output: num(r.output),
    cost: num(r.cost),
    sessions: num(r.sessions),
  }));
}

export interface ProjectRow {
  project: string;
  sessions: number;
  turns: number;
  tokens: number;
  cost: number;
  tools: number;
  errors: number;
}

function projectsOf(db: DatabaseSync, slice: Slice): ProjectRow[] {
  const span = rollSpan(db, slice);
  const src = span ? cellSource(slice, span) : rawCellSource(slice);
  const rows = db
    .prepare(
      `SELECT project, COUNT(DISTINCT session_id) sessions, SUM(turns) turns,
              SUM(input+output+cache_read+cache_write) tokens, SUM(cost) cost,
              SUM(tools) tools, SUM(tool_errors) errors
       FROM (${src.sql}) t GROUP BY project ORDER BY tokens DESC`
    )
    .all(...(src.args as never[])) as Record<string, unknown>[];
  return rows.map((r) => ({
    project: String(r.project),
    sessions: num(r.sessions),
    turns: num(r.turns),
    tokens: num(r.tokens),
    cost: num(r.cost),
    tools: num(r.tools),
    errors: num(r.errors),
  }));
}

export interface AgentRow {
  agent: string;
  turns: number;
  tokens: number;
  cost: number;
  sessions: number;
  tools: number;
  errors: number;
}

/**
 * The agent dimension. The TUI only ever printed an error count per agent; a table of
 * the same rows with tokens and cost answers the more useful question — which agent is
 * expensive, and which one is unreliable.
 */
function agentsOf(db: DatabaseSync, slice: Slice): AgentRow[] {
  const span = rollSpan(db, slice);
  const src = span ? cellSource(slice, span) : rawCellSource(slice);
  const rows = db
    .prepare(
      `SELECT agent, SUM(turns) turns,
              SUM(input+output+cache_read+cache_write) tokens, SUM(cost) cost,
              COUNT(DISTINCT session_id) sessions,
              SUM(tools) tools, SUM(tool_errors) errors
       FROM (${src.sql}) t GROUP BY agent ORDER BY tokens DESC`
    )
    .all(...(src.args as never[])) as Record<string, unknown>[];
  return rows.map((r) => ({
    agent: String(r.agent),
    turns: num(r.turns),
    tokens: num(r.tokens),
    cost: num(r.cost),
    sessions: num(r.sessions),
    tools: num(r.tools),
    errors: num(r.errors),
  }));
}

export interface ToolRow {
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  sessions: number;
  agents: number;
}

interface ToolBin extends BinRow {
  name: string;
  errors: number;
  ms: number;
  maxMs: number;
}

function toolsOf(db: DatabaseSync, slice: Slice): ToolRow[] {
  const span = rollSpan(db, slice);
  const sums = span ? toolSource(slice, span) : rawToolSource(slice);
  const bins = span ? toolBins(slice, span) : rawToolBins(slice);

  // Two grouped passes: one for the additive columns and one for the latency bins. Both
  // read the day rollup when the window has whole days in it, so neither joins half a
  // million turns to answer a question about 22 tools.
  const people = db
    .prepare(
      `SELECT name, SUM(calls) calls, SUM(errors) errors, SUM(ms) ms, MAX(mx) maxMs,
              COUNT(DISTINCT session_id) sessions, COUNT(DISTINCT agent) agents
       FROM (${sums.sql}) GROUP BY name`
    )
    .all(...(sums.args as never[])) as unknown as {
    name: string;
    calls: number;
    errors: number;
    ms: number;
    maxMs: number;
    sessions: number;
    agents: number;
  }[];

  const hist = db.prepare(bins.sql).all(...(bins.args as never[])) as unknown as ToolBin[];

  interface Acc {
    name: string;
    calls: number;
    errors: number;
    totalMs: number;
    maxMs: number;
    sessions: number;
    agents: number;
    hist: Histogram;
  }
  const acc = new Map<string, Acc>();
  for (const r of people) {
    const name = String(r.name);
    acc.set(name, {
      name,
      calls: num(r.calls),
      errors: num(r.errors),
      totalMs: num(r.ms),
      maxMs: num(r.maxMs),
      sessions: num(r.sessions),
      agents: num(r.agents),
      hist: new Map(),
    });
  }
  for (const r of hist) {
    const a = acc.get(String(r.name));
    if (!a) continue;
    const bin = Number(r.bin) || 0;
    a.hist.set(bin, (a.hist.get(bin) ?? 0) + num(r.n));
  }

  return [...acc.values()]
    .map((a) => ({
      name: a.name,
      calls: a.calls,
      errors: a.errors,
      totalMs: a.totalMs,
      avgMs: a.calls > 0 ? a.totalMs / a.calls : 0,
      p50Ms: quantile(a.hist, 0.5, ladder.ms, a.maxMs),
      p95Ms: quantile(a.hist, 0.95, ladder.ms, a.maxMs),
      maxMs: a.maxMs,
      sessions: a.sessions,
      agents: a.agents,
    }))
    .sort((x, y) => y.calls - x.calls);
}

/** One point per session active in the slice — the scatter, the table and the picker. */
export interface SessionRow {
  id: string;
  title: string | null;
  project: string;
  agent: string | null;
  model: string | null;
  parentId: string | null;
  created: number;
  updated: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  tools: number;
  errors: number;
  spanMs: number;
  outputRate: number;
  contextPct: number;
  peakFill: number;
  firstPrompt: string | null;
  /** Sub-agent sessions hanging off this one, among the rows returned. */
  childCount: number;
}

/**
 * Per-session aggregates over a slice, in one grouped scan.
 *
 * Shared by the dashboard sample, the paged grid and the detail page's family lookup, so
 * all three count turns the same way. `ctx` is computed here rather than in JS because it
 * is also a sort key, and sorting a page after fetching it would page the wrong rows.
 */
function sessionAgg(db: DatabaseSync, slice: Slice): { sql: string; args: unknown[] } {
  const span = rollSpan(db, slice);
  const meta = `SELECT s.id id, s.parent_id parent, COALESCE(s.title,'') title, COALESCE(s.project,'—') project,
                       COALESCE(s.agent,'main') agent, COALESCE(s.model,'') model,
                       COALESCE(s.created,0) created, COALESCE(s.updated,0) updated,
                       COALESCE(s.first_prompt,'') prompt, COALESCE(s.peak_fill,0) peak,
                       a.i i, a.o o, a.cr cr, a.cw cw, a.tokens tokens, a.cost cost, a.turns turns,
                       a.tools tools, a.errors errors, a.span span, a.win win, a.ctx ctx
                  FROM (`;

  if (span) {
    const src = cellSource(slice, span);
    return {
      args: src.args,
      sql: `${meta}SELECT session_id id, SUM(input) i, SUM(output) o, SUM(cache_read) cr, SUM(cache_write) cw,
                   SUM(input+output+cache_read+cache_write) tokens, SUM(cost) cost, SUM(turns) turns,
                   SUM(tools) tools, SUM(tool_errors) errors,
                   MAX(ended) - MIN(created) span, MAX(win) win,
                   SUM(input+cache_read+cache_write) * 1.0 /
                     MAX(CASE WHEN win > 0 THEN win ELSE 128000 END) ctx
              FROM (${src.sql}) GROUP BY session_id) a
             JOIN sessions s ON s.id = a.id`,
    };
  }

  const w = turnWhere(slice);
  return {
    args: w.args,
    sql: `${meta}SELECT t.session_id id, SUM(t.input) i, SUM(t.output) o,
                   SUM(t.cache_read) cr, SUM(t.cache_write) cw,
                   SUM(t.input+t.output+t.cache_read+t.cache_write) tokens,
                   SUM(t.cost) cost, COUNT(*) turns,
                   SUM(COALESCE(t.tool_calls,0)) tools, SUM(COALESCE(t.tool_errors,0)) errors,
                   MAX(COALESCE(t.completed,t.created)) - MIN(t.created) span,
                   MAX(COALESCE(t.context_window,0)) win,
                   SUM(t.input+t.cache_read+t.cache_write) * 1.0 /
                     MAX(CASE WHEN COALESCE(t.context_window,0) > 0 THEN t.context_window ELSE 128000 END) ctx
              FROM turns t WHERE ${w.sql} GROUP BY t.session_id) a
             JOIN sessions s ON s.id = a.id`,
  };
}

function toSessionRows(rows: Record<string, unknown>[]): SessionRow[] {
  const ids = new Set(rows.map((r) => String(r.id)));
  const childCount = new Map<string, number>();
  for (const r of rows) {
    const p = r.parent == null ? "" : String(r.parent);
    if (p && ids.has(p)) childCount.set(p, (childCount.get(p) ?? 0) + 1);
  }

  return rows.map((r) => {
    const id = String(r.id);
    const spanMs = num(r.span);
    const out = num(r.o);
    const input = num(r.i);
    const cacheRead = num(r.cr);
    const cacheWrite = num(r.cw);
    const window = num(r.win) || 128000;
    const model = r.model == null || String(r.model) === "" ? null : String(r.model);
    return {
      id,
      title: String(r.title) || null,
      project: String(r.project),
      agent: r.agent == null ? null : String(r.agent),
      model,
      parentId: r.parent == null ? null : String(r.parent),
      created: num(r.created),
      updated: num(r.updated),
      tokens: num(r.tokens),
      input,
      output: out,
      cacheRead,
      cacheWrite,
      cost: num(r.cost),
      turns: num(r.turns),
      tools: num(r.tools),
      errors: num(r.errors),
      spanMs,
      outputRate: spanMs > 0 && out > 0 ? (out / spanMs) * 1000 : 0,
      // Same context convention as the rest of the project: what the provider had to
      // re-read plus what it wrote, over the model's window.
      contextPct: (input + cacheRead + cacheWrite) / window,
      peakFill: num(r.peak),
      firstPrompt: String(r.prompt) || null,
      childCount: childCount.get(id) ?? 0,
    };
  });
}

/**
 * How many sessions the dashboard carries.
 *
 * The list used to be every session in the slice, which is the one array that grows with
 * history — 4,662 rows and 3.7 MB on a decade of turns, for a chart that cannot draw them
 * all. 200 heaviest is a bounded sample of the same shape; the Sessions screen pages
 * through the rest server-side.
 */
export const SESSION_SAMPLE = 200;

/**
 * The most roots one page of the session grid may return.
 *
 * Different number from `SESSION_SAMPLE`, for a different job: the dashboard sample is a
 * *drawing* budget (scatter points, the heaviest list) while a page is a *reading* budget.
 * A page of 500 roots is big enough that an ordinary store arrives in one request and the
 * grid never shows a paging control at all; a decade store still answers in bounded slices.
 */
export const MAX_PAGE_ROOTS = 500;

function sessionsOf(db: DatabaseSync, slice: Slice): SessionRow[] {
  const a = sessionAgg(db, slice);
  const rows = db
    .prepare(`${a.sql} ORDER BY tokens DESC, id DESC LIMIT ${SESSION_SAMPLE}`)
    .all(...(a.args as never[])) as Record<string, unknown>[];
  return toSessionRows(rows);
}

export type SessionOrder =
  | "updated" | "created" | "tokens" | "cost" | "turns"
  | "tools" | "errors" | "span" | "ctx" | "title" | "project" | "model" | "agent";

const SESSION_ORDER_COLUMN: Record<SessionOrder, string> = {
  updated: "updated", created: "created", tokens: "tokens", cost: "cost",
  turns: "turns", tools: "tools", errors: "errors", span: "span", ctx: "ctx",
  title: "title", project: "project", model: "model", agent: "agent",
};

export const SESSION_ORDERS = Object.keys(SESSION_ORDER_COLUMN) as SessionOrder[];

export interface SessionTotals {
  sessions: number;
  tokens: number;
  cost: number;
  turns: number;
  tools: number;
  errors: number;
}

export interface SessionPage {
  rows: SessionRow[];
  /** Sessions matching the filter, including the ancestors kept for context. */
  matching: number;
  /** Root sessions in the filtered forest — what paging walks. */
  roots: number;
  /** Cursor for the next page, or null on the last one. */
  next: string | null;
  /** Aggregates over every matching session, not just this page. */
  totals: SessionTotals;
}

const likePattern = (q: string): string => `%${q.replace(/[\%_]/g, (c) => `\${c}`)}%`;

/** Keyset cursor as an opaque token; the value keeps its type so tuple comparison works. */
export const encodeCursor = (value: { v: unknown; id: string }): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decodeCursor = (raw: string | null | undefined): { v: unknown; id: string } | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { v?: unknown; id?: unknown };
    if (parsed.id == null) return null;
    return { v: parsed.v ?? 0, id: String(parsed.id) };
  } catch {
    return null;
  }
};

/**
 * One page of the session grid, filtered and sorted in SQL.
 *
 * Two things make this more than a `LIMIT`:
 *
 * - paging walks **roots**, and every page carries the whole subtree under each of them,
 *   so a sub-agent is never orphaned into a page its parent is not on;
 * - a text filter keeps the **ancestors** of every match (a recursive walk up, then back
 *   down), which is what the screen always meant by "matching a tree".
 *
 * `matching` counts the kept rows, `roots` counts the page units, and `totals` aggregates
 * the whole filtered set — the status bar must not describe only the visible page.
 */
export function sessionsPage(
  db: DatabaseSync,
  slice: Slice,
  opts: {
    q?: string | null;
    order?: SessionOrder;
    dir?: "asc" | "desc";
    limit?: number;
    cursor?: string | null;
  } = {}
): SessionPage {
  const agg = sessionAgg(db, slice);
  const q = (opts.q ?? "").trim();
  const order = SESSION_ORDER_COLUMN[opts.order ?? "updated"] ?? "updated";
  const asc = opts.dir === "asc";
  const limit = Math.min(MAX_PAGE_ROOTS, Math.max(1, Math.round(opts.limit ?? MAX_PAGE_ROOTS)));

  const hit = q
    ? `SELECT * FROM agg WHERE title LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\'
              OR model LIKE ? ESCAPE '\\' OR agent LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\'`
    : "SELECT * FROM agg";
  const hitArgs = q ? Array(5).fill(likePattern(q)) : [];
  const args = [...(agg.args as never[]), ...(hitArgs as never[])];

  const cursor = decodeCursor(opts.cursor);
  const cursorSql = cursor ? `WHERE (${order}, id) ${asc ? ">" : "<"} (?, ?)` : "";
  const cursorArgs: (string | number)[] = cursor ? [cursor.v as string | number, cursor.id] : [];
  const direction = asc ? "ASC" : "DESC";

  const prefix = `WITH RECURSIVE
      agg AS MATERIALIZED (${agg.sql}),
      hit AS (${hit}),
      keep(id) AS (
        SELECT id FROM hit
        UNION
        SELECT a.parent FROM agg a JOIN keep k ON a.id = k.id
         WHERE a.parent IS NOT NULL AND a.parent IN (SELECT id FROM agg)
      ),
      roots AS (
        SELECT * FROM agg WHERE id IN (SELECT id FROM keep)
          AND (parent IS NULL OR parent NOT IN (SELECT id FROM keep))
      ),
      page AS (
        SELECT * FROM roots ${cursorSql} ORDER BY ${order} ${direction}, id ${direction} LIMIT ?
      ),
      down(id) AS (
        SELECT id FROM page
        UNION
        SELECT a.id FROM agg a JOIN down d ON a.parent = d.id WHERE a.id IN (SELECT id FROM keep)
      ),
      matched AS (SELECT * FROM agg WHERE id IN (SELECT id FROM keep))`;

  /**
   * One statement, not four.
   *
   * The per-session aggregate is the expensive half (a decade of turns is half a million
   * rows joined and grouped), and every extra statement used to pay for it again. The
   * counts and sums ride along as uncorrelated subqueries — SQLite evaluates those once —
   * so a page costs one aggregate pass instead of four.
   */
  const rows = db
    .prepare(
      `${prefix}
       SELECT a.*, (a.id IN (SELECT id FROM page)) inpage,
              (SELECT COUNT(*) FROM matched) matching,
              (SELECT COUNT(*) FROM roots) roots,
              (SELECT SUM(tokens) FROM matched) m_tokens,
              (SELECT SUM(cost) FROM matched) m_cost,
              (SELECT SUM(turns) FROM matched) m_turns,
              (SELECT SUM(tools) FROM matched) m_tools,
              (SELECT SUM(errors) FROM matched) m_errors,
              (SELECT COUNT(*) FROM matched) m_sessions
         FROM agg a JOIN down d ON d.id = a.id
         ORDER BY ${order} ${direction}, a.id ${direction}`
    )
    .all(...args, ...cursorArgs, limit) as Record<string, unknown>[];

  const meta = rows[0];
  const pageRoots = rows.filter((r) => num(r.inpage) === 1);
  const last = pageRoots[pageRoots.length - 1];
  const next = pageRoots.length >= limit && last ? encodeCursor({ v: last[order] ?? 0, id: String(last.id) }) : null;

  return {
    rows: toSessionRows(rows),
    matching: num(meta?.matching),
    roots: num(meta?.roots),
    next,
    totals: {
      sessions: num(meta?.m_sessions),
      tokens: num(meta?.m_tokens),
      cost: num(meta?.m_cost),
      turns: num(meta?.m_turns),
      tools: num(meta?.m_tools),
      errors: num(meta?.m_errors),
    },
  };
}

/**
 * The family of one session inside the slice: itself, its ancestors, its siblings and its
 * children. The detail page asks for this instead of scanning the whole session list,
 * which it cannot afford to receive once history is long.
 */
export function sessionContext(db: DatabaseSync, slice: Slice, id: string): SessionRow[] {
  const agg = sessionAgg(db, slice);
  const rows = db
    .prepare(
      `WITH RECURSIVE
       agg AS (${agg.sql}),
       focus AS (SELECT parent FROM agg WHERE id = ?),
       up(id) AS (
         SELECT parent FROM focus WHERE parent IS NOT NULL
         UNION
         SELECT a.parent FROM agg a JOIN up ON a.id = up.id WHERE a.parent IS NOT NULL
       )
       SELECT a.* FROM agg a
        WHERE a.id = ? OR a.id IN (SELECT id FROM up)
           OR a.parent = ? OR a.parent = (SELECT parent FROM focus)
        ORDER BY updated DESC`
    )
    .all(...(agg.args as never[]), id, id, id) as Record<string, unknown>[];
  return toSessionRows(rows);
}


/* ------------------------------------------------------------------ *
 * Public payloads
 * ------------------------------------------------------------------ */

export interface Kpi {
  value: number;
  prev: number;
  /**
   * Relative change against the previous window of equal length; null when there is no
   * earlier window (all of history) or no baseline to divide by (prev = 0).
   */
  delta: number | null;
}

export interface Dashboard {
  generatedAt: number;
  slice: Slice & {
    gran: Granularity;
    /** The unit that was asked for, when it differs from the one the axis can afford. */
    granRequested: Granularity | null;
    resolvedFrom: number;
    spanMs: number;
  };
  totals: Totals;
  kpis: {
    tokens: Kpi;
    cost: Kpi;
    turns: Kpi;
    tools: Kpi;
    errors: Kpi;
    sessions: Kpi;
    output: Kpi;
    additions: Kpi;
    deletions: Kpi;
  };
  efficiency: Efficiency;
  series: Series;
  models: ModelRow[];
  projects: ProjectRow[];
  agents: AgentRow[];
  tools: ToolRow[];
  sessions: SessionRow[];
}

/**
 * A KPI against the previous window of equal length.
 *
 * `delta` is null when there is nothing to compare *with* — the whole history is
 * selected, or the metric was empty last time. Saying "+100 %" because the baseline was
 * zero is a claim about the past that the data does not support.
 */
const kpi = (value: number, prev: number, comparable: boolean): Kpi => ({
  value,
  prev,
  delta: !comparable || prev <= 0 ? (comparable && value === 0 ? 0 : null) : (value - prev) / prev,
});

export function dashboard(db: DatabaseSync, raw: Slice): Dashboard {
  const { slice, gran } = resolveSlice(db, raw);
  const span = slice.to - slice.from;
  const totals = totalsOf(db, slice);
  // The comparison window is the same length immediately before this one; with the
  // whole history selected there is nothing before it, so the deltas go to zero.
  const hasPrev = raw.from > 0 && span > 0;
  const prev = hasPrev ? totalsOf(db, { ...slice, from: slice.from - span, to: slice.from }) : ZERO;

  return {
    generatedAt: Date.now(),
    slice: { ...slice, gran, granRequested: raw.gran ?? null, resolvedFrom: slice.from, spanMs: span },
    totals,
    kpis: {
      tokens: kpi(totals.total, prev.total, hasPrev),
      cost: kpi(totals.cost, prev.cost, hasPrev),
      turns: kpi(totals.turns, prev.turns, hasPrev),
      tools: kpi(totals.tools, prev.tools, hasPrev),
      errors: kpi(totals.errors, prev.errors, hasPrev),
      sessions: kpi(totals.sessions, prev.sessions, hasPrev),
      output: kpi(totals.output, prev.output, hasPrev),
      additions: kpi(totals.additions, prev.additions, hasPrev),
      deletions: kpi(totals.deletions, prev.deletions, hasPrev),
    },
    efficiency: efficiencyOf(db, slice, totals),
    series: seriesOf(db, slice, gran),
    models: modelsOf(db, slice),
    projects: projectsOf(db, slice),
    agents: agentsOf(db, slice),
    tools: toolsOf(db, slice),
    sessions: sessionsOf(db, slice),
  };
}

export interface ToolDetail {
  name: string;
  totals: ToolRow | null;
  gran: Granularity;
  buckets: { ts: number; calls: number; errors: number; avgMs: number; totalMs: number }[];
  /** Latency histogram, log-ish bins of milliseconds. */
  latency: { label: string; count: number; upperMs: number }[];
  agents: { agent: string; calls: number; errors: number }[];
  projects: { project: string; calls: number; errors: number }[];
  signatures: { sig: string; count: number; sample: string }[];
  recentErrors: { at: number; session: string; error: string }[];
  /** Whatever the tool wrote back into the tree, summed over the slice. */
  edited: { additions: number; deletions: number; files: number; chars: number };
}

const LAT_BINS: [string, number, number][] = [
  ["0–10ms", 0, 10],
  ["10–50ms", 10, 50],
  ["50–200ms", 50, 200],
  ["200ms–1s", 200, 1000],
  ["1–5s", 1000, 5000],
  ["5–30s", 5000, 30000],
  ["30s+", 30000, Infinity],
];

export function toolDetail(db: DatabaseSync, raw: Slice, name: string): ToolDetail {
  const { slice, gran } = resolveSlice(db, raw);
  const w = turnWhere(slice);
  const args = [...w.args, name];

  const rows = db
    .prepare(
      `SELECT tl.name name, COALESCE(tl.dur_ms,0) ms, tl.status status,
              COALESCE(tl.started,0) started, COALESCE(tl.sig,'') sig,
              COALESCE(tl.error,'') error, COALESCE(tl.session_id,'') session,
              COALESCE(t.agent,'main') agent, COALESCE(t.project,'—') project,
              COALESCE(tl.additions,0) adds, COALESCE(tl.deletions,0) dels,
              COALESCE(tl.files,0) files, COALESCE(tl.output_chars,0) chars
       FROM tools tl JOIN turns t ON t.id = tl.turn_id
       WHERE ${w.sql} AND tl.name = ?`
    )
    .all(...args) as Record<string, unknown>[];

  const starts = bucketStarts(slice.from, slice.to, gran);
  const buckets = starts.map((ts) => ({ ts, calls: 0, errors: 0, avgMs: 0, totalMs: 0 }));
  // Calendar buckets have no fixed width, so a call is placed by resolving its own bucket
  // start through the axis rather than by dividing by a step.
  const place = bucketIndexer(gran, starts);
  const idx = (ts: number) => {
    const start = bucketStart(ts, gran);
    const i = place(gran === "month" || gran === "quarter" || gran === "year" ? calendarKey(start, gran) : start);
    return i < 0 ? 0 : i;
  };

  const latency = LAT_BINS.map(([label, lo, hi]) => ({ label, count: 0, upperMs: hi }));
  const agents = new Map<string, { agent: string; calls: number; errors: number }>();
  const projects = new Map<string, { project: string; calls: number; errors: number }>();
  const signatures = new Map<string, { sig: string; count: number; sample: string }>();
  const recentErrors: ToolDetail["recentErrors"] = [];
  let additions = 0;
  let deletions = 0;
  let files = 0;
  let chars = 0;
  let failures = 0;

  for (const r of rows) {
    const ms = num(r.ms);
    const isError = r.status === "error";
    const b = buckets[idx(num(r.started) || slice.to - 1)];
    b.calls++;
    if (isError) b.errors++;
    b.totalMs += ms;
    if (isError) failures++;
    additions += num(r.adds);
    deletions += num(r.dels);
    files += num(r.files);
    chars += num(r.chars);

    for (let k = 0; k < LAT_BINS.length; k++) {
      if (ms >= LAT_BINS[k][1] && ms < LAT_BINS[k][2]) {
        latency[k].count++;
        break;
      }
    }

    const agent = String(r.agent);
    const a = agents.get(agent) ?? { agent, calls: 0, errors: 0 };
    a.calls++;
    if (isError) a.errors++;
    agents.set(agent, a);

    const project = String(r.project);
    const p = projects.get(project) ?? { project, calls: 0, errors: 0 };
    p.calls++;
    if (isError) p.errors++;
    projects.set(project, p);

    const sig = String(r.sig) || "(no signature)";
    const s = signatures.get(sig) ?? { sig, count: 0, sample: String(r.error).slice(0, 400) };
    s.count++;
    if (!s.sample && r.error) s.sample = String(r.error).slice(0, 400);
    signatures.set(sig, s);

    if (isError && String(r.error) && recentErrors.length < 12) {
      recentErrors.push({ at: num(r.started), session: String(r.session), error: String(r.error).slice(0, 400) });
    }
  }
  for (const b of buckets) b.avgMs = b.calls > 0 ? b.totalMs / b.calls : 0;

  const calls = rows.length;
  const totalMs = rows.reduce((a, r) => a + num(r.ms), 0);
  const durs = rows.map((r) => num(r.ms)).sort((a, b) => a - b);
  const sessions = new Set(rows.map((r) => String(r.session))).size;

  return {
    name,
    gran,
    totals: {
      name,
      calls,
      errors: failures,
      totalMs,
      avgMs: calls > 0 ? totalMs / calls : 0,
      p50Ms: percentile(durs, 0.5),
      p95Ms: percentile(durs, 0.95),
      maxMs: durs.length ? durs[durs.length - 1] : 0,
      sessions,
      agents: agents.size,
    },
    buckets,
    latency,
    agents: [...agents.values()].sort((a, b) => b.calls - a.calls),
    projects: [...projects.values()].sort((a, b) => b.calls - a.calls).slice(0, 12),
    signatures: [...signatures.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    recentErrors,
    edited: { additions, deletions, files, chars },
  };
}

export interface Facets {
  projects: { project: string; sessions: number; tokens: number; cost: number; updated: number }[];
  models: { id: string; label: string; calls: number }[];
  agents: { agent: string; calls: number }[];
  tools: { name: string; calls: number }[];
  extent: { from: number; to: number };
  counts: { sessions: number; turns: number; tools: number; parts: number };
}

export function facets(db: DatabaseSync): Facets {
  const projects = db
    .prepare(
      `SELECT COALESCE(s.project,'—') project, COUNT(*) sessions,
              SUM(COALESCE(s.t_input,0)+COALESCE(s.t_output,0)+COALESCE(s.t_cache_read,0)+COALESCE(s.t_cache_write,0)) tokens,
              SUM(COALESCE(s.cost,0)) cost, MAX(COALESCE(s.updated,0)) updated
       FROM sessions s GROUP BY COALESCE(s.project,'—') ORDER BY sessions DESC`
    )
    .all() as Record<string, unknown>[];
  // Turns carry the bare model id (`deepseek-v4-flash-free`); the `models` table keys on
  // `provider/id`. The facet therefore groups turns and borrows the catalogue label when
  // it can be matched, because a facet value has to be exactly what `slice.model` accepts.
  const models = db
    .prepare(
      `SELECT COALESCE(t.model,'unknown') id, COUNT(*) calls
       FROM turns t WHERE t.role='assistant'
       GROUP BY COALESCE(t.model,'unknown') ORDER BY calls DESC`
    )
    .all() as Record<string, unknown>[];
  const catalogue = new Map<string, string>();
  for (const m of db.prepare("SELECT id, label FROM models").all() as Record<string, unknown>[]) {
    const full = String(m.id);
    const bare = full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : full;
    const label = m.label == null ? null : String(m.label);
    // A row whose label is just its full id is a stub; a friendlier name wins.
    if (!label || label === full) {
      if (!catalogue.has(bare)) catalogue.set(bare, bare);
      continue;
    }
    catalogue.set(bare, label);
  }
  const agents = db
    .prepare(
      `SELECT COALESCE(agent,'main') agent, COUNT(*) calls FROM turns WHERE role='assistant'
       GROUP BY COALESCE(agent,'main') ORDER BY calls DESC`
    )
    .all() as Record<string, unknown>[];
  const extent = db.prepare("SELECT MIN(created) a, MAX(created) b FROM turns WHERE role='assistant'").get() as
    | { a: number | null; b: number | null }
    | undefined;

  // The tool list rides along so the search palette can offer every tool as a target
  // without a second round trip.
  const tools = db
    .prepare("SELECT name, COUNT(*) calls FROM tools GROUP BY name ORDER BY calls DESC")
    .all() as Record<string, unknown>[];

  return {
    projects: projects.map((p) => ({
      project: String(p.project),
      sessions: num(p.sessions),
      tokens: num(p.tokens),
      cost: num(p.cost),
      updated: num(p.updated),
    })),
    models: models.map((m) => ({
      id: String(m.id),
      label: catalogue.get(String(m.id)) ?? String(m.id),
      calls: num(m.calls),
    })),
    agents: agents.map((a) => ({ agent: String(a.agent), calls: num(a.calls) })),
    tools: tools.map((t) => ({ name: String(t.name), calls: num(t.calls) })),
    extent: { from: num(extent?.a), to: num(extent?.b) || Date.now() },
    counts: {
      sessions: num((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number })?.c),
      turns: num((db.prepare("SELECT COUNT(*) c FROM turns WHERE role='assistant'").get() as { c: number })?.c),
      tools: num((db.prepare("SELECT COUNT(*) c FROM tools").get() as { c: number })?.c),
      parts: num((db.prepare("SELECT COUNT(*) c FROM parts").get() as { c: number })?.c),
    },
  };
}
