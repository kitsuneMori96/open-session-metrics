import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { refresh, useStatus } from "./lib/api";
import { setMoneyUnit } from "./lib/format";
import { makeClient } from "./lib/query";
import {
  ScopeContext,
  commitSource,
  fetchSources,
  rememberSlice,
  storedSlice,
  storedSource,
  type SourceKind,
  type SourceList,
  type ScopeValue,
} from "./lib/scope";
import { useKeys } from "./lib/useKeys";
import { useSliceHref } from "./lib/slice";
import { NAV, SliceBar, TopBar } from "./components/Chrome";
import Palette from "./components/Palette";
import Overview from "./screens/Overview";
import Sessions from "./screens/Sessions";
import SessionDetail from "./screens/SessionDetail";
import Tools from "./screens/Tools";
import Compare from "./screens/Compare";

/**
 * The shell.
 *
 * Four routes plus a deep link for every session, one slice bar above all of them,
 * and one scope above the slice bar: which store the whole panel reads. The keymap
 * survives: 1–4 navigate, `/` opens the palette, `r` re-materializes the store,
 * Escape dismisses overlays.
 *
 * The scope is resolved *before* the first paint, because everything downstream
 * depends on it — the cache it reads, the unit it prints in, the slice it restores.
 * That is one local request, not a spinner.
 */
export default function App() {
  const boot = useBootScope();
  if (!boot) {
    return (
      <div className="grid-paper flex h-full min-h-0 flex-col">
        <div className="hairline-b h-9 shrink-0 bg-paper-raised/85" />
      </div>
    );
  }
  return <ScopeHost boot={boot} />;
}

interface Boot {
  list: SourceList;
  kind: SourceKind;
}

function useBootScope(): Boot | null {
  const [boot, setBoot] = useState<Boot | null>(null);
  useEffect(() => {
    let alive = true;
    fetchSources()
      .then((list) => {
        if (!alive) return;
        const stored = storedSource();
        // A remembered source that is no longer installed must not strand the panel
        // on an empty store: fall back to the server's default, then to anything.
        const pick =
          list.sources.find((s) => s.kind === stored && s.available) ??
          list.sources.find((s) => s.kind === list.default) ??
          list.sources[0];
        const kind = pick?.kind ?? list.default;
        commitSource(kind);
        setBoot({ list, kind });
      })
      .catch(() => {
        // The server is down or still starting. Draw the shell for the remembered
        // source anyway; every panel reports its own failure.
        const kind = storedSource() ?? "opencode";
        commitSource(kind);
        if (alive) setBoot({ list: { default: kind, sources: [] }, kind });
      });
    return () => {
      alive = false;
    };
  }, []);
  return boot;
}

/**
 * Owns the scope: the committed source, the per-source cache, and the per-source slice.
 *
 * A switch is three things at once and they have to happen in one commit, or one
 * frame is drawn with the new numbers in the old currency:
 *   1. remember the outgoing source's slice,
 *   2. set the unit from the incoming store,
 *   3. throw the cache away and remount the tree under the new scope.
 */
function ScopeHost({ boot }: { boot: Boot }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [kind, setKind] = useState<SourceKind>(boot.kind);
  const [list, setList] = useState<SourceList>(boot.list);
  const [client, setClient] = useState(makeClient);

  // The slice belongs to the source: keep the outgoing one as the URL changes, so
  // switching away and back returns to the window and filters you left.
  useEffect(() => {
    rememberSlice(kind, location.search);
  }, [kind, location.search]);

  const reload = useCallback(async () => {
    try {
      setList(await fetchSources());
    } catch {
      // The menu keeps its last snapshot; the panels keep theirs.
    }
  }, []);

  const switchTo = useCallback(
    (next: SourceKind) => {
      if (next === kind) return;
      rememberSlice(kind, location.search);
      const target = list.sources.find((s) => s.kind === next);
      // The unit is a property of the store. Set it before the new scope mounts.
      setMoneyUnit(target?.unit ?? null);
      commitSource(next);
      setKind(next);
      setClient(makeClient());
      // A session id belongs to one store. Switching while reading one drops back to
      // the list rather than asking the other store for a session it cannot have.
      const pathname = /^\/sessions\/[^/]+$/.test(location.pathname) ? "/sessions" : location.pathname;
      navigate({ pathname, search: storedSlice(next) }, { replace: true });
    },
    [kind, list, location.pathname, location.search, navigate]
  );

  const scope = useMemo<ScopeValue>(
    () => ({ kind, list, active: list.sources.find((s) => s.kind === kind), switchTo, reload }),
    [kind, list, switchTo, reload]
  );

  // A store that has never been built is built by the switch that asked for it, not
  // at boot: a user who never opens the second source never pays for its parse.
  const active = scope.active;
  useEffect(() => {
    if (!active?.available || active.ready) return;
    let alive = true;
    void (async () => {
      try {
        await refresh(false);
        if (!alive) return;
        await reload();
        if (!alive) return;
        await client.invalidateQueries();
      } catch {
        // The header keeps saying `first build`; sync is one click away.
      }
    })();
    return () => {
      alive = false;
    };
  }, [active?.available, active?.ready, client, reload]);

  return (
    <QueryClientProvider client={client}>
      <ScopeContext.Provider value={scope}>
        {/* A new scope is a new store: nothing held in component state survives it. */}
        <Shell key={kind} />
      </ScopeContext.Provider>
    </QueryClientProvider>
  );
}

function Shell() {
  const [palette, setPalette] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const href = useSliceHref();
  const qc = useQueryClient();
  const status = useStatus();

  // The unit is a property of the store (`meta.unit`), declared once by the server.
  // It is written here, during the render that first sees the status, and not in an
  // effect: an effect runs after the children have already printed their figures, so
  // a store that bills in credits would paint one frame of `$`. Writing it before the
  // children render means every number below reads the right unit on the first pass.
  setMoneyUnit(status.data?.unit);

  const sync = useCallback(async () => {
    try {
      await refresh(false);
      await qc.invalidateQueries();
    } catch {
      // keep showing the last good snapshot
    }
  }, [qc]);

  useKeys((e) => {
    const hit = NAV.find((n) => n.key === e.key);
    if (hit) {
      navigate(href(hit.to));
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      setPalette(true);
      return;
    }
    if (e.key === "r") {
      void sync();
      return;
    }
    if (e.key === "Escape") setPalette(false);
  });

  return (
    <div className="grid-paper flex h-full min-h-0 flex-col">
      <TopBar onPalette={() => setPalette(true)} />
      <SliceBar />
      <main className="flex min-h-0 flex-1 flex-col">
        <Routes>
          <Route path="/" element={<Navigate to={`/overview${location.search}`} replace />} />
          <Route path="/overview" element={<Overview />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/tools/:name" element={<Tools />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="*" element={<Navigate to={`/overview${location.search}`} replace />} />
        </Routes>
      </main>
      {palette && <Palette onClose={() => setPalette(false)} />}
    </div>
  );
}
