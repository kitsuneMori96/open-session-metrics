import { useQuery } from "@tanstack/react-query";

export const DAY = 86_400_000;

export interface FlowPoint {
  project: string;
  bucket: number;
  tokens: number;
  cost: number;
  sessions: number;
  dominant_model: string;
  peak_fill: number;
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
  additions: number;
  deletions: number;
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
  project: string;
  created: number;
  completed: number | null;
  dur_ms: number | null;
  model: string | null;
  provider: string | null;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  prompt_total: number;
  occupancy: number;
  context_window: number;
  fill: number;
  finish: string | null;
  has_error: number;
  tool_calls: number;
  tool_errors: number;
  additions: number;
  deletions: number;
  cost: number;
  text: string | null;
}
export interface ToolRow {
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
}
export interface EventRow {
  id: number;
  session_id: string;
  turn_id: string | null;
  type: "compaction" | "retry" | "failure" | "idle" | "switch" | "error";
  at: number;
  fill: number;
  detail: string | null;
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
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const rangeKey = (w: { from: number; to: number }) => `${w.from}|${w.to}`;

export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: () => get<any>("/api/status"), refetchInterval: 30000 });
}

/** Full extent of the recorded history — the scrubber's universe. */
export function useRange() {
  return useQuery({
    queryKey: ["range"],
    queryFn: () => get<{ from: number; to: number }>("/api/range"),
    staleTime: 60000,
  });
}

export function useOverview(w: TimeWindow) {
  return useQuery({
    queryKey: ["overview", rangeKey(w)],
    queryFn: () => get<any>(`/api/overview?${qs(w)}`),
  });
}

export function useEcg(w: TimeWindow) {
  return useQuery({
    queryKey: ["ecg", rangeKey(w)],
    queryFn: () =>
      get<{ step: number; projects: string[]; points: FlowPoint[] }>(`/api/ecg?${qs(w)}`),
  });
}

export function useSessions(w: TimeWindow, project?: string | null) {
  return useQuery({
    queryKey: ["sessions", rangeKey(w), project ?? null],
    queryFn: () =>
      get<SessionRow[]>(`/api/sessions?${qs(w)}${project ? `&project=${encodeURIComponent(project)}` : ""}`),
  });
}

export function useSession(id: string | null) {
  return useQuery({
    queryKey: ["session", id],
    queryFn: () =>
      get<{ session: SessionRow & Record<string, unknown>; turns: TurnRow[]; tools: ToolRow[]; events: EventRow[]; prompts: { id: string; session_id: string; created: number; text: string }[]; children: SessionRow[]; probe: { failureOverload: number } }>(
        `/api/session/${id}`
      ),
    enabled: !!id,
  });
}

export function useHeatmap(w: TimeWindow) {
  return useQuery({
    queryKey: ["heatmap", rangeKey(w)],
    queryFn: () =>
      get<{ days: number; cells: { dow: number; hour: number; tokens: number; cost: number; turns: number }[]; nightShare: number; peak: any; totalTokens: number }>(
        `/api/heatmap?${qs(w)}`
      ),
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
        series: { at: number; gap: number; session: string }[];
        flow: { bucket: number; tokens: number }[];
      }>(`/api/focus?${qs(w)}`),
  });
}

export function useConversion(w: TimeWindow) {
  return useQuery({
    queryKey: ["conversion", rangeKey(w)],
    queryFn: () =>
      get<{
        points: { session: string; project: string; title: string | null; cost: number; tokens: number; lines: number; ratio: number; expected_lines: number; eff_score: number; peak_fill: number; created: number }[];
        regression: { slope: number; intercept: number };
        linesPer10k: number;
        padded: any[];
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


export interface TimeWindow { from: number; to: number }
const qs = (w: TimeWindow) => `from=${w.from}&to=${w.to}`;
