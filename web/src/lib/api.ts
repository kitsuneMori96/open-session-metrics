import { keepPreviousData, useInfiniteQuery, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { BASE } from "./base";
import { committedSource } from "./scope";

/**
 * Every request names the store it reads.
 *
 * The header is the *only* carrier: the scope is not linkable, so it cannot ride
 * in the URL. When nothing has been committed yet the header is omitted and the
 * server answers with its default store.
 */
function headers(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  const kind = committedSource();
  if (kind) h.set("x-osm-source", kind);
  return h;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal, headers: headers() });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ *
 * The slice: every analytical view is rendered against this window and
 * this cross-filter, so the URL alone can reproduce a screen.
 * ------------------------------------------------------------------ */

export interface Slice {
  from: number;
  to: number;
  project: string | null;
  model: string | null;
  agent: string | null;
  /** Axis unit. `null`/absent means "the finest unit this span can afford". */
  gran?: Granularity | null;
}

/**
 * Time-axis units, finest to coarsest. The server climbs this ladder until a window fits
 * in 200 columns, so the choice only matters when it is explicit — five minutes is
 * reachable, but asking for it over a decade answers monthly instead of a million columns.
 */
export type Granularity = "5m" | "hour" | "day" | "week" | "month" | "quarter" | "year";
export const GRANULARITIES: readonly Granularity[] = ["5m", "hour", "day", "week", "month", "quarter", "year"];

export const DAY = 86_400_000;

/**
 * A window is kept symbolic in the URL so "last 30 days" stays relative across
 * reloads, and so a query key does not change every time the clock ticks: only a
 * brush commits absolute epoch values.
 */
export type WindowSpec = { kind: "preset"; id: PresetId } | { kind: "custom"; from: number; to: number };

export const DEFAULT_PRESET: PresetId = "24h";

export const PRESETS = [
  { id: "24h", label: "24h", ms: DAY },
  { id: "7d", label: "7d", ms: 7 * DAY },
  { id: "30d", label: "30d", ms: 30 * DAY },
  { id: "90d", label: "90d", ms: 90 * DAY },
  { id: "1y", label: "1y", ms: 365 * DAY },
  { id: "all", label: "all", ms: 0 },
] as const;
export type PresetId = (typeof PRESETS)[number]["id"];

const presetOf = (id: string): (typeof PRESETS)[number] | undefined => PRESETS.find((p) => p.id === id);

/** Resolved once so an unknown id in the URL falls back to the default, not to an index. */
const DEFAULT = presetOf(DEFAULT_PRESET)!;

export function resolveWindow(w: WindowSpec, now: number): { from: number; to: number } {
  if (w.kind === "custom") return { from: w.from, to: w.to };
  const preset = presetOf(w.id) ?? DEFAULT;
  return preset.ms > 0 ? { from: now - preset.ms, to: now } : { from: 0, to: now };
}

export const windowKey = (w: WindowSpec): string =>
  w.kind === "preset" ? `p:${w.id}` : `c:${Math.round(w.from)}-${Math.round(w.to)}`;

export const windowLabel = (w: WindowSpec): string => {
  if (w.kind === "preset") return presetOf(w.id)?.label ?? "all";
  const p = (n: number) => String(n).padStart(2, "0");
  const day = (ts: number) => {
    const x = new Date(ts);
    return `${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  const time = (ts: number) => {
    const x = new Date(ts);
    return `${p(x.getHours())}:${p(x.getMinutes())}`;
  };
  // A brushed or clicked window is often shorter than a day, where "10-18 → 10-18"
  // would describe an hour and a month with the same five characters.
  if (w.to - w.from >= 22 * 3600000) return `${day(w.from)} → ${day(w.to)}`;
  if (day(w.from) === day(w.to - 1)) return `${day(w.from)} ${time(w.from)}–${time(w.to)}`;
  return `${day(w.from)} ${time(w.from)} → ${day(w.to)} ${time(w.to)}`;
};

export const sliceQuery = (s: Slice): string => {
  const p = new URLSearchParams();
  p.set("from", String(Math.max(0, Math.round(s.from))));
  p.set("to", String(Math.round(s.to)));
  if (s.project) p.set("project", s.project);
  if (s.model) p.set("model", s.model);
  if (s.agent) p.set("agent", s.agent);
  if (s.gran) p.set("gran", s.gran);
  return p.toString();
};

/* ------------------------------------------------------------------ *
 * Payloads
 * ------------------------------------------------------------------ */

export interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Totals extends TokenTotals {
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

export interface Kpi {
  value: number;
  prev: number;
  /** null when there is no earlier window to compare with. */
  delta: number | null;
}

export interface Efficiency {
  outputRate: number;
  turnMs: { p50: number; p90: number; p99: number };
  cacheHit: number;
  fill: { p50: number; p90: number; max: number };
  stopped: number;
}

export interface Series {
  gran: Granularity;
  buckets: Bucket[];
  models: string[];
  modelTokens: number[][];
  heat: number[][];
  hourly: number[];
}

export interface ModelRow {
  id: string;
  calls: number;
  tokens: number;
  input: number;
  output: number;
  cost: number;
  sessions: number;
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

export interface AgentRow {
  agent: string;
  turns: number;
  tokens: number;
  cost: number;
  sessions: number;
  tools: number;
  errors: number;
}

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

/** Columns the session grid can be sorted by, server-side. */
export type SessionOrder =
  | "updated" | "created" | "tokens" | "cost" | "turns"
  | "tools" | "errors" | "span" | "ctx" | "title" | "project" | "model" | "agent";

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
  next: string | null;
  totals: SessionTotals;
}

export interface Dashboard {
  generatedAt: number;
  slice: Slice & {
    gran: Granularity;
    /** What was asked for, when the axis could not afford it. */
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

export interface ToolDetail {
  name: string;
  totals: ToolRow | null;
  gran: Granularity;
  buckets: { ts: number; calls: number; errors: number; avgMs: number; totalMs: number }[];
  latency: { label: string; count: number; upperMs: number }[];
  agents: { agent: string; calls: number; errors: number }[];
  projects: { project: string; calls: number; errors: number }[];
  signatures: { message: string; count: number; sample: string }[];
  recentErrors: { at: number; session: string; error: string }[];
  edited: { additions: number; deletions: number; files: number; chars: number };
}

export interface Facets {
  projects: { project: string; sessions: number; tokens: number; cost: number; updated: number }[];
  models: { id: string; label: string; calls: number }[];
  agents: { agent: string; calls: number }[];
  tools: { name: string; calls: number }[];
  extent: { from: number; to: number };
  counts: { sessions: number; turns: number; tools: number; parts: number };
}

export interface ToolPart {
  kind: "tool";
  ordinal: number;
  name: string;
  callId: string;
  status: string;
  title: string | null;
  /** raw JSON of the call arguments */
  input: string;
  output: string;
  exitCode: number | null;
  truncated: boolean;
  started: number | null;
  ended: number | null;
  chars: number;
}

export interface BodyPart {
  kind: "text" | "reasoning";
  ordinal: number;
  text: string;
  chars: number;
  name: "";
  callId: "";
  status: "";
  title: null;
  input: "";
  output: "";
  exitCode: null;
  truncated: boolean;
  started: null;
  ended: null;
}

export type Part = ToolPart | BodyPart;

export interface Turn {
  id: string;
  model: string;
  provider: string | null;
  agent: string | null;
  created: number;
  completed: number | null;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  cost: number;
  durMs: number;
  finish: string | null;
  tools: number;
  errors: number;
  project: string;
  occupancy: number;
  contextWindow: number;
  fill: number;
  fillAfter: number;
  additions: number;
  deletions: number;
  writeLines: number;
  hasError: boolean;
  parts: Part[];
}

export interface PromptLine {
  id: string;
  created: number;
  text: string;
}

export interface Transcript {
  session: {
    id: string;
    parentId: string | null;
    project: string;
    title: string | null;
    agent: string | null;
    model: string | null;
    provider: string | null;
    created: number;
    updated: number;
    cost: number;
    firstPrompt: string | null;
  };
  turns: Turn[];
  /** The user's own messages, in order; they carry no tokens and no parts. */
  prompts: PromptLine[];
}

export interface SearchHit {
  id: string;
  title: string | null;
  project: string;
  updated: number;
  hits: number;
}

export interface Status {
  /** False when this source has never been materialized: every count below is zero. */
  ready: boolean;
  sourceDb: string | null;
  sourceSchema: string | null;
  sourceKind: string | null;
  unit: "usd" | "credit" | null;
  sourceMaxTime: number;
  materializedAt: number;
  mode: string | null;
  extent: { from: number; to: number };
  counts: { sessions: number; turns: number; tools: number; parts: number; events: number; models: number };
}

/* ------------------------------------------------------------------ *
 * Hooks. The store only changes when the server re-materializes, so the
 * panels poll slowly and keep the previous frame while a filter settles.
 * ------------------------------------------------------------------ */

const POLL_MS = 60_000;

export interface Facets0 {
  project: string | null;
  model: string | null;
  agent: string | null;
}

const facetKey = (f: Facets0): string => `${f.project ?? ""}|${f.model ?? ""}|${f.agent ?? ""}`;

/** Resolve a symbolic window plus the cross-filter into a concrete slice. */
export const sliceOf = (win: WindowSpec, f: Facets0, gran: Granularity | null = null, now = Date.now()): Slice => {
  const { from, to } = resolveWindow(win, now);
  return { from, to, ...f, gran };
};

export const useStatus = () =>
  useQuery({ queryKey: ["status"], queryFn: ({ signal }) => get<Status>("/api/status", signal), refetchInterval: 30_000 });

export const useFacets = () =>
  useQuery({ queryKey: ["facets"], queryFn: ({ signal }) => get<Facets>("/api/top/facets", signal), staleTime: POLL_MS });

/**
 * The window stays symbolic in the key, so a preset does not re-key the cache on
 * every tick; the request still resolves `now` when it fires.
 */
export const useAnalytics = (
  win: WindowSpec,
  f: Facets0,
  gran: Granularity | null = null
): UseQueryResult<Dashboard> =>
  useQuery({
    queryKey: ["analytics", windowKey(win), facetKey(f), gran ?? "auto"],
    queryFn: ({ signal }) =>
      get<Dashboard>(`/api/top/analytics?${sliceQuery(sliceOf(win, f, gran))}`, signal),
    placeholderData: keepPreviousData,
    staleTime: 20_000,
    refetchInterval: POLL_MS,
  });

export const useToolDetail = (
  win: WindowSpec,
  f: Facets0,
  name: string | null,
  gran: Granularity | null = null
) =>
  useQuery({
    queryKey: ["tool", name, windowKey(win), facetKey(f), gran ?? "auto"],
    queryFn: ({ signal }) =>
      get<ToolDetail>(`/api/top/tool?name=${encodeURIComponent(name!)}&${sliceQuery(sliceOf(win, f, gran))}`, signal),
    enabled: !!name,
    placeholderData: keepPreviousData,
    staleTime: 20_000,
  });

/**
 * The session grid, a page at a time.
 *
 * The dashboard carries a bounded sample of sessions; this endpoint is where the rest
 * live. `cursor` comes from the previous page, so appending is exact: the server sorts,
 * filters and slices, and the browser never holds the whole table.
 */
export const useSessionPages = (
  win: WindowSpec,
  f: Facets0,
  opts: { q: string; order: SessionOrder; dir: "asc" | "desc"; limit: number }
) =>
  useInfiniteQuery({
    queryKey: ["sessions", windowKey(win), facetKey(f), opts.q, opts.order, opts.dir, opts.limit],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(opts.limit), order: opts.order, dir: opts.dir });
      if (opts.q) params.set("q", opts.q);
      if (pageParam) params.set("cursor", pageParam);
      return get<SessionPage>(`/api/top/sessions?${sliceQuery(sliceOf(win, f))}&${params}`, signal);
    },
    getNextPageParam: (last) => last.next,
  });

/** One session plus its ancestors, siblings and children inside the window. */
export const useSessionContext = (win: WindowSpec, f: Facets0, id: string | null) =>
  useQuery({
    queryKey: ["session-context", id, windowKey(win), facetKey(f)],
    enabled: !!id,
    queryFn: ({ signal }) =>
      get<{ rows: SessionRow[] }>(
        `/api/top/sessions?focus=${encodeURIComponent(id!)}&${sliceQuery(sliceOf(win, f))}`,
        signal
      ),
  });

export const useTranscript = (id: string | null) =>
  useQuery({
    queryKey: ["transcript", id],
    queryFn: ({ signal }) => get<Transcript>(`/api/top/session/${id}/messages`, signal),
    enabled: !!id,
    staleTime: 300_000,
  });

export const useSearch = (q: string) =>
  useQuery({
    queryKey: ["search", q],
    queryFn: ({ signal }) => get<{ query: string; hits: SearchHit[] }>(`/api/top/search?q=${encodeURIComponent(q)}`, signal),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
  });

export async function refresh(full = false): Promise<{ ok: boolean; report?: unknown }> {
  const res = await fetch(`${BASE}/api/refresh`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ full }),
  });
  return (await res.json()) as { ok: boolean; report?: unknown };
}

/* ------------------------------------------------------------------ *
 * Windows
 * ------------------------------------------------------------------ */


