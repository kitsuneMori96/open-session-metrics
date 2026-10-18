import { useCockpit } from "../state/CockpitContext";
import { useRefresh, useStatus } from "../lib/api";
import { Panel } from "./ui";
import ClockHeatmap from "./ClockHeatmap";
import EfficiencyGauge from "./EfficiencyGauge";
import FocusTrace from "./FocusTrace";

export default function LeftRail() {
  const { window } = useCockpit();
  const { data: status } = useStatus();
  const refresh = useRefresh();
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
        {status?.counts?.sessions ?? 0} SESSIONS · {status?.mode ?? "—"}
        <br />
        MATERIALIZED {status?.materializedAt ? new Date(status.materializedAt).toLocaleTimeString("zh-CN") : "—"}
        <div className="flex gap-1 mt-1.5">
          <button
            type="button"
            onClick={() => refresh.mutate(false)}
            disabled={refresh.isPending}
            className="flex-1 tape border border-rule py-1 text-ink-soft hover:border-rule-strong disabled:text-ink-faint"
            title="按水位线增量重跑物化"
          >
            {refresh.isPending ? "重算中…" : "增量刷新"}
          </button>
          <button
            type="button"
            onClick={() => refresh.mutate(true)}
            disabled={refresh.isPending}
            className="flex-1 tape border border-rule py-1 text-ink-soft hover:border-rule-strong disabled:text-ink-faint"
            title="全量重建（改价后重算历史轮次）"
          >
            全量重建
          </button>
        </div>
        {refresh.data && (
          <div className="mt-1 text-ink-soft leading-[1.5] break-all">
            {JSON.stringify(refresh.data.report).slice(0, 140)}
          </div>
        )}
      </div>
    </aside>
  );
}
