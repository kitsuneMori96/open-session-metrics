import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const DAY = 86_400_000;

/** `/api/ecg` point. `tokens` is generated volume only — cache is reported apart (§1.4). */
export interface FlowPoint {
  project: string;
  bucket: number;
  tokens: number;
  cache: number;
  cost: number;
  sessions: number;
  peak: number;
  model: string;
}
export interface SessionRow {
  id: string;
  project: string;
  title: string | null;
  created: number;
  updated: number;
  duration_ms: number | null;
  cost: number;
  turns: number;
  tool_calls: number;
  tool_errors: number;
  compactions: number;
  retries: number;
  loops: number;
  additions: number;
  deletions: number;
  files_changed?: number;
  peak_fill: number;
  avg_fill: number;
  eff_score: number;
  dominant_model: string;
  first_prompt: string | null;
  parent_id: string | null;
  depth: number;
}
export interface TurnRow {
  id: string;
  session_id: string;
  seq: number;
  created: number;
  completed: number | null;
  dur_ms: number | null;
  role: string;
  model: string | null;
  provider: string | null;
  agent: string | null;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  prompt_total: number;
  occupancy: number;
  context_window: number;
  /** Context occupancy at send time: prompt_total / context_window. */
  fill: number;
  fill_after: number;
  finish: string | null;
  has_error: number;
  tool_calls: number;
  tool_errors: number;
  additions: number;
  deletions: number;
  cost: number;
  /** Only present with `?include=text`. */
  text?: string | null;
}
export interface ToolRow {
  session_id: string;
  turn_id: string;
  call_id: string;
  name: string;
  status: string;
  started: number | null;
  ended: number | null;
  dur_ms: number | null;
  title: string | null;
  output_chars: number;
  additions: number;
  deletions: number;
  files: number;
  error: string | null;
  input_preview?: string | null;
  target_session?: string | null;
}
export interface EventDetail {
  reason?: string;
  summary?: string;
  before?: number;
  after?: number;
  delta?: number;
  model?: string;
  sourceTokens?: number;
  tool?: string;
  title?: string;
  error?: string;
  sig?: string;
  repeats?: number;
  span_ms?: number;
  first_failed?: boolean;
}
export interface EventRow {
  id: number;
  session_id: string;
  turn_id: string | null;
  type: "compaction" | "retry" | "loop" | "failure" | "idle" | "switch" | "error";
  at: number;
  end_at: number | null;
  count: number;
  fill: number;
  /** JSON text; parse with `detailOf`. */
  detail: string | null;
}
export interface MarkerRow extends Omit<EventRow, "id" | "turn_id"> {
  project: string;
}
export interface ModelRow {
  id: string;
  provider: string;
  label: string;
  context: number;
  cost_input: number;
  cost_output: number;
  cost_cache_read: number;
  cost_cache_write: number;
  source?: string;
  overridden?: boolean;
}
export interface SessionPayload {
  session: SessionRow & Record<string, unknown>;
  subtree: string[];
  forks: { turn_id: string; started: number; target_session: string; title: string | null; status: string }[];
  turns: TurnRow[];
  tools: ToolRow[];
  events: EventRow[];
  prompts: { id: string; session_id: string; created: number; text: string }[];
  children: SessionRow[];
  probe: {
    failuresOver80: number;
    compactions: number;
    retries: number;
    loops: number;
    peakFill: number;
    avgFill: number;
    effScore: number;
    tokensPerLine: number;
    diffLines: number;
    tokens: number;
  };
}
export interface SandboxResult {
  range: { from: number; to: number };
  current: number;
  projected: number;
  delta: number;
  deltaPct: number;
  byModel: {
    key: string;
    label: string;
    tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
    current: number;
    projected: number;
    delta: number;
    price: { input: number; output: number; cacheRead: number; cacheWrite: number };
    target: string | null;
    pricedFrom: string;
  }[];
}

export function detailOf(e: { detail: string | null }): EventDetail | null {
  if (!e.detail) return null;
  try {
    return typeof e.detail === "string" ? (JSON.parse(e.detail) as EventDetail) : (e.detail as EventDetail);
  } catch {
    return null;
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const rangeKey = (w: { from: number; to: number }) => `${w.from}|${w.to}`;

/** Also carries `extent` — the full recorded history the scrubber can pan across. */
export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => get<{ counts: Record<string, number>; materializedAt: number; sourceSchema: string; mode: string; extent: { from: number; to: number } }>("/api/status"),
    refetchInterval: 30000,
  });
}

export function useOverview(w: TimeWindow) {
  return useQuery({
    queryKey: ["overview", rangeKey(w)],
    queryFn: () =>
      get<{
        totals: {
          input: number;
          output: number;
          reasoning: number;
          cache_read: number;
          cache_write: number;
          cost: number;
          flowCost: number;
          generated: number;
          turns: number;
          tool_errors: number;
          additions: number;
          deletions: number;
          sessions: number;
        };
        coverage: { total: number; with_diff: number; with_cost: number };
      }>(`/api/overview?${qs(w)}`),
  });
}

export function useEcg(w: TimeWindow) {
  return useQuery({
    queryKey: ["ecg", rangeKey(w)],
    queryFn: () => get<{ step: number; projects: string[]; points: FlowPoint[] }>(`/api/ecg?${qs(w)}`),
  });
}

/** Operation-level ECG point: a single spike on the waveform. */
export interface EcgOp {
  at: number;
  /** Duration in ms — the spike's width on screen. */
  d: number;
  out: number;
  r?: number;
  fill?: number;
  sid: string;
  project: string;
  /** tool rows */
  name?: string;
  status?: string;
  add?: number;
  del?: number;
  /** turn rows */
  model?: string;
  err?: number;
}
export interface EcgSpan {
  child: string;
  from: number;
  to: number;
  parent: string;
  project: string;
}

export function useEcgOps(w: TimeWindow, project?: string | null) {
  return useQuery({
    queryKey: ["ecg-ops", rangeKey(w), project ?? null],
    queryFn: () =>
      get<{ tools: EcgOp[]; turns: EcgOp[]; spans: EcgSpan[]; truncated: boolean }>(
        `/api/ecg/ops?${qs(w)}${project ? `&project=${encodeURIComponent(project)}` : ""}`
      ),
    // the waveform is the stage's main visual — keep it fresh but not chatty
    staleTime: 60000,
  });
}

/** One local day of one project, from `/api/ecg/daily`. `add`/`del` are incremental
 * edit lines; `write` is full-file line count — two units that are never summed. */
export interface DailyCell {
  day: number;
  add: number;
  del: number;
  write: number;
  gen: number;
  cache: number;
  cost: number;
  turns: number;
  sessions: number;
  tools: number;
  errors: number;
  peak: number;
  compactions: number;
  retries: number;
  loops: number;
}
export interface DailyTotals {
  add: number; del: number; write: number; gen: number; cache: number; cost: number;
  turns: number; sessions: number; tools: number; errors: number;
  compactions: number; retries: number; loops: number; activeDays: number;
}
export interface DailyLane {
  project: string;
  days: DailyCell[];
  totals: DailyTotals;
  /** last day with any activity — the recency key the lane order uses */
  lastDay: number;
  recent: number;
}

/** Daily/hourly roll-up feeding the wide-window stage (one row per project × bucket). */
export function useEcgDaily(w: TimeWindow, bucket: "day" | "hour" = "day") {
  return useQuery({
    queryKey: ["ecg-daily", rangeKey(w), bucket],
    queryFn: () => get<{ from: number; to: number; bucketMs: number; lanes: DailyLane[] }>(`/api/ecg/daily?${qs(w)}&bucket=${bucket}`),
    staleTime: 60000,
  });
}

/** ECG marker layer: compaction arrows, retry/loop bars, failure crosses. */
export function useMarkers(w: TimeWindow, types = "compaction,retry,loop,failure") {
  return useQuery({
    queryKey: ["markers", rangeKey(w), types],
    queryFn: () => get<MarkerRow[]>(`/api/events?${qs(w)}&type=${types}`),
  });
}

export function useSessions(w: TimeWindow, project?: string | null) {
  return useQuery({
    queryKey: ["sessions", rangeKey(w), project ?? null],
    queryFn: () =>
      get<SessionRow[]>(`/api/sessions?${qs(w)}${project ? `&project=${encodeURIComponent(project)}` : ""}`),
  });
}

export function useSession(id: string | null, includeText = false) {
  return useQuery({
    queryKey: ["session", id, includeText ? "text" : "lean"],
    queryFn: () =>
      get<SessionPayload>(`/api/session/${id}${includeText ? "?include=text" : ""}`),
    enabled: !!id,
  });
}

export function useHeatmap(w: TimeWindow) {
  return useQuery({
    queryKey: ["heatmap", rangeKey(w)],
    queryFn: () =>
      get<{
        days: number;
        fromDay: number;
        cells: { dow: number; hour: number; gen: number; cache: number; cost: number; turns: number }[];
        spectrogram: { day: number; hour: number; gen: number; cache: number; cost: number; turns: number }[];
        totalTokens: number;
        totalCacheRead: number;
        nightShare: number;
        peak: { dow: number; hour: number; gen: number } | null;
        topHour: number;
        insight: string | null;
      }>(`/api/heatmap?${qs(w)}`),
  });
}

export function useFocus(w: TimeWindow) {
  return useQuery({
    queryKey: ["focus", rangeKey(w)],
    queryFn: () =>
      get<{
        count: number;
        p50: number;
        p90: number;
        p99: number;
        max: number;
        deepFocusShare: number;
        interruptionShare: number;
        histogram: { seconds: number; count: number }[];
        series: { at: number; gap: number; session: string; tool: string }[];
        flow: { bucket: number; tokens: number }[];
      }>(`/api/focus?${qs(w)}`),
  });
}

export interface ConversionPoint {
  session: string;
  project: string;
  title: string | null;
  cost: number;
  created: number;
  dominant_model: string;
  tokens: number;
  lines: number;
  files_changed: number;
  eff_score: number;
  peak_fill: number;
  turns: number;
  expected_lines: number | null;
  ratio: number | null;
}

export function useConversion(w: TimeWindow) {
  return useQuery({
    queryKey: ["conversion", rangeKey(w)],
    queryFn: () =>
      get<{
        points: ConversionPoint[];
        /** null when fewer than 3 sessions have diff data — the line is meaningless then. */
        regression: { slope: number; intercept: number } | null;
        linesPer10k: number;
        padded: ConversionPoint[];
        coverage: { total: number; withDiff: number };
      }>(`/api/conversion?${qs(w)}`),
  });
}

export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => get<{ models: ModelRow[]; usage: any[] }>("/api/models"),
    staleTime: 5 * 60000,
  });
}

/** Re-run the incremental materialisation after editing prices. */
export function useRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (full: boolean) =>
      fetch("/api/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full }),
      }).then((r) => {
        if (!r.ok) throw new Error(`/api/refresh → HTTP ${r.status}`);
        return r.json() as Promise<{ ok: boolean; full: boolean; report: unknown }>;
      }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

/** What-if pricing runs server-side so it uses the same price table as history. */
export function useSandbox() {
  return useMutation({
    mutationFn: (body: {
      from: number;
      to: number;
      swaps?: { from: string; to: string }[];
      cacheReadGain?: number;
    }) =>
      fetch("/api/sandbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => {
        if (!r.ok) throw new Error(`/api/sandbox → HTTP ${r.status}`);
        return r.json() as Promise<SandboxResult>;
      }),
  });
}

export interface TimeWindow {
  from: number;
  to: number;
}
const qs = (w: TimeWindow) => `from=${w.from}&to=${w.to}`;
