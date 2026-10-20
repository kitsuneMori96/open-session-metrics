import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAnalytics, type SessionRow } from "../lib/api";
import { useSlice, useSliceHref } from "../lib/slice";
import { dur, int, pct, shortModel, stamp, tok, usd } from "../lib/format";
import { modelColor } from "../lib/format";
import { Caret, DataTable, type Column } from "../components/DataTable";
import { Chip, Num, Panel, RateBar, Spinner } from "../components/ui";
import { BaseHints, StatusBar } from "../components/Chrome";
import { StackRule } from "../components/charts/series";
import type { ExpandedState, SortingState, Updater } from "@tanstack/react-table";

/** A session plus its sub-agent sessions, which is what the grid expands into. */
type Node = SessionRow & { children: Node[] };

/**
 * Screen 2: every session in the slice, as a grid.
 *
 * opencode-top drew this as a keyboard-driven tree with a details panel bolted to the
 * right. Here it is one virtualized grid: columns sort, the tree expands in place, a
 * click opens a deep-linked session page, and the whole thing answers to the same
 * window and cross-filter as the dashboard.
 */
export default function Sessions() {
  const { window, facets, gran, slice, label } = useSlice();
  const { data, isLoading } = useAnalytics(window, facets, gran);
  const navigate = useNavigate();
  const href = useSliceHref();
  const [sorting, setSorting] = useState<SortingState>([{ id: "updated", desc: true }]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const sessions = data?.sessions ?? [];

  const tree = useMemo<Node[]>(() => {
    const byId = new Map<string, Node>();
    for (const s of sessions) byId.set(s.id, { ...s, children: [] });
    const roots: Node[] = [];
    for (const s of sessions) {
      const parent = s.parentId ? byId.get(s.parentId) : undefined;
      if (parent) parent.children.push(byId.get(s.id)!);
      else roots.push(byId.get(s.id)!);
    }
    return roots;
  }, [sessions]);

  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (s: SessionRow) =>
      !q ||
      (s.title ?? "").toLowerCase().includes(q) ||
      s.project.toLowerCase().includes(q) ||
      (s.model ?? "").toLowerCase().includes(q) ||
      (s.agent ?? "").toLowerCase().includes(q) ||
      (s.firstPrompt ?? "").toLowerCase().includes(q),
    [q]
  );

  /** Filtering a tree has to keep the ancestors of a match, or the row loses its home. */
  const filtered = useMemo<Node[]>(() => {
    if (!q) return tree;
    const keep = (node: Node): Node | null => {
      const kids = node.children.map(keep).filter((n): n is Node => !!n);
      if (matches(node) || kids.length) return { ...node, children: kids };
      return null;
    };
    return tree.map(keep).filter((n): n is Node => !!n);
  }, [tree, q, matches]);

  const hitCount = useMemo(() => {
    if (!q) return sessions.length;
    let n = 0;
    const walk = (nodes: Node[]) => {
      for (const node of nodes) {
        if (matches(node)) n++;
        walk(node.children);
      }
    };
    walk(filtered);
    return n;
  }, [filtered, matches, q, sessions.length]);

  const columns = useMemo<Column<Node>[]>(() => {
    const tokenSegments = (s: SessionRow) => [
      { value: s.output, color: "var(--chart-2)", label: "output" },
      { value: s.input, color: "var(--chart-1)", label: "input" },
      { value: s.cacheRead, color: "var(--chart-6)", label: "cache read" },
      { value: s.cacheWrite, color: "var(--chart-7)", label: "cache write" },
    ];
    return [
      {
        id: "title",
        header: "session",
        size: 400,
        accessorFn: (s) => s.title ?? s.firstPrompt ?? "",
        cell: ({ row }) => {
          const s = row.original;
          return (
            <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: row.depth * 14 }}>
              <Caret
                open={row.getIsExpanded()}
                hasChildren={row.getCanExpand()}
                onToggle={row.getToggleExpandedHandler()}
              />
              <span className="min-w-0 truncate" title={s.firstPrompt ?? s.id}>
                {s.title ?? <span className="text-ink-faint">(untitled)</span>}
              </span>
              {row.depth > 0 && <span className="tape shrink-0 text-ink-faint">sub-agent</span>}
              {s.childCount > 0 && !row.getIsExpanded() && (
                <span className="tape shrink-0 text-ink-faint">+{s.childCount}</span>
              )}
            </span>
          );
        },
      },
      {
        id: "project",
        header: "project",
        size: 132,
        accessorKey: "project",
        cell: ({ row }) => <span className="tape truncate text-ink-soft">{row.original.project}</span>,
      },
      {
        id: "agent",
        header: "agent",
        size: 74,
        accessorFn: (s) => s.agent ?? "main",
        cell: ({ row }) => <span className="tape text-ink-soft">{row.original.agent ?? "main"}</span>,
      },
      {
        id: "model",
        header: "model",
        size: 132,
        accessorKey: "model",
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1">
            <i className="block h-[7px] w-[7px] shrink-0" style={{ background: modelColor(row.original.model) }} />
            <span className="tape truncate" title={row.original.model ?? ""}>
              {shortModel(row.original.model)}
            </span>
          </span>
        ),
      },
      {
        id: "tokens",
        header: "tokens",
        size: 148,
        accessorKey: "tokens",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2">
            <StackRule segments={tokenSegments(row.original)} />
            {/* A fixed slot: `flex-1` would let the container shrink to the number's own
                width, which walks the rule left and right from row to row. */}
            <span className="tape tabular w-[44px] shrink-0 text-right">{tok(row.original.tokens)}</span>
          </span>
        ),
      },
      {
        id: "cost",
        header: "cost",
        size: 74,
        accessorKey: "cost",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className={`tape tabular ${row.original.cost > 0 ? "text-good" : "text-ink-faint"}`}>
            {row.original.cost > 0 ? usd(row.original.cost) : "free"}
          </span>
        ),
      },
      { id: "turns", header: "turns", size: 58, accessorKey: "turns", meta: { align: "right" }, cell: ({ row }) => <span className="tape tabular">{int(row.original.turns)}</span> },
      {
        id: "tools",
        header: "calls",
        size: 62,
        accessorKey: "tools",
        meta: { align: "right" },
        cell: ({ row }) => <span className="tape tabular">{int(row.original.tools)}</span>,
      },
      {
        id: "errors",
        header: "err",
        size: 48,
        accessorKey: "errors",
        meta: { align: "right" },
        cell: ({ row }) =>
          row.original.errors > 0 ? <span className="tape tabular text-danger">{row.original.errors}</span> : <span className="tape text-ink-faint">—</span>,
      },
      {
        id: "span",
        header: "span",
        size: 74,
        accessorKey: "spanMs",
        meta: { align: "right" },
        cell: ({ row }) => <span className="tape tabular text-ink-soft">{dur(row.original.spanMs)}</span>,
      },
      {
        id: "ctx",
        header: "ctx",
        size: 86,
        accessorKey: "contextPct",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="flex items-center justify-end gap-2" title="context tokens over the model window">
            <RateBar rate={row.original.contextPct} tone="var(--color-flow)" />
            <span className="tape tabular w-[28px] text-right text-ink-faint">{pct(Math.min(1, row.original.contextPct), 0)}</span>
          </span>
        ),
      },
      {
        id: "updated",
        header: "updated",
        size: 92,
        accessorKey: "updated",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="tape tabular text-ink-faint" title={stamp(row.original.updated)}>
            {stamp(row.original.updated)}
          </span>
        ),
      },
    ];
  }, []);

  if (isLoading || !data) return <Spinner label="reading the store" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="hairline-b flex shrink-0 flex-wrap items-center gap-2 px-2 py-1">
        <span className="micro shrink-0">sessions</span>
        <input
          ref={filterRef}
          className="field w-[240px]"
          placeholder="filter title / project / model…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query && (
          <Chip onClick={() => setQuery("")} title="clear the filter">
            ✕
          </Chip>
        )}
        <span className="tape shrink-0 text-ink-faint">
          {int(hitCount)} matching of {int(sessions.length)} in slice
        </span>
        <span className="shrink-0 text-rule-strong">│</span>
        <Chip onClick={() => setExpanded(allExpanded(filtered))}>expand all</Chip>
        <Chip onClick={() => setExpanded({})}>collapse</Chip>
        <span className="flex-1" />
        <span className="tape shrink-0 text-ink-faint">window {label}</span>
      </div>

      <Panel title={undefined} bodyClass="flex min-h-0 flex-1 flex-col p-0" className="min-h-0 flex-1 border-0">
        <DataTable<Node>
          rows={filtered}
          columns={columns}
          getRowId={(n) => n.id}
          getSubRows={(n) => n.children}
          sorting={sorting}
          onSortingChange={(u: Updater<SortingState>) => setSorting((prev) => (typeof u === "function" ? u(prev) : u))}
          expanded={expanded}
          onExpandedChange={(u: Updater<ExpandedState>) => setExpanded((prev) => (typeof u === "function" ? u(prev) : u))}
          onRowClick={(n) => navigate(href(`/sessions/${n.id}`))}
          onRowHover={(n) => setHover(n?.id ?? null)}
          activeId={hover}
          empty="no session in this slice matches"
        />
      </Panel>

      <StatusBar
        hints={
          <>
            <BaseHints /> · click a header to sort · ▸ expands the sub-agents
          </>
        }
        info={
          <>
            {int(sessions.length)} sessions · {tok(sessions.reduce((a, s) => a + s.tokens, 0))} tokens ·{" "}
            {usd(sessions.reduce((a, s) => a + s.cost, 0))}
          </>
        }
      />
    </div>
  );
}

const allExpanded = (nodes: Node[]): ExpandedState => {
  const out: Record<string, boolean> = {};
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (n.children.length) {
        out[n.id] = true;
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
};

