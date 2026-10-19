import express from "express";
import cors from "cors";
import type { DatabaseSync } from "node:sqlite";
import { BUCKET_MS } from "./config";
import { getMeta, getMetaNumber } from "./metrics/schema";
import { buildTrendBuckets } from "./metrics/trend";
import type { BuildReport } from "./metrics/build";

export function createApp(deps: {
  db: () => DatabaseSync;
  refresh: (full: boolean) => Promise<BuildReport | undefined>;
}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const q = <T,>(sql: string, ...args: unknown[]): T[] => deps.db().prepare(sql).all(...(args as any[])) as T[];
  const one = <T,>(sql: string, ...args: unknown[]): T | undefined =>
    deps.db().prepare(sql).get(...(args as any[])) as T | undefined;

  /** `?from=` is a cutoff in epoch ms; 0 or absent means all time. */
  const cutoffOf = (req: express.Request): number => {
    const raw = Number(req.query.from ?? 0);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  };
  const projectOf = (req: express.Request): string | null =>
    typeof req.query.project === "string" && req.query.project ? req.query.project : null;

  app.get("/api/status", (_req, res) => {
    const db = deps.db();
    const count = (t: string) => (one<{ c: number }>(`SELECT COUNT(*) c FROM ${t}`)?.c ?? 0);
    const extent =
      one<{ from_ts: number | null; to_ts: number | null }>(
        `SELECT MIN(created) AS from_ts, MAX(COALESCE(updated, created)) AS to_ts FROM sessions`
      ) ?? { from_ts: null, to_ts: null };
    res.json({
      sourceDb: getMeta(db, "sourceDb"),
      sourceSchema: getMeta(db, "sourceSchema"),
      sourceMaxTime: getMetaNumber(db, "sourceMaxTime"),
      materializedAt: getMetaNumber(db, "materializedAt"),
      mode: getMeta(db, "mode"),
      bucketMs: BUCKET_MS,
      extent: { from: Number(extent.from_ts ?? 0), to: Number(extent.to_ts ?? Date.now()) },
      counts: {
        sessions: count("sessions"),
        turns: count("turns"),
        tools: count("tools"),
        parts: count("parts"),
        events: count("events"),
        models: count("models"),
      },
    });
  });

  app.post("/api/refresh", async (req, res) => {
    try {
      const full = req.body?.full === true;
      const report = await deps.refresh(full);
      res.json({ ok: true, full, report });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  /**
   * Screen 1 payload. Every session with the aggregates the details panel and the
   * agent tree need, so selecting a row never hits the network: the tree, the STATS
   * block, the context bar, MODELS, TOOLS and the AGENT CHAIN all render from this.
   * The transcript is the only thing loaded separately (it is big).
   */
  app.get("/api/top/sessions", (req, res) => {
    const project = projectOf(req);
    const sessions = q<any>(
      `SELECT s.id, s.parent_id, s.project, s.title, s.agent, s.model, s.provider, s.created, s.updated,
              s.t_input, s.t_output, s.t_reasoning, s.t_cache_read, s.t_cache_write,
              s.cost, s.turns, s.tool_calls, s.tool_errors, s.first_prompt, s.output_rate,
              s.peak_fill, s.avg_fill,
              (SELECT MAX(COALESCE(t.completed, t.created)) - MIN(t.created)
                 FROM turns t WHERE t.session_id = s.id) AS span_ms,
              (SELECT MAX(t.context_window) FROM turns t
                 WHERE t.session_id = s.id AND t.role = 'assistant') AS ctx_window
       FROM sessions s ${project ? "WHERE s.project = ?" : ""} ORDER BY s.updated DESC`,
      ...(project ? [project] : [])
    );

    const bySessionModels = new Map<string, any[]>();
    for (const r of q<any>(
      `SELECT session_id, model, COUNT(*) calls, SUM(input+output+reasoning+cache_read+cache_write) tokens
       FROM turns WHERE role='assistant' GROUP BY session_id, model`
    )) {
      const list = bySessionModels.get(r.session_id) ?? [];
      list.push({ id: r.model ?? "unknown", calls: r.calls, tokens: r.tokens });
      bySessionModels.set(r.session_id, list);
    }
    for (const list of bySessionModels.values()) list.sort((a, b) => b.tokens - a.tokens);

    const bySessionTools = new Map<string, any[]>();
    for (const r of q<any>(
      `SELECT session_id, name, COUNT(*) calls,
              SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) successes,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) failures,
              SUM(COALESCE(dur_ms,0)) ms
       FROM tools GROUP BY session_id, name`
    )) {
      const list = bySessionTools.get(r.session_id) ?? [];
      list.push({
        name: r.name,
        calls: r.calls,
        successes: r.successes,
        failures: r.failures,
        avgMs: r.calls > 0 ? r.ms / r.calls : 0,
      });
      bySessionTools.set(r.session_id, list);
    }
    for (const list of bySessionTools.values()) list.sort((a, b) => b.calls - a.calls);

    res.json({
      generatedAt: Date.now(),
      sessions: sessions.map((s) => {
        const input = Number(s.t_input ?? 0);
        const cacheRead = Number(s.t_cache_read ?? 0);
        const cacheWrite = Number(s.t_cache_write ?? 0);
        // Context pressure is measured the way the TUI measures it: what the provider
        // had to re-read plus what it wrote, over the model's window. Output is not
        // resident context, and reasoning is billed separately from it.
        const contextUsage = input + cacheRead + cacheWrite;
        const contextWindow = Number(s.ctx_window ?? 0) || 128000;
        return {
          id: s.id,
          parentId: s.parent_id ?? null,
          project: s.project ?? "—",
          title: s.title ?? null,
          agent: s.agent ?? null,
          model: s.model ?? null,
          provider: s.provider ?? null,
          created: Number(s.created ?? 0),
          updated: Number(s.updated ?? 0),
          tokens: {
            input,
            output: Number(s.t_output ?? 0),
            reasoning: Number(s.t_reasoning ?? 0),
            cacheRead,
            cacheWrite,
            total: input + Number(s.t_output ?? 0) + cacheRead + cacheWrite,
          },
          cost: Number(s.cost ?? 0),
          calls: Number(s.turns ?? 0),
          durationMs: Number(s.span_ms ?? 0),
          outputRate: Number(s.output_rate ?? 0),
          contextUsage,
          contextWindow,
          contextPct: contextWindow > 0 ? contextUsage / contextWindow : 0,
          peakFill: Number(s.peak_fill ?? 0),
          avgFill: Number(s.avg_fill ?? 0),
          firstPrompt: s.first_prompt ?? null,
          models: bySessionModels.get(s.id) ?? [],
          tools: bySessionModels.has(s.id) ? bySessionTools.get(s.id) ?? [] : [],
        };
      }),
    });
  });

  /**
   * Screen 1, right panel in "Messages" mode: one session's assistant turns in order,
   * each with its content parts. This is the only endpoint that returns bodies, and it
   * is fetched per session on demand.
   */
  app.get("/api/top/session/:id/messages", (req, res) => {
    const id = req.params.id;
    const session = one<any>(
      `SELECT id, parent_id, project, title, agent, model, provider, created, updated,
              t_input, t_output, t_reasoning, t_cache_read, t_cache_write, cost, turns, first_prompt
       FROM sessions WHERE id = ?`,
      id
    );
    if (!session) return res.status(404).json({ error: "unknown session" });

    const turns = q<any>(
      `SELECT id, seq, model, provider, agent, created, completed, input, output, reasoning,
              cache_read, cache_write, cost, dur_ms, finish, tool_calls, tool_errors
       FROM turns WHERE session_id = ? AND role = 'assistant'
       ORDER BY created ASC, seq ASC`,
      id
    );
    const parts = q<any>(
      `SELECT turn_id, ordinal, kind, text, name, call_id, status, title, input, output,
              exit_code, truncated, started, ended, chars
       FROM parts WHERE session_id = ? ORDER BY turn_id, ordinal, id`,
      id
    );
    const byTurn = new Map<string, any[]>();
    for (const p of parts) {
      const list = byTurn.get(p.turn_id) ?? [];
      list.push({
        kind: p.kind,
        ordinal: Number(p.ordinal ?? 0),
        text: p.text ?? "",
        name: p.name ?? "",
        callId: p.call_id ?? "",
        status: p.status ?? "",
        title: p.title ?? null,
        input: p.input ?? "",
        output: p.output ?? "",
        exitCode: p.exit_code ?? null,
        truncated: Number(p.truncated ?? 0) === 1,
        started: p.started ?? null,
        ended: p.ended ?? null,
        chars: Number(p.chars ?? 0),
      });
      byTurn.set(p.turn_id, list);
    }

    res.json({
      session: {
        id: session.id,
        parentId: session.parent_id ?? null,
        project: session.project ?? "—",
        title: session.title ?? null,
        agent: session.agent ?? null,
        model: session.model ?? null,
        provider: session.provider ?? null,
        created: Number(session.created ?? 0),
        updated: Number(session.updated ?? 0),
        cost: Number(session.cost ?? 0),
        firstPrompt: session.first_prompt ?? null,
      },
      turns: turns.map((t) => ({
        id: t.id,
        model: t.model ?? "",
        provider: t.provider ?? null,
        agent: t.agent ?? null,
        created: Number(t.created ?? 0),
        completed: t.completed == null ? null : Number(t.completed),
        tokens: {
          input: Number(t.input ?? 0),
          output: Number(t.output ?? 0),
          reasoning: Number(t.reasoning ?? 0),
          cacheRead: Number(t.cache_read ?? 0),
          cacheWrite: Number(t.cache_write ?? 0),
        },
        cost: Number(t.cost ?? 0),
        durMs: Number(t.dur_ms ?? 0),
        finish: t.finish ?? null,
        tools: Number(t.tool_calls ?? 0),
        errors: Number(t.tool_errors ?? 0),
        parts: byTurn.get(t.id) ?? [],
      })),
    });
  });

  /**
   * Screen 2 payload: tool usage aggregated across every session, with the newest
   * error messages per tool.
   */
  app.get("/api/top/tools", (_req, res) => {
    const rows = q<any>(
      `SELECT name, COUNT(*) calls,
              SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) successes,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) failures,
              SUM(COALESCE(dur_ms,0)) total_ms
       FROM tools GROUP BY name ORDER BY calls DESC`
    );
    const recentByTool = new Map<string, string[]>();
    for (const r of q<any>(
      `SELECT name, error FROM tools
       WHERE status='error' AND error IS NOT NULL AND error <> ''
       ORDER BY COALESCE(ended, started, 0) DESC`
    )) {
      const list = recentByTool.get(r.name) ?? [];
      if (list.length < 3) list.push(String(r.error).slice(0, 200));
      recentByTool.set(r.name, list);
    }
    res.json({
      tools: rows.map((r) => ({
        name: r.name,
        calls: Number(r.calls),
        successes: Number(r.successes),
        failures: Number(r.failures),
        totalDurationMs: Number(r.total_ms ?? 0),
        avgDurationMs: r.calls > 0 ? Number(r.total_ms ?? 0) / Number(r.calls) : 0,
        recentErrors: recentByTool.get(r.name) ?? [],
      })),
    });
  });

  /**
   * Screen 3 payload: aggregate stats over a time range/project.
   *
   * The TUI keeps whole workflows and skips *interactions* before the cutoff, so a
   * sub-agent whose parent went quiet is dropped along with the parent. We reproduce
   * that: roots are selected first (by project and cutoff), then their descendants.
   */
  app.get("/api/top/overview", (req, res) => {
    const now = Date.now();
    const cutoff = cutoffOf(req);
    const project = projectOf(req);

    const meta = q<any>(`SELECT id, parent_id, project, created, updated FROM sessions`);
    const roots = meta.filter((s) => !s.parent_id || !meta.some((p) => p.id === s.parent_id));
    const projects = [...new Set(roots.map((r) => String(r.project ?? "—")))].sort();

    const chosen = roots.filter(
      (r) => (!project || String(r.project ?? "—") === project) && (cutoff === 0 || Number(r.updated ?? 0) >= cutoff)
    );
    const activeIds = new Set<string>(chosen.map((r) => String(r.id)));
    // Descendants are attached by walking parent links once; 200 sessions is small.
    for (let pass = 0; pass < 8; pass++) {
      for (const s of meta) {
        if (s.parent_id && activeIds.has(String(s.parent_id))) activeIds.add(String(s.id));
      }
    }
    const ids = [...activeIds];
    const ph = ids.map(() => "?").join(",");
    const turnWhere = ids.length ? `t.session_id IN (${ph}) AND t.created >= ?` : null;

    const turns = turnWhere
      ? q<any>(
          `SELECT t.id, t.session_id, t.project, t.agent, t.model, t.created, t.input, t.output,
                  t.reasoning, t.cache_read, t.cache_write, t.cost
           FROM turns t WHERE t.role='assistant' AND ${turnWhere}`,
          ...ids,
          cutoff
        )
      : [];
    const toolRows = turnWhere
      ? q<any>(
          `SELECT COALESCE(t.agent,'main') agent, tl.name, tl.status, COALESCE(tl.dur_ms,0) dur_ms
           FROM tools tl JOIN turns t ON t.id = tl.turn_id WHERE ${turnWhere}`,
          ...ids,
          cutoff
        )
      : [];

    const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const models = new Map<string, { id: string; calls: number; tokens: number; cost: number }>();
    const projBreak = new Map<string, { project: string; sessions: number; cost: number }>();
    const agentErrors = new Map<string, { agent: string; calls: number; errors: number }>();
    const toolCounts = new Map<string, { name: string; calls: number; errors: number; totalDurationMs: number }>();
    const tokenPoints: [number, number][] = [];
    const hourly = new Array(24).fill(0);
    const activeSessions = new Set<string>();

    for (const t of turns) {
      const input = Number(t.input ?? 0);
      const output = Number(t.output ?? 0);
      const reasoning = Number(t.reasoning ?? 0);
      const cacheRead = Number(t.cache_read ?? 0);
      const cacheWrite = Number(t.cache_write ?? 0);
      const cost = Number(t.cost ?? 0);
      // `total` deliberately excludes reasoning: it is what the provider billed as
      // context traffic, and the TUI's own TokenUsage.total draws the same line.
      const total = input + output + cacheRead + cacheWrite;

      totals.input += input;
      totals.output += output;
      totals.reasoning += reasoning;
      totals.cacheRead += cacheRead;
      totals.cacheWrite += cacheWrite;
      totals.cost += cost;

      const modelId = String(t.model ?? "unknown");
      const mEntry = models.get(modelId) ?? { id: modelId, calls: 0, tokens: 0, cost: 0 };
      mEntry.calls++;
      mEntry.tokens += total;
      mEntry.cost += cost;
      models.set(modelId, mEntry);

      const proj = String(t.project ?? "—");
      const pEntry = projBreak.get(proj) ?? { project: proj, sessions: 0, cost: 0 };
      pEntry.cost += cost;
      projBreak.set(proj, pEntry);

      activeSessions.add(String(t.session_id));
      const ts = Number(t.created ?? 0);
      if (ts) {
        hourly[new Date(ts).getHours()]++;
        tokenPoints.push([ts, total]);
      }
    }

    for (const r of toolRows) {
      const name = String(r.name);
      const isError = r.status === "error";
      const tEntry = toolCounts.get(name) ?? { name, calls: 0, errors: 0, totalDurationMs: 0 };
      tEntry.calls++;
      if (isError) tEntry.errors++;
      tEntry.totalDurationMs += Number(r.dur_ms ?? 0);
      toolCounts.set(name, tEntry);

      const agent = String(r.agent ?? "main");
      const aEntry = agentErrors.get(agent) ?? { agent, calls: 0, errors: 0 };
      aEntry.calls++;
      if (isError) aEntry.errors++;
      agentErrors.set(agent, aEntry);
    }

    // A session counts once it has an interaction inside the window, whatever the
    // wall-clock span of its row says.
    for (const s of meta) {
      if (!activeSessions.has(String(s.id))) continue;
      const proj = String(s.project ?? "—");
      const pEntry = projBreak.get(proj) ?? { project: proj, sessions: 0, cost: 0 };
      pEntry.sessions++;
      projBreak.set(proj, pEntry);
    }

    const sessionPoints: [number, number][] = meta
      .filter((s) => activeSessions.has(String(s.id)))
      .map((s) => [Number(s.updated ?? s.created ?? 0), 1] as [number, number]);

    res.json({
      generatedAt: now,
      range: { from: cutoff, to: now, project },
      projects,
      activity: { roots: { shown: chosen.length, total: roots.length } },
      totals: { ...totals, total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite },
      models: [...models.values()].sort((a, b) => b.calls - a.calls),
      projectsBreakdown: [...projBreak.values()].sort((a, b) => b.sessions - a.sessions),
      agentErrors: [...agentErrors.values()].sort((a, b) => b.calls - a.calls),
      tools: [...toolCounts.values()].sort((a, b) => b.calls - a.calls),
      tokenTrend: buildTrendBuckets(tokenPoints, cutoff, now),
      sessionTrend: buildTrendBuckets(sessionPoints, cutoff, now),
      hourly,
    });
  });

  /**
   * Cross-session search, the web equivalent of `/` + `n`/`N` in the TUI: it answers
   * "which sessions mention this" without shipping every transcript to the browser.
   */
  app.get("/api/top/search", (req, res) => {
    const raw = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (raw.length < 2) return res.json({ query: raw, hits: [] });
    const like = `%${raw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = q<any>(
      `SELECT s.id, s.title, s.project, s.updated,
              (SELECT COUNT(*) FROM parts p WHERE p.session_id = s.id
                 AND (p.text LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\'
                      OR p.title LIKE ? ESCAPE '\\' OR p.input LIKE ? ESCAPE '\\'
                      OR p.output LIKE ? ESCAPE '\\')) hits
       FROM sessions s
       WHERE s.id IN (SELECT session_id FROM parts WHERE text LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
                        OR title LIKE ? ESCAPE '\\' OR input LIKE ? ESCAPE '\\' OR output LIKE ? ESCAPE '\\')
       ORDER BY s.updated DESC LIMIT 40`,
      like, like, like, like, like, like, like, like, like, like
    );
    res.json({
      query: raw,
      hits: rows.map((r) => ({
        id: r.id,
        title: r.title ?? null,
        project: r.project ?? "—",
        updated: Number(r.updated ?? 0),
        hits: Number(r.hits ?? 0),
      })),
    });
  });

  return app;
}
