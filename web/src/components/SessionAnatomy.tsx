import { useMemo, useRef, useState } from "react";
import { scaleLinear } from "d3-scale";
import { useQueryClient } from "@tanstack/react-query";
import { useCockpit } from "../state/CockpitContext";
import { useSession, type EventRow, type ToolRow, type TurnRow } from "../lib/api";
import { clock, compact, duration, money, pct, shortModel } from "../lib/format";
import { Crosshair, Spinner } from "./ui";

const BAND_H = 150;
const PROBE_H = 34;

const SEG = [
  { key: "cache_read", label: "CACHE READ", color: "oklch(0.78 0.06 240)" },
  { key: "input", label: "INPUT", color: "oklch(0.42 0.14 258)" },
  { key: "output", label: "OUTPUT", color: "oklch(0.62 0.13 190)" },
  { key: "reasoning", label: "REASONING", color: "oklch(0.6 0.06 220)" },
  { key: "cache_write", label: "CACHE WRITE", color: "oklch(0.45 0.13 300)" },
] as const;

/** System 2 — single-session dissection: health band + event probes + agent tree. */
export default function SessionAnatomy({ id }: { id: string }) {
  const { openSession, setMode, callId, setCallId } = useCockpit();
  const { data } = useSession(id);
  const [hoverEvent, setHoverEvent] = useState<EventRow | null>(null);
  const [flash, setFlash] = useState(0);
  const bandRef = useRef<HTMLDivElement>(null);

  const turns = useMemo(() => (data?.turns ?? []).filter((t) => t.session_id === id), [data, id]);
  const events = useMemo(() => (data?.events ?? []).filter((e) => e.session_id === id), [data, id]);

  const geom = useMemo(() => {
    if (turns.length < 1) return null;
    const t0 = turns[0].created;
    const t1 = Math.max(turns[turns.length - 1].created, t0 + 60000);
    return { x: scaleLinear().domain([t0, t1]).range([0, 1]), t0, t1 };
  }, [turns]);

  const overloadFailures = events.filter((e) => e.type === "failure" && e.fill >= 0.8);
  const compactions = events.filter((e) => e.type === "compaction");
  const retries = events.filter((e) => e.type === "retry");

  const chart = useMemo(() => {
    if (!callId) return null;
    const tool = (data?.tools ?? []).find((t) => t.call_id === callId) ?? null;
    const turn = tool ? turns.find((t) => t.id === tool.turn_id) ?? null : null;
    return { tool, turn };
  }, [callId, data, turns]);

  if (!data) return <Spinner label="剥离会话数据" />;
  if (!geom) return <div className="p-4 tape">该会话没有可解析的轮次数据</div>;

  const width = bandRef.current?.clientWidth ?? 720;
  const X = (ts: number) => geom.x(ts) * width;

  const fillAt = (ts: number): TurnRow | undefined => {
    let last: TurnRow | undefined;
    for (const t of turns) if (t.created <= ts) last = t;
    return last ?? turns[0];
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-paper">
      <header className="shrink-0 border-b border-rule px-3 py-2 flex items-start gap-4">
        <button type="button" onClick={() => setMode("ecg")} className="tape hover:text-danger mt-0.5">
          ← 心电图
        </button>
        <div className="min-w-0 flex-1">
          <div className="micro">{data.session.project} · {clock(data.session.created)} 开启 · {data.session.turns} TURNS · {data.session.tool_calls} TOOLS</div>
          <h1 className="font-mono font-extralight text-[22px] leading-tight truncate">{data.session.title ?? data.session.first_prompt ?? id}</h1>
          {data.session.first_prompt && data.session.title !== data.session.first_prompt && (
            <p className="tape text-ink-soft mt-0.5 line-clamp-2">“{data.session.first_prompt}”</p>
          )}
        </div>
        <div className="flex gap-4 shrink-0 tabular-nums">
          <Metric k="COST" v={money(data.session.cost)} />
          <Metric k="PEAK CTX" v={pct(data.session.peak_fill)} tone={data.session.peak_fill > 0.85 ? "danger" : undefined} />
          <Metric k="EFF" v={`${data.session.eff_score.toFixed(1)}%`} tone={data.session.eff_score < 5 ? "danger" : undefined} />
          <Metric k="DIFF" v={`${data.session.additions ?? 0}+/${data.session.deletions ?? 0}-`} />
        </div>
      </header>

      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "minmax(0,1fr) 232px" }}>
        <div className={`min-w-0 overflow-y-auto no-scrollbar p-3 ${flash ? "flash-amber" : ""}`}>
          {/* ---------------- context health band ---------------- */}
          <div className="flex items-baseline justify-between mb-1">
            <span className="micro">CONTEXT HEALTH BAND · 上下文健康度剖面</span>
            <span className="tape text-ink-faint">
              窗口 {compact(turns[0]?.context_window ?? 0)} TK · {duration(geom.t1 - geom.t0)}
            </span>
          </div>

          <div ref={bandRef} className="relative hairline bg-paper-raised" style={{ height: BAND_H + PROBE_H }}>
            {/* probe layer */}
            <div className="absolute left-0 right-0 top-0" style={{ height: PROBE_H }}>
              {compactions.map((e) => (
                <button
                  key={`c${e.id}`}
                  type="button"
                  onMouseEnter={() => {
                    setHoverEvent(e);
                    setFlash(Date.now());
                  }}
                  onMouseLeave={() => setHoverEvent(null)}
                  className="absolute top-1 w-[14px] h-[26px] -translate-x-1/2"
                  style={{ left: X(e.at) }}
                  title="压缩事件"
                >
                  <svg viewBox="0 0 14 26" className="w-full h-full">
                    <line x1="7" y1="0" x2="7" y2="14" stroke="var(--color-warning)" strokeWidth="1" />
                    <path d="M2 13 L7 22 L12 13 Z" fill="var(--color-warning)" />
                  </svg>
                </button>
              ))}
              {retryRuns(retries, X, (run) => (
                <div
                  key={`r${run.from}`}
                  className="absolute top-[13px] h-[1px] bg-danger"
                  style={{ left: run.from, width: Math.max(4, run.to - run.from) }}
                  title={`连续重试 ×${run.count} — 代理卡住 ${duration(run.span)}`}
                >
                  <span className="absolute -top-[9px] left-0 tape text-[8px] text-danger whitespace-nowrap">
                    RETRY ×{run.count}
                  </span>
                  <Crosshair size={9} />
                </div>
              ))}
              {events
                .filter((e) => e.type === "failure")
                .map((e) => {
                  const y = PROBE_H + BAND_H * (1 - e.fill) - 5;
                  return (
                    <button
                      key={`f${e.id}`}
                      type="button"
                      onMouseEnter={() => setHoverEvent(e)}
                      onMouseLeave={() => setHoverEvent(null)}
                      className="absolute w-[11px] h-[11px] -translate-x-1/2 grid place-items-center"
                      style={{ left: X(e.at), top: y }}
                      title="失败标记"
                    >
                      <Crosshair size={11} />
                    </button>
                  );
                })}
            </div>

            {/* band body */}
            <svg className="absolute left-0 right-0" style={{ top: PROBE_H }} width={width} height={BAND_H}>
              <rect x={0} y={0} width={width} height={BAND_H * 0.2} fill="oklch(0.55 0.22 25 / 0.05)" />
              <line x1={0} x2={width} y1={BAND_H * 0.2} y2={BAND_H * 0.2} stroke="oklch(0.55 0.22 25 / 0.45)" strokeDasharray="3 3" />
              {turns.map((t, i) => {
                const w = Math.max(1.6, X(t.created) - X(turns[i - 1]?.created ?? t.created));
                const h = BAND_H * Math.min(1, t.fill);
                const total = Math.max(1, SEG.reduce((a, s) => a + (t[s.key] as number), 0));
                let acc = 0;
                const rects = SEG.map((s) => {
                  const v = (t[s.key] as number) / total;
                  const y0 = h * acc;
                  acc += v;
                  return <rect key={s.key} x={X(t.created)} y={BAND_H - y0 - h * v} width={w} height={Math.max(0, h * v)} fill={s.color} />;
                });
                const isPeak = t.fill >= 0.8;
                return (
                  <g
                    key={t.id}
                    onMouseEnter={() => setHoverEvent(null)}
                    onClick={() => {
                      const firstTool = (data.tools ?? []).find((x) => x.turn_id === t.id);
                      if (firstTool) setCallId(firstTool.call_id);
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <rect x={X(t.created)} y={0} width={w} height={BAND_H} fill="transparent" />
                    {rects}
                    {isPeak && (
                      <rect
                        x={X(t.created)}
                        y={BAND_H - h}
                        width={w}
                        height={h}
                        fill="url(#hazard)"
                      />
                    )}
                    {t.has_error ? <rect x={X(t.created)} y={BAND_H - 2} width={w} height={2} fill="var(--color-danger)" /> : null}
                    {t.tool_calls > 0 ? (
                      <rect x={X(t.created)} y={BAND_H - 6} width={w} height={1} fill="oklch(0.2 0.05 250 / 0.55)" />
                    ) : null}
                  </g>
                );
              })}
              <defs>
                <pattern id="hazard" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="6" height="6" fill="transparent" />
                  <line x1="0" y1="0" x2="0" y2="6" stroke="oklch(0.55 0.22 25 / 0.55)" strokeWidth="1.5" />
                </pattern>
              </defs>
            </svg>

            {/* y axis labels */}
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <div
                key={f}
                className="absolute right-0 tape text-[8px] text-ink-faint bg-paper-raised/80 px-0.5 -translate-y-1/2"
                style={{ top: PROBE_H + BAND_H * (1 - f) }}
              >
                {(f * 100).toFixed(0)}%
              </div>
            ))}

            {hoverEvent && (
              <div
                className="absolute z-20 hairline bg-paper px-2 py-1.5 w-[290px] pointer-events-none"
                style={{ left: Math.max(4, Math.min(width - 296, X(hoverEvent.at) - 145)), top: 2 }}
              >
                <div className="flex items-baseline justify-between">
                  <span className="micro">{hoverEvent.type.toUpperCase()} @ {clock(hoverEvent.at)}</span>
                  <span className="tape text-ink">CTX {pct(hoverEvent.fill)}</span>
                </div>
                <div className="tape mt-1 leading-[1.45]">
                  {describeEvent(hoverEvent, turns, fillAt, compactions)}
                </div>
              </div>
            )}
          </div>

          {/* legend */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
            {SEG.map((s) => (
              <span key={s.key} className="tape text-ink-soft flex items-center gap-1">
                <span className="w-2 h-2" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
            <span className="tape text-ink-soft flex items-center gap-1 ml-auto">
              <span className="w-2 h-2 hazard inline-block" /> ≥80% 过载
            </span>
          </div>

          {overloadFailures.length >= 2 && (
            <div className="mt-2 border border-danger px-2 py-1.5 flex items-center gap-2">
              <Crosshair size={12} />
              <span className="tape text-danger leading-[1.4]">
                上下文过载：{overloadFailures.length} 次工具失败集中在填充率 ≥80% 区间 —— 工具调用质量已被上下文挤压拖累。
              </span>
            </div>
          )}

          {/* ---------------- efficiency + timeline ---------------- */}
          <div className="grid grid-cols-[168px_minmax(0,1fr)] gap-3 mt-3">
            <EfficiencyRing score={data.session.eff_score} output={turns.reduce((a, t) => a + t.output + t.reasoning, 0)} prompt={turns.reduce((a, t) => a + t.prompt_total, 0)} />
            <TurnTimeline turns={turns} tools={data.tools ?? []} callId={callId} onPick={setCallId} />
          </div>

          {/* ---------------- medical chart for one tool call ---------------- */}
          {chart?.tool && (
            <div className="mt-3 hairline bg-paper-raised p-2">
              <div className="flex items-baseline gap-3">
                <span className="micro">病历 · TOOL CALL</span>
                <span className="tape text-ink">{chart.tool.name}</span>
                <span className={`tape ml-auto ${chart.tool.status === "error" ? "text-danger" : "text-ink-faint"}`}>
                  {chart.tool.status.toUpperCase()}
                </span>
                <button type="button" className="tape hover:text-danger" onClick={() => setCallId(null)}>
                  ×
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2 mt-2 tabular-nums">
                <Metric k="耗时" v={duration(chart.tool.dur_ms)} />
                <Metric k="输出字符" v={compact(chart.tool.output_chars)} />
                <Metric k="DIFF" v={`${chart.tool.additions}+/${chart.tool.deletions}-`} />
                <Metric k="轮次填充" v={pct(chart.turn?.fill ?? 0)} tone={(chart.turn?.fill ?? 0) > 0.8 ? "danger" : undefined} />
              </div>
              {chart.tool.title && <div className="tape text-ink-soft mt-1.5 truncate">{chart.tool.title}</div>}
              {chart.tool.error && (
                <pre className="mt-1.5 tape text-danger whitespace-pre-wrap break-all max-h-[120px] overflow-auto no-scrollbar border-t border-danger/30 pt-1.5">
                  {chart.tool.error}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* ---------------- agent tree ---------------- */}
        <aside className="hairline-l overflow-y-auto no-scrollbar">
          <div className="px-2 py-1.5 border-b border-rule micro">SUBAGENTS · 代理分叉</div>
          <TreeItem label={data.session.title ?? id} active onSelect={() => openSession(id)} meta={`${data.session.turns} T`} />
          {data.children.map((c) => (
            <TreeItem
              key={c.id}
              label={c.title ?? c.id}
              meta={`${c.turns} T · ${money(c.cost)}`}
              onSelect={() => openSession(c.id)}
            />
          ))}
          {!data.children.length && <div className="px-2 py-1.5 tape text-ink-faint">无子代理分叉</div>}

          <div className="px-2 py-1.5 border-y border-rule micro">PROBE LOG · 事件流水</div>
          <div className="px-2 py-1.5">
            {events.length === 0 && <div className="tape text-ink-faint">窗口内无异常事件</div>}
            {events
              .slice()
              .reverse()
              .slice(0, 40)
              .map((e) => (
                <div
                  key={e.id}
                  className="flex items-baseline gap-1.5 py-[3px] border-b border-rule/60"
                  onMouseEnter={() => setHoverEvent(e)}
                  onMouseLeave={() => setHoverEvent(null)}
                >
                  <span
                    className={`w-1.5 h-1.5 shrink-0 ${
                      e.type === "failure" ? "bg-danger" : e.type === "compaction" ? "bg-warning" : e.type === "retry" ? "bg-danger/60" : "bg-ink-faint"
                    }`}
                  />
                  <span className="tape text-[9px] shrink-0">{clock(e.at)}</span>
                  <span className="tape text-ink-soft truncate flex-1">{e.type}</span>
                  <span className="tape text-[9px] tabular-nums shrink-0">{pct(e.fill)}</span>
                </div>
              ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Metric({ k, v, tone }: { k: string; v: string; tone?: "danger" }) {
  return (
    <div>
      <div className="micro">{k}</div>
      <div className={`font-mono font-extralight text-[18px] leading-none tabular-nums ${tone === "danger" ? "text-danger" : ""}`}>{v}</div>
    </div>
  );
}

function TreeItem({
  label,
  meta,
  active,
  onSelect,
}: {
  label: string;
  meta?: string;
  active?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-2 py-1.5 border-b border-rule hover:bg-paper-raised ${active ? "bg-ink text-paper" : ""}`}
    >
      <div className="tape truncate leading-[1.35]">{label}</div>
      {meta && <div className={`micro mt-0.5 ${active ? "text-paper/70" : ""}`}>{meta}</div>}
    </button>
  );
}

function EfficiencyRing({ score, output, prompt }: { score: number; output: number; prompt: number }) {
  const R = 52;
  const C = 2 * Math.PI * R;
  const v = Math.min(1, score / 100);
  const danger = score < 5;
  return (
    <div className="hairline bg-paper-raised p-2 flex flex-col items-center">
      <div className="micro self-start">上下文效率评分</div>
      <svg width="128" height="128" viewBox="0 0 128 128" className="mt-1">
        <circle cx="64" cy="64" r={R} fill="none" stroke="oklch(0.2 0.05 250 / 0.12)" strokeWidth="10" />
        <circle
          cx="64"
          cy="64"
          r={R}
          fill="none"
          stroke={danger ? "var(--color-danger)" : score > 15 ? "var(--color-good)" : "var(--color-ink)"}
          strokeWidth="10"
          strokeDasharray={`${C * v} ${C}`}
          transform="rotate(-90 64 64)"
          style={{ transition: "stroke-dasharray 520ms cubic-bezier(.22,1,.36,1)" }}
        />
        <text x="64" y="60" textAnchor="middle" className="font-mono" fontSize="30" fontWeight="200" fill={danger ? "var(--color-danger)" : "var(--color-ink)"}>
          {score.toFixed(1)}
        </text>
        <text x="64" y="76" textAnchor="middle" fontSize="8" letterSpacing="2" fill="oklch(0.42 0.03 250)">
          % EFFECTIVE
        </text>
      </svg>
      <div className="tape text-ink-soft text-center leading-[1.5] mt-1 tabular-nums">
        有效输出 {compact(output)} / 上下文 {compact(prompt)}
      </div>
      {danger && <div className="tape text-danger text-center mt-1 leading-[1.4]">红灯：AI 在大量空转，建议收紧 Prompt 或清理无用输出</div>}
    </div>
  );
}

function TurnTimeline({
  turns,
  tools,
  callId,
  onPick,
}: {
  turns: TurnRow[];
  tools: ToolRow[];
  callId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="hairline bg-paper-raised overflow-y-auto no-scrollbar max-h-[260px]">
      <div className="px-2 py-1.5 border-b border-rule micro sticky top-0 bg-paper-raised">TURNS · 轮次时间线</div>
      {turns.map((t) => {
        const ts = tools.filter((x) => x.turn_id === t.id);
        return (
          <div key={t.id} className="px-2 py-1.5 border-b border-rule/60">
            <div className="flex items-baseline gap-2">
              <span className="tape text-ink-faint tabular-nums">{clock(t.created)}</span>
              <span className="tape">{shortModel(t.model)}</span>
              <span className={`tape ml-auto tabular-nums ${t.fill > 0.8 ? "text-danger" : "text-ink-soft"}`}>CTX {pct(t.fill)}</span>
            </div>
            <div className="flex flex-wrap gap-1 mt-1">
              {ts.map((x) => (
                <button
                  key={x.call_id}
                  type="button"
                  onClick={() => onPick(x.call_id)}
                  className={`tape px-1 border ${
                    callId === x.call_id
                      ? "border-ink bg-ink text-paper"
                      : x.status === "error"
                        ? "border-danger/50 text-danger"
                        : "border-rule text-ink-soft hover:border-rule-strong"
                  }`}
                  title={`${x.name} · ${duration(x.dur_ms)}${x.title ? ` · ${x.title}` : ""}`}
                >
                  {x.name}
                  {x.additions + x.deletions > 0 ? ` ${x.additions}+${x.deletions}-` : ""}
                </button>
              ))}
              {!ts.length && <span className="tape text-ink-faint">no tools · {t.finish ?? "—"}</span>}
            </div>
            {t.text ? <p className="tape text-ink-soft mt-1 line-clamp-2 leading-[1.4]">{t.text}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

interface RetryRun {
  from: number;
  to: number;
  count: number;
  span: number;
}

/** Consecutive retries (same call within 2 min) collapse into one "stuck agent" bar. */
function retryRuns(
  retries: EventRow[],
  X: (ts: number) => number,
  render: (run: RetryRun) => React.ReactNode
) {
  const runs: RetryRun[] = [];
  let t0 = 0;
  let t1 = 0;
  for (const e of [...retries].sort((a, b) => a.at - b.at)) {
    const last = runs[runs.length - 1];
    if (last && e.at - t1 < 120000) {
      last.to = X(e.at);
      last.count += 1;
      t1 = e.at;
      last.span = t1 - t0;
    } else {
      runs.push({ from: X(e.at), to: X(e.at), count: 1, span: 0 });
      t0 = e.at;
      t1 = e.at;
    }
  }
  return runs.map((r, i) => render(r));
}

function describeEvent(
  e: EventRow,
  turns: TurnRow[],
  fillAt: (ts: number) => TurnRow | undefined,
  compactions: EventRow[]
): string {
  const detail = (() => {
    try {
      return JSON.parse(e.detail ?? "{}");
    } catch {
      return {};
    }
  })();
  const before = fillAt(e.at);
  if (e.type === "compaction") {
    const after = turns.find((t) => t.created > e.at);
    const busy = before?.tool_calls ? "正在执行工具调用" : "等待续写";
    return `上下文达 ${pct(e.fill)}，触发${detail.reason === "auto" ? "自动" : "手动"}压缩。${
      after ? `压缩前 ${compact(before?.occupancy ?? 0)} → 压缩后 ${compact(after.occupancy)}。` : ""
    }触发时${busy}。`;
  }
  if (e.type === "failure") return `${detail.tool ?? "tool"} 在填充率 ${pct(e.fill)} 处失败：${(detail.error ?? "").slice(0, 120)}`;
  if (e.type === "retry") return `${detail.tool ?? "tool"} 重复调用（相同参数）— 代理在此打转。`;
  if (e.type === "error") return `提供方错误：${detail.reason ?? ""} ${(detail.detail ?? "").slice(0, 90)}`;
  return `${e.type} @ ${pct(e.fill)} ${(detail.detail ?? "").slice(0, 90)}`;
}
