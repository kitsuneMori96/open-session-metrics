import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { DEFAULT_PRESET, useAnalytics, type SessionRow } from "../lib/api";
import { TOKEN_CLASSES, paletteFor } from "../lib/chart";
import { dur, int, pct, pctInt, rate, shortModel, tok, usd, usdPerM } from "../lib/format";
import { useSlice } from "../lib/slice";
import { SessionScatter } from "../components/charts/scatter";
import { TimeArea, Sparkline } from "../components/charts/series";
import { ActivityHeatmap, HourStrip } from "../components/charts/heat";
import { RankBars, TimeBars, DeltaBar } from "../components/charts/ranks";
import { Legend } from "../components/charts/base";
import { Chip, Panel, SectionHeader, Spinner, Stat, Tile, toneColor } from "../components/ui";
import { BaseHints, StatusBar } from "../components/Chrome";

/**
 * Screen 1, rebuilt for a browser.
 *
 * The TUI's Overview drew a fixed stack of block-glyph charts, one screen at a time.
 * Here the same measurements share one pane, one window and one cross-filter, and the
 * two things a terminal could not do are the point: the charts have real axes you can
 * brush to re-window the whole page, and every bar is a filter — clicking a project or
 * a model narrows everything, including the other screens.
 */
export default function Overview() {
  const { window, facets, slice, label, setWindow, setPreset, setFacet } = useSlice();
  const { data, isLoading, isFetching } = useAnalytics(window, facets);
  const [, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [split, setSplit] = useState<"class" | "model" | "cost">("class");
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [hoverSession, setHoverSession] = useState<string | null>(null);

  const params = useSearchParams()[0];
  const scatterX = params.get("sx") ?? "tokens";
  const scatterY = params.get("sy") ?? "cost";

  const series = data?.series;
  const keys = useMemo(() => {
    if (!series) return [];
    if (split === "class") return TOKEN_CLASSES.map((c) => ({ key: c.key, label: c.label, color: c.color }));
    if (split === "cost") return [{ key: "cost", label: "cost", color: "var(--color-good)" }];
    const colors = paletteFor(series.models);
    return series.models.map((m) => ({ key: `m:${m}`, label: shortModel(m), color: colors.get(m)! }));
  }, [series, split]);

  /** The model stack arrives as index-aligned rows rather than named keys. */
  const buckets = useMemo(() => {
    if (!series) return [];
    if (split !== "model") return series.buckets;
    return series.buckets.map((b, i) => {
      const row: Record<string, number> = {};
      for (const [k, v] of Object.entries(b)) if (typeof v === "number") row[k] = v;
      series.models.forEach((m, k) => {
        row[`m:${m}`] = series.modelTokens[k]?.[i] ?? 0;
      });
      return row;
    }) as unknown as typeof series.buckets;
  }, [series, split]);

  if (isLoading || !data) return <Spinner label="reading the store" />;

  const { totals, kpis, efficiency, tools, projects, models, agents, sessions } = data;
  const toolPeak = Math.max(1, ...tools.map((t) => t.calls));
  const projectPeak = Math.max(1, ...projects.map((p) => p.tokens));
  const seriesTokens = series?.buckets.map((b) => b.total) ?? [];
  const seriesCost = series?.buckets.map((b) => b.cost) ?? [];
  const seriesTurns = series?.buckets.map((b) => b.turns) ?? [];
  const seriesErrors = series?.buckets.map((b) => b.errors) ?? [];
  const seriesSessions = series?.buckets.map((b) => b.sessions) ?? [];
  const hasBaseline = slice.from > 0;

  const openSession = (id: string) => navigate(`/sessions/${id}?${params.toString()}`);
  const apiRate = totals.tools > 0 ? totals.errors / totals.tools : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {/* ── the readout strip ───────────────────────────────────── */}
        <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-2 sm:grid-cols-3 xl:grid-cols-6">
          <Tile
            label="tokens billed"
            value={tok(totals.total)}
            delta={kpis.tokens.delta}
            prev={tok(kpis.tokens.prev)}
            tone="flow"
            spark={<Sparkline values={seriesTokens} color="var(--color-flow)" />}
            note={hasBaseline ? "change against the previous window of equal length" : "all time — no earlier window to compare"}
          />
          <Tile
            label="spend"
            value={usd(totals.cost)}
            delta={kpis.cost.delta}
            prev={usd(kpis.cost.prev)}
            tone="good"
            spark={<Sparkline values={seriesCost} color="var(--color-good)" />}
          />
          <Tile
            label="assistant turns"
            value={int(totals.turns)}
            delta={kpis.turns.delta}
            prev={int(kpis.turns.prev)}
            spark={<Sparkline values={seriesTurns} color="var(--color-ink)" />}
          />
          <Tile
            label="tool calls"
            value={int(totals.tools)}
            delta={kpis.tools.delta}
            prev={int(kpis.tools.prev)}
            spark={<Sparkline values={tools.map((t) => t.calls)} color="var(--color-ink-soft)" />}
            onClick={() => navigate("/tools")}
            note="open the tools screen"
          />
          <Tile
            label="tool errors"
            value={int(totals.errors)}
            delta={kpis.errors.delta}
            prev={int(kpis.errors.prev)}
            tone={totals.errors > 0 ? "danger" : "faint"}
            spark={<Sparkline values={seriesErrors} color="var(--color-danger)" />}
          />
          <Tile
            label="sessions"
            value={int(totals.sessions)}
            delta={kpis.sessions.delta}
            prev={int(kpis.sessions.prev)}
            spark={<Sparkline values={seriesSessions} color="var(--color-ink)" />}
            note="sessions with at least one assistant turn in this window"
          />
        </div>

        {/* ── the series ──────────────────────────────────────────── */}
        <div className="mt-4">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="tape text-ink-faint">stack by</span>
            {(
              [
                ["class", "token class"],
                ["model", "model"],
                ["cost", "cost"],
              ] as const
            ).map(([id, text]) => (
              <Chip key={id} active={split === id} onClick={() => setSplit(id)}>
                {text}
              </Chip>
            ))}
            <span className="flex-1" />
            <Legend
              items={keys}
              active={new Set(keys.map((k) => k.key).filter((k) => !muted.has(k)))}
              onToggle={(k) =>
                setMuted((prev) => {
                  const next = new Set(prev);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  return next;
                })
              }
            />
          </div>
          <TimeArea
            buckets={buckets}
            keys={keys}
            gran={series?.gran ?? "day"}
            active={new Set(keys.map((k) => k.key).filter((k) => !muted.has(k)))}
            format={split === "cost" ? (v) => usd(v) : tok}
            onWindow={setWindow}
            windowLabel={window.kind === "custom" ? label : undefined}
            onClearWindow={() => setPreset(DEFAULT_PRESET)}
            height={196}
            tipExtra={(b) => [
              { label: "cost", value: usd(b.cost) },
              { label: "additions", value: `+${int(b.additions)}` },
              { label: "deletions", value: `−${int(b.deletions)}` },
            ]}
          />
          <div className="micro mt-1">
            drag across the series to set the window for the whole page · {series?.buckets.length ?? 0} buckets ·{" "}
            {hasBaseline ? "baseline: previous window" : "baseline: none (all time)"}
          </div>
        </div>

        {/* ── sessions: the plane a table cannot show ─────────────── */}
        <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <SessionScatter
            sessions={sessions}
            url={params}
            xKey={scatterX}
            yKey={scatterY}
            onAxes={(x, y) =>
              setParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set("sx", x);
                next.set("sy", y);
                return next;
              }, { replace: true })
            }
            onPick={openSession}
            highlightId={hoverSession}
            onHighlight={setHoverSession}
          />
          <div className="flex flex-col gap-4">
            <ActivityHeatmap heat={series?.heat ?? emptyHeat()} />
            <div>
              <div className="mb-1 flex items-baseline gap-2">
                <span className="micro shrink-0">turn volume, by hour</span>
                <span className="h-px min-w-2 flex-1 bg-rule" />
                <span className="tape shrink-0 text-ink-faint">peak {int(Math.max(...(series?.hourly ?? [0])))}</span>
              </div>
              <HourStrip hourly={series?.hourly ?? []} />
            </div>
          </div>
        </div>

        {/* ── breakdowns ──────────────────────────────────────────── */}
        <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-4 lg:grid-cols-2 xl:grid-cols-3">
          <Panel title="projects" right={<span className="tape text-ink-faint">by tokens</span>}>
            <RankBars
              rows={projects.slice(0, 10).map((p) => ({
                key: p.project,
                label: p.project,
                value: p.tokens,
                sub: `${p.sessions} sessions · ${int(p.turns)} turns · ${usd(p.cost)}`,
                right: `${tok(p.tokens)} · ${usd3ceil(p.cost)}`,
                active: facets.project === p.project,
                color: facets.project === p.project ? "var(--color-flow)" : undefined,
                onClick: () => setFacet("project", facets.project === p.project ? null : p.project),
              }))}
              max={projectPeak}
              empty="no project activity in this window"
            />
            <div className="micro mt-1">click a project to filter every screen</div>
          </Panel>

          <Panel title="models" right={<span className="tape text-ink-faint">$/Mtok</span>}>
            <RankBars
              rows={models.slice(0, 10).map((m) => ({
                key: m.id,
                label: shortModel(m.id),
                value: m.tokens,
                right: `${tok(m.tokens)} · ${usdPerM(m.cost, m.tokens)}`,
                sub: `${int(m.calls)} turns · ${m.sessions} sessions · ${usd(m.cost)}`,
                active: facets.model === m.id,
                onClick: () => setFacet("model", facets.model === m.id ? null : m.id),
              }))}
              max={Math.max(1, ...models.map((m) => m.tokens))}
              empty="no model usage in this window"
            />
          </Panel>

          <Panel title="tools" right={<span className="tape text-ink-faint">calls · p95</span>}>
            <RankBars
              rows={tools.slice(0, 10).map((t) => ({
                key: t.name,
                label: t.name,
                value: t.calls,
                right: `${int(t.calls)} · ${dur(t.p95Ms)}`,
                sub: `${int(t.calls)} calls · ${t.errors} errors · median ${dur(t.p50Ms)} · p95 ${dur(t.p95Ms)}`,
                color: t.errors > 0 ? "var(--color-warning)" : undefined,
                onClick: () => navigate(`/tools/${encodeURIComponent(t.name)}?${params.toString()}`),
              }))}
              max={toolPeak}
              empty="no tool calls in this window"
            />
            <div className="micro mt-1">click a tool for its latency distribution and error signatures</div>
          </Panel>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-4 lg:grid-cols-2 xl:grid-cols-3">
          <Panel title="agents">
            <RankBars
              rows={agents.map((a) => ({
                key: a.agent,
                label: a.agent,
                value: a.tokens,
                right: `${tok(a.tokens)}`,
                sub: `${int(a.turns)} turns · ${int(a.tools)} calls · ${a.errors} errors`,
                active: facets.agent === a.agent,
                onClick: () => setFacet("agent", facets.agent === a.agent ? null : a.agent),
              }))}
              empty="no agent activity in this window"
            />
            <div className="mt-2">
              <SectionHeader title="failure rate" />
              {agents.map((a) => {
                const r = a.tools > 0 ? a.errors / a.tools : 0;
                return (
                  <div key={a.agent} className="flex items-baseline gap-2 py-px">
                    <span className="tape w-[64px] shrink-0 truncate">{a.agent}</span>
                    <DeltaBar delta={r} />
                    <span className="tape tabular shrink-0 text-ink-soft">{pct(r)}</span>
                    <span className="tape shrink-0 text-ink-faint">
                      {a.errors}/{int(a.tools)}
                    </span>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel title="efficiency" right={<span className="tape text-ink-faint">same slice</span>}>
            <Stat
              label="cache hit"
              value={pctInt(efficiency.cacheHit)}
              tone="flow"
              title="share of context tokens that came from the prompt cache"
            />
            <Stat label="output rate" value={rate(efficiency.outputRate)} tone="good" title="median over turns that produced output" />
            <Stat label="turn p50 / p90" value={`${dur(efficiency.turnMs.p50)} / ${dur(efficiency.turnMs.p90)}`} />
            <Stat label="turn p99" value={dur(efficiency.turnMs.p99)} tone="faint" />
            <Stat
              label="context fill"
              value={`${pctInt(efficiency.fill.p50)} / ${pctInt(efficiency.fill.p90)} · max ${pctInt(efficiency.fill.max)}`}
              title="per-turn occupancy of the model window; a sawtooth here is compaction"
            />
            <Stat label="turns ended early" value={int(efficiency.stopped)} tone={efficiency.stopped > 0 ? "warning" : "faint"} />
            <Stat label="tool failure rate" value={pct(apiRate)} tone={apiRate > 0.02 ? "warning" : "faint"} />
            <SectionHeader title="code written" />
            <Stat label="lines added" value={`+${int(totals.additions)}`} tone="good" />
            <Stat label="lines removed" value={`−${int(totals.deletions)}`} tone="danger" />
            <Stat label="net" value={`${totals.additions - totals.deletions >= 0 ? "+" : "−"}${int(Math.abs(totals.additions - totals.deletions))}`} />
          </Panel>

          <Panel title="rhythm">
            {series && series.gran !== "hour" && (
              <>
                <TimeBars
                  label="sessions per day"
                  values={series.buckets.map((b) => ({ ts: b.ts, value: b.sessions }))}
                  gran={series.gran}
                  color="var(--color-ink)"
                  height={86}
                  format={(v) => int(v)}
                />
                <div className="mt-2" />
              </>
            )}
            <TimeBars
              label="turns per bucket"
              values={series?.buckets.map((b) => ({ ts: b.ts, value: b.turns })) ?? []}
              gran={series?.gran ?? "day"}
              color="var(--color-flow)"
              height={86}
              format={(v) => int(v)}
              note={`${int(totals.turns)} assistant turns over ${series?.buckets.length ?? 0} buckets`}
            />
          </Panel>
        </div>

        {/* ── the biggest sessions in this slice ──────────────────── */}
        <Panel
          title="heaviest sessions"
          className="mt-4"
          right={<span className="tape text-ink-faint">by tokens · hover to locate in the plot</span>}
        >
          <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
            {[...sessions]
              .sort((a, b) => b.tokens - a.tokens)
              .slice(0, 12)
              .map((s: SessionRow) => (
                <button
                  key={s.id}
                  type="button"
                  onMouseEnter={() => setHoverSession(s.id)}
                  onMouseLeave={() => setHoverSession(null)}
                  onClick={() => openSession(s.id)}
                  className="flex w-full items-baseline gap-2 border-b border-rule/60 py-[3px] text-left hover:bg-ink/5"
                >
                  <span className="tape min-w-0 flex-1 truncate">{s.title ?? s.firstPrompt ?? s.id}</span>
                  <span className="tape shrink-0 text-ink-faint">{s.project}</span>
                  <span className="tape tabular shrink-0" style={{ color: toneColor("flow") }}>
                    {tok(s.tokens)}
                  </span>
                  <span className="tape tabular shrink-0 text-good">{usd(s.cost)}</span>
                  <span className="tape tabular shrink-0 text-ink-faint">{int(s.turns)}t</span>
                  {s.errors > 0 && <span className="tape shrink-0 text-danger">✗{s.errors}</span>}
                </button>
              ))}
          </div>
        </Panel>
      </div>

      <StatusBar
        hints={
          <>
            <BaseHints /> · drag the series to re-window · click any bar to cross-filter
          </>
        }
        info={
          <>
            window {label} · {isFetching ? "refreshing…" : `${int(totals.sessions)} sessions in slice`}
          </>
        }
      />
    </div>
  );
}

const emptyHeat = () => Array.from({ length: 7 }, () => new Array(24).fill(0));
const usd3ceil = (v: number) => (v > 0 ? usd(v) : "free");
