import { useMemo } from "react";
import { useCockpit } from "../state/CockpitContext";
import { useOverview, useSessions } from "../lib/api";
import { compact, pct } from "../lib/format";

/** Context efficiency gauge: effective output ÷ total prompt tokens. */
export default function EfficiencyGauge() {
  const { window, openSession } = useCockpit();
  const { data } = useOverview(window);
  const { data: sessions } = useSessions(window);

  const eff = useMemo(() => {
    const t = data?.totals;
    if (!t) return null;
    const prompt = t.input + t.cache_read + t.cache_write;
    return {
      value: prompt > 0 ? (t.output + t.reasoning) / prompt : 0,
      cacheHit: prompt > 0 ? t.cache_read / prompt : 0,
      prompt,
      output: t.output + t.reasoning,
    };
  }, [data]);

  const spinning = useMemo(() => (sessions ?? []).filter((s) => s.eff_score < 5 && s.turns > 4), [sessions]);
  const R = 34;
  const C = 2 * Math.PI * R;
  const value = eff?.value ?? 0;
  const danger = value > 0 && value < 0.05;
  const tone = danger ? "var(--color-danger)" : value >= 0.15 ? "var(--color-good)" : "var(--color-ink)";

  return (
    <div className="p-2 flex items-center gap-3">
      <svg width="86" height="86" viewBox="0 0 86 86" className="shrink-0">
        <circle cx="43" cy="43" r={R} fill="none" stroke="oklch(0.2 0.05 250 / 0.12)" strokeWidth="7" />
        <circle
          cx="43"
          cy="43"
          r={R}
          fill="none"
          stroke={tone}
          strokeWidth="7"
          strokeDasharray={`${C * Math.min(1, value * 4)} ${C}`}
          transform="rotate(-90 43 43)"
          style={{ transition: "stroke-dasharray 420ms cubic-bezier(.22,1,.36,1)" }}
        />
        <text x="43" y="41" textAnchor="middle" className="font-mono" fontSize="17" fontWeight="200" fill={tone}>
          {(value * 100).toFixed(value < 0.1 ? 1 : 0)}
        </text>
        <text x="43" y="54" textAnchor="middle" fontSize="7" fill="oklch(0.42 0.03 250)" letterSpacing="1">
          % EFFECTIVE
        </text>
      </svg>
      <div className="min-w-0 flex-1">
        <div className="micro">有效输出 / 上下文</div>
        <div className="tape mt-1 leading-[1.5] tabular-nums">
          <Row k="PROMPT" v={compact(eff?.prompt ?? 0)} />
          <Row k="OUTPUT" v={compact(eff?.output ?? 0)} />
          <Row k="CACHE HIT" v={pct(eff?.cacheHit ?? 0)} />
        </div>
        {danger && (
          <button
            type="button"
            onClick={() => spinning[0] && openSession(spinning[0].id)}
            className="tape text-danger text-left mt-1.5 border-t border-danger/30 pt-1.5 w-full hover:underline"
          >
            ⚠ 大量空转：{spinning.length} 个会话有效输出 &lt; 5%
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-ink-faint">{k}</span>
      <span className="text-ink">{v}</span>
    </div>
  );
}
