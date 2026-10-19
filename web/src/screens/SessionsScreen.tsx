import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useSearch, useSessions, useTranscript } from "../lib/api";
import { flattenWorkflow, groupWorkflows } from "../lib/derive";
import { stamp } from "../lib/format";
import { useDebounced, useKeys } from "../lib/useKeys";
import AgentTree from "../components/AgentTree";
import DetailsPanel from "../components/DetailsPanel";
import MessagesPanel from "../components/MessagesPanel";
import StatusBar from "../components/StatusBar";
import { Empty } from "../components/ui";

type RightMode = "stats" | "messages";

/**
 * Screen 1. Left: every workflow, expandable to its sub-agent sessions, with a search
 * box. Right: either the STATS block or the transcript, switched with Tab — the same
 * two modes the TUI toggles.
 */
export default function SessionsScreen({ active }: { active: boolean }) {
  const { data, isLoading } = useSessions();
  const sessions = useMemo(() => data?.sessions ?? [], [data]);
  const workflows = useMemo(() => groupWorkflows(sessions), [sessions]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [rightMode, setRightMode] = useState<RightMode>("stats");
  const [chainCollapsed, setChainCollapsed] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [hitPos, setHitPos] = useState(-1);

  const searching = query.trim().length > 0;
  const inputRef = useRef<HTMLInputElement>(null);

  // While searching every workflow is expanded, so a match is never hidden inside a
  // collapsed root.
  const effectiveExpanded = useMemo(
    () => (searching ? new Set(workflows.map((w) => w.id)) : expandedIds),
    [searching, expandedIds, workflows]
  );

  const allFlatNodes = useMemo(
    () => workflows.flatMap((w, i) => flattenWorkflow(w, i, searching || expandedIds.has(w.id))),
    [workflows, expandedIds, searching]
  );

  const flatNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allFlatNodes;
    return allFlatNodes.filter((n) => {
      const s = n.session;
      return (
        (s.title ?? "").toLowerCase().includes(q) ||
        s.project.toLowerCase().includes(q) ||
        (s.agent ?? "").toLowerCase().includes(q) ||
        (s.firstPrompt ?? "").toLowerCase().includes(q)
      );
    });
  }, [allFlatNodes, query]);

  const deep = useSearch(useDebounced(query.trim()));

  const selectedIndex = Math.max(0, flatNodes.findIndex((n) => n.id === selectedId));
  const selectedNode = flatNodes[selectedIndex] ?? null;

  // Default to the most recently active workflow once the list arrives.
  useEffect(() => {
    if (!selectedNode && flatNodes.length > 0) setSelectedId(flatNodes[0].id);
  }, [flatNodes, selectedNode]);

  const selectedWorkflow = useMemo(() => {
    if (!selectedNode) return null;
    const w = workflows[selectedNode.workflowIndex];
    if (!w) return null;
    // Selecting a sub-agent re-roots the panel on it, as the TUI does.
    if (selectedNode.session.id !== w.mainSession.id) {
      return {
        id: selectedNode.session.id,
        mainSession: selectedNode.session,
        subAgentSessions: selectedNode.node.children.map((c) => c.session),
        agentTree: selectedNode.node,
      };
    }
    return w;
  }, [selectedNode, workflows]);

  const workflowId = selectedWorkflow?.id ?? null;
  useEffect(() => {
    setChainCollapsed(null);
  }, [workflowId]);

  const transcript = useTranscript(rightMode === "messages" ? selectedNode?.session.id ?? null : null);

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
    },
    []
  );

  const toggleWorkflow = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const hits = deep.data?.hits ?? [];

  const cycleHit = useCallback(
    (delta: number) => {
      if (hits.length === 0) return;
      const next = hitPos < 0 ? (delta > 0 ? 0 : hits.length - 1) : (hitPos + delta + hits.length) % hits.length;
      setHitPos(next);
      setRightMode("messages");
      select(hits[next].id);
    },
    [hits, hitPos, select]
  );

  useKeys(
    (e) => {
      if (e.key === "/" && !searchOpen) {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
        return;
      }
      if (e.key === "Escape" && searching) {
        setQuery("");
        setHitPos(-1);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setRightMode((m) => (m === "stats" ? "messages" : "stats"));
        return;
      }
      if (e.key === "n") return cycleHit(1);
      if (e.key === "N") return cycleHit(-1);
      if (e.key === "c") {
        setChainCollapsed((prev) => (prev === null ? !((selectedWorkflow?.subAgentSessions.length ?? 0) > 5) : !prev));
        return;
      }
      if (rightMode !== "stats") {
        if (e.key === "[") return move(-1);
        if (e.key === "]") return move(1);
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") return move(1);
      if (e.key === "k" || e.key === "ArrowUp") return move(-1);
      if (e.key === "g") return select(flatNodes[0]?.id ?? "");
      if (e.key === "G") return select(flatNodes[flatNodes.length - 1]?.id ?? "");
      if (e.key === "Enter" && selectedNode?.depth === 0 && selectedNode.hasChildren) {
        return toggleWorkflow(workflows[selectedNode.workflowIndex].id);
      }
      return;
    },
    active
  );

  function move(delta: number) {
    const target = Math.max(0, Math.min(flatNodes.length - 1, selectedIndex + delta));
    const node = flatNodes[target];
    if (node) select(node.id);
  }

  if (isLoading && sessions.length === 0) return <Empty>Loading sessions…</Empty>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="hairline-r flex min-h-0 w-[36%] min-w-[330px] max-w-[560px] flex-col">
        <div className="hairline-b flex h-[26px] shrink-0 items-center gap-1 px-2">
          <span className={clsx("tape shrink-0", searchOpen ? "text-flow" : searching ? "text-warning" : "text-ink-faint")}>
            /
          </span>
          {searchOpen ? (
            <input
              ref={inputRef}
              autoFocus
              value={query}
              placeholder="search titles and prompts"
              onChange={(e) => {
                setQuery(e.target.value);
                setHitPos(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setSearchOpen(false);
                  setRightMode("messages");
                }
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  setQuery("");
                }
              }}
              className="tape min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint"
            />
          ) : searching ? (
            <span className="tape min-w-0 flex-1 truncate text-warning">
              /{query}
              <span className="text-ink-faint"> · {flatNodes.length} sessions</span>
              {hits.length > 0 && (
                <span className="text-good">
                  {" "}
                  · {hitPos >= 0 ? `${hitPos + 1}/` : ""}
                  {hits.length} content hits
                </span>
              )}
            </span>
          ) : (
            <span className="tape flex-1 text-ink-faint">Sessions ({allFlatNodes.length}) · /:search</span>
          )}
        </div>

        {searching && hits.length > 0 && (
          <div className="no-scrollbar hairline-b max-h-[126px] shrink-0 overflow-y-auto">
            {hits.slice(0, 8).map((h, i) => (
              <button
                key={h.id}
                type="button"
                onClick={() => {
                  setHitPos(i);
                  setRightMode("messages");
                  select(h.id);
                }}
                className={clsx(
                  "tape flex w-full items-baseline gap-2 px-2 py-[2px] text-left",
                  i === hitPos ? "bg-ink text-paper" : "text-ink-soft hover:bg-ink/[0.045]"
                )}
              >
                <span className="min-w-0 flex-1 truncate">{h.title ?? h.id}</span>
                <span className={clsx("shrink-0", i === hitPos ? "text-paper" : "text-ink-faint")}>
                  {h.hits} hits
                </span>
                <span className={clsx("shrink-0", i === hitPos ? "text-paper" : "text-ink-faint")}>
                  {stamp(h.updated)}
                </span>
              </button>
            ))}
          </div>
        )}

        <AgentTree
          workflows={workflows}
          flatNodes={flatNodes}
          selectedId={selectedNode?.id ?? null}
          expandedIds={effectiveExpanded}
          onSelect={select}
          onToggle={toggleWorkflow}
        />
      </aside>

      <section className="flex min-h-0 flex-1 flex-col">
        <div className="hairline-b flex h-[26px] shrink-0 items-center gap-1 px-2">
          {(["stats", "messages"] as RightMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setRightMode(m)}
              className={clsx(
                "tape px-2 py-[2px] capitalize",
                rightMode === m ? "bg-ink font-bold text-paper" : "text-ink-faint hover:bg-ink/5"
              )}
            >
              {m}
            </button>
          ))}
          <span className="flex-1" />
          <span className="tape text-ink-faint">Tab:switch</span>
        </div>

        {rightMode === "stats" ? (
          <DetailsPanel
            workflow={selectedWorkflow}
            chainCollapsed={chainCollapsed}
            onToggleChain={() =>
              setChainCollapsed((prev) => (prev === null ? !((selectedWorkflow?.subAgentSessions.length ?? 0) > 5) : !prev))
            }
          />
        ) : (
          <MessagesPanel
            transcript={transcript.data}
            isLoading={transcript.isLoading}
            searchQuery={query}
            active={active}
          />
        )}
        </section>
      </div>

      <StatusBar
        hints={
          searchOpen
            ? "type to filter · Enter:confirm · Esc:clear"
            : rightMode === "messages"
              ? `j/k:scroll  d/u:half  g/G:top/bot  Enter:fold  f:filter${query ? "  n/N:next hit" : ""}  [/]:prev/next session  Tab:stats`
              : `j/k:nav  Enter:expand  c:chain  g/G:top/bot  /:search${query ? "  n/N:next hit" : ""}  Tab:messages  2:tools  3:overview`
        }
      />
    </div>
  );
}
