import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useFacets, useSearch, type Facets } from "../lib/api";
import { useDebounced } from "../lib/useKeys";
import { useSlice, useSliceHref } from "../lib/slice";
import { PRESETS } from "../lib/api";
import { ago, int } from "../lib/format";
import clsx from "clsx";

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * One overlay for everything the terminal did with `/` and a keymap.
 *
 * Text search runs server-side over the materialized transcripts, so the browser never
 * holds the corpus; navigation, window presets, facet filters and every tool are offered
 * from the same list. This is the web-native replacement for four separate TUI keys.
 */
export default function Palette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const href = useSliceHref();
  const { setPreset, setWindow, setFacet, reset } = useSlice();
  const facets = useFacets();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 200);
  const hits = useSearch(debounced);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    const go = (to: string, label: string) => out.push({ id: `go:${to}`, group: "go", label, run: () => { navigate(href(to)); onClose(); } });
    go("/overview", "Overview — dashboard");
    go("/sessions", "Sessions — every session in the slice");
    go("/tools", "Tools — call volume, latency, failures");
    go("/compare", "Compare — two sessions side by side");

    for (const p of PRESETS) {
      out.push({
        id: `range:${p.id}`,
        group: "window",
        label: `window: last ${p.id === "all" ? "everything" : p.label}`,
        run: () => {
          setPreset(p.id);
          onClose();
        },
      });
    }
    out.push({ id: "clear", group: "window", label: "clear filters and window", run: () => { reset(); onClose(); } });
    out.push({
      id: "last-7-of-all",
      group: "window",
      label: "window: the last 7 days (absolute)",
      run: () => {
        const to = Date.now();
        setWindow(to - 7 * 86_400_000, to);
        onClose();
      },
    });

    const f: Facets | undefined = facets.data;
    for (const p of f?.projects.slice(0, 40) ?? []) {
      out.push({
        id: `project:${p.project}`,
        group: "filter project",
        label: p.project,
        hint: `${p.sessions} sessions`,
        run: () => {
          setFacet("project", p.project);
          onClose();
        },
      });
    }
    for (const m of f?.models ?? []) {
      out.push({
        id: `model:${m.id}`,
        group: "filter model",
        label: m.label,
        hint: `${int(m.calls)} turns`,
        run: () => {
          setFacet("model", m.id);
          onClose();
        },
      });
    }
    for (const a of f?.agents ?? []) {
      out.push({
        id: `agent:${a.agent}`,
        group: "filter agent",
        label: a.agent,
        hint: `${int(a.calls)} turns`,
        run: () => {
          setFacet("agent", a.agent);
          onClose();
        },
      });
    }
    for (const t of f?.tools ?? []) {
      out.push({
        id: `tool:${t.name}`,
        group: "tool",
        label: t.name,
        hint: `${int(t.calls)} calls`,
        run: () => {
          navigate(href(`/tools/${encodeURIComponent(t.name)}`));
          onClose();
        },
      });
    }
    return out;
  }, [facets.data, href, navigate, onClose, reset, setFacet, setPreset, setWindow]);

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(
    () => (needle ? commands.filter((c) => `${c.label} ${c.group}`.toLowerCase().includes(needle)) : commands).slice(0, 60),
    [commands, needle]
  );

  const sessionHits = debounced.trim().length >= 2 ? hits.data?.hits ?? [] : [];

  const items = useMemo(
    () => [
      ...sessionHits.map((h) => ({
        id: `session:${h.id}`,
        group: "session",
        label: h.title ?? h.id,
        hint: `${h.project} · ${h.hits} matches · ${ago(h.updated)}`,
        run: () => {
          navigate(href(`/sessions/${h.id}`));
          onClose();
        },
      })),
      ...filtered,
    ],
    [sessionHits, filtered, href, navigate, onClose]
  );

  useEffect(() => setCursor(0), [needle, debounced]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 pt-[10vh]" onClick={onClose}>
      <div
        className="hairline w-[min(720px,92vw)] bg-paper-raised shadow-[0_2px_0_var(--color-rule-strong)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-rule px-2 py-1.5">
          <span className="tape text-ink-faint">⌕</span>
          <input
            autoFocus
            className="tape min-w-0 flex-1 border-0 bg-transparent outline-none"
            placeholder="search transcripts, jump to a tool, change the window or a filter…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(items.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                items[cursor]?.run();
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
            spellCheck={false}
          />
          {hits.isFetching && <span className="tape shrink-0 text-ink-faint">searching…</span>}
          <span className="tape shrink-0 text-ink-faint">↑↓ ↵ esc</span>
        </div>
        <div ref={listRef} className="no-scrollbar max-h-[56vh] overflow-y-auto">
          {items.length === 0 ? (
            <div className="tape p-3 text-ink-faint">
              nothing matches {needle ? `“${q}”` : "yet"}
              {debounced.trim().length >= 2 && !hits.isFetching ? " — no transcript mentions it" : ""}
            </div>
          ) : (
            items.map((item, i) => (
              <div key={item.id}>
                {(i === 0 || items[i - 1].group !== item.group) && (
                  <div className="micro sticky top-0 bg-paper px-2 py-1">{item.group}</div>
                )}
                <button
                  type="button"
                  data-i={i}
                  onMouseEnter={() => setCursor(i)}
                  onClick={item.run}
                  className={clsx(
                    "flex w-full items-baseline gap-2 px-2 py-1 text-left",
                    i === cursor ? "bg-flow/10" : "hover:bg-ink/5"
                  )}
                >
                  <span className="tape min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="tape shrink-0 text-ink-faint">{item.hint}</span>}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
