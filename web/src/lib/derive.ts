import type { Part, ToolPart, TopSession, Turn } from "./api";
import { clockSec, durInline } from "./format";

/* ------------------------------------------------------------------ *
 * Workflows: a root session plus every session spawned under it.
 * Ported from opencode-top's `groupSessionsToWorkflows` so the tree, the
 * "N workflows" counter and the AGENT CHAIN read identically.
 * ------------------------------------------------------------------ */

export interface AgentNode {
  session: TopSession;
  children: AgentNode[];
  depth: number;
}

export interface Workflow {
  id: string;
  mainSession: TopSession;
  subAgentSessions: TopSession[];
  agentTree: AgentNode;
}

export interface FlatNode {
  id: string;
  session: TopSession;
  workflowIndex: number;
  depth: number;
  hasChildren: boolean;
  node: AgentNode;
}

const ts0 = (s: TopSession): number => s.updated || s.created || 0;

function buildAgentNode(session: TopSession, children: Map<string, TopSession[]>, depth: number): AgentNode {
  const kids = (children.get(session.id) ?? [])
    .map((s) => buildAgentNode(s, children, depth + 1))
    .sort((a, b) => ts0(b.session) - ts0(a.session));
  return { session, children: kids, depth };
}

function collectDescendants(node: AgentNode): TopSession[] {
  return node.children.flatMap((c) => [c.session, ...collectDescendants(c)]);
}

export function groupWorkflows(sessions: TopSession[]): Workflow[] {
  const children = new Map<string, TopSession[]>();
  const known = new Set(sessions.map((s) => s.id));
  for (const s of sessions) {
    if (!s.parentId) continue;
    const list = children.get(s.parentId) ?? [];
    list.push(s);
    children.set(s.parentId, list);
  }
  // A session whose parent is missing from the snapshot still has to appear, so it
  // is treated as a root rather than dropped.
  const roots = sessions.filter((s) => !s.parentId || !known.has(s.parentId));
  const workflows = roots.map((root) => {
    const agentTree = buildAgentNode(root, children, 0);
    return { id: root.id, mainSession: root, subAgentSessions: collectDescendants(agentTree), agentTree };
  });
  const latest = (w: Workflow) => Math.max(ts0(w.mainSession), ...w.subAgentSessions.map(ts0), 0);
  return workflows.sort((a, b) => latest(b) - latest(a));
}

/** Depth-first flattening; a collapsed workflow shows only its root row. */
export function flattenWorkflow(workflow: Workflow, workflowIndex: number, expandChildren: boolean): FlatNode[] {
  const nodes: FlatNode[] = [];
  const walk = (node: AgentNode) => {
    nodes.push({
      id: node.session.id,
      session: node.session,
      workflowIndex,
      depth: node.depth,
      hasChildren: node.children.length > 0,
      node,
    });
    if (node.depth === 0 && !expandChildren) return;
    for (const child of node.children) walk(child);
  };
  walk(workflow.agentTree);
  return nodes;
}

/* ------------------------------------------------------------------ *
 * Transcript lines: ported from opencode-top's `buildLines`.
 * ------------------------------------------------------------------ */

export type MsgLine =
  | {
      id: string;
      kind: "header";
      modelId: string;
      agent: string | null;
      duration: string;
      time: string;
      tokensIn: number;
      tokensOut: number;
      cumTokens: number;
    }
  | {
      id: string;
      kind: "tool";
      callId: string;
      icon: string;
      status: string;
      name: string;
      title: string;
      right: string;
      expanded: boolean;
      rawInput: string;
      rawOutput: string;
      cumTokens: number;
      truncated: boolean;
    }
  | { id: string; kind: "tool-detail"; label: string; value: string; isSection: boolean; cumTokens: number }
  | { id: string; kind: "text"; text: string; cumTokens: number }
  | {
      id: string;
      kind: "reasoning-header";
      reasoningId: string;
      preview: string;
      charCount: number;
      expanded: boolean;
      cumTokens: number;
    }
  | { id: string; kind: "reasoning"; text: string; cumTokens: number };

/** Number of output rows the panel shows before it stops (the TUI's 40-line cap). */
export const OUT_ROWS = 40;

export const toolKey = (turnId: string, p: ToolPart): string => p.callId || `${turnId}:${p.ordinal}`;

function parseInput(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { value: raw };
  }
}

/** One row per argument; long strings collapse to their first line, like the TUI. */
export function formatParamValue(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "string") return val.split("\n")[0];
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

export function buildLines(
  turns: Turn[],
  expandedTools: Set<string>,
  expandedReasoning: Set<string>
): MsgLine[] {
  const lines: MsgLine[] = [];
  let cumTokens = 0;

  for (const turn of turns) {
    cumTokens += turn.tokens.input + turn.tokens.cacheRead + turn.tokens.output;
    const duration = turn.completed && turn.created ? durInline(turn.completed - turn.created) : "";

    lines.push({
      id: `h-${turn.id}`,
      kind: "header",
      modelId: turn.model,
      agent: turn.agent,
      duration,
      time: clockSec(turn.created),
      tokensIn: turn.tokens.input + turn.tokens.cacheRead,
      tokensOut: turn.tokens.output,
      cumTokens,
    });

    for (const part of turn.parts as Part[]) {
      if (part.kind === "tool") {
        const key = toolKey(turn.id, part);
        const expanded = expandedTools.has(key);
        const icon = part.status === "completed" ? "✓" : part.status === "error" ? "✗" : "◌";
        const exit = part.exitCode !== null && part.exitCode !== 0 ? `exit:${part.exitCode} ` : "";
        const ran = part.ended && part.started ? durInline(part.ended - part.started) : "";
        const input = parseInput(part.input);
        lines.push({
          id: `t-${key}`,
          kind: "tool",
          callId: key,
          icon,
          status: part.status,
          name: part.name,
          title: part.title ?? "",
          right: exit + ran,
          expanded,
          rawInput: JSON.stringify(input),
          rawOutput: part.output ?? "",
          cumTokens,
          truncated: part.truncated,
        });

        if (expanded) {
          const keys = Object.keys(input);
          if (keys.length > 0) {
            lines.push({ id: `td-${key}-in`, kind: "tool-detail", label: "input", value: "", isSection: true, cumTokens });
            for (const k of keys) {
              lines.push({
                id: `td-${key}-in-${k}`,
                kind: "tool-detail",
                label: k,
                value: formatParamValue(input[k]),
                isSection: false,
                cumTokens,
              });
            }
          }
          const out = (part.output ?? "").trim();
          if (out) {
            lines.push({ id: `td-${key}-out`, kind: "tool-detail", label: "output", value: "", isSection: true, cumTokens });
            out
              .split("\n")
              .slice(0, OUT_ROWS)
              .forEach((row, i) => {
                lines.push({ id: `td-${key}-out-${i}`, kind: "tool-detail", label: "", value: row, isSection: false, cumTokens });
              });
          }
        }
      } else if (part.kind === "text" && part.text.trim()) {
        lines.push({ id: `tx-${turn.id}`, kind: "text", text: part.text.trim(), cumTokens });
      } else if (part.kind === "reasoning" && part.text.trim()) {
        const trimmed = part.text.trim();
        const reasoningId = `r-${turn.id}`;
        lines.push({
          id: `rh-${turn.id}`,
          kind: "reasoning-header",
          reasoningId,
          preview: trimmed.slice(0, 90),
          charCount: trimmed.length,
          expanded: expandedReasoning.has(reasoningId),
          cumTokens,
        });
        if (expandedReasoning.has(reasoningId)) {
          lines.push({ id: `r-${turn.id}`, kind: "reasoning", text: trimmed, cumTokens });
        }
      }
    }
  }
  return lines;
}

export function lineMatchesQuery(line: MsgLine, q: string): boolean {
  switch (line.kind) {
    case "text":
      return line.text.toLowerCase().includes(q);
    case "tool":
      return (
        line.name.toLowerCase().includes(q) ||
        line.title.toLowerCase().includes(q) ||
        line.rawInput.toLowerCase().includes(q) ||
        line.rawOutput.toLowerCase().includes(q)
      );
    case "tool-detail":
      return line.label.toLowerCase().includes(q) || line.value.toLowerCase().includes(q);
    case "reasoning-header":
      return line.preview.toLowerCase().includes(q);
    case "reasoning":
      return line.text.toLowerCase().includes(q);
    default:
      return false;
  }
}

export type LineFilter = "all" | "errors" | "tools" | "text";

export function filterLines(lines: MsgLine[], filter: LineFilter): MsgLine[] {
  if (filter === "all") return lines;
  return lines.filter((line) => {
    if (line.kind === "header") return true;
    if (filter === "errors") return line.kind === "tool" && line.status === "error";
    if (filter === "tools") return line.kind === "tool" || line.kind === "tool-detail";
    return line.kind === "text";
  });
}

export const NEXT_FILTER: Record<LineFilter, LineFilter> = {
  all: "errors",
  errors: "tools",
  tools: "text",
  text: "all",
};
