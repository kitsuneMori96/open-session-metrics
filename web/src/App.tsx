import { AnimatePresence, motion } from "motion/react";
import { CockpitProvider, useCockpit } from "./state/CockpitContext";
import TopBar from "./components/TopBar";
import LeftRail from "./components/LeftRail";
import RightRail from "./components/RightRail";
import EcgCanvas from "./components/EcgCanvas";
import DailyStage from "./components/DailyStage";
import SessionAnatomy from "./components/SessionAnatomy";
import TrayDrawer from "./components/TrayDrawer";

const HOUR_MS = 3_600_000;

function Stage() {
  const { mode, sessionId, trayOpen, window: win } = useCockpit();
  // The stage follows the zoom level: up to half a day the waveform is still readable
  // (spikes are the right glyph for individual operations); anything wider rolls up into
  // bucketed bands, which switch from hours to days on their own as the window grows.
  const wide = win.to - win.from > 12 * HOUR_MS;
  const stage = mode === "anatomy" && sessionId ? `anatomy-${sessionId}` : wide ? "daily" : "ecg";
  return (
    <div className="h-full flex flex-col bg-paper text-ink overflow-hidden relative">
      <TopBar />
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "280px minmax(0,1fr) 360px" }}>
        <LeftRail />
        <main className="relative min-w-0 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={stage}
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.01 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0"
            >
              {mode === "anatomy" && sessionId ? <SessionAnatomy id={sessionId} /> : wide ? <DailyStage /> : <EcgCanvas />}
            </motion.div>
          </AnimatePresence>
        </main>
        <RightRail />
      </div>
      <AnimatePresence>{trayOpen && <TrayDrawer key="tray" />}</AnimatePresence>
    </div>
  );
}

export default function App() {
  return (
    <CockpitProvider>
      <Stage />
    </CockpitProvider>
  );
}
