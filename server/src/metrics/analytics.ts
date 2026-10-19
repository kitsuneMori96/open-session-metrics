import type { DatabaseSync } from "node:sqlite";

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

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export type Granularity = "hour" | "day" | "week";

export interface Slice {
  from: number;
  to: number;
  project: string | null;
  model: string | null;
  agent: string | null;
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

const localDay = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Monday 00:00 of the week containing `ts`. */
const localWeek = (ts: number): number => {
  const d = new Date(localDay(ts));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
};

export function pickGranularity(from: number, to: number): Granularity {
  const span = Math.max(0, to - from);
  if (span <= 3 * DAY) return "hour";
  if (span <= 180 * DAY) return "day";
  return "week";
}

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

function granularityOf(db: DatabaseSync, slice: Slice): { gran: Granularity; from: number } {
  const row = db
    .prepare("SELECT MIN(created) a FROM turns WHERE role='assistant'")
    .get() as { a: number | null } | undefined;
  const dataFrom = num(row?.a) || slice.to;
  const from = slice.from > 0 ? slice.from : dataFrom;
  return { gran: pickGranularity(from, slice.to), from };
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
  const w = turnWhere(slice);
  const r = db
    .prepare(
      `SELECT SUM(t.input) i, SUM(t.output) o, SUM(t.reasoning) r,
              SUM(t.cache_read) cr, SUM(t.cache_write) cw, SUM(t.cost) cost,
              COUNT(*) calls, SUM(COALESCE(t.tool_calls,0)) tools, SUM(COALESCE(t.tool_errors,0)) errors,
              COUNT(DISTINCT t.session_id) sessions,
              SUM(COALESCE(t.additions,0)) adds, SUM(COALESCE(t.deletions,0)) dels,
              SUM(COALESCE(t.write_lines,0)) writes
       FROM turns t WHERE ${w.sql}`
    )
    .get(...w.args) as Record<string, unknown> | undefined;

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

/** Median of an already-sorted numeric array. */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

function efficiencyOf(db: DatabaseSync, slice: Slice, totals: Totals): Efficiency {
  const w = turnWhere(slice);
  const rows = db
    .prepare(
      `SELECT COALESCE(t.dur_ms,0) dur, COALESCE(t.output,0) out, COALESCE(t.fill,0) fill, COALESCE(t.finish,'') finish
       FROM turns t WHERE ${w.sql}`
    )
    .all(...w.args) as { dur: number; out: number; fill: number; finish: string }[];

  const durs: number[] = [];
  const rates: number[] = [];
  const fills: number[] = [];
  let stopped = 0;
  for (const r of rows) {
    const dur = num(r.dur);
    const out = num(r.out);
    if (dur > 0) {
      durs.push(dur);
      if (out > 0) rates.push((out / dur) * 1000);
    }
    if (num(r.fill) > 0) fills.push(num(r.fill));
    if (r.finish && r.finish !== "stop") stopped++;
  }
  durs.sort((a, b) => a - b);
  rates.sort((a, b) => a - b);
  fills.sort((a, b) => a - b);

  return {
    outputRate: median(rates),
    turnMs: { p50: percentile(durs, 0.5), p90: percentile(durs, 0.9), p99: percentile(durs, 0.99) },
    cacheHit: totals.cacheRead + totals.input > 0 ? totals.cacheRead / (totals.cacheRead + totals.input) : 0,
    fill: { p50: percentile(fills, 0.5), p90: percentile(fills, 0.9), max: fills.length ? fills[fills.length - 1] : 0 },
    stopped,
  };
}

/* ------------------------------------------------------------------ *
 * Time series, model stack, activity heatmap — one scan
 * ------------------------------------------------------------------ */

interface Cell {
  d: number;
  hr: number;
  model: string;
  i: number; o: number; r: number; cr: number; cw: number;
  cost: number; calls: number; tools: number; errors: number;
  adds: number; dels: number; writes: number;
  sessions: string;
}

export interface Series {
  gran: Granularity;
  bucketMs: number;
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

function seriesOf(db: DatabaseSync, slice: Slice, gran: Granularity): Series {
  const w = turnWhere(slice);
  const cells = db
    .prepare(
      `SELECT CAST(t.day AS INTEGER) d,
              CAST(strftime('%H', t.created/1000, 'unixepoch', 'localtime') AS INTEGER) hr,
              COALESCE(t.model,'unknown') model,
              SUM(t.input) i, SUM(t.output) o, SUM(t.reasoning) r,
              SUM(t.cache_read) cr, SUM(t.cache_write) cw, SUM(t.cost) cost,
              COUNT(*) calls, SUM(COALESCE(t.tool_calls,0)) tools, SUM(COALESCE(t.tool_errors,0)) errors,
              SUM(COALESCE(t.additions,0)) adds, SUM(COALESCE(t.deletions,0)) dels,
              SUM(COALESCE(t.write_lines,0)) writes,
              GROUP_CONCAT(t.session_id, ' ') sessions
       FROM turns t WHERE ${w.sql}
       GROUP BY t.day, strftime('%H', t.created/1000, 'unixepoch', 'localtime'), COALESCE(t.model,'unknown')`
    )
    .all(...w.args) as unknown as Cell[];

  const bucketMs = gran === "hour" ? HOUR : gran === "week" ? 7 * DAY : DAY;
  const align = (ts: number) => (gran === "hour" ? Math.floor(ts / HOUR) * HOUR : gran === "week" ? localWeek(ts) : localDay(ts));
  const start = align(slice.from);
  const count = Math.max(1, Math.floor((slice.to - start) / bucketMs) + 1);

  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({ ts: start + i * bucketMs, ...ZERO, sessions: 0 }));
  const sessionSeen: Set<string>[] = Array.from({ length: count }, () => new Set<string>());
  const modelTotals = new Map<string, number>();
  const perModel = new Map<string, number[]>();

  const indexOf = (c: Cell): number => {
    const ts = num(c.d) + num(c.hr) * HOUR;
    const i = Math.floor((ts - start) / bucketMs);
    return i < 0 ? 0 : i >= count ? count - 1 : i;
  };

  const heat: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const hourly = new Array(24).fill(0);

  for (const c of cells) {
    const i = indexOf(c);
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
    for (const id of String(c.sessions).split(" ")) if (id) sessionSeen[i].add(id);

    const mi = ((new Date(num(c.d)).getDay() + 6) % 7);
    heat[mi][num(c.hr)] += num(c.calls);
    hourly[num(c.hr)] += num(c.calls);

    const row = perModel.get(c.model) ?? new Array(count).fill(0);
    row[i] += total;
    perModel.set(c.model, row);
    modelTotals.set(c.model, (modelTotals.get(c.model) ?? 0) + total);
  }

  for (let i = 0; i < count; i++) buckets[i].sessions = sessionSeen[i].size;

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

  return { gran, bucketMs, buckets, models, modelTokens, heat, hourly };
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
  const w = turnWhere(slice);
  const rows = db
    .prepare(
      `SELECT COALESCE(t.model,'unknown') id, COUNT(*) calls,
              SUM(t.input+t.output+t.cache_read+t.cache_write) tokens,
              SUM(t.input) input, SUM(t.output) output, SUM(t.cost) cost,
              COUNT(DISTINCT t.session_id) sessions
       FROM turns t WHERE ${w.sql} GROUP BY COALESCE(t.model,'unknown') ORDER BY tokens DESC`
    )
    .all(...w.args) as Record<string, unknown>[];
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
  const w = turnWhere(slice);
  const rows = db
    .prepare(
      `SELECT COALESCE(t.project,'—') project, COUNT(DISTINCT t.session_id) sessions, COUNT(*) turns,
              SUM(t.input+t.output+t.cache_read+t.cache_write) tokens, SUM(t.cost) cost,
              SUM(COALESCE(t.tool_calls,0)) tools, SUM(COALESCE(t.tool_errors,0)) errors
       FROM turns t WHERE ${w.sql} GROUP BY COALESCE(t.project,'—') ORDER BY tokens DESC`
    )
    .all(...w.args) as Record<string, unknown>[];
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
  const w = turnWhere(slice);
  const rows = db
    .prepare(
      `SELECT COALESCE(t.agent,'main') agent, COUNT(*) turns,
              SUM(t.input+t.output+t.cache_read+t.cache_write) tokens, SUM(t.cost) cost,
              COUNT(DISTINCT t.session_id) sessions,
              SUM(COALESCE(t.tool_calls,0)) tools, SUM(COALESCE(t.tool_errors,0)) errors
       FROM turns t WHERE ${w.sql} GROUP BY COALESCE(t.agent,'main') ORDER BY tokens DESC`
    )
    .all(...w.args) as Record<string, unknown>[];
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

function toolsOf(db: DatabaseSync, slice: Slice): ToolRow[] {
  const w = turnWhere(slice);
  const rows = db
    .prepare(
      `SELECT tl.name name, COUNT(*) calls,
              SUM(CASE WHEN tl.status='error' THEN 1 ELSE 0 END) errors,
              SUM(COALESCE(tl.dur_ms,0)) ms, COUNT(DISTINCT tl.session_id) sessions,
              COUNT(DISTINCT COALESCE(t.agent,'main')) agents
       FROM tools tl JOIN turns t ON t.id = tl.turn_id
       WHERE ${w.sql} GROUP BY tl.name ORDER BY calls DESC`
    )
    .all(...w.args) as Record<string, unknown>[];

  // Percentiles need the individual durations; one narrow scan beats a correlated
  // subquery per tool. ~25k integers is a couple of milliseconds.
  const dur = db
    .prepare(
      `SELECT tl.name name, COALESCE(tl.dur_ms,0) ms
       FROM tools tl JOIN turns t ON t.id = tl.turn_id WHERE ${w.sql}`
    )
    .all(...w.args) as { name: string; ms: number }[];
  const byName = new Map<string, number[]>();
  for (const r of dur) {
    const list = byName.get(String(r.name)) ?? [];
    list.push(num(r.ms));
    byName.set(String(r.name), list);
  }

  return rows.map((r) => {
    const list = (byName.get(String(r.name)) ?? []).sort((a, b) => a - b);
    return {
      name: String(r.name),
      calls: num(r.calls),
      errors: num(r.errors),
      totalMs: num(r.ms),
      avgMs: num(r.calls) > 0 ? num(r.ms) / num(r.calls) : 0,
      p50Ms: percentile(list, 0.5),
      p95Ms: percentile(list, 0.95),
      maxMs: list.length ? list[list.length - 1] : 0,
      sessions: num(r.sessions),
      agents: num(r.agents),
    };
  });
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
  /** Root session this one hangs off, restricted to rows inside the slice. */
  workflow: string;
  /** Distance from that root, so the list can indent a sub-agent. */
  depth: number;
  childCount: number;
}

function sessionsOf(db: DatabaseSync, slice: Slice): SessionRow[] {
  const w = turnWhere(slice);
  const rows = db
    .prepare(
      `SELECT s.id id, s.parent_id parent, COALESCE(s.title,'') title, COALESCE(s.project,'—') project,
              s.agent agent, s.model model, COALESCE(s.created,0) created, COALESCE(s.updated,0) updated,
              COALESCE(s.first_prompt,'') prompt, COALESCE(s.peak_fill,0) peak,
              SUM(t.input) i, SUM(t.output) o,
              SUM(t.cache_read) cr, SUM(t.cache_write) cw,
              SUM(t.input+t.output+t.cache_read+t.cache_write) tokens,
              SUM(t.cost) cost, COUNT(*) turns,
              SUM(COALESCE(t.tool_calls,0)) tools, SUM(COALESCE(t.tool_errors,0)) errors,
              MAX(COALESCE(t.completed,t.created)) - MIN(t.created) span,
              MAX(COALESCE(t.context_window,0)) window
       FROM turns t JOIN sessions s ON s.id = t.session_id
       WHERE ${w.sql} GROUP BY s.id ORDER BY updated DESC`
    )
    .all(...w.args) as Record<string, unknown>[];

  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const parentOf = (id: string): string => {
    const p = byId.get(id)?.parent;
    const s = p == null ? "" : String(p);
    return s && byId.has(s) ? s : "";
  };
  const childCount = new Map<string, number>();
  for (const r of rows) {
    const p = parentOf(String(r.id));
    if (p) childCount.set(p, (childCount.get(p) ?? 0) + 1);
  }
  /** The ancestor inside the slice, plus how deep below it this row sits. */
  const lineage = (id: string): { workflow: string; depth: number } => {
    let cur = id;
    let depth = 0;
    for (let i = 0; i < 32; i++) {
      const p = parentOf(cur);
      if (!p) break;
      cur = p;
      depth++;
    }
    return { workflow: cur, depth };
  };

  return rows.map((r) => {
    const id = String(r.id);
    const spanMs = num(r.span);
    const out = num(r.o);
    const input = num(r.i);
    const cacheRead = num(r.cr);
    const cacheWrite = num(r.cw);
    const window = num(r.window) || 128000;
    const { workflow, depth } = lineage(id);
    return {
      id,
      title: String(r.title) || null,
      project: String(r.project),
      agent: r.agent == null ? null : String(r.agent),
      model: r.model == null ? null : String(r.model),
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
      workflow,
      depth,
      childCount: childCount.get(id) ?? 0,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Public payloads
 * ------------------------------------------------------------------ */

export interface Kpi {
  value: number;
  prev: number;
  /** Relative change against the previous window of equal length; 0 when prev is 0. */
  delta: number;
}

export interface Dashboard {
  generatedAt: number;
  slice: Slice & { gran: Granularity; resolvedFrom: number; spanMs: number };
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

const kpi = (value: number, prev: number): Kpi => ({
  value,
  prev,
  delta: prev > 0 ? (value - prev) / prev : value > 0 ? 1 : 0,
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
    slice: { ...slice, gran, resolvedFrom: slice.from, spanMs: span },
    totals,
    kpis: {
      tokens: kpi(totals.total, prev.total),
      cost: kpi(totals.cost, prev.cost),
      turns: kpi(totals.turns, prev.turns),
      tools: kpi(totals.tools, prev.tools),
      errors: kpi(totals.errors, prev.errors),
      sessions: kpi(totals.sessions, prev.sessions),
      output: kpi(totals.output, prev.output),
      additions: kpi(totals.additions, prev.additions),
      deletions: kpi(totals.deletions, prev.deletions),
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

  const bucketMs = gran === "hour" ? HOUR : gran === "week" ? 7 * DAY : DAY;
  const align = (ts: number) => (gran === "hour" ? Math.floor(ts / HOUR) * HOUR : gran === "week" ? localWeek(ts) : localDay(ts));
  const start = align(slice.from);
  const count = Math.max(1, Math.floor((slice.to - start) / bucketMs) + 1);
  const buckets = Array.from({ length: count }, (_, i) => ({ ts: start + i * bucketMs, calls: 0, errors: 0, avgMs: 0, totalMs: 0 }));
  const idx = (ts: number) => {
    const i = Math.floor((ts - start) / bucketMs);
    return i < 0 ? 0 : i >= count ? count - 1 : i;
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
