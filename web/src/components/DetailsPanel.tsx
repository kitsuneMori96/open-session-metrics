import type { Workflow } from "../lib/derive";
import { modelColor, durPanel, pctInt, shortModel, tok, usd, usd4 } from "../lib/format";
import AgentChainGraph from "./AgentChainGraph";
import { FillBar, SectionHeader, StatRow } from "./ui";

/** The TUI folds the chain once a session spawned more than this many sub-agents. */
export const CHAIN_COLLAPSE_THRESHOLD = 5;
/** …and never draws more than this many rows at once. */
export const CHAIN_MAX_ROWS = 15;

/**
 * The right panel of the Sessions screen in "Stats" mode: what the selected session
 * asked of its provider, which models served it, which tools it leaned on, and what it
 * spawned. Every number here is the TUI's own number.
 */
export default function DetailsPanel({
  workflow,
  chainCollapsed,
  onToggleChain,
}: {
  workflow: Workflow | null;
  chainCollapsed: boolean | null;
  onToggleChain: () => void;
}) {
  if (!workflow) {
    return <div className="tape px-3 py-2 text-ink-faint">Select a session</div>;
  }
  const session = workflow.mainSession;
  const chainCount = workflow.subAgentSessions.length;
  const chainTokens = workflow.subAgentSessions.reduce((a, s) => a + s.tokens.total, 0);
  const collapsed = chainCollapsed ?? chainCount > CHAIN_COLLAPSE_THRESHOLD;
  const models = session.models.slice(0, 3);
  const tools = session.tools.slice(0, 3);

  return (
    <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2">
      <div className="flex max-w-[420px] flex-col">
        <span className="tape truncate font-bold" title={session.title ?? undefined}>
          {session.title ?? "Untitled"}
        </span>
        <span className="tape truncate text-ink-faint" title={session.project}>
          ◎ {session.project}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-x-10 lg:grid-cols-[minmax(280px,420px)_minmax(300px,560px)]">
        <div>
          <SectionHeader title="stats" />
          <StatRow label="Tokens" value={tok(session.tokens.total)} />
          <StatRow label="Cost" value={usd4(session.cost)} tone="good" />
          <StatRow label="Duration" value={durPanel(session.durationMs)} />
          <StatRow label="Rate" value={`${session.outputRate.toFixed(0)} tok/s`} />
          <StatRow label="Calls" value={String(session.calls)} />

          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="tape shrink-0 text-ink-soft">context</span>
            <span
              className="tape truncate text-ink-faint"
              title="cumulative input + cache traffic against one model window"
            >
              {tok(session.contextUsage)} / {tok(session.contextWindow)} ·{" "}
              {session.contextPct <= 1 ? pctInt(session.contextPct) : `×${Math.round(session.contextPct)}`}
            </span>
          </div>
          <div className="mt-1" title="context traffic over one model window (input + cache)">
            <FillBar
              value={session.contextPct}
              tone={session.contextPct > 0.8 ? "var(--color-warning)" : "var(--color-flow)"}
            />
          </div>

          <SectionHeader title="models" />
          {models.length === 0 && <div className="tape text-ink-faint">—</div>}
          {models.map((m) => (
            <div key={m.id} className="flex items-baseline gap-2 py-px">
              <i className="mt-[5px] h-[6px] w-[6px] shrink-0" style={{ background: modelColor(m.id) }} />
              <span className="tape w-[168px] shrink-0 truncate" title={m.id}>
                {shortModel(m.id)}
              </span>
              <span className="tape w-[38px] shrink-0 text-right text-ink-faint">{m.calls}×</span>
              <span className="tape w-[50px] shrink-0 text-right text-flow">{tok(m.tokens)}</span>
            </div>
          ))}

          {tools.length > 0 && (
            <>
              <SectionHeader title="tools" />
              {tools.map((t) => (
                <div key={t.name} className="flex items-baseline gap-2 py-px">
                  <span className="tape w-[168px] shrink-0 truncate" title={t.name}>
                    {t.name}
                  </span>
                  <span className={`tape w-[54px] shrink-0 text-right ${t.failures > 0 ? "text-warning" : "text-good"}`}>
                    {t.successes}/{t.calls}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>

        {chainCount > 0 && (
          <div className="min-w-0">
            <SectionHeader
              title={`agent chain (${chainCount})`}
              right={
                <button type="button" onClick={onToggleChain} className="tape text-ink-soft hover:text-ink">
                  {collapsed ? "▶ c" : "▾ c"}
                </button>
              }
            />
            {collapsed ? (
              <div className="tape text-ink-faint">
                {chainCount} agents · {tok(chainTokens)} — c:expand
              </div>
            ) : (
              <AgentChainGraph agentTree={workflow.agentTree} maxRows={CHAIN_MAX_ROWS} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
