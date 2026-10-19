import { useMemo, useState } from "react";
import clsx from "clsx";
import { RANGES, useOverview, type RangeId } from "../lib/api";
import { modelColor, shortModel, tok, usd3, usd4 } from "../lib/format";
import { useKeys } from "../lib/useKeys";
import BarChart from "../components/BarChart";
import StatusBar from "../components/StatusBar";
import { Empty, SectionHeader, SegBar, SplitBar, StatRow } from "../components/ui";

const HOUR_LABELS = Array.from({ length: 24 }, (_, i) =>
  i % 6 === 0 || i === 23 ? String(i).padStart(2, "0") : ""
);

/**
 * Screen 3. Aggregate spend and activity over a time range, with a project filter:
 * totals, spend and session trends, the 24-hour activity profile, tool error rates by
 * agent, and the leaderboards (tools by call count, projects, slowest tools, models).
 */
export default function OverviewScreen({ active }: { active: boolean }) {
  const [range, setRange] = useState<RangeId>("today");
  const [project, setProject] = useState<string | null>(null);
  const { data, isLoading } = useOverview(range, project);

  const projects = useMemo(() => data?.projects ?? [], [data]);

  useKeys(
    (e) => {
      if (e.key === "t") {
        setRange((r) => RANGES[(RANGES.findIndex((x) => x.id === r) + 1) % RANGES.length].id);
        return;
      }
      if (e.key === "p" || e.key === "P") {
        const idx = project === null ? -1 : projects.indexOf(project);
        const next = e.key === "p" ? idx + 1 : idx - 1;
        if (next < -1) setProject(projects[projects.length - 1] ?? null);
        else if (next >= projects.length) setProject(null);
        else setProject(next === -1 ? null : projects[next]);
        return;
      }
      return;
    },
    active
  );

  if (isLoading && !data) return <Empty>Loading overview…</Empty>;
  if (!data) return <Empty>No data</Empty>;

  const { totals, tokenTrend, sessionTrend, hourly } = data;
  const maxTokens = Math.max(...tokenTrend.values, 1);
  const maxSessions = Math.max(...sessionTrend.values, 1);
  const topModels = [...data.models].sort((a, b) => b.calls - a.calls).slice(0, 4);
  const topProjects = [...data.projectsBreakdown].sort((a, b) => b.sessions - a.sessions).slice(0, 4);
  const agentErrors = [...data.agentErrors].sort((a, b) => b.calls - a.calls);
  const topTools = [...data.tools].sort((a, b) => b.calls - a.calls).slice(0, 8);
  const maxToolCalls = topTools[0]?.calls ?? 1;
  const slowest = data.tools
    .filter((t) => t.calls > 0 && t.totalDurationMs > 0)
    .map((t) => ({ name: t.name, avg: t.totalDurationMs / t.calls }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);
  const maxAvg = slowest[0]?.avg ?? 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="hairline-b flex h-[26px] shrink-0 items-center gap-2 px-2">
        <span className="tape font-bold tracking-[0.1em]">◆ OVERVIEW</span>
        <span className="flex-1" />
        <span className="tape text-ink-faint">
          {data.activity.roots.shown}/{data.activity.roots.total} workflows
        </span>
        <span className="tape text-ink-faint">{tok(totals.total)} tokens</span>
      </div>

      <div className="hairline-b flex shrink-0 items-center gap-2 px-2 py-1">
        <span className="tape shrink-0 text-ink-faint">filter:</span>
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setRange(r.id)}
            className={clsx(
              "tape shrink-0 border px-1.5 py-[2px]",
              range === r.id ? "border-ink bg-ink font-bold text-paper" : "border-rule text-ink-soft hover:border-rule-strong"
            )}
          >
            {r.label}
          </button>
        ))}
        <span className="shrink-0 text-ink-faint">·</span>
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => setProject(null)}
            className={clsx(
              "tape shrink-0 border px-1.5 py-[2px]",
              project === null ? "border-flow bg-flow/10 font-bold text-flow" : "border-rule text-ink-soft hover:border-rule-strong"
            )}
          >
            all projects
          </button>
          {projects.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setProject(p)}
              className={clsx(
                "tape shrink-0 border px-1.5 py-[2px]",
                project === p ? "border-flow bg-flow/10 font-bold text-flow" : "border-rule text-ink-soft hover:border-rule-strong"
              )}
            >
              {p}
            </button>
          ))}
        </div>
        <span className="tape shrink-0 text-ink-faint">t/p</span>
      </div>

      <div className="no-scrollbar grid min-h-0 flex-1 grid-cols-[minmax(240px,32%)_minmax(210px,26%)_minmax(230px,1fr)] gap-6 overflow-y-auto px-3 py-1">
        {/* ── totals and trends ─────────────────────────────────── */}
        <div className="min-w-0 max-w-[420px]">
          <SectionHeader title="totals" />
          <StatRow label="Total tokens" value={tok(totals.total)} />
          <StatRow label="input" value={tok(totals.input)} tone="flow" />
          <StatRow label="output" value={tok(totals.output)} tone="good" />
          <StatRow label="reasoning" value={tok(totals.reasoning)} tone="faint" />
          <StatRow label="cache r/w" value={`${tok(totals.cacheRead)} / ${tok(totals.cacheWrite)}`} tone="faint" />
          <StatRow label="Total cost" value={usd4(totals.cost)} tone="good" />

          {range !== "all" && (
            <>
              <SectionHeader title={`token trend (${tokenTrend.spanText} · peak ${tok(maxTokens)})`} />
              <BarChart values={tokenTrend.values} labels={tokenTrend.labels} color="var(--color-flow)" height={52} />
              <SectionHeader
                title={`sessions (${sessionTrend.spanText} · peak ${maxSessions}${sessionTrend.mode === "hour" ? "/h" : "/day"})`}
              />
              <BarChart
                values={sessionTrend.values}
                labels={sessionTrend.labels}
                color="var(--color-ink)"
                height={38}
              />
            </>
          )}

          <SectionHeader title="hourly activity" />
          <BarChart values={hourly} labels={HOUR_LABELS} color="var(--color-good)" height={38} />
        </div>

        {/* ── tool health ───────────────────────────────────────── */}
        <div className="min-w-0 max-w-[400px]">
          <SectionHeader title="tool errors by agent" />
          {agentErrors.length === 0 && <div className="tape text-ink-faint">No tool data</div>}
          {agentErrors.map((a) => (
            <div key={a.agent} className="flex items-baseline gap-2 py-px">
              <span className="tape w-[70px] shrink-0 truncate" title={a.agent}>
                {a.agent}
              </span>
              <SplitBar ok={a.calls - a.errors} total={a.calls} cells={14} />
              <span className="tape shrink-0 text-ink-soft">{a.calls}</span>
              {a.errors > 0 && (
                <span className="tape shrink-0 text-danger">
                  ✗{a.errors} ({Math.round((a.errors / a.calls) * 100)}%)
                </span>
              )}
            </div>
          ))}

          <SectionHeader title="top tools (calls / errors)" />
          {topTools.length === 0 && <div className="tape text-ink-faint">No tool data</div>}
          {topTools.map((t) => {
            const cells = Math.max(1, Math.round(Math.sqrt(t.calls / maxToolCalls) * 12));
            return (
              <div key={t.name} className="flex items-baseline gap-2 py-px">
                <span className="tape w-[78px] shrink-0 truncate" title={t.name}>
                  {t.name}
                </span>
                <SegBar filled={cells} total={12} tone={t.errors > 0 ? "var(--color-warning)" : "var(--color-ink)"} />
                <span className="tape shrink-0 text-ink-soft">{t.calls}</span>
                {t.errors > 0 && <span className="tape shrink-0 text-danger">✗{t.errors}</span>}
              </div>
            );
          })}
        </div>

        {/* ── leaderboards ──────────────────────────────────────── */}
        <div className="min-w-0 max-w-[520px]">
          <SectionHeader title="projects" />
          {topProjects.length === 0 && <div className="tape text-ink-faint">No project data</div>}
          {topProjects.map((p) => (
            <div key={p.project} className="flex items-baseline gap-2 py-px">
              <span className="tape w-[200px] shrink-0 truncate" title={p.project}>
                {p.project}
              </span>
              <span className="tape shrink-0 text-flow">{p.sessions} sess</span>
              <span className="tape w-[60px] shrink-0 text-right text-good">{usd3(p.cost)}</span>
            </div>
          ))}

          <SectionHeader title="tool avg duration (top 5)" />
          {slowest.map((t) => (
            <div key={t.name} className="flex items-baseline gap-2 py-px">
              <span className="tape w-[90px] shrink-0 truncate" title={t.name}>
                {t.name}
              </span>
              <SegBar
                filled={Math.max(1, Math.round((t.avg / maxAvg) * 10))}
                total={10}
                tone="var(--color-warning)"
              />
              <span className="tape shrink-0 text-ink-faint">
                {t.avg < 1000 ? `${t.avg.toFixed(0)}ms` : `${(t.avg / 1000).toFixed(1)}s`}
              </span>
            </div>
          ))}

          <SectionHeader title="models" />
          {topModels.length === 0 && <div className="tape text-ink-faint">No model data</div>}
          {topModels.map((m) => (
            <div key={m.id} className="flex items-baseline gap-2 py-px">
              <i className="mt-[5px] h-[6px] w-[6px] shrink-0" style={{ background: modelColor(m.id) }} />
              <span className="tape w-[170px] shrink-0 truncate" title={m.id}>
                {shortModel(m.id)}
              </span>
              <span className="tape shrink-0 text-flow">{m.calls}</span>
              <span className="tape w-[56px] shrink-0 text-right text-ink-faint">{tok(m.tokens)}</span>
            </div>
          ))}
        </div>
      </div>

      <StatusBar
        hints="1:sessions  2:tools  t:time-filter  p/P:project  r:refresh"
        info={`${data.activity.roots.shown}/${data.activity.roots.total} workflows`}
      />
    </div>
  );
}
