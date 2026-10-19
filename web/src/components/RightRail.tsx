import { useMemo, useState } from "react";
import { useCockpit } from "../state/CockpitContext";
import { useConversion, useSessions } from "../lib/api";
import { compact, dateShort, money, pct, shortModel } from "../lib/format";
import { Chip, Panel } from "./ui";

type Sort = "tokens" | "fill" | "eff" | "recent";

/** Right rail — the micro-anatomy launcher: pick a session, or read the live probe. */
export default function RightRail() {
  const { window, sessionId, openSession } = useCockpit();
  const { data: sessions } = useSessions(window);
  const { data: conv } = useConversion(window);
  const [sort, setSort] = useState<Sort>("recent");
  const [query, setQuery] = useState("");

  const ranked = useMemo(() => {
    const term = query.trim().toLowerCase();
    const list = (sessions ?? []).filter(
      (s) => !term || (s.title ?? "").toLowerCase().includes(term) || (s.first_prompt ?? "").toLowerCase().includes(term)
    );
    // "recent" means last activity, not creation — a long-running session is still live.
    const key = (s: (typeof list)[number]) =>
      sort === "tokens" ? s.cost : sort === "fill" ? s.peak_fill : sort === "eff" ? -s.eff_score : s.updated;
    return [...list].sort((a, b) => key(b) - key(a)).slice(0, 60);
  }, [sessions, sort, query]);

  const padded = conv?.padded ?? [];

  return (
    <aside className="hairline-l bg-paper flex flex-col min-h-0">
      <Panel
        title={`SESSIONS · 会话解剖入口 (${sessions?.length ?? 0})`}
        right={
          <div className="flex gap-1">
            {(["recent", "fill", "eff", "tokens"] as Sort[]).map((s) => (
              <Chip key={s} active={sort === s} onClick={() => setSort(s)}>
                {s === "fill" ? "过载" : s === "tokens" ? "花费" : s === "eff" ? "空转" : "最新"}
              </Chip>
            ))}
          </div>
        }
        className="flex-1 min-h-0"
      >
        <div className="flex flex-col h-full min-h-0">
          <div className="px-2 py-1.5 border-b border-rule">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 PROMPT / 标题…"
              className="w-full tape bg-transparent outline-none border-b border-rule focus:border-ink py-0.5 placeholder:text-ink-faint"
            />
          </div>
          <div className="flex-1 overflow-y-auto no-scrollbar">
            {ranked.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => openSession(s.id)}
                className={`w-full text-left px-2 py-1.5 border-b border-rule hover:bg-paper-raised ${
                  sessionId === s.id ? "bg-ink text-paper" : ""
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className={`micro ${sessionId === s.id ? "text-paper" : "text-ink-faint"}`}>
                    {dateShort(s.created)}
                  </span>
                  <span className="tape truncate flex-1">{s.title ?? s.first_prompt ?? s.id}</span>
                  <span className="tape tabular-nums shrink-0">{money(s.cost)}</span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`micro ${sessionId === s.id ? "text-paper/70" : ""}`}>{shortModel(s.dominant_model)}</span>
                  <span className={`tape ml-auto tabular-nums ${s.peak_fill > 0.85 && sessionId !== s.id ? "text-danger" : ""}`}>
                    CTX {pct(s.peak_fill)}
                  </span>
                  <span className={`tape tabular-nums ${s.eff_score < 5 && sessionId !== s.id ? "text-danger" : ""}`}>
                    EFF {s.eff_score.toFixed(1)}%
                  </span>
                </div>
                <div className="mt-1 h-[3px] w-full bg-rule/40 relative">
                  <div
                    className="absolute inset-y-0 left-0"
                    style={{
                      width: `${Math.min(100, s.peak_fill * 100)}%`,
                      background: s.peak_fill > 0.85 ? "var(--color-danger)" : sessionId === s.id ? "var(--color-paper)" : "var(--color-ink)",
                    }}
                  />
                </div>
              </button>
            ))}
            {!ranked.length && <div className="p-3 tape text-ink-faint">窗口内没有会话</div>}
          </div>
        </div>
      </Panel>

      <div className="hairline-t p-2 shrink-0">
        <div className="flex items-baseline justify-between">
          <span className="micro">TOKEN / 代码行 转化率</span>
          <span className="readout text-[22px] tabular-nums">{conv ? conv.linesPer10k.toFixed(1) : "—"}</span>
        </div>
        <div className="micro mt-0.5">每 10K TOKEN 换得的 DIFF 行数</div>
        {padded.length > 0 && (
          <div className="mt-1.5">
            <div className="tape text-danger leading-[1.35]">
              ⚠ {padded.length} 个注水会话（花费高、Diff 低）
            </div>
            <button
              type="button"
              className="tape text-left mt-0.5 underline decoration-dotted"
              onClick={() => openSession(padded[0].session)}
            >
              {compact(padded[0].tokens)} TK → {padded[0].lines} 行 · “{(padded[0].title ?? "").slice(0, 28)}”
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
