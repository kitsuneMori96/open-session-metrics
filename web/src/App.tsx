import { useCallback, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { refresh, useStatus } from "./lib/api";
import { useKeys } from "./lib/useKeys";
import TabBar, { type ScreenId } from "./components/TabBar";
import SessionsScreen from "./screens/SessionsScreen";
import ToolsScreen from "./screens/ToolsScreen";
import OverviewScreen from "./screens/OverviewScreen";

/**
 * Three screens behind a tab bar: Sessions, Tools, Overview. All three stay mounted so
 * a selection, a scroll position or a filter survives a tab switch — the same way the
 * TUI keeps every screen in memory behind a key press.
 */
export default function App() {
  const [screen, setScreen] = useState<ScreenId>("sessions");
  const [refreshing, setRefreshing] = useState(false);
  const status = useStatus();
  const qc = useQueryClient();

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh(false);
      await qc.invalidateQueries();
    } finally {
      setRefreshing(false);
    }
  }, [qc]);

  useKeys((e) => {
    if (e.key === "1") return setScreen("sessions");
    if (e.key === "2") return setScreen("tools");
    if (e.key === "3") return setScreen("overview");
    if (e.key === "r") return void doRefresh();
    return;
  });

  const panels: { id: ScreenId; node: ReactNode }[] = [
    { id: "sessions", node: <SessionsScreen active={screen === "sessions"} /> },
    { id: "tools", node: <ToolsScreen active={screen === "tools"} /> },
    { id: "overview", node: <OverviewScreen active={screen === "overview"} /> },
  ];

  return (
    <div className="grid-paper flex h-full flex-col overflow-hidden bg-paper text-ink">
      <TabBar
        screen={screen}
        onScreen={setScreen}
        status={status.data}
        onRefresh={() => void doRefresh()}
        refreshing={refreshing}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        {panels.map((p) => (
          <div key={p.id} className={clsx("min-h-0 flex-1", screen === p.id ? "flex flex-col" : "hidden")}>
            {p.node}
          </div>
        ))}
      </main>
    </div>
  );
}
