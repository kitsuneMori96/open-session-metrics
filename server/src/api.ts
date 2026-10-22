import express from "express";
import cors from "cors";
import type { DatabaseSync } from "node:sqlite";
import { BUCKET_MS } from "./config";
import { getMeta, getMetaNumber } from "./metrics/schema";
import {
  dashboard,
  facets,
  sessionContext,
  sessionsPage,
  toolDetail,
  MAX_PAGE_ROOTS,
  SESSION_ORDERS,
  type SessionOrder,
  type Slice,
} from "./metrics/analytics";
import { isGranularity } from "./metrics/buckets";
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

  const str = (req: express.Request, key: string): string | null => {
    const raw = req.query[key];
    return typeof raw === "string" && raw ? raw : null;
  };

  /** The window + cross-filter a dashboard view is rendered against. */
  const sliceOf = (req: express.Request): Slice => {
    const rawTo = Number(req.query.to ?? 0);
    const gran = str(req, "gran");
    return {
      from: cutoffOf(req),
      to: Number.isFinite(rawTo) && rawTo > 0 ? rawTo : Date.now() + 1,
      project: projectOf(req),
      model: str(req, "model"),
      agent: str(req, "agent"),
      // An unknown unit is ignored rather than rejected: the axis then picks for the span.
      gran: isGranularity(gran) ? gran : null,
    };
  };

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
   * One session's assistant turns in order, each with its content parts, plus the user
   * prompts that opened them. This is the only endpoint that returns bodies, and it is
   * fetched per session on demand.
   *
   * Prompts travel beside `turns` rather than inside it: every other consumer of a turn
   * (the timeline, the spend panel, the session totals) means "what the model did", and a
   * user row has no tokens, no cost and no parts.
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
              cache_read, cache_write, cost, dur_ms, finish, tool_calls, tool_errors,
              project, occupancy, context_window, fill, fill_after, additions, deletions, write_lines, has_error
       FROM turns WHERE session_id = ? AND role = 'assistant'
       ORDER BY created ASC, seq ASC`,
      id
    );
    const prompts = q<any>(
      `SELECT id, created, text FROM turns
       WHERE session_id = ? AND role = 'user' AND length(trim(coalesce(text, ''))) > 0
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
        // Turn-level context readings: the transcript timeline plots these, and the
        // Stats panel needs the model window the fill ratio was measured against.
        project: t.project ?? "—",
        occupancy: Number(t.occupancy ?? 0),
        contextWindow: Number(t.context_window ?? 0),
        fill: Number(t.fill ?? 0),
        fillAfter: Number(t.fill_after ?? 0),
        additions: Number(t.additions ?? 0),
        deletions: Number(t.deletions ?? 0),
        writeLines: Number(t.write_lines ?? 0),
        hasError: Number(t.has_error ?? 0) === 1,
        parts: byTurn.get(t.id) ?? [],
      })),
      prompts: prompts.map((p) => ({ id: p.id, created: Number(p.created ?? 0), text: p.text ?? "" })),
    });
  });

  /**
   * Everything the dashboard's filter bar needs to describe the corpus, in one call:
   * the project / model / agent dimensions with their sizes, plus the data extent so a
   * relative window ("last 30 days") can be anchored to what actually exists.
   */
  app.get("/api/top/facets", (_req, res) => {
    res.json(facets(deps.db()));
  });

  /**
   * The dashboard payload: raw buckets rather than a pre-thinned label array, so the
   * browser can draw a real time axis, brush a sub-range and stack the series by model
   * without another round trip.
   */
  app.get("/api/top/analytics", (req, res) => {
    res.json(dashboard(deps.db(), sliceOf(req)));
  });

  /**
   * One page of the session grid, filtered and sorted in SQL.
   *
   * The dashboard carries only a bounded sample of sessions; this is where the rest are,
   * `limit` roots at a time, with `cursor` resuming exactly where the last page stopped.
   */
  app.get("/api/top/sessions", (req, res) => {
    const focus = str(req, "focus");
    const slice = sliceOf(req);
    if (focus) {
      const rows = sessionContext(deps.db(), slice, focus);
      if (!rows.length) return res.status(404).json({ error: "session not in this window" });
      return res.json({ rows, matching: rows.length, roots: 0, next: null, totals: null });
    }
    const order = str(req, "order");
    const limit = Number(req.query.limit ?? MAX_PAGE_ROOTS);
    res.json(
      sessionsPage(deps.db(), slice, {
        q: str(req, "q"),
        order: (SESSION_ORDERS as string[]).includes(order ?? "") ? (order as SessionOrder) : "updated",
        dir: req.query.dir === "asc" ? "asc" : "desc",
        limit: Number.isFinite(limit) ? limit : MAX_PAGE_ROOTS,
        cursor: str(req, "cursor"),
      })
    );
  });

  /** Per-tool forensics: volume, latency distribution, error signatures, call sites. */
  app.get("/api/top/tool", (req, res) => {
    const name = str(req, "name");
    if (!name) return res.status(400).json({ error: "name is required" });
    const detail = toolDetail(deps.db(), sliceOf(req), name);
    if (!detail.totals || detail.totals.calls === 0) return res.status(404).json({ error: "no calls for that tool in this window" });
    res.json(detail);
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
