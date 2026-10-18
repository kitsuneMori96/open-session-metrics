import { useCockpit } from "../state/CockpitContext";
import { useStatus } from "../lib/api";
import { Panel } from "./ui";
import ClockHeatmap from "./ClockHeatmap";
import EfficiencyGauge from "./EfficiencyGauge";
import FocusTrace from "./FocusTrace";

export default function LeftRail() {
  const { window } = useCockpit();
  const { data: status } = useStatus();
  return (
    <aside className="hairline-r bg-paper flex flex-col min-h-0 overflow-y-auto no-scrollbar">
      <Panel title="BIOSWARM · 生物钟吞金兽">
        <ClockHeatmap />
      </Panel>
      <Panel title="EFFICIENCY · 上下文效率" className="border-t-0">
        <EfficiencyGauge />
      </Panel>
      <Panel title="ATTENTION · 注意力集中度" className="border-t-0">
        <FocusTrace window={window} />
      </Panel>
      <div className="p-2 tape text-[9px] text-ink-faint leading-[1.6] mt-auto">
        SOURCE {status?.sourceSchema === "v2" ? "OPENCODE V2" : "V1"} · {status?.counts?.turns ?? 0} TURNS ·{" "}
        {status?.counts?.sessions ?? 0} SESSIONS
        <br />
        MATERIALIZED {status?.materializedAt ? new Date(status.materializedAt).toLocaleTimeString("zh-CN") : "—"}
      </div>
    </aside>
  );
}
