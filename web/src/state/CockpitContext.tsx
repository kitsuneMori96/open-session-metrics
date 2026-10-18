import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { DAY, type TimeWindow } from "../lib/api";

const END = Date.now();

export type ViewMode = "ecg" | "anatomy";

interface Cockpit {
  window: TimeWindow;
  setWindow: (w: TimeWindow) => void;
  preset: (days: number) => void;
  spanDays: number;
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  sessionId: string | null;
  openSession: (id: string | null) => void;
  trayOpen: boolean;
  setTrayOpen: (v: boolean) => void;
  /** Tool call id selected in the anatomy view — drives the medical-chart card. */
  callId: string | null;
  setCallId: (id: string | null) => void;
}

const Ctx = createContext<Cockpit | null>(null);

export function CockpitProvider({ children }: { children: ReactNode }) {
  const [window, setWindow] = useState<TimeWindow>({ from: END - 30 * DAY, to: END });
  const [mode, setMode] = useState<ViewMode>("ecg");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [trayOpen, setTrayOpen] = useState(false);
  const [callId, setCallId] = useState<string | null>(null);

  const preset = useCallback((days: number) => {
    const to = Date.now();
    setWindow({ from: to - days * DAY, to });
  }, []);

  const openSession = useCallback((id: string | null) => {
    setSessionId(id);
    setCallId(null);
    if (id) setMode("anatomy");
  }, []);

  const value = useMemo<Cockpit>(
    () => ({
      window,
      setWindow,
      preset,
      spanDays: Math.max(1, Math.round((window.to - window.from) / DAY)),
      mode,
      setMode,
      sessionId,
      openSession,
      trayOpen,
      setTrayOpen,
      callId,
      setCallId: (id) => { setCallId(id); },
    }),
    [window, preset, mode, sessionId, openSession, trayOpen, callId]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCockpit(): Cockpit {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCockpit must be used inside CockpitProvider");
  return ctx;
}
