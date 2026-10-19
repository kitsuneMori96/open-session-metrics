import clsx from "clsx";
import type { FlatNode, Workflow } from "../lib/derive";
import { stamp, tok, usd, shortModel } from "../lib/format";

/**
 * The left column of the Sessions screen: one row per workflow, its sub-agent
 * sessions indented underneath once expanded. Columns follow the TUI's: label
 * flexes, then stamp / tokens / cost are right-aligned so they can be scanned down.
 */
export default function AgentTree({
  workflows,
  flatNodes,
  selectedId,
  expandedIds,
  onSelect,
  onToggle,
}: {
  workflows: Workflow[];
  flatNodes: FlatNode[];
  selectedId: string | null;
  expandedIds: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (workflowId: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-2 py-1">
        <span className="micro">Sessions</span>
        <span className="h-px flex-1 bg-rule" />
        <span className="tape text-ink-faint">{workflows.length} workflows</span>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto pb-2">
        {flatNodes.map((node) => {
          const selected = node.id === selectedId;
          const root = node.depth === 0;
          const expandable = root && node.hasChildren;
          const expanded = expandable && expandedIds.has(workflows[node.workflowIndex]?.id ?? "");
          const prefix = root ? (node.hasChildren ? (expanded ? "▾" : "▸") : "") : node.hasChildren ? "╰▸" : "╰─";
          const label = root
            ? node.session.title ?? node.session.project ?? "Untitled"
            : `[${node.session.agent ?? "?"}] ${node.session.title ?? shortModel(node.session.model)}`;

          return (
            <div
              key={node.id}
              className={clsx(
                "group flex h-[19px] items-center gap-1 pl-1 pr-2",
                selected ? "bg-ink text-paper" : "text-ink hover:bg-ink/[0.045]"
              )}
            >
              <button
                type="button"
                aria-label={expandable ? (expanded ? "collapse" : "expand") : undefined}
                onClick={() => expandable && onToggle(workflows[node.workflowIndex].id)}
                className={clsx(
                  "tape w-[18px] shrink-0 text-center",
                  expandable ? "cursor-pointer" : "cursor-default",
                  selected ? "text-paper" : root ? "text-ink-soft" : "text-ink-faint"
                )}
                style={{ paddingLeft: node.depth * 12 }}
              >
                {prefix}
              </button>
              <button
                type="button"
                onClick={() => onSelect(node.id)}
                className="flex min-w-0 flex-1 items-center gap-1 text-left"
              >
                <span
                  className={clsx(
                    "tape w-[9px] shrink-0",
                    selected ? "text-paper" : "text-ink-faint"
                  )}
                >
                  {selected ? "▶" : ""}
                </span>
                <span
                  className={clsx(
                    "tape flex-1 truncate",
                    selected ? "font-bold" : root ? "" : "text-ink-soft"
                  )}
                  title={label}
                >
                  {label}
                </span>
                <span className={clsx("tape w-[74px] shrink-0 text-right", selected ? "text-paper" : "text-ink-faint")}>
                  {stamp(node.session.updated || node.session.created)}
                </span>
                <span className={clsx("tape w-[52px] shrink-0 text-right", selected ? "text-paper" : "text-ink-soft")}>
                  {tok(node.session.tokens.total)}
                </span>
                <span
                  className={clsx(
                    "tape w-[62px] shrink-0 text-right",
                    selected ? "text-paper" : node.session.cost > 0 ? "text-good" : "text-ink-faint"
                  )}
                >
                  {usd(node.session.cost)}
                </span>
              </button>
            </div>
          );
        })}
        {flatNodes.length === 0 && <div className="tape px-3 py-2 text-ink-faint">No matching sessions</div>}
      </div>
    </div>
  );
}
