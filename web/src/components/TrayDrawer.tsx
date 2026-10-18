import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { scaleLog } from "d3-scale";
import { useCockpit } from "../state/CockpitContext";
import {
  useConversion,
  useModels,
  useSandbox,
  type ConversionPoint,
  type SandboxResult,
} from "../lib/api";
import { clock, compact, money, pct, shortModel } from "../lib/format";
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
          <span className="tape text-ink-faint ml-2 tabular-nums truncate">
            {conv.coverage.withDiff}/{conv.coverage.total} 会话有 DIFF · {compact(conv.points.reduce((a, p) => a + p.tokens, 0))} TK →{" "}
            {conv.points.reduce((a, p) => a + p.lines, 0)} 行 · 每万 TK {conv.linesPer10k.toFixed(1)} 行 · 注水 {conv.padded.length}
          </span>
        )}
        <button type="button" onClick={() => setTrayOpen(false)} className="ml-auto tape hover:text-danger shrink-0">
          关闭 ×
        </button>
      </header>
      <div className="h-[294px]">
        {tab === "roi" ? <RoiScatter /> : <Sandbox />}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ ROI ---- */

const PAD_L = 46;
const PAD_B = 20;
const PAD_T = 8;
const PAD_R = 12;

function RoiScatter() {
  const { window, openSession } = useCockpit();
  const { data: conv } = useConversion(window);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 720, h: 294 });
  const [hover, setHover] = useState<{ p: ConversionPoint; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(60, size.w - PAD_L - PAD_R);
  const plotH = Math.max(60, size.h - PAD_T - PAD_B);

  const scales = useMemo(() => {
    const withDiff = (conv?.points ?? []).filter((p) => p.lines > 0 && p.tokens > 0);
    if (!withDiff.length) return null;
    const xs = withDiff.map((p) => p.tokens);
    const ys = withDiff.map((p) => p.lines);
    const x = scaleLog()
      .domain([Math.max(1000, Math.min(...xs) * 0.7), Math.max(...xs) * 1.3])
      .range([0, plotW])
      .clamp(true);
    const y = scaleLog()
      .domain([0.7, Math.max(10, Math.max(...ys) * 1.3)])
      .range([plotH, 0])
      .clamp(true);
    return { x, y, withDiff };
  }, [conv, plotW, plotH]);

  if (!conv) return <div className="h-full grid place-items-center tape text-ink-faint">载入转化数据…</div>;

  const zeroDiff = conv.points.filter((p) => p.lines <= 0);
  const paddedKeys = new Set(conv.padded.map((p) => p.session));
  const X = (tk: number) => PAD_L + (scales?.x(Math.max(tk, 1)) ?? 0);
  const Y = (ln: number) => PAD_T + (scales ? scales.y(Math.max(ln, 0.8)) : plotH);

  const line = conv.regression && scales
    ? (() => {
        const [a, b] = scales.x.domain();
        const f = (tk: number) => Math.pow(10, conv.regression!.slope * Math.log10(Math.max(tk, 1)) + conv.regression!.intercept);
        return `M ${X(a)},${Y(f(a))} L ${X(b)},${Y(f(b))}`;
      })()
    : null;

  return (
    <div className="h-full grid" style={{ gridTemplateColumns: "minmax(0,1fr) 248px" }}>
      <div ref={box} className="relative min-w-0 overflow-hidden">
        {!scales && (
          <div className="absolute inset-0 grid place-items-center text-center px-6">
            <p className="tape text-ink-soft leading-[1.6]">
              窗口内没有 「TOKENS → 代码行」 的成对样本（{conv.coverage.withDiff}/{conv.coverage.total} 会话带 DIFF）。
              <br />
              把时间窗拉长，或先去心电图里点开一个真正改过文件的会话。
            </p>
          </div>
        )}
        <svg className="absolute inset-0 pointer-events-none" width={size.w} height={size.h}>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line
              key={f}
              x1={PAD_L}
              x2={size.w - PAD_R}
              y1={PAD_T + plotH * f}
              y2={PAD_T + plotH * f}
              stroke="oklch(0.2 0.05 250 / 0.08)"
            />
          ))}
          {scales &&
            scales.y.ticks(4).map((v) => (
              <text key={`y${v}`} x={PAD_L - 6} y={Y(v) + 3} textAnchor="end" fontSize="8" className="font-mono" fill="oklch(0.42 0.03 250)">
                {compact(v)}
              </text>
            ))}
          {scales &&
            scales.x.ticks(5).map((v) => (
              <text key={`x${v}`} x={X(v)} y={size.h - 6} textAnchor="middle" fontSize="8" className="font-mono" fill="oklch(0.42 0.03 250)">
                {compact(v)}
              </text>
            ))}
          <line x1={PAD_L} x2={size.w - PAD_R} y1={PAD_T + plotH} y2={PAD_T + plotH} stroke="oklch(0.2 0.05 250 / 0.35)" />
          <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={PAD_T + plotH} stroke="oklch(0.2 0.05 250 / 0.35)" />
          <text x={PAD_L - 6} y={PAD_T + 6} textAnchor="end" fontSize="8" className="font-mono" fill="oklch(0.42 0.03 250)">
            行
          </text>
          <text x={size.w - PAD_R} y={PAD_T + plotH + 13} textAnchor="end" fontSize="8" className="font-mono" fill="oklch(0.42 0.03 250)">
            TOKENS（对数）→
          </text>

          {line && (
            <path
              d={line}
              fill="none"
              stroke="var(--color-ink)"
              strokeWidth="1"
              strokeDasharray="4 3"
              className="trace-in"
              style={{ ["--len" as string]: 1400 }}
            />
          )}

          {/* zero-diff sessions sit on the floor as hollow squares */}
          {zeroDiff.map((p) => (
            <rect
              key={`z${p.session}`}
              x={X(p.tokens) - 2.5}
              y={PAD_T + plotH - 5}
              width={5}
              height={5}
              fill="none"
              stroke="oklch(0.42 0.03 250 / 0.7)"
            />
          ))}

          {scales &&
            conv.points
              .filter((p) => p.lines > 0 && p.tokens > 0)
              .map((p) => {
                const bad = paddedKeys.has(p.session);
                return (
                  <circle
                    key={p.session}
                    cx={X(p.tokens)}
                    cy={Y(p.lines)}
                    r={bad ? 4.5 : 3}
                    fill={bad ? "none" : "var(--color-ink)"}
                    fillOpacity={bad ? 0 : 0.55}
                    stroke={bad ? "var(--color-danger)" : "none"}
                    strokeWidth={bad ? 1.4 : 0}
                  />
                );
              })}
        </svg>

        {scales &&
          conv.points
            .filter((p) => p.lines > 0 && p.tokens > 0)
            .map((p) => (
              <button
                key={`h${p.session}`}
                type="button"
                onMouseEnter={() => setHover({ p, x: X(p.tokens), y: Y(p.lines) })}
                onMouseLeave={() => setHover(null)}
                onClick={() => openSession(p.session)}
                className="absolute w-[14px] h-[14px] -translate-x-1/2 -translate-y-1/2"
                style={{ left: X(p.tokens), top: Y(p.lines) }}
                title={p.title ?? p.session}
              />
            ))}

        {hover && (
          <div
            className="absolute z-10 pointer-events-none hairline bg-paper-raised px-2 py-1.5 w-[250px]"
            style={{ left: Math.max(4, Math.min(size.w - 254, hover.x + 12)), top: Math.max(4, Math.min(size.h - 110, hover.y - 14)) }}
          >
            <div className="tape text-ink leading-[1.35] line-clamp-2">{hover.p.title ?? hover.p.session}</div>
            <div className="micro mt-1">{hover.p.project} · {clock(hover.p.created)} · {hover.p.turns} T</div>
            <div className="grid grid-cols-2 gap-x-2 mt-1 tape tabular-nums">
              <span className="text-ink-faint">TOKENS</span>
              <span className="text-right">{compact(hover.p.tokens)}</span>
              <span className="text-ink-faint">DIFF 行</span>
              <span className="text-right">{hover.p.lines}</span>
              {hover.p.expected_lines != null && (
                <>
                  <span className="text-ink-faint">期望</span>
                  <span className="text-right">{hover.p.expected_lines.toFixed(0)}</span>
                  <span className="text-ink-faint">转化率</span>
                  <span className={`text-right ${paddedKeys.has(hover.p.session) ? "text-danger" : ""}`}>
                    {pct(hover.p.ratio ?? 0)}
                  </span>
                </>
              )}
              <span className="text-ink-faint">COST</span>
              <span className="text-right text-flow">{money(hover.p.cost)}</span>
            </div>
            <div className="micro mt-1.5 text-ink-faint">CLICK → 解剖该会话</div>
          </div>
        )}
      </div>

      <aside className="border-l border-rule overflow-y-auto no-scrollbar">
        <div className="px-2 py-1.5 border-b border-rule micro">注水会话 · 高投入低产出</div>
        {!conv.regression && (
          <div className="px-2 py-1.5 tape text-ink-faint border-b border-rule">
            样本不足（{conv.coverage.withDiff} &lt; 3），无法拟合回归线
          </div>
        )}
        {conv.padded.length === 0 && <div className="px-2 py-1.5 tape text-ink-faint">暂无 ratio &lt; 25% 的高价会话</div>}
        {conv.padded.map((p) => (
          <button
            key={p.session}
            type="button"
            onClick={() => openSession(p.session)}
            className="w-full text-left px-2 py-1.5 border-b border-rule/60 hover:bg-paper-raised"
          >
            <div className="tape text-ink truncate">{p.title ?? p.session}</div>
            <div className="flex items-baseline gap-2 mt-0.5 tape text-[9px] tabular-nums">
              <span className="text-danger">{pct(p.ratio ?? 0)}</span>
              <span className="text-ink-faint">{compact(p.tokens)} TK</span>
              <span className="text-ink-faint">{p.lines} 行</span>
              <span className="text-flow ml-auto">{money(p.cost)}</span>
            </div>
          </button>
        ))}
        <div className="px-2 py-1.5 tape text-ink-faint leading-[1.5]">
          空心方块 = {zeroDiff.length} 个零 DIFF 会话（探索/问答型，不计入回归）
        </div>
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------- SANDBOX ---- */

interface SwapState {
  gain: number;
  swaps: Record<string, string>;
}

function Sandbox() {
  const { window } = useCockpit();
  const { data: catalog } = useModels();
  const sandbox = useSandbox();
  const [st, setSt] = useState<SwapState>({ gain: 0, swaps: {} });

  const body = useMemo(
    () => ({
      from: window.from,
      to: window.to,
      cacheReadGain: st.gain,
      swaps: Object.entries(st.swaps)
        .filter(([, to]) => to && to !== "keep")
        .map(([from, to]) => ({ from, to })),
    }),
    [window.from, window.to, st]
  );

  useEffect(() => {
    const t = setTimeout(() => sandbox.mutate(body), 180);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  const res = sandbox.data;
  const cheaper = res != null && res.delta < -0.0001;
  const dearer = res != null && res.delta > 0.0001;

  return (
    <div className="h-full grid" style={{ gridTemplateColumns: "286px_minmax(0,1fr)" }}>
      {/* mixer */}
      <div className="border-r border-rule overflow-y-auto no-scrollbar p-2">
        <div className="micro">MIXER · 推演旋钮</div>
        <label className="block mt-2">
          <div className="flex items-baseline justify-between tape">
            <span>缓存命中提升</span>
            <span className="tabular-nums text-flow">{pct(st.gain)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={0.9}
            step={0.05}
            value={st.gain}
            onChange={(e) => setSt((s) => ({ ...s, gain: Number(e.target.value) }))}
            className="w-full mt-1 knob"
          />
          <div className="tape text-ink-faint leading-[1.4] mt-0.5">把 input 桶按比例搬进 cache_read 桶（更便宜）</div>
        </label>

        <div className="mt-3 space-y-1.5">
          {(res?.byModel ?? []).map((m) => (
            <div key={m.key}>
              <div className="tape truncate" title={m.key}>
                {m.label || shortModel(m.key)}
              </div>
              <select
                value={st.swaps[m.key] ?? "keep"}
                onChange={(e) => setSt((s) => ({ ...s, swaps: { ...s.swaps, [m.key]: e.target.value } }))}
                className="w-full tape border border-rule bg-paper-raised px-1 py-0.5 mt-0.5"
              >
                <option value="keep">保持原模型</option>
                {(catalog?.models ?? [])
                  .filter((c) => c.id !== m.key)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      → {c.label ?? shortModel(c.id)}（IN {c.cost_input}/M · OUT {c.cost_output}/M）
                    </option>
                  ))}
              </select>
            </div>
          ))}
          {!res?.byModel?.length && <div className="tape text-ink-faint">窗口内无可计价的模型用量</div>}
        </div>

        <button
          type="button"
          onClick={() => setSt({ gain: 0, swaps: {} })}
          className="mt-3 w-full tape border border-rule py-1 hover:border-rule-strong"
        >
          重置假设
        </button>
      </div>

      {/* readout */}
      <div className="min-w-0 flex flex-col">
        <div className="flex items-end gap-5 px-3 pt-2.5 pb-2 border-b border-rule">
          <div>
            <div className="micro">CURRENT BILL · 实际账单</div>
            <div className="font-mono font-extralight text-[30px] leading-none tabular-nums text-ink-soft">
              {res ? money(res.current) : "—"}
            </div>
          </div>
          <div>
            <div className="micro">PROJECTED · 假设账单</div>
            <div
              className={`font-mono font-extralight text-[38px] leading-none tabular-nums ${
                cheaper ? "text-good" : dearer ? "text-danger" : "text-ink"
              }`}
            >
              <RollingMoney value={res?.projected ?? 0} />
            </div>
          </div>
          <div className="ml-auto text-right tabular-nums">
            <div className="micro">Δ</div>
            <div className={`font-mono text-[18px] leading-none ${cheaper ? "text-good" : dearer ? "text-danger" : "text-ink-faint"}`}>
              {res ? `${res.delta >= 0 ? "+" : ""}${money(res.delta)}` : "—"}
            </div>
            <div className={`tape mt-0.5 ${cheaper ? "text-good" : dearer ? "text-danger" : "text-ink-faint"}`}>
              {res ? `${res.deltaPct >= 0 ? "+" : ""}${pct(res.deltaPct, 1)}` : "…"}
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
          <table className="w-full tape border-collapse">
            <thead className="sticky top-0 bg-paper">
              <tr className="text-ink-faint border-b border-rule">
                <th className="text-left font-normal px-2 py-1 micro">MODEL</th>
                <th className="text-right font-normal px-2 py-1 micro">IN</th>
                <th className="text-right font-normal px-2 py-1 micro">OUT+R</th>
                <th className="text-right font-normal px-2 py-1 micro">CACHE R</th>
                <th className="text-right font-normal px-2 py-1 micro">当前</th>
                <th className="text-right font-normal px-2 py-1 micro">假设</th>
                <th className="text-right font-normal px-2 py-1 micro">Δ</th>
              </tr>
            </thead>
            <tbody>
              {(res?.byModel ?? []).map((m) => (
                <ModelRow key={m.key} m={m} />
              ))}
              {!res && (
                <tr>
                  <td colSpan={7} className="px-2 py-3 text-center text-ink-faint">
                    {sandbox.isPending ? "重算中…" : "载入用量数据…"}
                  </td>
                </tr>
              )}
              {res && !res.byModel.length && (
                <tr>
                  <td colSpan={7} className="px-2 py-3 text-center text-ink-faint">
                    窗口内没有 assistant 轮次
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {res && (
          <div className="px-2 py-1 border-t border-rule tape text-ink-faint leading-[1.4] truncate">
            价格来源 {res.byModel.some((m) => m.pricedFrom === "override") ? "含手动覆盖" : "models.dev 缓存"} ·
            改价用 PUT /api/models/:key，再 POST /api/refresh {"{"}full:true{"}"} 重算历史
          </div>
        )}
      </div>
    </div>
  );
}

function ModelRow({ m }: { m: SandboxResult["byModel"][number] }) {
  const saving = m.delta < -0.0001;
  return (
    <tr className="border-b border-rule/60 tabular-nums hover:bg-paper-raised">
      <td className="px-2 py-1">
        <div className="truncate max-w-[190px]">{m.label || shortModel(m.key)}</div>
        {m.target && <div className="text-[9px] text-flow">→ {shortModel(m.target)}</div>}
      </td>
      <td className="px-2 py-1 text-right text-ink-faint">{compact(m.tokens.input)}</td>
      <td className="px-2 py-1 text-right text-ink-faint">{compact(m.tokens.output + m.tokens.reasoning)}</td>
      <td className="px-2 py-1 text-right text-ink-faint">{compact(m.tokens.cacheRead)}</td>
      <td className="px-2 py-1 text-right">{money(m.current)}</td>
      <td className={`px-2 py-1 text-right ${saving ? "text-good" : m.delta > 0.0001 ? "text-danger" : ""}`}>{money(m.projected)}</td>
      <td className={`px-2 py-1 text-right ${saving ? "text-good" : m.delta > 0.0001 ? "text-danger" : "text-ink-faint"}`}>
        {m.delta >= 0 ? "+" : ""}
        {money(m.delta)}
      </td>
    </tr>
  );
}

/** Slot-machine roll: the projected bill eases to its new value whenever the knobs move. */
function RollingMoney({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef(0);

  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    const b = value;
    const span = 520;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / span);
      const e = 1 - Math.pow(1 - t, 3);
      setShown(a + (b - a) * e);
      if (t < 1) raf.current = requestAnimationFrame(step);
      else from.current = b;
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);

  return <>{money(shown)}</>;
}
