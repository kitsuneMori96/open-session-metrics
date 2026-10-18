import { AnimatePresence, motion } from "motion/react";
import { CockpitProvider, useCockpit } from "./state/CockpitContext";
import TopBar from "./components/TopBar";
import LeftRail from "./components/LeftRail";
import RightRail from "./components/RightRail";
import EcgCanvas from "./components/EcgCanvas";
import SessionAnatomy from "./components/SessionAnatomy";
import TrayDrawer from "./components/TrayDrawer";

function Stage() {
  const { mode, sessionId, trayOpen } = useCockpit();
  return (
    <div className="h-full flex flex-col bg-paper text-ink overflow-hidden relative">
      <TopBar />
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "280px minmax(0,1fr) 360px" }}>
        <LeftRail />
        <main className="relative min-w-0 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={mode === "anatomy" && sessionId ? `anatomy-${sessionId}` : "ecg"}
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.01 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0"
            >
              {mode === "anatomy" && sessionId ? <SessionAnatomy id={sessionId} /> : <EcgCanvas />}
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
