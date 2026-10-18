import { useState } from "react";
import { motion } from "motion/react";
import { useCockpit } from "../state/CockpitContext";
import { useConversion } from "../lib/api";
import { compact, money, pct } from "../lib/format";
import { Chip } from "./ui";

/** Bottom tray (System 4) — ROI scatter + what-if sandbox live here. */
export default function TrayDrawer() {
  const { setTrayOpen, window } = useCockpit();
  const [tab, setTab] = useState<"roi" | "sandbox">("roi");
  const { data: conv } = useConversion(window);

  return (
    <motion.div
      initial={{ y: 320 }}
      animate={{ y: 0 }}
      exit={{ y: 320 }}
      transition={{ type: "spring", stiffness: 320, damping: 34 }}
      className="absolute inset-x-0 bottom-0 z-30 h-[320px] bg-paper border-t border-ink shadow-[0_-1px_0_oklch(0.2_0.05_250)]"
    >
      <header className="h-[26px] flex items-center gap-2 px-2 border-b border-rule">
        <span className="micro">DECISION TRAY · 决策托盘</span>
        <Chip active={tab === "roi"} onClick={() => setTab("roi")}>
          转化率
        </Chip>
        <Chip active={tab === "sandbox"} onClick={() => setTab("sandbox")}>
          预算沙盘
        </Chip>
        {tab === "roi" && conv && (
          <span className="tape text-ink-faint ml-2 tabular-nums">
            {conv.points.length} 会话 · {compact(conv.points.reduce((a, p) => a + p.tokens, 0))} TK →{" "}
            {conv.points.reduce((a, p) => a + p.lines, 0)} 行 DIFF · 注水 {conv.padded.length}
          </span>
        )}
        <button type="button" onClick={() => setTrayOpen(false)} className="ml-auto tape hover:text-danger">
          关闭 ×
        </button>
      </header>
      <div className="h-[294px] grid place-items-center">
        <div className="text-center">
          <div className="micro">{tab === "roi" ? "散点图 / 回归线" : "What-If 推演"}</div>
          <p className="tape text-ink-soft mt-1 max-w-[420px] leading-[1.5]">
            Phase 4 渲染区：转化率散点 + 偏离回归线的注水会话标红；沙盘旋钮与 Total Cost 实时重算。
            当前 ROI 数据已就绪（{conv ? money(conv.points.reduce((a, p) => a + p.cost, 0)) : "…"} ·
            中位转化率 {conv ? pct(conv.points[Math.floor(conv.points.length / 2)]?.ratio ?? 0) : "…"}）。
          </p>
        </div>
      </div>
    </motion.div>
  );
}
