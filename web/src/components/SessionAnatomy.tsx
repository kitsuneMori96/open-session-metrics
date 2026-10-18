import { useMemo, useRef, useState } from "react";
import { scaleLinear } from "d3-scale";
import { useCockpit } from "../state/CockpitContext";
import {
  detailOf,
  useSession,
  type EventRow,
  type SessionPayload,
  type ToolRow,
  type TurnRow,
} from "../lib/api";
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
  const [wantText, setWantText] = useState(false);
  const { data } = useSession(id, wantText);
  const [hoverEvent, setHoverEvent] = useState<EventRow | null>(null);
  const [flash, setFlash] = useState(0);
  const bandRef = useRef<HTMLDivElement>(null);

  const turns = useMemo(() => (data?.turns ?? []).filter((t) => t.session_id === id), [data, id]);
  const events = useMemo(() => (data?.events ?? []).filter((e) => e.session_id === id), [data, id]);
  const userText = useMemo(
    () => new Map((data?.prompts ?? []).map((p) => [p.id, p.text])),
    [data]
  );

  const geom = useMemo(() => {
    if (turns.length < 1) return null;
    const t0 = turns[0].created;
    const t1 = Math.max(turns[turns.length - 1].created, t0 + 60000);
    return { x: scaleLinear().domain([t0, t1]).range([0, 1]), t0, t1 };
  }, [turns]);

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

  const compactions = events.filter((e) => e.type === "compaction");
  const retries = events.filter((e) => e.type === "retry");
  const loops = events.filter((e) => e.type === "loop");
  const failures = events.filter((e) => e.type === "failure");

  return (
    <div className="h-full flex flex-col min-h-0 bg-paper">
      <header className="shrink-0 border-b border-rule px-3 py-2 flex items-start gap-4">
        <button type="button" onClick={() => setMode("ecg")} className="tape hover:text-danger mt-0.5">
          ← 心电图
        </button>
        <div className="min-w-0 flex-1">
          <div className="micro">
            {data.session.project} · {clock(data.session.created)} 开启 · {data.session.turns} TURNS · {data.session.tool_calls} TOOLS
          </div>
          <h1 className="font-mono font-extralight text-[22px] leading-tight truncate">
            {data.session.title ?? data.session.first_prompt ?? id}
          </h1>
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
              窗口 {compact(turns.reduce((a, t) => Math.max(a, t.context_window), 0))} TK · {duration(geom.t1 - geom.t0)}
            </span>
          </div>

          <div ref={bandRef} className="relative hairline bg-paper-raised" style={{ height: BAND_H + PROBE_H }}>
            {/* probe layer */}
            <div className="absolute left-0 right-0 top-0" style={{ height: PROBE_H }}>
              {loops.map((e) => (
                <div
                  key={`l${e.id}`}
                  className="absolute top-[3px] h-[8px]"
                  style={{
                    left: X(e.at),
                    width: Math.max(5, X(e.end_at ?? e.at) - X(e.at)),
                    background:
                      "repeating-linear-gradient(45deg, oklch(0.55 0.22 25 / 0.75) 0 3px, oklch(0.55 0.22 25 / 0.25) 3px 6px)",
                  }}
                  title={`卡死循环 ×${e.count}`}
                >
                  <span className="absolute -top-[3px] left-full ml-1 tape text-[8px] text-danger whitespace-nowrap leading-none">
                    LOOP ×{e.count}
                  </span>
                </div>
              ))}
              {compactions.map((e) => (
                <button
                  key={`c${e.id}`}
                  type="button"
                  onMouseEnter={() => {
                    setHoverEvent(e);
                    setFlash(Date.now());
                  }}
                  onMouseLeave={() => setHoverEvent(null)}
                  className="absolute top-[10px] w-[14px] h-[26px] -translate-x-1/2"
                  style={{ left: X(e.at) }}
                  title="压缩事件"
                >
                  <svg viewBox="0 0 14 26" className="w-full h-full">
                    <line x1="7" y1="0" x2="7" y2="14" stroke="var(--color-warning)" strokeWidth="1" />
                    <path d="M2 13 L7 22 L12 13 Z" fill="var(--color-warning)" />
                  </svg>
                </button>
              ))}
              {retries.map((e) => (
                <button
                  key={`r${e.id}`}
                  type="button"
                  onMouseEnter={() => setHoverEvent(e)}
                  onMouseLeave={() => setHoverEvent(null)}
                  className="absolute top-[22px] h-[1px] bg-danger"
                  style={{ left: X(e.at), width: Math.max(4, X(e.end_at ?? e.at) - X(e.at)) }}
                  title={`重试 — 相同调用在 ${duration((e.end_at ?? e.at) - e.at)} 内重发`}
                >
                  <span className="absolute -top-[11px] left-0 tape text-[8px] text-danger whitespace-nowrap leading-none">
                    RETRY{e.count > 1 ? ` ×${e.count}` : ""}
                  </span>
                  <Crosshair size={9} />
                </button>
              ))}
              {failures.map((e) => {
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
                const afterY = BAND_H * (1 - Math.min(1, t.fill_after));
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
                    {isPeak && <rect x={X(t.created)} y={BAND_H - h} width={w} height={h} fill="url(#hazard)" />}
                    {t.fill_after > t.fill ? (
                      <line x1={X(t.created)} x2={X(t.created) + w} y1={afterY} y2={afterY} stroke="oklch(0.62 0.13 190)" strokeWidth={1} />
                    ) : null}
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
                <div className="tape mt-1 leading-[1.45]">{describeEvent(hoverEvent)}</div>
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
            <span className="tape text-ink-soft flex items-center gap-1">
              <span className="w-3 h-[2px]" style={{ background: "oklch(0.62 0.13 190)" }} /> 回复后占用
            </span>
            <span className="tape text-ink-soft flex items-center gap-1 ml-auto">
              <span className="w-2 h-2 hazard inline-block" /> ≥80% 过载
            </span>
          </div>

          {data.probe.failuresOver80 >= 2 && (
            <div className="mt-2 border border-danger px-2 py-1.5 flex items-center gap-2">
              <Crosshair size={12} />
              <span className="tape text-danger leading-[1.4]">
                上下文过载：{data.probe.failuresOver80} 次工具失败集中在填充率 ≥80% 区间 —— 工具调用质量已被上下文挤压拖累。
              </span>
            </div>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 tabular-nums">
            <Probe k="COMPACTION" v={data.probe.compactions} />
            <Probe k="RETRY" v={data.probe.retries} tone={data.probe.retries >= 5 ? "danger" : undefined} />
            <Probe k="LOOP" v={data.probe.loops} tone={data.probe.loops > 0 ? "danger" : undefined} />
            <Probe k="FAIL ≥80%" v={data.probe.failuresOver80} tone={data.probe.failuresOver80 > 0 ? "danger" : undefined} />
            <Probe k="AVG FILL" v={pct(data.probe.avgFill)} />
            <Probe k="TK/行" v={data.probe.tokensPerLine ? Math.round(data.probe.tokensPerLine).toLocaleString() : "—"} />
          </div>

          {/* ---------------- efficiency + timeline ---------------- */}
          <div className="grid grid-cols-[168px_minmax(0,1fr)] gap-3 mt-3">
            <EfficiencyRing
              score={data.session.eff_score}
              output={turns.reduce((a, t) => a + t.output + t.reasoning, 0)}
              prompt={turns.reduce((a, t) => a + t.prompt_total, 0)}
            />
            <div className="min-w-0">
              <div className="flex items-baseline justify-between mb-1">
                <span className="micro">TURNS · 轮次时间线</span>
                <button
                  type="button"
                  onClick={() => setWantText((v) => !v)}
                  className="tape hover:text-danger"
                  title="正文体积大，默认不拉取"
                >
                  {wantText ? "收起正文" : "加载正文"}
                </button>
              </div>
              <TurnTimeline
                turns={turns}
                tools={data.tools ?? []}
                callId={callId}
                onPick={setCallId}
                userText={userText}
                showText={wantText}
              />
            </div>
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
              {chart.tool.input_preview && (
                <pre className="mt-1.5 tape text-ink-soft whitespace-pre-wrap break-all max-h-[90px] overflow-auto no-scrollbar border-t border-rule pt-1.5">
                  {chart.tool.input_preview}
                </pre>
              )}
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
          {childrenOf(data).map((c) => (
            <TreeItem key={c.id} label={c.title ?? c.id} meta={`${c.turns} T · ${money(c.cost)}`} onSelect={() => openSession(c.id)} />
          ))}
          {forksOf(data).map((f) => (
            <TreeItem
              key={f.target_session}
              label={f.title ?? f.target_session}
              meta={`FORK · ${f.status}`}
              onSelect={() => openSession(f.target_session)}
            />
          ))}
          {!data.children.length && !forksOf(data).length && (
            <div className="px-2 py-1.5 tape text-ink-faint">无子代理分叉</div>
          )}

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
                  <span className={`w-1.5 h-1.5 shrink-0 ${dotClass(e.type)}`} />
                  <span className="tape text-[9px] shrink-0">{clock(e.at)}</span>
                  <span className="tape text-ink-soft truncate flex-1">
                    {e.type}
                    {e.count > 1 ? ` ×${e.count}` : ""}
                  </span>
                  <span className="tape text-[9px] tabular-nums shrink-0">{pct(e.fill)}</span>
                </div>
              ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function dotClass(type: EventRow["type"]): string {
  if (type === "failure" || type === "error") return "bg-danger";
  if (type === "loop") return "bg-danger";
  if (type === "retry") return "bg-danger/60";
  if (type === "compaction") return "bg-warning";
  return "bg-ink-faint";
}

function childrenOf(data: SessionPayload) {
  return [...new Map(data.children.map((c) => [c.id, c])).values()];
}

/** `task`-tool forks that are outside the parent_id children list (deduped). */
function forksOf(data: SessionPayload) {
  const kids = new Set(data.children.map((c) => c.id));
  const seen = new Set<string>();
  return data.forks.filter((f) => {
    const sid = f.target_session;
    if (!sid || kids.has(sid) || seen.has(sid)) return false;
    seen.add(sid);
    return true;
  });
}

function Probe({ k, v, tone }: { k: string; v: number | string; tone?: "danger" }) {
  return (
    <span className="tape">
      <span className="text-ink-faint">{k} </span>
      <span className={tone === "danger" ? "text-danger" : "text-ink"}>{v}</span>
    </span>
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
  userText,
  showText,
}: {
  turns: TurnRow[];
  tools: ToolRow[];
  callId: string | null;
  onPick: (id: string) => void;
  userText: Map<string, string>;
  showText: boolean;
}) {
  return (
    <div className="hairline bg-paper-raised overflow-y-auto no-scrollbar max-h-[260px]">
      {turns.map((t) => {
        const ts = tools.filter((x) => x.turn_id === t.id);
        const text = userText.get(t.id) ?? (showText ? t.text : null);
        return (
          <div key={t.id} className="px-2 py-1.5 border-b border-rule/60">
            <div className="flex items-baseline gap-2">
              <span className="tape text-ink-faint tabular-nums">{clock(t.created)}</span>
              <span className="tape">{t.role === "user" ? "USER" : shortModel(t.model)}</span>
              <span className={`tape ml-auto tabular-nums ${t.fill > 0.8 ? "text-danger" : "text-ink-soft"}`}>CTX {pct(t.fill)}</span>
            </div>
            <BudgetBar t={t} />
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
              {!ts.length && t.role !== "user" && <span className="tape text-ink-faint">no tools · {t.finish ?? "—"}</span>}
            </div>
            {text ? <p className="tape text-ink-soft mt-1 line-clamp-2 leading-[1.4]">{text}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

/** 3 px stacked bar: where this turn's context budget actually came from. */
function BudgetBar({ t }: { t: TurnRow }) {
  const segs = [
    { v: t.cache_read, c: "oklch(0.78 0.06 240)", k: "缓存读" },
    { v: t.input, c: "oklch(0.42 0.14 258)", k: "新输入" },
    { v: t.output, c: "oklch(0.62 0.13 190)", k: "输出" },
    { v: t.reasoning, c: "oklch(0.6 0.06 220)", k: "推理" },
    { v: t.cache_write, c: "oklch(0.45 0.13 300)", k: "缓存写" },
  ];
  const total = segs.reduce((a, s) => a + s.v, 0);
  if (total <= 0) return null;
  return (
    <div className="tokens mt-1" title={segs.filter((s) => s.v > 0).map((s) => `${s.k} ${compact(s.v)}`).join(" · ")}>
      {segs.map((s) => (s.v > 0 ? <i key={s.k} style={{ width: `${(s.v / total) * 100}%`, background: s.c }} /> : null))}
    </div>
  );
}

function describeEvent(e: EventRow): string {
  const d = detailOf(e) ?? {};
  const span = e.end_at && e.end_at > e.at ? duration(e.end_at - e.at) : null;
  switch (e.type) {
    case "compaction":
      return [
        `上下文达 ${pct(e.fill)}，触发${d.reason === "auto" ? "自动" : "手动"}压缩。`,
        d.before != null ? `压缩前 ${compact(d.before)} → ${d.after != null ? `压缩后 ${compact(d.after)}` : "压缩后未记录"}${d.delta != null ? `（Δ ${d.delta >= 0 ? "+" : ""}${compact(d.delta)}）` : ""}。` : "",
        d.summary ? `摘要：${d.summary.slice(0, 90)}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    case "retry":
      return `${d.tool ?? "tool"} 在失败后重发同一调用${span ? `，间隔 ${span}` : ""}${d.title ? `：${d.title.slice(0, 70)}` : ""}`;
    case "loop":
      return `代理卡住 —— 相同调用连续 ${e.count} 次${span ? `，横跨 ${span}` : ""}：${(d.sig ?? "").slice(0, 70)}`;
    case "failure":
      return `${d.tool ?? "tool"} 在填充率 ${pct(e.fill)} 处失败：${(d.error ?? "").slice(0, 120)}`;
    case "error":
      return `提供方错误：${d.reason ?? ""} ${(d.error ?? "").slice(0, 90)}`;
    default:
      return `${e.type} @ ${pct(e.fill)} ${(d.summary ?? d.error ?? "").slice(0, 90)}`;
  }
}
