import express from "express";
import cors from "cors";
import type { DatabaseSync } from "node:sqlite";
import { BUCKET_MS } from "./config";
import { getMeta, getMetaNumber } from "./metrics/schema";
import { catalogKey, readOverrides, writeOverride, type ModelInfo } from "./metrics/catalog";
import type { BuildReport } from "./metrics/build";

const DAY = 86400000;
const HOUR = 3600000;
/** Cap for one ECG lane; wider windows are coarsened server-side. */
const MAX_POINTS = 900;

export function createApp(deps: { db: () => DatabaseSync; refresh: () => Promise<BuildReport | undefined> }) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const q = <T,>(sql: string, ...args: unknown[]): T[] => deps.db().prepare(sql).all(...(args as any[])) as T[];
  const one = <T,>(sql: string, ...args: unknown[]): T | undefined =>
    deps.db().prepare(sql).get(...(args as any[])) as T | undefined;

  /** Window helper: rejects NaN/reversed ranges instead of silently returning zeros. */
  const windowOf = (req: express.Request, res: express.Response): { from: number; to: number } | null => {
    const now = Date.now();
    const raw = { from: req.query.from, to: req.query.to };
    const from = raw.from === undefined ? now - 30 * DAY : Number(raw.from);
    const to = raw.to === undefined ? now : Number(raw.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      res.status(400).json({ error: "from/to must be epoch milliseconds" });
      return null;
    }
    if (from >= to) {
      res.status(400).json({ error: "`from` must be earlier than `to`" });
      return null;
    }
    return { from, to };
  };

  app.get("/api/status", (_req, res) => {
    const db = deps.db();
    const count = (t: string) => (one<{ c: number }>(`SELECT COUNT(*) c FROM ${t}`)?.c ?? 0);
    res.json({
      sourceDb: getMeta(db, "sourceDb"),
      sourceSchema: getMeta(db, "sourceSchema"),
      sourceMaxTime: getMetaNumber(db, "sourceMaxTime"),
      materializedAt: getMetaNumber(db, "materializedAt"),
      mode: getMeta(db, "mode"),
      bucketMs: BUCKET_MS,
      counts: {
        sessions: count("sessions"),
        turns: count("turns"),
        tools: count("tools"),
        events: count("events"),
        flow: count("flow"),
        heat: count("heat"),
        models: count("models"),
      },
    });
  });

  app.post("/api/refresh", async (req, res) => {
    try {
      const full = req.body?.full === true;
      const report = await deps.refresh();
      res.json({ ok: true, full, report });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  /**
   * Global totals for a window (header readouts + what-if sandbox).
   * Token buckets are reported separately everywhere: `generated` is what the
   * model produced (input+output+reasoning), `cache_*` is billed separately and is
   * ~14x larger on this dataset — mixing them produces numbers that don't add up.
   */
  app.get("/api/overview", (req, res) => {
    const win = windowOf(req, res);
    if (!win) return;
    const { from, to } = win;
    const flowTotals =
      one<any>(
        `SELECT COALESCE(SUM(tokens_gen),0) AS generated, COALESCE(SUM(tokens_cache_read),0) AS cache_read,
                COALESCE(SUM(cost),0) AS cost
         FROM flow WHERE bucket >= ? AND bucket <= ?`,
        from,
        to
      ) ?? {};
    const turnTotals =
      one<any>(
        `SELECT COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
                COALESCE(SUM(reasoning),0) reasoning, COALESCE(SUM(cache_read),0) cache_read,
                COALESCE(SUM(cache_write),0) cache_write, COALESCE(SUM(cost),0) cost,
                COALESCE(SUM(additions),0) additions, COALESCE(SUM(deletions),0) deletions,
                COUNT(*) turns, COALESCE(SUM(tool_errors),0) tool_errors
         FROM turns WHERE role='assistant' AND created BETWEEN ? AND ?`,
        from,
        to
      ) ?? {};
    const byModel = q<any>(
      `SELECT provider, model,
              SUM(input) input, SUM(output) output, SUM(reasoning) reasoning,
              SUM(cache_read) cache_read, SUM(cache_write) cache_write,
              SUM(cost) cost, COUNT(*) turns
       FROM turns WHERE role='assistant' AND created BETWEEN ? AND ?
       GROUP BY provider, model ORDER BY (input+output) DESC`,
      from,
      to
    );
    const coverage =
      one<any>(
        `SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN additions+deletions > 0 THEN 1 ELSE 0 END),0) with_diff,
                COALESCE(SUM(CASE WHEN cost > 0 THEN 1 ELSE 0 END),0) with_cost
         FROM sessions WHERE created BETWEEN ? AND ?`,
        from,
        to
      ) ?? {};
    const sessions =
      one<{ c: number }>(`SELECT COUNT(*) c FROM sessions WHERE created BETWEEN ? AND ?`, from, to)?.c ?? 0;
    res.json({
      range: { from, to },
      totals: { ...turnTotals, generated: Number(flowTotals.generated ?? 0), flowCost: Number(flowTotals.cost ?? 0), sessions },
      byModel,
      coverage,
    });
  });

  /** System 1 — the ECG: one lane per project, waveform = token flow per bucket. */
  app.get("/api/ecg", (req, res) => {
    const win = windowOf(req, res);
    if (!win) return;
    const { from, to } = win;
    const step = Math.max(BUCKET_MS, Math.ceil((to - from) / MAX_POINTS / BUCKET_MS) * BUCKET_MS);
    const rows = q<any>(
      `SELECT project, bucket, tokens_gen, tokens_cache_read, cost, sessions, dominant_model, peak_fill
       FROM flow WHERE bucket >= ? AND bucket <= ? ORDER BY bucket`,
      from,
      to
    );

    // coarsen + pick the dominant model per merged cell (no correlated subquery)
    const cells = new Map<string, {
      project: string; bucket: number; gen: number; cache: number; cost: number; sessions: number; peak: number;
      models: Map<string, number>;
    }>();
    for (const r of rows) {
      const bucket = Math.floor(Number(r.bucket) / step) * step;
      const key = `${r.project}|${bucket}`;
      let c = cells.get(key);
      if (!c) {
        c = { project: r.project, bucket, gen: 0, cache: 0, cost: 0, sessions: 0, peak: 0, models: new Map() };
        cells.set(key, c);
      }
      c.gen += Number(r.tokens_gen ?? 0);
      c.cache += Number(r.tokens_cache_read ?? 0);
      c.cost += Number(r.cost ?? 0);
      c.sessions = Math.max(c.sessions, Number(r.sessions ?? 0));
      c.peak = Math.max(c.peak, Number(r.peak_fill ?? 0));
      c.models.set(r.dominant_model ?? "unknown", (c.models.get(r.dominant_model ?? "unknown") ?? 0) + Number(r.tokens_gen ?? 0));
    }
    const points = [...cells.values()]
      .sort((a, b) => a.bucket - b.bucket)
      .map((c) => {
        let dominant = "unknown";
        let best = -1;
        for (const [k, v] of c.models) if (v > best) ((best = v), (dominant = k));
        return {
          project: c.project, bucket: c.bucket, tokens: c.gen, cache: c.cache,
          cost: c.cost, sessions: c.sessions, peak: c.peak, model: dominant,
        };
      });
    const projects = [...new Set(points.map((p) => p.project))];
    res.json({ step, from, to, projects, points });
  });

  /** Sessions overlapping the window, for peak hover/click probes. */
  app.get("/api/sessions", (req, res) => {
    const win = windowOf(req, res);
    if (!win) return;
    const { from, to } = win;
    const project = req.query.project as string | undefined;
    const rows = q<any>(
      `SELECT id, project, directory, title, created, updated, duration_ms, cost,
              t_input+t_output+t_reasoning+t_cache_read+t_cache_write AS tokens,
              turns, tool_calls, tool_errors, compactions, retries, loops,
              additions, deletions, files_changed, peak_fill, avg_fill, eff_score,
              dominant_model, first_prompt, parent_id, depth
       FROM sessions WHERE created <= ? AND updated >= ? AND (? IS NULL OR project = ?)
       ORDER BY created DESC LIMIT 4000`,
      to,
      from,
      project ?? null,
      project ?? null
    );
    res.json(rows);
  });

  /** System 2 — dissection view for one session and its whole sub-agent tree. */
  app.get("/api/session/:id", (req, res) => {
    const id = String(req.params.id);
    const session = one<any>("SELECT * FROM sessions WHERE id = ?", id);
    if (!session) return res.status(404).json({ error: "session not found" });

    const subtree = q<{ id: string }>(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM sessions WHERE id = ?
         UNION
         SELECT s.id FROM sessions s JOIN sub ON s.parent_id = sub.id
       ) SELECT id FROM sub`,
      id
    ).map((r) => r.id);

    // `task` tool calls that spawned children outside the parent_id tree
    const forks = q<any>(
      `SELECT t.turn_id, t.started, t.target_session, t.title, t.status
       FROM tools t WHERE t.session_id = ? AND t.target_session IS NOT NULL ORDER BY t.started`,
      id
    );
    for (const f of forks) if (f.target_session && !subtree.includes(f.target_session)) subtree.push(f.target_session);

    const ph = subtree.map(() => "?").join(",");
    const includeText = req.query.include === "text";
    const turns = q<any>(
      `SELECT t.id, t.session_id, t.seq, t.created, t.completed, t.dur_ms, t.role, t.provider, t.model,
              t.agent, t.input, t.output, t.reasoning, t.cache_read, t.cache_write, t.cost,
              t.prompt_total, t.occupancy, t.context_window, t.fill, t.fill_after, t.finish,
              t.has_error, t.tool_calls, t.tool_errors, t.additions, t.deletions
              ${includeText ? ", t.text" : ""}
       FROM turns t WHERE t.session_id IN (${ph}) ORDER BY t.created ASC`,
      ...subtree
    );
    const tools = q<any>(
      `SELECT * FROM tools WHERE session_id IN (${ph}) ORDER BY started ASC`,
      ...subtree
    );
    const events = q<any>(
      `SELECT * FROM events WHERE session_id IN (${ph}) ORDER BY at ASC`,
      ...subtree
    );
    const prompts = q<any>(
      `SELECT id, session_id, created, text FROM turns WHERE session_id IN (${ph}) AND role='user' ORDER BY created ASC`,
      ...subtree
    );
    const children = q<any>(
      `SELECT id, project, title, created, updated, cost, turns, tool_calls, tool_errors, peak_fill, eff_score, dominant_model
       FROM sessions WHERE parent_id = ? ORDER BY created ASC`,
      id
    );

    const failuresOver80 = events.filter((e: any) => e.type === "failure" && Number(e.fill) >= 0.8).length;
    const compactions = events.filter((e: any) => e.type === "compaction").length;
    const retries = events.filter((e: any) => e.type === "retry").length;
    const loops = events.filter((e: any) => e.type === "loop").length;
    const total = session.t_input + session.t_output + session.t_reasoning + session.t_cache_read + session.t_cache_write;
    res.json({
      session,
      subtree,
      forks,
      turns,
      tools,
      events,
      prompts,
      children,
      probe: {
        failuresOver80,
        compactions,
        retries,
        loops,
        peakFill: session.peak_fill,
        avgFill: session.avg_fill,
        // 有效输出 / 上下文总 Token
        effScore: session.eff_score,
        tokensPerLine: session.tokens_per_line,
        diffLines: session.additions + session.deletions,
        tokens: total,
      },
    });
  });

  /** Marker layer for the ECG: compaction arrows, retry/loop bars, failure crosses. */
  app.get("/api/events", (req, res) => {
    const win = windowOf(req, res);
    if (!win) return;
    const { from, to } = win;
    const raw = req.query.type ? String(req.query.type).split(",") : null;
    const allowed = new Set(["compaction", "retry", "loop", "failure", "idle", "switch", "error"]);
    const types = raw?.filter((t) => allowed.has(t)) ?? null;
    const rows = q<any>(
      `SELECT e.session_id, e.type, e.at, e.end_at, e.count, e.fill, e.detail, s.project
       FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE e.at BETWEEN ? AND ?${types ? ` AND e.type IN (${types.map(() => "?").join(",")})` : ""}
       ORDER BY e.at LIMIT 6000`,
      from,
      to,
      ...(types ?? [])
    );
    res.json(rows);
  });

  /** System 3 — circadian spectrogram (day × hour), re-sliced by the scrubber. */
  app.get("/api/heatmap", (req, res) => {
    const win = windowOf(req, res);
    if (!win) return;
    const { from, to } = win;
    const fromDay = localDayStart(from);
    const rows = q<any>(
      `SELECT day, hour, SUM(tokens_gen) gen, SUM(tokens_cache_read) cache_read,
              SUM(cost) cost, SUM(turns) turns
       FROM heat WHERE day >= ? AND day <= ? GROUP BY day, hour ORDER BY day, hour`,
      fromDay,
      to
    );

    const spectrogram = rows.map((r: any) => ({
      day: Number(r.day),
      hour: Number(r.hour),
      gen: Number(r.gen ?? 0),
      cache: Number(r.cache_read ?? 0),
      cost: Number(r.cost ?? 0),
      turns: Number(r.turns ?? 0),
    }));
    const matrix = new Map<string, { dow: number; hour: number; gen: number; cache: number; cost: number; turns: number }>();
    for (const c of spectrogram) {
      const d = new Date(c.day);
      const dow = (d.getDay() + 6) % 7; // Mon=0
      const key = `${dow}|${c.hour}`;
      const cell = matrix.get(key) ?? { dow, hour: c.hour, gen: 0, cache: 0, cost: 0, turns: 0 };
      cell.gen += c.gen;
      cell.cache += c.cache;
      cell.cost += c.cost;
      cell.turns += c.turns;
      matrix.set(key, cell);
    }
    const cells = [...matrix.values()].sort((a, b) => a.dow - b.dow || a.hour - b.hour);
    const all = cells.reduce((a, c) => a + c.gen, 0);
    const cacheAll = cells.reduce((a, c) => a + c.cache, 0);
    const night = cells.filter((c) => c.hour >= 22 || c.hour < 2).reduce((a, c) => a + c.gen, 0);
    const peak = [...cells].sort((a, b) => b.gen - a.gen)[0] ?? null;
    const byHour = new Array<number>(24).fill(0);
    for (const c of cells) byHour[c.hour] += c.gen;
    const topHour = byHour.indexOf(Math.max(...byHour));
    res.json({
      days: Math.max(1, Math.round((to - fromDay) / DAY)),
      fromDay,
      cells,
      spectrogram,
      totalTokens: all,
      totalCacheRead: cacheAll,
      nightShare: all ? night / all : 0,
      peak,
      topHour,
      insight: all
        ? `${String(topHour).padStart(2, "0")}:00 是生成量最高的小时，占 ${(byHour[topHour] / all * 100).toFixed(1)}%；22:00–02:00 合计 ${((night / all) * 100).toFixed(1)}%`
        : null,
    });
  });

  /** Attention focus: gaps between consecutive tool calls in the window. */
  app.get("/api/focus", (req, res) => {
    const win = windowOf(req, res);
    if (!win) return;
    const { from, to } = win;
    const rows = q<any>(
      `SELECT started, name, dur_ms, session_id FROM tools
       WHERE started BETWEEN ? AND ? ORDER BY session_id, started`,
      from,
      to
    );
    const gaps: { at: number; gap: number; session: string; tool: string }[] = [];
    let prevSession: string | null = null;
    let prev: number | null = null;
    for (const r of rows) {
      if (prevSession === r.session_id && prev != null) {
        const gap = Math.max(0, r.started - prev);
        if (gap > 0 && gap < 10 * 60 * 60 * 1000) {
          gaps.push({ at: r.started, gap: gap / 1000, session: r.session_id, tool: r.name });
        }
      }
      prev = r.started;
      prevSession = r.session_id;
    }
    const sorted = gaps.map((g) => g.gap).sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.floor(sorted.length * p)] : 0);
    const buckets = new Map<number, number>();
    for (const g of gaps) {
      const k = Math.min(6, Math.floor(Math.log10(Math.max(g.gap, 0.1))));
      buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
    const flow = q<any>(
      `SELECT bucket, SUM(tokens_gen) tokens FROM flow WHERE bucket BETWEEN ? AND ? GROUP BY bucket ORDER BY bucket`,
      from,
      to
    );
    res.json({
      count: gaps.length,
      p50: pct(0.5),
      p90: pct(0.9),
      p99: pct(0.99),
      max: sorted.at(-1) ?? 0,
      deepFocusShare: gaps.length ? gaps.filter((g) => g.gap < 15).length / gaps.length : 0,
      interruptionShare: gaps.length ? gaps.filter((g) => g.gap > 120).length / gaps.length : 0,
      histogram: [...buckets.entries()].map(([k, c]) => ({ seconds: Math.pow(10, k), count: c })),
      series: gaps.slice(-1500),
      flow: flow.map((f: any) => ({ bucket: Number(f.bucket), tokens: Number(f.tokens ?? 0) })),
    });
  });

  /**
   * System 4 — token → diff lines. Sessions with no diff data are counted in
   * `coverage` instead of being silently dropped (the scatter is only honest if
   * the denominator is visible).
   */
  app.get("/api/conversion", (req, res) => {
    const win = windowOf(req, res);
    if (!win) return;
    const { from, to } = win;
    const rows = q<any>(
      `SELECT id session, project, title, cost, created, dominant_model,
              t_input+t_output+t_reasoning+t_cache_read+t_cache_write AS tokens,
              additions+deletions AS lines, files_changed, eff_score, peak_fill, turns
       FROM sessions WHERE created BETWEEN ? AND ? ORDER BY created DESC LIMIT 2000`,
      from,
      to
    );
    const pts = rows.filter((r: any) => Number(r.tokens) > 0);
    const withDiff = pts.filter((r: any) => Number(r.lines) > 0);
    const coverage = { total: pts.length, withDiff: withDiff.length };

    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    let regression: { slope: number; intercept: number } | null = null;
    let scored = pts.map((r: any) => ({ ...r, expected_lines: null as number | null, ratio: null as number | null }));

    if (withDiff.length >= 3) {
      const mx = mean(withDiff.map((r: any) => Math.log10(Math.max(r.tokens, 1))));
      const my = mean(withDiff.map((r: any) => Math.log10(Math.max(r.lines, 1))));
      let num = 0;
      let den = 0;
      for (const r of withDiff as any[]) {
        const x = Math.log10(Math.max(r.tokens, 1));
        const y = Math.log10(Math.max(r.lines, 1));
        num += (x - mx) * (y - my);
        den += (x - mx) ** 2;
      }
      const slope = den ? num / den : 0;
      const intercept = my - slope * mx;
      regression = { slope, intercept };
      scored = pts.map((r: any) => {
        const expected = Math.pow(10, slope * Math.log10(Math.max(r.tokens, 1)) + intercept);
        return { ...r, expected_lines: expected, ratio: Number(r.lines) > 0 ? r.lines / expected : 0 };
      });
    }

    // "注水会话": well above the median spend, far below the expected output
    const tokenVals = pts.map((r: any) => Number(r.tokens)).sort((a, b) => a - b);
    const p75 = tokenVals.length ? tokenVals[Math.floor(tokenVals.length * 0.75)] : 0;
    const padded = scored
      .filter((r: any) => r.ratio != null && r.ratio < 0.25 && r.tokens >= Math.max(p75, 50000))
      .sort((a: any, b: any) => b.tokens - a.tokens)
      .slice(0, 20);
    const totalTokens = pts.reduce((a: number, r: any) => a + Number(r.tokens), 0);
    const totalLines = withDiff.reduce((a: number, r: any) => a + Number(r.lines), 0);
    res.json({
      points: scored,
      regression,
      linesPer10k: totalTokens > 0 ? totalLines / (totalTokens / 10000) : 0,
      padded,
      coverage,
    });
  });

  /** Catalog + per-model totals used by the what-if sandbox. */
  app.get("/api/models", (_req, res) => {
    const overrides = readOverrides();
    const models = q<any>(`SELECT * FROM models ORDER BY id`).map((m: any) => {
      const ov = overrides[m.id];
      return {
        id: m.id,
        provider: m.provider,
        label: ov?.label ?? m.label,
        context: ov?.context ?? m.context,
        cost_input: ov?.costInput ?? m.cost_input,
        cost_output: ov?.costOutput ?? m.cost_output,
        cost_cache_read: ov?.costCacheRead ?? m.cost_cache_read,
        cost_cache_write: ov?.costCacheWrite ?? m.cost_cache_write,
        source: ov ? "override" : m.source,
        overridden: Boolean(ov),
      };
    });
    const usage = q<any>(
      `SELECT provider, model,
              SUM(input) input, SUM(output) output, SUM(reasoning) reasoning,
              SUM(cache_read) cache_read, SUM(cache_write) cache_write,
              SUM(cost) cost, COUNT(*) turns
       FROM turns WHERE role='assistant' GROUP BY provider, model ORDER BY (input+output) DESC`
    );
    res.json({ models, usage });
  });

  /** Manual price/context override (free-tier models price as 0 on models.dev). */
  app.put("/api/models/:key", (req, res) => {
    const key = String(req.params.key);
    if (!key.includes("/")) return res.status(400).json({ error: "key must be `provider/model`" });
    const body = req.body ?? {};
    const patch: Partial<ModelInfo> = {};
    const numFields: (keyof ModelInfo)[] = ["costInput", "costOutput", "costCacheRead", "costCacheWrite", "context"];
    for (const f of numFields) {
      const v = body[f] ?? body[String(f).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
      if (v !== undefined) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${f} must be a non-negative number` });
        (patch as any)[f] = n;
      }
    }
    if (body.label !== undefined) patch.label = String(body.label).slice(0, 120);
    const next = writeOverride(key, patch);
    res.json({ ok: true, model: next, note: "run POST /api/refresh {full:true} to reprice historical turns" });
  });

  /**
   * System 4 — what-if sandbox: recompute the window's bill under model swaps and
   * a cache-hit improvement, from the per-turn token buckets.
   */
  app.post("/api/sandbox", (req, res) => {
    const body = req.body ?? {};
    const now = Date.now();
    const from = Number(body.from ?? now - 30 * DAY);
    const to = Number(body.to ?? now);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return res.status(400).json({ error: "invalid window" });
    }
    const swaps = Array.isArray(body.swaps) ? body.swaps : [];
    const cacheReadGain = clamp(Number(body.cacheReadGain ?? 0), -1, 1);

    const rows = q<any>(
      `SELECT provider, model, SUM(input) input, SUM(output) output, SUM(reasoning) reasoning,
              SUM(cache_read) cache_read, SUM(cache_write) cache_write, SUM(cost) cost
       FROM turns WHERE role='assistant' AND created BETWEEN ? AND ?
       GROUP BY provider, model`,
      from,
      to
    );

    const overrides = readOverrides();
    const toInfo = (row: any, ov: any): ModelInfo | null => {
      if (!row && !ov) return null;
      return {
        id: row?.id ?? ov?.id, provider: row?.provider ?? ov?.provider, label: ov?.label ?? row?.label,
        context: ov?.context ?? row?.context ?? 128000,
        costInput: ov?.costInput ?? row?.cost_input ?? 0,
        costOutput: ov?.costOutput ?? row?.cost_output ?? 0,
        costCacheRead: ov?.costCacheRead ?? row?.cost_cache_read ?? 0,
        costCacheWrite: ov?.costCacheWrite ?? row?.cost_cache_write ?? 0,
        source: ov ? "override" : row?.source ?? "cache",
      };
    };
    const priceOf = (provider: string | null, model: string | null): ModelInfo | null => {
      const key = catalogKey(provider, model);
      return toInfo(one<any>("SELECT * FROM models WHERE id = ?", key), overrides[key]);
    };
    const priceById = (id: string): ModelInfo | null =>
      toInfo(one<any>("SELECT * FROM models WHERE id = ?", id), overrides[id]);

    const byKey: any[] = [];
    let currentCost = 0;
    let projectedCost = 0;
    for (const r of rows) {
      const key = catalogKey(r.provider, r.model);
      const base = { input: Number(r.input), output: Number(r.output), reasoning: Number(r.reasoning), cacheRead: Number(r.cache_read), cacheWrite: Number(r.cache_write) };
      const srcPrice = priceOf(r.provider, r.model) ?? zeroPrice();
      const swap = swaps.find((s: any) => s?.from === key) ?? swaps.find((s: any) => s?.from === r.model);
      const targetPrice = swap?.price ? toPrice(swap.price) : swap?.to ? priceById(swap.to) ?? srcPrice : srcPrice;

      const moved = Math.min(base.input * Math.max(0, cacheReadGain), base.input);
      const projectedTokens = {
        input: base.input - moved,
        output: base.output,
        reasoning: base.reasoning,
        cacheRead: base.cacheRead + moved,
        cacheWrite: base.cacheWrite,
      };
      const cur = costOf(base, srcPrice);
      const proj = costOf(projectedTokens, targetPrice);
      currentCost += cur;
      projectedCost += proj;
      byKey.push({
        key,
        label: srcPrice.label,
        tokens: base,
        current: cur,
        projected: proj,
        delta: proj - cur,
        price: { input: srcPrice.costInput, output: srcPrice.costOutput, cacheRead: srcPrice.costCacheRead, cacheWrite: srcPrice.costCacheWrite },
        target: swap?.to ?? null,
        pricedFrom: srcPrice.source,
      });
    }

    res.json({
      range: { from, to },
      assumptions: { cacheReadGain, swaps: swaps.map((s: any) => ({ from: s?.from, to: s?.to })) },
      current: currentCost,
      projected: projectedCost,
      delta: projectedCost - currentCost,
      deltaPct: currentCost > 0 ? (projectedCost - currentCost) / currentCost : 0,
      byModel: byKey.sort((a, b) => b.current - a.current),
    });
  });

  app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  });

  return app;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));

function costOf(t: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }, p: ModelInfo): number {
  return (t.input * p.costInput + (t.output + t.reasoning) * p.costOutput + t.cacheRead * p.costCacheRead + t.cacheWrite * p.costCacheWrite) / 1e6;
}

function zeroPrice(): ModelInfo {
  return { id: "unknown", provider: "unknown", label: "unknown", context: 128000, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, source: "fallback" };
}

function toPrice(p: any): ModelInfo {
  return {
    id: "custom", provider: "custom", label: "custom", context: 128000,
    costInput: Number(p.input ?? p.costInput ?? 0),
    costOutput: Number(p.output ?? p.costOutput ?? 0),
    costCacheRead: Number(p.cacheRead ?? p.costCacheRead ?? 0),
    costCacheWrite: Number(p.cacheWrite ?? p.costCacheWrite ?? 0),
    source: "override",
  };
}

function localDayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
