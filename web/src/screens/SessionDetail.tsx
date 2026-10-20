import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useAnalytics, useTranscript, type Bucket, type SessionRow, type Turn } from "../lib/api";
import { TOKEN_CLASSES } from "../lib/chart";
import {
  ago,
  clockSec,
  dur,
  fullStamp,
  int,
  pct,
  pctInt,
  rate,
  shortModel,
  tok,
  usd,
  usdPerM,
} from "../lib/format";
import { modelColor } from "../lib/format";
import { useSlice, useSliceHref } from "../lib/slice";
import Transcript from "../components/Transcript";
import { Sparkline, StackRule, TimeArea } from "../components/charts/series";
import { TimeBars } from "../components/charts/ranks";
import { Chip, Empty, Panel, RateBar, SectionHeader, Spinner, Stat } from "../components/ui";
import { StatusBar } from "../components/Chrome";
import type { LineFilter } from "../lib/transcript";

/**
 * Screen 2b: one session, in full.
 *
 * Everything the TUI put in a modal — the stats block, the agent chain, the transcript
 * with its filter and search — plus the two views that only make sense on a canvas: the
 * cumulative context curve (compaction is a sawtooth, and a sawtooth is invisible in a
 * list of turns) and a per-turn token timeline whose brush narrows the transcript below
 * it. The URL carries the session id, so any of this is a link.
 */
export default function SessionDetail() {
  const { id = "" } = useParams();
  const { window, facets, label } = useSlice();
  const { data, isLoading } = useTranscript(id);
  const list = useAnalytics(window, facets);
  const navigate = useNavigate();
  const link = useSliceHref();

  const [filter, setFilter] = useState<LineFilter>("all");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<[number, number] | null>(null);
  const [activeTurn, setActiveTurn] = useState<number | null>(null);

  const turns = data?.turns ?? [];

  const stats = useMemo(() => {
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let tools = 0;
    let errors = 0;
    let additions = 0;
    let deletions = 0;
    let writeLines = 0;
    let first = Infinity;
    let last = 0;
    let peak = 0;
    let windowTokens = 0;
    const rates: number[] = [];
    for (const t of turns) {
      input += t.tokens.input;
      output += t.tokens.output;
      reasoning += t.tokens.reasoning;
      cacheRead += t.tokens.cacheRead;
      cacheWrite += t.tokens.cacheWrite;
      cost += t.cost;
      tools += t.tools;
      errors += t.errors;
      additions += t.additions;
      deletions += t.deletions;
      writeLines += t.writeLines;
      first = Math.min(first, t.created);
      last = Math.max(last, t.completed ?? t.created);
      if (t.contextWindow > 0) {
        windowTokens = Math.max(windowTokens, t.contextWindow);
        peak = Math.max(peak, t.occupancy / t.contextWindow);
      } else peak = Math.max(peak, t.fill);
      if (t.durMs > 0 && t.tokens.output > 0) rates.push((t.tokens.output / t.durMs) * 1000);
    }
    rates.sort((a, b) => a - b);
    const median = rates.length ? (rates.length % 2 ? rates[rates.length >> 1] : (rates[(rates.length >> 1) - 1] + rates[rates.length >> 1]) / 2) : 0;
    return {
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
      cost,
      tools,
      errors,
      additions,
      deletions,
      writeLines,
      spanMs: last > first ? last - first : 0,
      peak,
      windowTokens,
      rate: median,
    };
  }, [turns]);

  /** Each turn becomes a one-bucket series, so the shared chart can draw it. */
  const buckets = useMemo<Bucket[]>(
    () =>
      turns.map((t) => {
        const input = t.tokens.input;
        const output = t.tokens.output;
        const cacheRead = t.tokens.cacheRead;
        const cacheWrite = t.tokens.cacheWrite;
        return {
          ts: t.created,
          input,
          output,
          reasoning: t.tokens.reasoning,
          cacheRead,
          cacheWrite,
          total: input + output + cacheRead + cacheWrite,
          cost: t.cost,
          turns: 1,
          tools: t.tools,
          errors: t.errors,
          sessions: 1,
          additions: t.additions,
          deletions: t.deletions,
          writeLines: t.writeLines,
        };
      }),
    [turns]
  );

  const related = useMemo(() => {
    const all = list.data?.sessions ?? [];
    const byId = new Map(all.map((s) => [s.id, s]));
    const ancestors: SessionRow[] = [];
    let cursor = byId.get(id)?.parentId ?? null;
    for (let i = 0; i < 32 && cursor; i++) {
      const parent = byId.get(cursor);
      if (!parent) break;
      ancestors.unshift(parent);
      cursor = parent.parentId;
    }
    const children = all.filter((s) => s.parentId === id);
    const siblings = (byId.get(id)?.parentId ? all.filter((s) => s.parentId === byId.get(id)!.parentId) : [])
      .filter((s) => s.id !== id);
    return { ancestors, children, siblings, all };
  }, [list.data, id]);

  const turnCount = turns.length;
  const shown: [number, number] = range ?? [0, Math.max(0, turnCount - 1)];
  const toolsByName = useMemo(() => {
    const map = new Map<string, { calls: number; errors: number }>();
    for (const t of turns) {
      for (const part of t.parts) {
        if (part.kind !== "tool") continue;
        const entry = map.get(part.name) ?? { calls: 0, errors: 0 };
        entry.calls++;
        if (part.status === "error") entry.errors++;
        map.set(part.name, entry);
      }
    }
    return [...map.entries()].sort((a, b) => b[1].calls - a[1].calls);
  }, [turns]);

  if (isLoading || !data) return <Spinner label="reading the transcript" />;

  const s = data.session;
  const title = s.title ?? "untitled session";
  const href = (sid: string) => link(`/sessions/${sid}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="hairline-b flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 bg-paper-raised/60 px-3 py-1.5">
        <Link to={link("/sessions")} className="tape shrink-0 text-flow no-underline hover:underline">
          ← sessions
        </Link>
        <span className="tape min-w-0 shrink truncate font-semibold" title={title}>
          {title}
        </span>
        <span className="tape shrink-0 text-ink-soft">{s.project}</span>
        <span className="flex shrink-0 items-center gap-1">
          <i className="block h-[7px] w-[7px]" style={{ background: modelColor(s.model) }} />
          <span className="tape" title={s.model ?? ""}>
            {shortModel(s.model)}
          </span>
        </span>
        <span className="tape shrink-0 text-ink-faint">{s.agent ?? "main"}</span>
        <span className="tape shrink-0 tabular text-ink-faint" title={fullStamp(s.created)}>
          {fullStamp(s.created)} → {ago(s.updated)}
        </span>
        <span className="flex-1" />
        <span className="tape shrink-0 tabular text-ink-faint" title="session id">
          {s.id}
        </span>
        {related.siblings.length > 0 && (
          <>
            <Chip onClick={() => navigate(href(related.siblings[0].id))} title="next sibling session">
              → sibling
            </Chip>
          </>
        )}
      </header>

      <div className="no-scrollbar grid min-h-0 flex-1 grid-cols-1 gap-x-3 overflow-y-auto p-3 xl:grid-cols-[300px_minmax(0,1fr)]">
        {/* ── left rail ─────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-3">
          <Panel title="tokens">
            <div className="mb-1 flex items-center gap-2">
              <StackRule
                segments={[
                  { value: stats.output, color: "var(--chart-2)", label: "output" },
                  { value: stats.input, color: "var(--chart-1)", label: "input" },
                  { value: stats.cacheRead, color: "var(--chart-6)", label: "cache read" },
                  { value: stats.cacheWrite, color: "var(--chart-7)", label: "cache write" },
                ]}
                width={92}
                height={9}
              />
              <span className="tape tabular font-semibold">{tok(stats.total)}</span>
            </div>
            <Stat label="input" value={tok(stats.input)} labelWidth={92} />
            <Stat label="output" value={tok(stats.output)} labelWidth={92} />
            <Stat label="reasoning" value={tok(stats.reasoning)} labelWidth={92} />
            <Stat label="cache read" value={tok(stats.cacheRead)} labelWidth={92} />
            <Stat label="cache write" value={tok(stats.cacheWrite)} labelWidth={92} />
            <Stat label="billed cost" value={stats.cost > 0 ? usd(stats.cost) : "free"} tone="good" labelWidth={92} />
            <Stat label="$/Mtok" value={usdPerM(stats.cost, stats.total)} tone="faint" labelWidth={92} />
          </Panel>

          <Panel title="shape">
            <Stat label="turns" value={int(turnCount)} labelWidth={92} />
            <Stat label="tool calls" value={`${int(stats.tools)}${stats.errors > 0 ? ` · ${stats.errors}×` : ""}`} tone={stats.errors > 0 ? "warning" : "ink"} labelWidth={92} />
            <Stat label="wall clock" value={dur(stats.spanMs)} labelWidth={92} title="first turn to last completion" />
            <Stat label="output rate" value={rate(stats.rate)} tone="good" labelWidth={92} title="median tokens/second across turns" />
            <Stat label="context window" value={tok(stats.windowTokens)} labelWidth={92} />
            <div className="mt-1 flex items-center gap-2 py-[2px]">
              <span className="tape shrink-0 text-ink-soft" style={{ width: 92 }}>
                peak fill
              </span>
              {/* The readout rides at the end of its own bar, like every other rule in the app. */}
              <RateBar rate={stats.peak} width={140} tone="var(--color-flow)" />
              <span className="tape tabular shrink-0">{pctInt(stats.peak)}</span>
            </div>
            <SectionHeader title="code written" />
            <Stat label="lines" value={`+${int(stats.additions)} −${int(stats.deletions)}`} labelWidth={92} />
            <Stat label="written bytes" value={`${int(stats.writeLines)} lines`} tone="faint" labelWidth={92} />
          </Panel>

          <Panel title="tools used">
            {toolsByName.length === 0 ? (
              <Empty>no tool calls in this session</Empty>
            ) : (
              toolsByName.map(([name, t]) => (
                <div key={name} className="flex items-baseline gap-2 py-px">
                  <Link to={link(`/tools/${encodeURIComponent(name)}`)} className="tape w-[92px] shrink-0 truncate no-underline hover:underline" title={`open ${name}`}>
                    {name}
                  </Link>
                  <RateBar rate={t.calls > 0 ? t.errors / t.calls : 0} width={54} />
                  <span className="tape tabular w-[20px] shrink-0 text-right text-ink-soft">{int(t.calls)}</span>
                  {t.errors > 0 && <span className="tape shrink-0 text-danger">{t.errors}×</span>}
                </div>
              ))
            )}
          </Panel>

          <Panel title="agent chain">
            {related.ancestors.length === 0 && related.children.length === 0 ? (
              <Empty>a root session with no sub-agents</Empty>
            ) : (
              <>
                {related.ancestors.map((a) => (
                  <Link key={a.id} to={href(a.id)} className="tape block truncate py-px pl-2 text-ink-soft no-underline hover:bg-ink/5 hover:underline">
                    ↑ {a.title ?? a.id}
                  </Link>
                ))}
                <div className="tape py-px font-semibold">◆ {title}</div>
                {related.children.map((c) => (
                  <Link key={c.id} to={href(c.id)} className="tape block truncate py-px pl-2 no-underline hover:bg-ink/5 hover:underline">
                    └ {c.title ?? c.id} <span className="text-ink-faint">{shortModel(c.model)}</span>
                  </Link>
                ))}
              </>
            )}
            <div className="micro mt-1">
              {related.children.length} sub-agent{related.children.length === 1 ? "" : "s"} ·{" "}
              {list.data?.sessions.length ?? 0} sessions in the current window
            </div>
          </Panel>
        </div>

        {/* ── timeline + transcript ─────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-3">
          <Panel title="turn timeline" bodyClass="p-2" right={<span className="tape text-ink-faint">{turnCount} turns · brush to narrow the transcript</span>}>
            <TimeArea
              buckets={buckets}
              keys={TOKEN_CLASSES.map((c) => ({ key: c.key, label: c.label, color: c.color }))}
              gran="hour"
              height={132}
              label="tokens per turn"
              caption={`turn 1–${turnCount}`}
              xFormat={(i) => `#${i + 1}`}
              onWindowIndex={(lo, hi) => setRange([lo, hi])}
              onPointClick={(i) => setActiveTurn(i)}
              windowLabel={range ? `turns ${shown[0] + 1}–${shown[1] + 1}` : undefined}
              onClearWindow={() => setRange(null)}
              tipExtra={(b, i) => [
                { label: "turn", value: `#${i + 1}` },
                { label: "model", value: shortModel(turns[i]?.model ?? "") },
                { label: "cost", value: usd(b.cost) },
                { label: "duration", value: dur(turns[i]?.durMs ?? 0) },
              ]}
            />
            <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div>
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="micro shrink-0">context fill per turn</span>
                  <span className="h-px min-w-2 flex-1 bg-rule" />
                  <span className="tape shrink-0 text-ink-faint">peak {pctInt(stats.peak)}</span>
                </div>
                <TimeBars
                  label="occupancy"
                  values={turns.map((t: Turn) => ({
                    ts: t.created,
                    value: t.contextWindow > 0 ? t.occupancy / t.contextWindow : t.fill,
                  }))}
                  gran="hour"
                  mode="line"
                  color="var(--color-flow)"
                  height={78}
                  format={(v) => pct(v, 0)}
                  xFormat={(i) => `#${i + 1}`}
                  note="a falling edge is a compaction: the window was summarised and the next turn starts lower"
                />
              </div>
              <div>
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="micro shrink-0">output per turn</span>
                  <span className="h-px min-w-2 flex-1 bg-rule" />
                  <span className="tape shrink-0 text-ink-faint">median {rate(stats.rate)}</span>
                </div>
                <TimeBars
                  label="output tokens"
                  values={turns.map((t: Turn) => ({ ts: t.created, value: t.tokens.output }))}
                  gran="hour"
                  color="var(--chart-2)"
                  height={78}
                  format={(v) => tok(v)}
                  xFormat={(i) => `#${i + 1}`}
                />
              </div>
            </div>
          </Panel>

          <Panel
            title="transcript"
            bodyClass="flex min-h-0 flex-col p-0"
            className="min-h-[420px]"
            right={<span className="tape text-ink-faint">first prompt · {clockSec(s.created)}</span>}
          >
            {/* The wrapper must establish the height: `flex-1` on the transcript only
                resolves against a flex parent with a definite size, otherwise the list
                lays out at its full natural height and the virtualizer renders all of it. */}
            <div className="flex h-[62vh] min-h-[380px] flex-col overflow-hidden">
              <Transcript
                turns={turns}
                filter={filter}
                onFilter={setFilter}
                query={query}
                onQuery={setQuery}
                turnRange={shown}
                onTurnRange={(r) => setRange(r)}
                activeTurn={activeTurn}
                onActiveTurn={setActiveTurn}
              />
            </div>
          </Panel>

          <Panel title="spend per turn" right={<Sparkline values={turns.map((t) => t.cost)} color="var(--color-good)" height={16} />}>
            <div className="tape text-ink-faint">
              {(() => {
                const billed = turns.filter((t) => t.cost > 0).length;
                const free = turnCount - billed;
                if (billed === 0) return `every one of the ${turnCount} turns ran on a free model`;
                if (free === 0) return `all ${turnCount} turns were billed`;
                return `${billed} of ${turnCount} turns were billed; the other ${free} ran on a free model`;
              })()}
              . First prompt: “{(s.firstPrompt ?? "").slice(0, 180)}”
            </div>
          </Panel>
        </div>
      </div>

      <StatusBar
        hints={
          <>
            1–4 go · <b>/</b> search · j/k cursor · n/N match · f filter · ↵ expand · esc reset
          </>
        }
        info={
          <>
            window {label} · {int(turnCount)} turns · {tok(stats.total)} tokens · {stats.cost > 0 ? usd(stats.cost) : "free"}
          </>
        }
      />
    </div>
  );
}
