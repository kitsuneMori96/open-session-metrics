import type { AgentNode } from "../lib/derive";
import { tok, usd3 } from "../lib/format";

interface ChainRow {
  node: AgentNode;
  isLast: boolean;
  prefix: string;
}

function flattenChain(node: AgentNode, prefix: string, out: ChainRow[]) {
  node.children.forEach((child, i) => {
    const last = i === node.children.length - 1;
    out.push({ node: child, isLast: last, prefix });
    flattenChain(child, prefix + (last ? "   " : "│  "), out);
  });
}

function Row({ node, isLast, prefix }: ChainRow) {
  const { session } = node;
  return (
    <div className="flex items-baseline gap-2 py-px">
      <span className="tape min-w-0 flex-1 truncate" title={session.title ?? session.id}>
        <span className="text-ink-faint">
          {prefix}
          {isLast ? "└─ " : "├─ "}
        </span>
        <span className="text-flow">[{session.agent ?? "main"}]</span>{" "}
        <span className="text-ink">{session.title ?? session.id.slice(0, 12)}</span>
      </span>
      <span className="tape w-[46px] shrink-0 text-right text-ink-faint">{tok(session.tokens.total)}</span>
      <span className="tape w-[54px] shrink-0 text-right text-good">{usd3(session.cost)}</span>
    </div>
  );
}

/**
 * The AGENT CHAIN block: which sub-agents the selected session spawned, and what each
 * cost. The root row is the session itself; children hang off it with box-drawing
 * prefixes, exactly as the TUI draws them.
 */
export default function AgentChainGraph({ agentTree, maxRows }: { agentTree: AgentNode; maxRows?: number }) {
  const { session } = agentTree;
  if (agentTree.children.length === 0) return null;

  const all: ChainRow[] = [];
  flattenChain(agentTree, "", all);
  const rows = maxRows === undefined ? all : all.slice(0, maxRows);

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-2 py-px">
        <span className="tape min-w-0 flex-1 truncate" title={session.title ?? session.id}>
          <span className="font-bold text-flow">[{session.agent ?? "main"}]</span>{" "}
          <span className="text-ink">{session.title ?? "root"}</span>
        </span>
        <span className="tape w-[46px] shrink-0 text-right text-ink-faint">{tok(session.tokens.total)}</span>
        <span className="tape w-[54px] shrink-0 text-right text-good">{usd3(session.cost)}</span>
      </div>
      {rows.map((row) => (
        <Row key={row.node.session.id} {...row} />
      ))}
      {all.length > rows.length && <div className="tape text-ink-faint">… +{all.length - rows.length} more</div>}
    </div>
  );
}
