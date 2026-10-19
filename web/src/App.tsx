import { useCallback, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { refresh } from "./lib/api";
import { useKeys } from "./lib/useKeys";
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
 * Three panels that used to be three screens are now four routes plus a deep link for
 * every session, and one slice bar above all of them. The keymap survives: 1–4 navigate,
 * `/` opens the palette, `r` re-materializes the store, Escape dismisses overlays.
 */
export default function App() {
  const [palette, setPalette] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

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
      navigate(hit.to);
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
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<Overview />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/tools/:name" element={<Tools />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </main>
      {palette && <Palette onClose={() => setPalette(false)} />}
    </div>
  );
}
