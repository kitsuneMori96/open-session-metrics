import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { ExpandedState, SortingState, Updater } from "@tanstack/react-table";
import { useAnalytics, useToolDetail, type ToolRow } from "../lib/api";
import { useSlice, useSliceHref } from "../lib/slice";
import { dur, int, pct, stamp, tok } from "../lib/format";
import { DataTable, type Column } from "../components/DataTable";
import { Histogram, RankBars, TimeBars } from "../components/charts/ranks";
import { Chip, Empty, Panel, RateBar, SectionHeader, Spinner, Stat } from "../components/ui";
import { BaseHints, StatusBar } from "../components/Chrome";

/**
 * Screen 3: the tools, and one tool in depth.
 *
 * The TUI printed a flat call list. Here the list is sortable and the selection opens a
 * forensic pane over the same slice: volume and failure rate as two stacked series on a
 * shared time axis, the latency *distribution* rather than a mean, the error signatures
 * with a sample, and the call sites that produced them.
 */
export default function Tools() {
  const { name } = useParams();
  const navigate = useNavigate();
  const { window, facets, label } = useSlice();
  const { data, isLoading } = useAnalytics(window, facets);
  const detail = useToolDetail(window, facets, name ?? null);
  const href = useSliceHref();
  const [sorting, setSorting] = useState<SortingState>([{ id: "calls", desc: true }]);
  const [expanded] = useState<ExpandedState>({});

  const tools = data?.tools ?? [];
  const totals = useMemo(() => {
    const calls = tools.reduce((a, t) => a + t.calls, 0);
    const errors = tools.reduce((a, t) => a + t.errors, 0);
    const ms = tools.reduce((a, t) => a + t.totalMs, 0);
    return { calls, errors, ms, rate: calls > 0 ? errors / calls : 0 };
  }, [tools]);

  const columns = useMemo<Column<ToolRow>[]>(
    () => [
      {
        id: "name",
        header: "tool",
        size: 180,
        accessorKey: "name",
        cell: ({ row }) => <span className="tape truncate">{row.original.name}</span>,
      },
      { id: "calls", header: "calls", size: 66, accessorKey: "calls", meta: { align: "right" }, cell: ({ row }) => <span className="tape tabular">{int(row.original.calls)}</span> },
      {
        id: "errors",
        header: "err",
        size: 84,
        accessorKey: "errors",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="flex items-center justify-end gap-2">
            <RateBar rate={row.original.calls > 0 ? row.original.errors / row.original.calls : 0} width={34} />
            <span className="tape tabular w-[20px] text-right">{row.original.errors}</span>
          </span>
        ),
      },
      { id: "p50Ms", header: "p50", size: 62, accessorKey: "p50Ms", meta: { align: "right" }, cell: ({ row }) => <span className="tape tabular text-ink-soft">{dur(row.original.p50Ms)}</span> },
      { id: "p95Ms", header: "p95", size: 62, accessorKey: "p95Ms", meta: { align: "right" }, cell: ({ row }) => <span className="tape tabular text-ink-soft">{dur(row.original.p95Ms)}</span> },
      { id: "maxMs", header: "max", size: 66, accessorKey: "maxMs", meta: { align: "right" }, cell: ({ row }) => <span className="tape tabular text-ink-faint">{dur(row.original.maxMs)}</span> },
      { id: "avgMs", header: "mean", size: 66, accessorKey: "avgMs", meta: { align: "right" }, cell: ({ row }) => <span className="tape tabular text-ink-faint">{dur(row.original.avgMs)}</span> },
      { id: "sessions", header: "sessions", size: 72, accessorKey: "sessions", meta: { align: "right" }, cell: ({ row }) => <span className="tape tabular text-ink-faint">{row.original.sessions}</span> },
      { id: "agents", header: "agents", size: 62, accessorKey: "agents", meta: { align: "right" }, cell: ({ row }) => <span className="tape tabular text-ink-faint">{row.original.agents}</span> },
    ],
    []
  );

  if (isLoading || !data) return <Spinner label="reading the store" />;

  const active = detail.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="hairline-b flex shrink-0 flex-wrap items-center gap-2 px-2 py-1">
        <span className="micro shrink-0">tools</span>
        <span className="tape shrink-0 text-ink-faint">
          {tools.length} distinct · {int(totals.calls)} calls · {(totals.rate * 100).toFixed(2)}% failed · {dur(totals.ms)} in tool time
        </span>
        <span className="flex-1" />
        {name && (
          <Chip onClick={() => navigate(href("/tools"))} title="close the detail pane">
            ✕ {name}
          </Chip>
        )}
        <span className="tape shrink-0 text-ink-faint">window {label}</span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col xl:hairline-r">
          <DataTable<ToolRow>
            rows={tools}
            columns={columns}
            getRowId={(t) => t.name}
            sorting={sorting}
            onSortingChange={(u: Updater<SortingState>) => setSorting((prev) => (typeof u === "function" ? u(prev) : u))}
            expanded={expanded}
            onRowClick={(t) => navigate(href(`/tools/${encodeURIComponent(t.name)}`))}
            activeId={name ?? null}
            rowHeight={24}
            empty="no tool calls in this slice"
          />
        </div>

        <div className="no-scrollbar min-h-0 min-w-0 overflow-y-auto p-3">
          {!name ? (
            <Empty>select a tool on the left for its volume, latency distribution and error signatures</Empty>
          ) : !active ? (
            <Spinner label={`reading ${name}`} />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[15px] font-semibold">{active.name}</span>
                {active.totals && (
                  <span className="tape text-ink-faint">
                    {int(active.totals.calls)} calls in {active.totals.sessions} sessions by {active.totals.agents} agents
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
                <Stat label="failed" value={`${active.totals?.errors ?? 0} (${pct(active.totals && active.totals.calls > 0 ? active.totals.errors / active.totals.calls : 0)})`} tone={(active.totals?.errors ?? 0) > 0 ? "danger" : "good"} labelWidth={52} />
                <Stat label="median" value={dur(active.totals?.p50Ms ?? 0)} labelWidth={52} />
                <Stat label="p95" value={dur(active.totals?.p95Ms ?? 0)} labelWidth={52} />
                <Stat label="max" value={dur(active.totals?.maxMs ?? 0)} labelWidth={52} />
                <Stat label="mean" value={dur(active.totals?.avgMs ?? 0)} tone="faint" labelWidth={52} />
                <Stat label="total" value={dur(active.totals?.totalMs ?? 0)} tone="faint" labelWidth={52} />
                <Stat label="edited" value={`+${int(active.edited.additions)} −${int(active.edited.deletions)}`} labelWidth={52} />
                <Stat label="files" value={int(active.edited.files)} tone="faint" labelWidth={52} />
              </div>

              <TimeBars
                label="calls per bucket"
                values={active.buckets.map((b) => ({ ts: b.ts, value: b.calls }))}
                gran={active.gran}
                color="var(--color-ink)"
                height={92}
                format={(v) => int(v)}
              />
              <TimeBars
                label="failure rate"
                values={active.buckets.map((b) => ({ ts: b.ts, value: b.calls > 0 ? b.errors / b.calls : 0 }))}
                gran={active.gran}
                mode="line"
                color="var(--color-danger)"
                height={78}
                format={(v) => pct(v, 0)}
                note={`${active.totals?.errors ?? 0} failures across ${active.buckets.length} buckets`}
              />
              <Histogram
                label="latency distribution"
                bins={active.latency.map((b) => ({ label: b.label, count: b.count }))}
                color="var(--color-warning)"
                height={116}
                right={<span className="tape text-ink-faint">mean {dur(active.totals?.avgMs ?? 0)}</span>}
                note="a mean hides the shape: a second mode in the slow bins is usually a retry or a hung process"
              />

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <Panel title="by agent">
                  <RankBars
                    rows={active.agents.map((a) => ({
                      key: a.agent,
                      label: a.agent,
                      value: a.calls,
                      right: int(a.calls),
                      right2: a.errors > 0 ? `${a.errors}×` : undefined,
                      right2Tone: "danger",
                      color: a.errors > 0 ? "var(--color-warning)" : undefined,
                    }))}
                    empty="no calls in this slice"
                  />
                </Panel>
                <Panel title="by project">
                  <RankBars
                    rows={active.projects.map((p) => ({
                      key: p.project,
                      label: p.project,
                      value: p.calls,
                      right: int(p.calls),
                      right2: p.errors > 0 ? `${p.errors}×` : undefined,
                      right2Tone: "danger",
                      color: p.errors > 0 ? "var(--color-warning)" : undefined,
                    }))}
                    empty="no calls in this slice"
                  />
                </Panel>
              </div>

              <Panel title="error signatures" right={<span className="tape text-ink-faint">grouped by hash</span>}>
                {active.signatures.length === 0 ? (
                  <Empty>this tool has not failed in the window</Empty>
                ) : (
                  active.signatures.map((sig) => (
                    <div key={sig.sig} className="border-b border-rule/60 py-1 last:border-b-0">
                      <div className="flex items-baseline gap-2">
                        <span className="tape tabular shrink-0 text-danger">{int(sig.count)}×</span>
                        <span className="tape shrink-0 text-ink-faint">{sig.sig.slice(0, 16)}</span>
                        <span className="tape min-w-0 flex-1 truncate text-ink-soft">{sig.sample.split("\n")[0]}</span>
                      </div>
                      {sig.sample.includes("\n") && (
                        <pre className="out mt-1 max-h-[120px] overflow-auto border border-rule bg-paper/60 p-2 text-[10px]">{sig.sample}</pre>
                      )}
                    </div>
                  ))
                )}
              </Panel>

              <Panel title="recent failures" right={<span className="tape text-ink-faint">click to open the session</span>}>
                {active.recentErrors.length === 0 ? (
                  <Empty>none</Empty>
                ) : (
                  active.recentErrors.map((e) => (
                    <Link
                      key={`${e.at}-${e.session}`}
                      to={href(`/sessions/${e.session}`)}
                      className="block border-b border-rule/60 py-1 no-underline last:border-b-0 hover:bg-ink/5"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="tape shrink-0 tabular text-ink-faint">{stamp(e.at)}</span>
                        <span className="tape min-w-0 flex-1 truncate">{e.error.split("\n")[0]}</span>
                      </div>
                    </Link>
                  ))
                )}
              </Panel>
            </div>
          )}
        </div>
      </div>

      <StatusBar
        hints={
          <>
            <BaseHints /> · click a row to open the tool
          </>
        }
        info={<>{tools.length} tools · {tok(data.series.buckets.reduce((a, b) => a + b.total, 0))} tokens in slice</>}
      />
    </div>
  );
}
