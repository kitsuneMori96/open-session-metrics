import { useQuery } from "@tanstack/react-query";

const BASE = (import.meta.env.VITE_OSM_API as string | undefined) ?? "http://127.0.0.1:8787";
const DAY = 86_400_000;

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface Status {
  sourceDb: string | null;
  sourceSchema: string | null;
  sourceMaxTime: number;
  materializedAt: number;
  mode: string | null;
  extent: { from: number; to: number };
  counts: { sessions: number; turns: number; tools: number; parts: number; events: number; models: number };
}

export interface TokenBuckets {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ModelUsage {
  id: string;
  calls: number;
  tokens: number;
  cost?: number;
}

export interface ToolUsage {
  name: string;
  calls: number;
  successes: number;
  failures: number;
  avgMs: number;
  recentErrors?: string[];
}

/** One row of the sessions list — everything the tree and the STATS panel need. */
export interface TopSession {
  id: string;
  parentId: string | null;
  project: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  provider: string | null;
  created: number;
  updated: number;
  tokens: TokenBuckets;
  cost: number;
  calls: number;
  durationMs: number;
  outputRate: number;
  contextUsage: number;
  contextWindow: number;
  contextPct: number;
  peakFill: number;
  avgFill: number;
  firstPrompt: string | null;
  models: ModelUsage[];
  tools: ToolUsage[];
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
  parts: Part[];
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
}

export interface GlobalTool {
  name: string;
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  avgDurationMs: number;
  recentErrors: string[];
}

export interface TrendSeries {
  labels: string[];
  values: number[];
  mode: "hour" | "day" | "week";
  spanText: string;
}

export interface Overview {
  generatedAt: number;
  range: { from: number; to: number; project: string | null };
  projects: string[];
  activity: { roots: { shown: number; total: number } };
  totals: TokenBuckets & { cost: number };
  models: ModelUsage[];
  projectsBreakdown: { project: string; sessions: number; cost: number }[];
  agentErrors: { agent: string; calls: number; errors: number }[];
  tools: { name: string; calls: number; errors: number; totalDurationMs: number }[];
  tokenTrend: TrendSeries;
  sessionTrend: TrendSeries;
  hourly: number[];
}

export interface SearchHit {
  id: string;
  title: string | null;
  project: string;
  updated: number;
  hits: number;
}

/** Time filters, in the order the Overview screen cycles them with `t`. */
export const RANGES = [
  { id: "today", label: "today" },
  { id: "7d", label: "last 7d" },
  { id: "30d", label: "last 30d" },
  { id: "90d", label: "last 90d" },
  { id: "all", label: "all time" },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

/** Cutoff anchored to local midnight, so day buckets line up with the calendar. */
export function cutoffOf(range: RangeId, now = Date.now()): number {
  const midnight = (ts: number) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  if (range === "today") return midnight(now);
  const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 0;
  return days > 0 ? midnight(now - days * DAY) : 0;
}

const POLL_MS = 15_000;

export const useStatus = () =>
  useQuery({ queryKey: ["status"], queryFn: ({ signal }) => get<Status>("/api/status", signal), refetchInterval: POLL_MS });

export const useSessions = () =>
  useQuery({
    queryKey: ["top", "sessions"],
    queryFn: ({ signal }) => get<{ generatedAt: number; sessions: TopSession[] }>("/api/top/sessions", signal),
    refetchInterval: POLL_MS,
  });

export const useTools = () =>
  useQuery({
    queryKey: ["top", "tools"],
    queryFn: ({ signal }) => get<{ tools: GlobalTool[] }>("/api/top/tools", signal),
    refetchInterval: POLL_MS,
  });

export const useOverview = (range: RangeId, project: string | null) => {
  const from = cutoffOf(range);
  return useQuery({
    queryKey: ["top", "overview", range, project],
    queryFn: ({ signal }) =>
      get<Overview>(`/api/top/overview?from=${from}${project ? `&project=${encodeURIComponent(project)}` : ""}`, signal),
    refetchInterval: POLL_MS,
  });
};

export const useTranscript = (id: string | null) =>
  useQuery({
    queryKey: ["top", "messages", id],
    queryFn: ({ signal }) => get<Transcript>(`/api/top/session/${id}/messages`, signal),
    enabled: !!id,
    staleTime: 60_000,
  });

export const useSearch = (q: string) =>
  useQuery({
    queryKey: ["top", "search", q],
    queryFn: ({ signal }) => get<{ query: string; hits: SearchHit[] }>(`/api/top/search?q=${encodeURIComponent(q)}`, signal),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });

export async function refresh(full = false): Promise<{ ok: boolean; report?: unknown }> {
  const res = await fetch(`${BASE}/api/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ full }),
  });
  return (await res.json()) as { ok: boolean; report?: unknown };
}
