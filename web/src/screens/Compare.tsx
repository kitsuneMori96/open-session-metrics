import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { useAnalytics, useTranscript, type SessionRow, type Turn } from "../lib/api";
import { useSlice, useSliceHref } from "../lib/slice";
import { dur, int, pct, rate, shortModel, tok, usd, usdPerM } from "../lib/format";
import { TimeBars } from "../components/charts/ranks";
import { DeltaBar } from "../components/charts/ranks";
import { Empty, Panel, Spinner, Stat } from "../components/ui";
import { StatusBar } from "../components/Chrome";

/**
 * A screen the TUI could not have.
 *
 * Comparing two sessions is a two-column question about eight numbers and a shape, and
 * a terminal has neither a second pane nor a diff. The sessions picked here are the two
 * most recent by default; everything below reads from the same turn data the detail
 * screen uses.
 */
export default function Compare() {
  const { window, facets } = useSlice();
  const { data, isLoading } = useAnalytics(window, facets);
  const [params, setParams] = useSearchParams();

  const sessions = useMemo(
    () => [...(data?.sessions ?? [])].sort((a, b) => b.updated - a.updated),
    [data]
  );
  const a = params.get("a") ?? sessions[0]?.id ?? "";
  const b = params.get("b") ?? sessions[1]?.id ?? "";
  const ta = useTranscript(a || null);
  const tb = useTranscript(b || null);

  const set = (key: "a" | "b", id: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(key, id);
      return next;
    }, { replace: true });

  if (isLoading || !data) return <Spinner label="reading the store" />;

  const sa = sessions.find((s) => s.id === a);
  const sb = sessions.find((s) => s.id === b);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="hairline-b flex shrink-0 flex-wrap items-center gap-2 px-2 py-1">
        <span className="micro shrink-0">compare</span>
        <Picker label="A" value={a} sessions={sessions} onChange={(id) => set("a", id)} />
        <Picker label="B" value={b} sessions={sessions} onChange={(id) => set("b", id)} />
        <span className="flex-1" />
        <span className="tape shrink-0 text-ink-faint">both sides read the same window and filters</span>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        {!sa || !sb ? (
          <Empty>pick two sessions that were active in this window</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Head s={sa} turns={ta.data?.turns ?? []} />
              <Head s={sb} turns={tb.data?.turns ?? []} />
            </div>

            <DiffTable a={sa} b={sb} ta={ta.data?.turns ?? []} tb={tb.data?.turns ?? []} />

            <Panel title="output tokens per turn" right={<span className="tape text-ink-faint">aligned by turn index, not by clock</span>}>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <TimeBars
                  label={`A · ${sa.title ?? sa.id}`}
                  values={(ta.data?.turns ?? []).map((t: Turn) => ({ ts: t.created, value: t.tokens.output }))}
                  gran="hour"
                  color="var(--chart-1)"
                  height={92}
                  format={(v) => tok(v)}
                />
                <TimeBars
                  label={`B · ${sb.title ?? sb.id}`}
                  values={(tb.data?.turns ?? []).map((t: Turn) => ({ ts: t.created, value: t.tokens.output }))}
                  gran="hour"
                  color="var(--chart-5)"
                  height={92}
                  format={(v) => tok(v)}
                />
              </div>
            </Panel>

            <ToolMix a={sa} b={sb} ta={ta.data?.turns ?? []} tb={tb.data?.turns ?? []} />
          </div>
        )}
      </div>

      <StatusBar hints="1–4 go · / search · pick A and B above" info={`${sessions.length} sessions in slice`} />
    </div>
  );
}

function Picker({
  label,
  value,
  sessions,
  onChange,
}: {
  label: string;
  value: string;
  sessions: SessionRow[];
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex min-w-0 shrink items-center gap-1">
      <span className="micro shrink-0 text-flow">{label}</span>
      <select className="field max-w-[320px]" value={value} onChange={(e) => onChange(e.target.value)}>
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {(s.title ?? s.firstPrompt ?? s.id).slice(0, 60)} · {s.project}
          </option>
        ))}
      </select>
    </label>
  );
}

function Head({ s, turns }: { s: SessionRow; turns: Turn[] }) {
  const href = useSliceHref();
  return (
    <Panel title={<Link to={href(`/sessions/${s.id}`)} className="no-underline hover:underline">{s.title ?? s.firstPrompt ?? s.id}</Link>} right={<span className="tape text-ink-faint">{shortModel(s.model)}</span>}>
      <div className="tape text-ink-faint">
        {s.project} · {s.agent ?? "main"} · {int(turns.length)} turns · {tok(s.tokens)} tokens · {s.cost > 0 ? usd(s.cost) : "free"}
      </div>
    </Panel>
  );
}

interface Metric {
  label: string;
  a: number;
  b: number;
  fmt: (v: number) => string;
  lowerIsBetter?: boolean;
}

function DiffTable({ a, b, ta, tb }: { a: SessionRow; b: SessionRow; ta: Turn[]; tb: Turn[] }) {
  const outRate = (turns: Turn[]) => {
    const rates: number[] = [];
    for (const t of turns) if (t.durMs > 0 && t.tokens.output > 0) rates.push((t.tokens.output / t.durMs) * 1000);
    rates.sort((x, y) => x - y);
    return rates.length ? rates[rates.length >> 1] : 0;
  };
  const ctx = (s: SessionRow) => Math.min(1, s.contextPct);

  const rows: Metric[] = [
    { label: "tokens", a: a.tokens, b: b.tokens, fmt: tok },
    { label: "cost", a: a.cost, b: b.cost, fmt: (v) => (v > 0 ? usd(v) : "free"), lowerIsBetter: true },
    { label: "$ / Mtok", a: a.tokens > 0 ? (a.cost / a.tokens) * 1e6 : 0, b: b.tokens > 0 ? (b.cost / b.tokens) * 1e6 : 0, fmt: (v) => `$${v.toFixed(2)}`, lowerIsBetter: true },
    { label: "turns", a: a.turns, b: b.turns, fmt: int },
    { label: "tool calls", a: a.tools, b: b.tools, fmt: int },
    { label: "failures", a: a.errors, b: b.errors, fmt: int, lowerIsBetter: true },
    { label: "wall clock", a: a.spanMs / 1000, b: b.spanMs / 1000, fmt: (v) => dur(v * 1000) },
    { label: "output rate", a: outRate(ta), b: outRate(tb), fmt: rate },
    { label: "peak context", a: ctx(a), b: ctx(b), fmt: (v) => pct(v, 0), lowerIsBetter: true },
    { label: "lines added", a: a.turns ? ta.reduce((n, t) => n + t.additions, 0) : 0, b: tb.reduce((n, t) => n + t.additions, 0), fmt: (v) => `+${int(v)}` },
    { label: "lines removed", a: ta.reduce((n, t) => n + t.deletions, 0), b: tb.reduce((n, t) => n + t.deletions, 0), fmt: (v) => `−${int(v)}` },
  ];

  return (
    <Panel title="side by side" right={<span className="tape text-ink-faint">B relative to A</span>}>
      <div className="grid items-baseline gap-x-3" style={{ gridTemplateColumns: "minmax(88px,auto) minmax(0,1fr) 62px minmax(0,1fr)" }}>
        {rows.map((m) => {
          const delta = m.a > 0 ? (m.b - m.a) / m.a : m.b > 0 ? 1 : 0;
          const better = m.lowerIsBetter ? delta < 0 : delta > 0;
          return (
            <div key={m.label} className="contents">
              <span className="tape py-[3px] text-ink-soft">{m.label}</span>
              <span className="tape tabular py-[3px] text-right">{m.fmt(m.a)}</span>
              <span className="flex items-center justify-center gap-1 py-[3px]">
                <DeltaBar delta={better ? Math.abs(delta) : -Math.abs(delta)} width={40} />
                <span className={`tape tabular ${Math.abs(delta) < 0.005 ? "text-ink-faint" : better ? "text-good" : "text-danger"}`}>
                  {Math.abs(delta) < 0.005 ? "=" : `${delta > 0 ? "+" : "−"}${Math.abs(delta * 100).toFixed(0)}%`}
                </span>
              </span>
              <span className="tape tabular py-[3px]">{m.fmt(m.b)}</span>
            </div>
          );
        })}
      </div>
      <div className="micro mt-2">the middle column shows B against A, scaled so growth points right</div>
    </Panel>
  );
}

function ToolMix({ a, b, ta, tb }: { a: SessionRow; b: SessionRow; ta: Turn[]; tb: Turn[] }) {
  const mix = (turns: Turn[]) => {
    const map = new Map<string, { calls: number; errors: number }>();
    for (const t of turns) {
      for (const p of t.parts) {
        if (p.kind !== "tool") continue;
        const e = map.get(p.name) ?? { calls: 0, errors: 0 };
        e.calls++;
        if (p.status === "error") e.errors++;
        map.set(p.name, e);
      }
    }
    return map;
  };
  const ma = mix(ta);
  const mb = mix(tb);
  const names = [...new Set([...ma.keys(), ...mb.keys()])].sort(
    (x, y) => (mb.get(y)?.calls ?? 0) + (ma.get(y)?.calls ?? 0) - ((mb.get(x)?.calls ?? 0) + (ma.get(x)?.calls ?? 0))
  );

  if (names.length === 0) return <Panel title="tool mix"><Empty>neither session called a tool</Empty></Panel>;

  const peak = Math.max(1, ...names.flatMap((n) => [ma.get(n)?.calls ?? 0, mb.get(n)?.calls ?? 0]));

  return (
    <Panel title="tool mix" right={<span className="tape text-ink-faint">A | B calls, bar is the larger side</span>}>
      {names.map((n) => {
        const x = ma.get(n)?.calls ?? 0;
        const y = mb.get(n)?.calls ?? 0;
        const errs = (ma.get(n)?.errors ?? 0) + (mb.get(n)?.errors ?? 0);
        return (
          <div key={n} className="flex items-center gap-2 py-px">
            <span className="tape w-[110px] shrink-0 truncate">{n}</span>
            <span className="tape tabular w-[46px] shrink-0 text-right text-ink-soft">{int(x)}</span>
            <span className="relative h-[9px] min-w-0 flex-1 bg-ink/10">
              <i className="absolute inset-y-0 left-0 bg-chart-1" style={{ width: `${(x / peak) * 100}%` }} />
              <i className="absolute inset-y-0 left-0 opacity-70" style={{ width: `${(y / peak) * 100}%`, background: "var(--chart-5)", mixBlendMode: "multiply" }} />
            </span>
            <span className="tape tabular w-[46px] shrink-0 text-ink-soft">{int(y)}</span>
            {/* Always rendered: a trailing element that comes and goes would resize the
                flexible bar and shift the B column on the rows that carry an error. */}
            <span className="tape w-[30px] shrink-0 text-right text-danger">{errs > 0 ? `${errs}×` : ""}</span>
          </div>
        );
      })}
      <div className="micro mt-2">
        {a.id.slice(0, 14)}… vs {b.id.slice(0, 14)}… · {usdPerM(a.cost, a.tokens)} against {usdPerM(b.cost, b.tokens)} per Mtok
      </div>
    </Panel>
  );
}
