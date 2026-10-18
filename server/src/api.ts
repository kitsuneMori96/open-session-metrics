import express from "express";
import cors from "cors";
import type { DatabaseSync } from "node:sqlite";
import { BUCKET_MS } from "./config";
import { getMeta } from "./metrics/schema";

const DAY = 86400000;

export function createApp(deps: { db: () => DatabaseSync; refresh: () => Promise<unknown> }) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const q = <T,>(sql: string, ...args: unknown[]): T[] => deps.db().prepare(sql).all(...(args as any[])) as T[];
  const one = <T,>(sql: string, ...args: unknown[]): T | undefined => deps.db().prepare(sql).all(...(args as any[]))[0] as T | undefined;

  app.get("/api/status", (_req, res) => {
    const db = deps.db();
    res.json({
      sourceDb: getMeta(db, "sourceDb"),
      sourceSchema: getMeta(db, "sourceSchema"),
      sourceMaxTime: Number(getMeta(db, "sourceMaxTime") ?? 0),
      materializedAt: Number(getMeta(db, "materializedAt") ?? 0),
      bucketMs: BUCKET_MS,
      counts: {
        sessions: one<{ c: number }>("SELECT COUNT(*) c FROM sessions")?.c ?? 0,
        turns: one<{ c: number }>("SELECT COUNT(*) c FROM turns")?.c ?? 0,
        tools: one<{ c: number }>("SELECT COUNT(*) c FROM tools")?.c ?? 0,
        events: one<{ c: number }>("SELECT COUNT(*) c FROM events")?.c ?? 0,
        flow: one<{ c: number }>("SELECT COUNT(*) c FROM flow")?.c ?? 0,
      },
    });
  });

  app.post("/api/refresh", async (_req, res) => {
    try {
      const report = await deps.refresh();
      res.json({ ok: true, report });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  /** Full data extent, so the time scrubber knows its universe. */
  app.get("/api/range", (_req, res) => {
    const r = one<any>("SELECT MIN(created) AS min, MAX(updated) AS max FROM sessions");
    res.json({ from: Number(r?.min ?? Date.now() - 30 * DAY), to: Number(r?.max ?? Date.now()) });
  });

  /** Global totals for a time window (drives the header readouts + what-if sandbox). */
  app.get("/api/overview", (req, res) => {
    const { from, to } = windowOf(req);
    const totals =
      one<any>(
        `SELECT COALESCE(SUM(tokens),0) AS tokens, COALESCE(SUM(cost),0) AS cost
         FROM flow WHERE bucket >= ? AND bucket <= ?`,
        from,
        to
      ) ?? {};
    const distinctSessions =
      one<{ c: number }>(`SELECT COUNT(*) c FROM sessions WHERE created BETWEEN ? AND ?`, from, to)?.c ?? 0;
    const turnAgg =
      one<any>(
        `SELECT COALESCE(SUM(t.input),0) input, COALESCE(SUM(t.output),0) output,
                COALESCE(SUM(t.reasoning),0) reasoning, COALESCE(SUM(t.cache_read),0) cache_read,
                COALESCE(SUM(t.cache_write),0) cache_write, COALESCE(SUM(t.cost),0) cost,
                COALESCE(SUM(t.additions),0) additions, COALESCE(SUM(t.deletions),0) deletions,
                COUNT(*) turns, SUM(t.tool_errors) tool_errors
         FROM turns t WHERE t.role='assistant' AND t.created BETWEEN ? AND ?`,
        from,
        to
      ) ?? {};
    const byModel = q<any>(
      `SELECT t.model, t.provider, COALESCE(SUM(t.input+t.output+t.reasoning+t.cache_read+t.cache_write),0) tokens,
              COALESCE(SUM(t.cost),0) cost, COUNT(*) turns
       FROM turns t WHERE t.role='assistant' AND t.created BETWEEN ? AND ?
       GROUP BY t.provider, t.model ORDER BY tokens DESC`,
      from,
      to
    );
    res.json({ range: { from, to }, totals: { ...totals, ...turnAgg, sessions: distinctSessions }, byModel });
  });

  /** System 1 — the ECG: one lane per project, waveform = token flow per bucket. */
  app.get("/api/ecg", (req, res) => {
    const { from, to } = windowOf(req);
    const step = Math.max(BUCKET_MS, Math.ceil((to - from) / 900 / BUCKET_MS) * BUCKET_MS);
    const rows = q<any>(
      `SELECT project, (bucket / ? ) * ? AS bucket, SUM(tokens) tokens, SUM(cost) cost,
              SUM(sessions) sessions, MAX(peak_fill) peak_fill,
              (SELECT f2.dominant_model FROM flow f2
                WHERE f2.project = f.project AND (f2.bucket / ?) * ? = (f.bucket / ?) * ?
                ORDER BY f2.tokens DESC LIMIT 1) AS dominant_model
       FROM flow f WHERE bucket BETWEEN ? AND ?
       GROUP BY project, bucket ORDER BY bucket ASC`,
      step,
      step,
      step,
      step,
      step,
      step,
      from,
      to
    );
    const projects = q<any>(
      `SELECT project, COUNT(*) lanes FROM sessions WHERE created BETWEEN ? AND ?
       GROUP BY project ORDER BY project`,
      from,
      to
    );
    res.json({ step, projects: projects.map((p: any) => p.project), points: rows });
  });

  /** Sessions overlapping the window, for peak hover/click probes. */
  app.get("/api/sessions", (req, res) => {
    const { from, to } = windowOf(req);
    const project = req.query.project as string | undefined;
    const rows = q<any>(
      `SELECT id, project, title, created, updated, duration_ms, cost, turns, tool_calls, tool_errors, compactions,
              retries, additions, deletions, peak_fill, avg_fill, eff_score, dominant_model, first_prompt, parent_id, depth
       FROM sessions WHERE created BETWEEN ? AND ? AND (? IS NULL OR project = ?)
       ORDER BY created DESC LIMIT 4000`,
      from,
      to,
      project ?? null,
      project ?? null
    );
    res.json(rows);
  });

  /** System 2 — the dissection view for one session (plus its sub-agent children). */
  app.get("/api/session/:id", (req, res) => {
    const id = req.params.id;
    const session = one<any>("SELECT * FROM sessions WHERE id = ?", id);
    if (!session) return res.status(404).json({ error: "session not found" });
    const ids = [id, ...q<{ id: string }>(`SELECT id FROM sessions WHERE parent_id = ?`, id).map((r) => r.id)];
    const ph = ids.map(() => "?").join(",");
    const turns = q<any>(
      `SELECT t.*, s.project FROM turns t LEFT JOIN sessions s ON s.id = t.session_id
       WHERE t.session_id IN (${ph}) AND t.role='assistant' ORDER BY t.created ASC`,
      ...ids
    );
    const tools = q<any>(`SELECT * FROM tools WHERE session_id IN (${ph}) ORDER BY started ASC`, ...ids);
    const events = q<any>(`SELECT * FROM events WHERE session_id IN (${ph}) ORDER BY at ASC`, ...ids);
    const prompts = q<any>(
      `SELECT id, session_id, created, text FROM turns WHERE session_id IN (${ph}) AND role='user' ORDER BY created ASC`,
      ...ids
    );
    const children = q<any>(
      `SELECT id, project, title, created, updated, cost, turns, tool_calls, tool_errors, peak_fill, eff_score, dominant_model
       FROM sessions WHERE parent_id = ? ORDER BY created ASC`,
      id
    );
    const overloaded = events.filter((e: any) => e.type === "failure" && e.fill >= 0.8).length;
    res.json({ session, turns, tools, events, prompts, children, probe: { failureOverload: overloaded } });
  });

  /** System 3 — circadian spectrogram (7x24) recomputed live for the window. */
  app.get("/api/heatmap", (req, res) => {
    const { from, to } = windowOf(req);
    const HOUR = 3600000;
    const rows = q<any>(
      `SELECT CAST(created / ? AS INTEGER) AS hb, project,
              SUM(input+output+reasoning+cache_read) AS tokens, SUM(cost) cost, COUNT(*) turns
       FROM turns WHERE role='assistant' AND created BETWEEN ? AND ?
       GROUP BY hb, project`,
      HOUR,
      from,
      to
    );
    const cells = new Map<string, { dow: number; hour: number; tokens: number; cost: number; turns: number }>();
    for (const r of rows) {
      const d = new Date(Number(r.hb) * HOUR);
      const key = `${d.getDay()}|${d.getHours()}`;
      const cell = cells.get(key) ?? { dow: d.getDay(), hour: d.getHours(), tokens: 0, cost: 0, turns: 0 };
      cell.tokens += Number(r.tokens ?? 0);
      cell.cost += Number(r.cost ?? 0);
      cell.turns += Number(r.turns ?? 0);
      cells.set(key, cell);
    }
    const list = [...cells.values()].sort((a, b) => a.dow - b.dow || a.hour - b.hour);
    const fromDay = new Date(from);
    fromDay.setHours(0, 0, 0, 0);
    const days = Math.max(1, Math.round((to - fromDay.getTime()) / DAY));
    const night = list.filter((r) => r.hour >= 22 || r.hour < 2).reduce((a, r) => a + r.tokens, 0);
    const all = list.reduce((a, r) => a + r.tokens, 0);
    const peak = [...list].sort((a, b) => b.tokens - a.tokens)[0] ?? null;
    res.json({ days, cells: list, nightShare: all ? night / all : 0, peak, totalTokens: all });
  });

  /** Attention focus: gaps between consecutive tool calls in the window. */
  app.get("/api/focus", (req, res) => {
    const { from, to } = windowOf(req);
    const rows = q<any>(
      `SELECT started, name, dur_ms, session_id FROM tools
       WHERE started BETWEEN ? AND ? AND started IS NOT NULL ORDER BY session_id, started`,
      from,
      to
    );
    const gaps: { at: number; gap: number; session: string }[] = [];
    let prevSession: string | null = null;
    let prev: number | null = null;
    for (const r of rows) {
      if (prevSession === r.session_id && prev != null) {
        const gap = Math.max(0, r.started - prev);
        if (gap > 0 && gap < 10 * 60 * 60 * 1000) gaps.push({ at: r.started, gap: gap / 1000, session: r.session_id });
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
      `SELECT bucket, SUM(tokens) tokens FROM flow WHERE bucket BETWEEN ? AND ? GROUP BY bucket ORDER BY bucket`,
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
      series: gaps.slice(-1200),
      flow,
    });
  });

  /** System 4 — token → diff lines scatter + regression for flagging padded sessions. */
  app.get("/api/conversion", (req, res) => {
    const { from, to } = windowOf(req);
    const rows = q<any>(
      `SELECT id session, project, title, cost, t_input+t_output+t_reasoning+t_cache_read+t_cache_write AS tokens,
              additions+deletions AS lines, eff_score, peak_fill, created
       FROM sessions WHERE created BETWEEN ? AND ? AND cost > 0 AND (additions+deletions) >= 0
       ORDER BY created DESC LIMIT 1500`,
      from,
      to
    );
    const pts = rows.filter((r: any) => r.tokens > 0);
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const mx = mean(pts.map((r: any) => Math.log10(Math.max(r.tokens, 1))));
    const my = mean(pts.map((r: any) => Math.log10(Math.max(r.lines, 1))));
    let num = 0;
    let den = 0;
    for (const r of pts as any[]) {
      const x = Math.log10(Math.max(r.tokens, 1));
      const y = Math.log10(Math.max(r.lines, 1));
      num += (x - mx) * (y - my);
      den += (x - mx) ** 2;
    }
    const slope = den ? num / den : 0;
    const intercept = my - slope * mx;
    const scored = pts.map((r: any) => {
      const expected = Math.pow(10, slope * Math.log10(Math.max(r.tokens, 1)) + intercept);
      return { ...r, expected_lines: expected, ratio: expected > 0 ? r.lines / expected : 0 };
    });
    const padded = scored.filter((r: any) => r.ratio < 0.25 && r.tokens > 100000);
    const linesPer10k = pts.reduce((a: number, r: any) => a + r.lines, 0) /
      Math.max(1, pts.reduce((a: number, r: any) => a + r.tokens, 0) / 10000);
    res.json({
      points: scored,
      regression: { slope, intercept },
      linesPer10k,
      padded: padded.sort((a: any, b: any) => b.tokens - a.tokens).slice(0, 20),
    });
  });

  /** Catalog + per-model totals used by the what-if sandbox. */
  app.get("/api/models", (_req, res) => {
    const models = q<any>(`SELECT * FROM models ORDER BY id`);
    const usage = q<any>(
      `SELECT provider, model,
              SUM(input) input, SUM(output) output, SUM(reasoning) reasoning,
              SUM(cache_read) cache_read, SUM(cache_write) cache_write, SUM(cost) cost, COUNT(*) turns
       FROM turns WHERE role='assistant' GROUP BY provider, model ORDER BY cost DESC, turns DESC`
    );
    res.json({ models, usage });
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  });

  return app;
}

function windowOf(req: express.Request): { from: number; to: number } {
  const now = Date.now();
  const from = Number(req.query.from ?? now - 30 * DAY);
  const to = Number(req.query.to ?? now);
  return { from, to };
}
