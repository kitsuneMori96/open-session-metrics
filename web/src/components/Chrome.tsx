import { NavLink, useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import clsx from "clsx";
import { GRANULARITIES, PRESETS, useFacets, useStatus, type Granularity } from "../lib/api";
import { clockSec, int, tok } from "../lib/format";
import { useSlice, useSliceHref } from "../lib/slice";
import { Chip, KeyCap } from "./ui";

export const NAV = [
  { to: "/overview", label: "Overview", key: "1" },
  { to: "/sessions", label: "Sessions", key: "2" },
  { to: "/tools", label: "Tools", key: "3" },
  { to: "/compare", label: "Compare", key: "4" },
] as const;

/* ------------------------------------------------------------------ *
 * Top bar: identity, navigation, and the two actions that are not a view
 * (search the corpus, re-materialize the store).
 * ------------------------------------------------------------------ */

export function TopBar({ onPalette }: { onPalette: () => void }) {
  const status = useStatus();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const location = useLocation();
  const href = useSliceHref();

  const sync = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`${(import.meta.env.VITE_OSM_API as string | undefined) ?? "http://127.0.0.1:8787"}/api/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full: false }),
      });
      await qc.invalidateQueries();
    } catch {
      // The panel keeps the last good snapshot; the button just stops spinning.
    } finally {
      setBusy(false);
    }
  }, [qc]);

  return (
    <header className="hairline-b flex h-9 shrink-0 items-center gap-3 bg-paper-raised/85 px-2 backdrop-blur-[2px]">
      <span className="tape shrink-0 font-bold tracking-[0.18em]">◆ OSM</span>
      <nav className="flex shrink-0 items-center gap-0">
        {NAV.map((item) => {
          const active = location.pathname.startsWith(item.to);
          return (
            <NavLink
              key={item.to}
              to={href(item.to)}
              className={clsx(
                "tape flex items-center gap-1 px-2 py-[3px] no-underline",
                active ? "bg-ink font-bold text-paper" : "text-ink-soft hover:bg-ink/5"
              )}
            >
              <span className={clsx("text-[8px]", active ? "text-paper/70" : "text-ink-faint")}>{item.key}</span>
              {item.label}
            </NavLink>
          );
        })}
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
        title="re-materialize from opencode.db"
      >
        {busy ? "↻ syncing" : "↻ sync"}
      </button>
      {status.data && (
        <span className="tape shrink-0 text-ink-faint" title={`source: ${status.data.sourceDb ?? "?"}`}>
          {status.data.mode ?? "—"} · {clockSec(status.data.materializedAt)}
        </span>
      )}
    </header>
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
          title="everything materialized from opencode.db — the reference frame for this slice"
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
      <select
        className="field"
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
      </select>
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
      <select
        className="field max-w-[190px]"
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
      </select>
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
