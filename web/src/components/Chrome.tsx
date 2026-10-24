import { NavLink, useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { GRANULARITIES, PRESETS, refresh, useFacets, useStatus, type Granularity } from "../lib/api";
import { clockSec, int, tok } from "../lib/format";
import { useScope, tilde, type SourceView } from "../lib/scope";
import { useSlice, useSliceHref } from "../lib/slice";
import { Chip, KeyCap, Select } from "./ui";

export const NAV = [
  { to: "/overview", label: "Overview", key: "1" },
  { to: "/sessions", label: "Sessions", key: "2" },
  { to: "/tools", label: "Tools", key: "3" },
  { to: "/compare", label: "Compare", key: "4" },
] as const;

/* ------------------------------------------------------------------ *
 * Top bar: identity, navigation, and the three things that are not a view
 * (which store is in scope, search the corpus, re-materialize the store).
 *
 * The scope control trades one word for another in a column that already
 * existed — `mode` moved into the tooltip — so a fourth level of state costs
 * zero pixels of height and does not add a second row.
 * ------------------------------------------------------------------ */

export function TopBar({ onPalette }: { onPalette: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { reload, active } = useScope();

  const sync = useCallback(async () => {
    setBusy(true);
    try {
      await refresh(false);
      await qc.invalidateQueries();
      await reload();
    } catch {
      // The panel keeps the last good snapshot; the button just stops spinning.
    } finally {
      setBusy(false);
    }
  }, [qc, reload]);

  return (
    <header className="hairline-b relative z-30 flex h-9 shrink-0 items-center gap-3 bg-paper-raised/85 px-2 backdrop-blur-[2px]">
      <span className="tape shrink-0 font-bold tracking-[0.18em]">◆ OSM</span>
      <nav className="flex shrink-0 items-center gap-0">
        {NAV.map((item) => (
          <NavItem key={item.to} to={item.to} label={item.label} keyCap={item.key} />
        ))}
      </nav>

      <div className="flex-1" />

      <button type="button" onClick={onPalette} className="btn flex items-center gap-2 px-2 py-1" title="search everything ( / )">
        <span className="text-ink-faint">⌕</span>
        <span>search sessions, tools, text</span>
        <KeyCap>/</KeyCap>
      </button>

      {/* ↻ rather than ⟳: both text faces lack the latter, and a substituted glyph shows. */}
      <button
        type="button"
        onClick={() => void sync()}
        className={clsx("btn", busy && "pulse")}
        title={`re-materialize from ${tilde(active?.path ?? "?")}`}
      >
        {busy ? "↻ syncing" : "↻ sync"}
      </button>

      <SourceControl />
    </header>
  );
}

function NavItem({ to, label, keyCap }: { to: string; label: string; keyCap: string }) {
  const location = useLocation();
  const href = useSliceHref();
  const active = location.pathname.startsWith(to);
  return (
    <NavLink
      to={href(to)}
      className={clsx(
        "tape flex items-center gap-1 px-2 py-[3px] no-underline",
        active ? "bg-ink font-bold text-paper" : "text-ink-soft hover:bg-ink/5"
      )}
    >
      <span className={clsx("text-[8px]", active ? "text-paper/70" : "text-ink-faint")}>{keyCap}</span>
      {label}
    </NavLink>
  );
}

/**
 * The source scope, in the only place that costs nothing.
 *
 * It replaces the `mode · time` readout that used to sit here: `full`/`incremental`
 * is a property of the last build, so it belongs in the tooltip; which store you
 * are reading is the one thing the header must answer without a click.
 *
 * Three states, and one deliberate non-state:
 *   - two sources available → a menu (this control);
 *   - one source available  → plain text, no caret, not a button: nothing to switch to;
 *   - the scope's store has never been built → `◌ first build` while it is materialized.
 */
function SourceControl() {
  const scope = useScope();
  const status = useStatus();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = scope.active;
  const when = status.data?.materializedAt ?? active?.materializedAt ?? 0;
  const ready = status.data ? status.data.ready : !!active?.ready;
  const live = scope.list.sources.filter((s) => s.available);

  const title = [
    `source: ${active?.path ?? "?"}`,
    `store: ${tilde(active?.store ?? "?")}`,
    status.data?.mode ? `last build: ${status.data.mode}` : null,
    when ? `materialized ${clockSec(when)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  if (live.length < 2) {
    return (
      <span className="tape shrink-0 text-ink-faint" title={title}>
        {scope.kind}
        {ready ? (when ? ` · ${clockSec(when)}` : "") : " · no store"}
      </span>
    );
  }

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={clsx("btn flex items-center gap-1", !ready && "pulse")}
        title={title}
      >
        <span className={clsx("turn text-[9px]", open && "rotate-180")}>▾</span>
        <span>{scope.kind}</span>
        <span className="tabular text-ink-faint">{ready ? (when ? clockSec(when) : "—") : "first build"}</span>
      </button>
      {open && <SourceMenu onPick={() => setOpen(false)} />}
    </div>
  );
}

/**
 * The menu.
 *
 * Two lines per source: the name with what it holds, then the path it is read
 * from. The path is the answer to "why does this say 24 sessions" — a count
 * without a location is a rumour.
 */
function SourceMenu({ onPick }: { onPick: () => void }) {
  const scope = useScope();
  return (
    <div className="ink hairline absolute top-full right-0 z-40 mt-1 w-[286px] bg-paper-raised shadow-[0_2px_0_var(--color-rule-strong)]">
      <div className="flex items-center gap-2 border-b border-rule px-2 py-1">
        <span className="micro">source</span>
        <span className="h-px flex-1 bg-rule" />
      </div>
      {scope.list.sources.map((s) => (
        <SourceRow
          key={s.kind}
          source={s}
          current={s.kind === scope.kind}
          onPick={() => {
            scope.switchTo(s.kind);
            onPick();
          }}
        />
      ))}
      <div className="tape border-t border-rule px-2 py-1 text-ink-faint">window and filters stay per source</div>
    </div>
  );
}

function SourceRow({ source, current, onPick }: { source: SourceView; current: boolean; onPick: () => void }) {
  const glyph = !source.available ? "·" : !source.ready ? "◌" : current ? "◆" : "·";
  const right = !source.available
    ? "not found"
    : !source.ready
      ? "not built"
      : `${int(source.counts?.sessions ?? 0)} ses · ${int(source.counts?.turns ?? 0)} turns`;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={!source.available}
      className={clsx(
        "flex w-full items-baseline gap-2 px-2 py-1 text-left",
        current ? "bg-flow/10" : source.available && "hover:bg-ink/5",
        !source.available && "opacity-40"
      )}
    >
      <span className={clsx("shrink-0 text-[9px]", current ? "text-flow" : "text-ink-faint")}>{glyph}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={clsx("tape truncate", current && "font-bold")}>{source.label}</span>
          <span className="flex-1" />
          <span className="tape tabular shrink-0 text-ink-faint">{right}</span>
        </span>
        <span className="tape block truncate text-ink-faint">└ {tilde(source.path)}</span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Slice bar: the cross-filter.
 *
 * It sits above every screen, so "last 90 days in plugin projects on mimo" is one
 * gesture away from any figure, and the URL carries it.
 * ------------------------------------------------------------------ */

export function SliceBar() {
  const { window, facets, label, filtered, gran, setGran, setPreset, setFacet, reset } = useSlice();
  const query = useFacets();
  const data = query.data;
  const { kind } = useScope();

  return (
    <div className="hairline-b flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-paper/70 px-2 py-1">
      <span className="micro shrink-0 text-ink-faint">window</span>
      <div className="flex shrink-0 items-center gap-0">
        {PRESETS.map((p) => (
          <Chip
            key={p.id}
            active={window.kind === "preset" && window.id === p.id}
            onClick={() => setPreset(p.id)}
            className="border-r-0 last:border-r"
            title={p.ms ? `last ${p.label}` : "the whole history"}
          >
            {p.label}
          </Chip>
        ))}
      </div>
      <span className="tape shrink-0 tabular text-ink-faint" title="the resolved window, in local time">
        {window.kind === "custom" ? `${label} ✎` : label}
      </span>

      <GranSelect value={gran} onChange={setGran} />

      <span className="shrink-0 text-rule-strong">│</span>

      <FacetSelect
        label="project"
        value={facets.project}
        options={(data?.projects ?? []).map((p) => ({ value: p.project, label: `${p.project} · ${p.sessions}` }))}
        onChange={(v) => setFacet("project", v)}
      />
      <FacetSelect
        label="model"
        value={facets.model}
        options={(data?.models ?? []).map((m) => ({ value: m.id, label: `${m.label} · ${int(m.calls)}` }))}
        onChange={(v) => setFacet("model", v)}
      />
      <FacetSelect
        label="agent"
        value={facets.agent}
        options={(data?.agents ?? []).map((a) => ({ value: a.agent, label: `${a.agent} · ${int(a.calls)}` }))}
        onChange={(v) => setFacet("agent", v)}
      />

      {filtered ? (
        <Chip onClick={reset} title="back to 30 days, no facet filters">
          ✕ clear filters
        </Chip>
      ) : (
        <span className="tape text-ink-faint">whole store · no filter</span>
      )}

      <div className="flex-1" />

      {data && (
        <span
          className="tape shrink-0 tabular text-ink-faint"
          title={`everything materialized from the ${kind} store — the reference frame for this slice`}
        >
          store {int(data.counts.sessions)} sessions · {tok(data.counts.turns)} turns · {int(data.counts.tools)} tool calls
        </span>
      )}
    </div>
  );
}

/**
 * The axis unit. `auto` is the interesting choice — it climbs the ladder until the window
 * fits 200 columns — so an explicit unit is only for when you want a particular width, and
 * the server still refuses to ship a million columns if the span cannot afford it.
 */
function GranSelect({ value, onChange }: { value: Granularity | null; onChange: (v: Granularity | null) => void }) {
  return (
    <label className="flex shrink-0 items-center gap-1">
      <span className={clsx("micro", value ? "text-flow" : "text-ink-faint")}>by</span>
      <Select
        className="max-w-[92px]"
        value={value ?? ""}
        onChange={(e) => onChange((e.target.value || null) as Granularity | null)}
        title="time-axis unit — auto picks the finest one the window can afford"
        style={value ? { borderColor: "var(--color-flow)", color: "var(--color-flow)" } : undefined}
      >
        <option value="">auto</option>
        {GRANULARITIES.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </Select>
    </label>
  );
}

function FacetSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (v: string | null) => void;
}) {
  const active = value !== null;
  return (
    <label className={clsx("flex shrink-0 items-center gap-1", active && "font-bold")}>
      <span className={clsx("micro", active ? "text-flow" : "text-ink-faint")}>{label}</span>
      <Select
        className="max-w-[190px]"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        style={active ? { borderColor: "var(--color-flow)", color: "var(--color-flow)" } : undefined}
      >
        <option value="">all</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * Status bar
 * ------------------------------------------------------------------ */

export function StatusBar({ hints, info }: { hints: React.ReactNode; info?: React.ReactNode }) {
  return (
    <footer className="hairline-t flex h-6 shrink-0 items-center gap-3 bg-paper-raised/70 px-2">
      <span className="tape truncate text-ink-faint">{hints}</span>
      <div className="flex-1" />
      {info && <span className="tape tabular shrink-0 text-ink-faint">{info}</span>}
    </footer>
  );
}

/** Default hint line, so a screen only states what it adds. */
export const BaseHints = () => (
  <>
    1–4 go · <b>/</b> search · <b>r</b> sync · <b>esc</b> reset
  </>
);
