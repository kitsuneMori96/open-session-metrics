import type { DatabaseSync } from "node:sqlite";
import { BUCKET_MS, SOURCE_DB } from "../config";
import { SourceReader, type SrcTurn, type SrcSession, type SrcTool } from "../source";
import { initSchema, setMeta } from "./schema";
import { catalogKey, loadCatalog, type Catalog } from "./catalog";
import { ensureRollups, refreshRollups } from "./rollup";

/** Same-signature tool calls inside this window are candidates for retry probes. */
export const RETRY_WINDOW_MS = 15 * 60 * 1000;
/** N identical calls in a row (regardless of status) = the agent is stuck. */
export const LOOP_MIN_REPEATS = 3;

const localBucket = (ts: number) => Math.floor(ts / BUCKET_MS) * BUCKET_MS;
const localHour = (ts: number) => new Date(ts).getHours();
const localDayStart = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export interface BuildReport {
  mode: "full" | "incremental";
  schema: string;
  sessions: number;
  turns: number;
  tools: number;
  parts: number;
  events: number;
  flow: number;
  heat: number;
  models: number;
  ms: number;
}

interface TurnCalc extends SrcTurn {
  promptTotal: number;
  occupancy: number;
  contextWindow: number;
  fill: number;
  fillAfter: number;
  costComputed: number;
  bucket: number;
  day: number;
  hour: number;
}

interface ProbeEvent {
  type: string;
  at: number;
  endAt: number;
  count: number;
  turnId: string | null;
  detail: Record<string, unknown>;
}

/**
 * Most OpenCode sessions are launched from `/` or the home directory, so
 * `directory` alone makes the ECG collapse into meaningless lanes. Recover the
 * real project from the absolute paths the session's tools actually touched.
 */
const CONTAINERS = /\/(?:projects|repos|plugins|workspace|Code)\/([^/.][^/]*)\//;
const HOME_LEVEL = /^\/(?:home|Users)\/([^/]+)\/([^/.][^/]*)\//;
const ROOT_LEVEL = /^\/(?:tmp|srv|opt|data|work)\/([^/.][^/]*)\//;
const IGNORED = new Set([
  "home", "root", "users", "usr", "tmp", "var", "srv", "opt", "bin", "lib", "src", "dist",
  "data", "log", "logs", "cache", "config", "appdata", "desktop", "documents", "downloads",
  "program", "programs", "programdata", "node_modules", "versions", "share", "code",
]);

const isJunkLane = (project: string, accounts: Set<string>) =>
  !project || project === "/" || project === "unknown" || accounts.has(project);

export function inferProject(paths: string[], fallback: string, accounts: Set<string>): string {
  const votes = new Map<string, number>();
  const vote = (label: string | null | undefined, weight: number) => {
    if (!label) return;
    const l = label.toLowerCase();
    if (l.startsWith(".") || l.length < 3 || IGNORED.has(l)) return;
    votes.set(label, (votes.get(label) ?? 0) + weight);
  };
  for (const raw of paths) {
    const p = raw.replace(/^\/mnt\/[a-zA-Z]\//, "/");
    const container = p.match(CONTAINERS);
    if (container) vote(container[1], 4);
    else {
      const home = p.match(HOME_LEVEL);
      if (home) vote(home[2], 2);
      else vote(p.match(ROOT_LEVEL)?.[1], 1);
    }
  }
  const junk = isJunkLane(fallback, accounts);
  let bestV = junk ? 0 : 2;
  let best = junk ? "unknown" : fallback;
  for (const [label, v] of votes) if (v > bestV) ((bestV = v), (best = label));
  return best;
}

/** `kitsunemori` from `/home/kitsunemori` (also WSL-mounted `C:\Users\…`). */
export function accountOf(path: string | null | undefined): string | null {
  return (path ?? "").replace(/^\/mnt\/[a-zA-Z]\//, "/").match(/^\/(?:home|Users)\/([^/]+)$/)?.[1] ?? null;
}

/**
 * Re-materialize `sessionIds` (all sessions when omitted) into `db`.
 * - `mode: "full"` assumes an empty target file (tables are created, never dropped here).
 * - `mode: "incremental"` deletes and rewrites only those sessions, then
 *   re-aggregates the flow/heat cells their turns touched.
 */
export async function build(
  db: DatabaseSync,
  opts: { sessionIds?: Set<string>; mode?: "full" | "incremental"; sourceDb?: string } = {}
): Promise<BuildReport> {
  const t0 = Date.now();
  const mode = opts.mode ?? "full";
  const src = new SourceReader(opts.sourceDb ?? SOURCE_DB);
  try {
    initSchema(db, { drop: mode === "full" });
    ensureRollups(db);

    const allSessions = src.sessions();
    const allById = new Map<string, SrcSession>(allSessions.map((s) => [s.id, s]));
    const targetIds = opts.sessionIds ?? new Set(allSessions.map((s) => s.id));
    const sessionById = new Map<string, SrcSession>(
      allSessions.filter((s) => targetIds.has(s.id)).map((s) => [s.id, s])
    );

    const wanted = new Set<string>();
    for (const s of sessionById.values()) if (s.model) wanted.add(catalogKey(s.provider, s.model));
    const turnsRaw = src.turns(targetIds);
    for (const t of turnsRaw) if (t.role === "assistant" && t.model) wanted.add(catalogKey(t.provider, t.model));
    const catalog: Catalog = await loadCatalog(wanted);
    const patchFiles = src.patchFileCounts(targetIds);

    // ---- ECG lanes: recover the project from the files each session touched ----
    const pathsBySession = new Map<string, string[]>();
    for (const t of turnsRaw) {
      if (!t.tools.length) continue;
      const arr = pathsBySession.get(t.sessionId) ?? [];
      for (const tl of t.tools) arr.push(...tl.paths);
      pathsBySession.set(t.sessionId, arr);
    }
    for (const [sid, info] of patchFiles) {
      const arr = pathsBySession.get(sid) ?? [];
      arr.push(...info.paths);
      pathsBySession.set(sid, arr);
    }
    const accounts = new Set(
      allSessions.map((s) => accountOf(s.directory)).filter((a): a is string => !!a)
    );
    for (const s of sessionById.values()) {
      s.project = inferProject(pathsBySession.get(s.id) ?? [], s.project, accounts);
    }
    // Sub-agent sessions rarely touch files themselves — borrow the parent's lane.
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const s of sessionById.values()) {
        if (!isJunkLane(s.project, accounts)) continue;
        const parent = s.parentId ? allById.get(s.parentId) : null;
        if (parent && !isJunkLane(parent.project, accounts)) ((s.project = parent.project), (changed = true));
      }
      if (!changed) break;
    }
    // Sessions with no file evidence at all are scratch work, not a real project.
    for (const s of sessionById.values()) if (isJunkLane(s.project, accounts)) s.project = "scratch";

    const info = (provider: string | null | undefined, model: string | null | undefined) =>
      catalog[catalogKey(provider, model)] ?? catalog[catalogKey("opencode", model)] ?? null;

    // ---- per-turn metrics ----
    const turns: TurnCalc[] = turnsRaw.map((t) => {
      const bucket = localBucket(t.created);
      const day = localDayStart(t.created);
      const hour = localHour(t.created);
      if (t.role !== "assistant") {
        return { ...t, promptTotal: 0, occupancy: 0, contextWindow: 0, fill: 0, fillAfter: 0, costComputed: 0, bucket, day, hour };
      }
      const m = info(t.provider, t.model);
      // What the provider actually received = the real context occupancy for this call.
      const promptTotal = t.input + t.cacheRead + t.cacheWrite;
      const occupancy = promptTotal + t.output + t.reasoning;
      const contextWindow = m?.context ?? 128000;
      const costComputed = m
        ? (t.input * m.costInput + t.output * m.costOutput + t.reasoning * m.costOutput +
            t.cacheRead * m.costCacheRead + t.cacheWrite * m.costCacheWrite) / 1e6
        : 0;
      return {
        ...t,
        promptTotal,
        occupancy,
        contextWindow,
        fill: contextWindow > 0 ? Math.min(1, promptTotal / contextWindow) : 0,
        fillAfter: contextWindow > 0 ? Math.min(1, occupancy / contextWindow) : 0,
        costComputed: Math.max(t.cost, costComputed),
        bucket,
        day,
        hour,
      };
    });

    const assistantBySession = new Map<string, TurnCalc[]>();
    for (const t of turns) {
      if (t.role !== "assistant") continue;
      if (t.occupancy <= 0 && t.tools.length === 0) continue;
      const list = assistantBySession.get(t.sessionId) ?? [];
      list.push(t);
      assistantBySession.set(t.sessionId, list);
    }
    for (const list of assistantBySession.values()) list.sort((a, b) => a.created - b.created || a.seq - b.seq);

    const firstPromptBySession = new Map<string, string>();
    for (const t of turns) {
      if (t.role !== "user" || !t.text || firstPromptBySession.has(t.sessionId)) continue;
      firstPromptBySession.set(t.sessionId, t.text.replace(/\s+/g, " ").trim().slice(0, 300));
    }

    // ---- probes: source events (compaction/idle/switch) + failure/retry/loop ----
    const eventsBySession = buildEventProbes(src.events(targetIds), assistantBySession);

    // ---- flow/heat cells to re-aggregate (read BEFORE deleting the old rows) ----
    const affectedBuckets = new Set<number>();
    const affectedDays = new Set<number>();
    const idList = [...targetIds];
    if (idList.length) {
      const ph = idList.map(() => "?").join(",");
      const oldCells = db.prepare(`SELECT DISTINCT bucket, day FROM turns WHERE session_id IN (${ph})`).all(...idList) as any[];
      for (const r of oldCells) {
        if (r.bucket != null) affectedBuckets.add(Number(r.bucket));
        if (r.day != null) affectedDays.add(Number(r.day));
      }
    }

    let turnCount = 0;
    let toolCount = 0;
    let partCount = 0;
    let eventCount = 0;
    let sessionCount = 0;

    db.exec("BEGIN");
    try {
      if (idList.length) {
        const ph = idList.map(() => "?").join(",");
        db.prepare(`DELETE FROM tools WHERE session_id IN (${ph})`).run(...idList);
        db.prepare(`DELETE FROM parts WHERE session_id IN (${ph})`).run(...idList);
        db.prepare(`DELETE FROM events WHERE session_id IN (${ph})`).run(...idList);
        db.prepare(`DELETE FROM turns WHERE session_id IN (${ph})`).run(...idList);
        db.prepare(`DELETE FROM sessions WHERE id IN (${ph})`).run(...idList);
      }

      const turnCols = [
        "id", "session_id", "project", "seq", "created", "completed", "dur_ms", "role", "provider", "model",
        "variant", "agent", "input", "output", "reasoning", "cache_read", "cache_write", "cost", "prompt_total",
        "occupancy", "context_window", "fill", "fill_after", "bucket", "day", "hour", "finish",
        "has_error", "tool_calls", "tool_errors", "additions", "deletions", "write_lines", "text",
      ];
      const insTurn = db.prepare(`INSERT INTO turns(${turnCols.join(",")}) VALUES(${turnCols.map(() => "?").join(",")})`);
      const insTool = db.prepare(
        `INSERT INTO tools(session_id,turn_id,call_id,name,status,started,ended,dur_ms,title,output_chars,additions,deletions,files,write_lines,error,sig,input_preview,target_session)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      const insPart = db.prepare(
        `INSERT INTO parts(session_id,turn_id,ordinal,kind,text,name,call_id,status,title,input,output,exit_code,truncated,started,ended,chars)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );

      for (const t of turns) {
        const s = sessionById.get(t.sessionId);
        if (!s) continue;
        insTurn.run(
          t.id, t.sessionId, s.project, t.seq, t.created, t.completed,
          t.created && t.completed ? Math.max(0, t.completed - t.created) : null,
          t.role, t.provider, t.model, t.variant, t.agent,
          t.input, t.output, t.reasoning, t.cacheRead, t.cacheWrite, t.costComputed,
          t.promptTotal, t.occupancy, t.contextWindow, t.fill, t.fillAfter, t.bucket, t.day, t.hour, t.finish,
          t.tools.some((x: SrcTool) => x.status === "error") ? 1 : 0, t.tools.length,
          t.tools.filter((x: SrcTool) => x.status === "error").length, t._add ?? 0, t._del ?? 0, t._write ?? 0,
          (t.text ?? "").slice(0, 2000)
        );
        turnCount++;
        affectedBuckets.add(t.bucket);
        affectedDays.add(t.day);
        for (const tool of t.tools) {
          insTool.run(
            tool.sessionId, t.id, tool.callId, tool.name, tool.status, tool.started, tool.ended,
            tool.started && tool.ended ? Math.max(0, tool.ended - tool.started) : null,
            tool.title, tool.outputChars, tool.additions, tool.deletions, tool.files, tool.writeLines,
            tool.error ? tool.error.slice(0, 2000) : null, tool.sig, tool.inputPreview, tool.targetSession
          );
          toolCount++;
          if (tool.status === "error") {
            insertEvent(db, {
              sessionId: tool.sessionId, turnId: t.id, type: "failure",
              at: tool.started ?? t.created, endAt: tool.ended ?? tool.started ?? t.created, count: 1,
              fill: t.fill,
              detail: { tool: tool.name, error: (tool.error ?? "").slice(0, 300), title: tool.title },
            });
            eventCount++;
          }
        }
        // The transcript is written in content order; `ordinal` is what the messages
        // panel walks, so a turn always reads back exactly as the model produced it.
        for (let i = 0; i < t.parts.length; i++) {
          const p = t.parts[i];
          insPart.run(
            t.sessionId, t.id, i, p.kind, p.text || null, p.name || null, p.callId || null,
            p.status || null, p.title, p.input || null, p.output || null, p.exitCode,
            p.truncated ? 1 : 0, p.started, p.ended, p.chars
          );
          partCount++;
        }
      }

      for (const [sid, list] of eventsBySession) {
        const ts = assistantBySession.get(sid) ?? [];
        for (const e of list) {
          // Fill at the moment of the event = the last turn that had already been sent.
          let fill = 0;
          for (const t of ts) {
            if (t.created <= e.at) fill = t.fill;
            else break;
          }
          insertEvent(db, { sessionId: sid, turnId: e.turnId, type: e.type, at: e.at, endAt: e.endAt, count: e.count, fill, detail: e.detail });
          eventCount++;
        }
      }

      // ---- sessions ----
      const sessionCols = [
        "id", "project", "directory", "title", "agent", "provider", "model", "variant", "parent_id", "depth",
        "created", "updated", "t_input", "t_output", "t_reasoning", "t_cache_read", "t_cache_write", "cost",
        "turns", "tool_calls", "tool_errors", "compactions", "retries", "loops", "additions", "deletions", "files_changed",
        "peak_fill", "avg_fill", "eff_score", "tokens_per_line", "first_prompt", "duration_ms", "dominant_model",
        "output_rate",
      ];
      const insSession = db.prepare(`INSERT INTO sessions(${sessionCols.join(",")}) VALUES(${sessionCols.map(() => "?").join(",")})`);

      for (const s of sessionById.values()) {
        const ts = assistantBySession.get(s.id) ?? [];
        const sum = (f: (t: TurnCalc) => number) => ts.reduce((a, t) => f(t) + a, 0);
        const tInput = s.tInput || sum((t) => t.input);
        const tOutput = s.tOutput || sum((t) => t.output);
        const tReasoning = s.tReasoning || sum((t) => t.reasoning);
        const tCacheRead = s.tCacheRead || sum((t) => t.cacheRead);
        const tCacheWrite = s.tCacheWrite || sum((t) => t.cacheWrite);
        const promptTotal = tInput + tCacheRead + tCacheWrite;
        // Prefer the per-turn diffs we now parse from tool metadata; the v2 session
        // summary only counts part of the stream, so it is a fallback, not the source.
        const turnAdd = sum((t) => t._add ?? 0);
        const turnDel = sum((t) => t._del ?? 0);
        const additions = turnAdd || s.additions;
        const deletions = turnDel || s.deletions;
        const toolCalls = ts.reduce((a, t) => a + t.tools.length, 0);
        const toolErrors = ts.reduce((a, t) => a + t.tools.filter((x) => x.status === "error").length, 0);
        const patches = patchFiles.get(s.id);
        const filesChanged = Math.max(sum((t) => t._files ?? 0), patches?.files ?? 0);
        const peak = ts.reduce((a, t) => Math.max(a, t.fill), 0);
        const avg = ts.length ? ts.reduce((a, t) => a + t.fill, 0) / ts.length : 0;
        const eff = promptTotal > 0 ? ((tOutput + tReasoning) / promptTotal) * 100 : 0;
        const lines = additions + deletions;
        const totalTokens = tInput + tOutput + tReasoning + tCacheRead + tCacheWrite;

        const byModel = new Map<string, number>();
        for (const t of ts) {
          const k = t.model ?? "unknown";
          byModel.set(k, (byModel.get(k) ?? 0) + t.occupancy);
        }
        let dominant = s.model ?? "unknown";
        let bestV = -1;
        for (const [k, v] of byModel) if (v > bestV) ((bestV = v), (dominant = k));

        // Median generation speed, the same statistic the transcript header shows per
        // turn: a mean would be dragged around by turns that waited on a tool.
        const rates = ts
          .map((t) => (t.output > 0 && t.completed && t.created && t.completed > t.created
            ? t.output / ((t.completed - t.created) / 1000)
            : 0))
          .filter((r) => r > 0)
          .sort((a, b) => a - b);
        const mid = Math.floor(rates.length / 2);
        const outputRate = rates.length === 0 ? 0 : rates.length % 2 !== 0 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;

        const sessionEvents = eventsBySession.get(s.id) ?? [];
        const compactions = sessionEvents.filter((e) => e.type === "compaction").length;
        const retries = sessionEvents.filter((e) => e.type === "retry").length;
        const loops = sessionEvents.filter((e) => e.type === "loop").length;

        insSession.run(
          s.id, s.project, s.directory, s.title, s.agent, s.provider, s.model, s.variant, s.parentId, depthOf(s, allById),
          s.created, s.updated,
          tInput, tOutput, tReasoning, tCacheRead, tCacheWrite,
          Math.max(s.cost, ts.reduce((a, t) => a + t.costComputed, 0)),
          ts.length, toolCalls, toolErrors, compactions, retries, loops,
          additions, deletions, filesChanged,
          peak, avg, eff, lines > 0 ? totalTokens / lines : null,
          firstPromptBySession.get(s.id) ?? null, s.updated - s.created, dominant, outputRate
        );
        sessionCount++;
      }

      // ---- model catalog upsert ----
      const upModel = db.prepare(
        `INSERT INTO models(id,provider,label,context,cost_input,cost_output,cost_cache_read,cost_cache_write,source)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, context=excluded.context,
           cost_input=excluded.cost_input, cost_output=excluded.cost_output,
           cost_cache_read=excluded.cost_cache_read, cost_cache_write=excluded.cost_cache_write, source=excluded.source`
      );
      for (const [key, m] of Object.entries(catalog)) {
        upModel.run(key, m.provider, m.label, m.context, m.costInput, m.costOutput, m.costCacheRead, m.costCacheWrite, m.source);
      }

      // Derived tables commit with their facts: a crash can never leave the rollups
      // describing a build that did not happen.
      refreshRollups(db, idList, [...affectedDays], mode === "full");
      setMeta(db, "sourceDb", opts.sourceDb ?? SOURCE_DB);
      setMeta(db, "sourceSchema", src.schema);
      setMeta(db, "sourceMaxTime", String(src.maxMessageTime()));
      setMeta(db, "materializedAt", String(Date.now()));
      setMeta(db, "bucketMs", String(BUCKET_MS));
      setMeta(db, "mode", mode);
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* transaction already gone */
      }
      throw e;
    }

    const flowRows = recomputeFlow(db, affectedBuckets);
    const heatRows = recomputeHeat(db, affectedDays);

    return {
      mode,
      schema: src.schema,
      sessions: sessionCount,
      turns: turnCount,
      tools: toolCount,
      parts: partCount,
      events: eventCount,
      flow: flowRows,
      heat: heatRows,
      models: Object.keys(catalog).length,
      ms: Date.now() - t0,
    };
  } finally {
    src.close();
  }
}

function depthOf(s: SrcSession, byId: Map<string, SrcSession>): number {
  let d = 0;
  let cur = s.parentId ? byId.get(s.parentId) : null;
  while (cur && d < 10) {
    d++;
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return d;
}

const insEventStmt = new WeakMap<DatabaseSync, ReturnType<DatabaseSync["prepare"]>>();
function insertEvent(db: DatabaseSync, e: {
  sessionId: string; turnId: string | null; type: string; at: number; endAt: number; count: number; fill: number; detail: Record<string, unknown>;
}) {
  let st = insEventStmt.get(db);
  if (!st) {
    st = db.prepare("INSERT INTO events(session_id,turn_id,type,at,end_at,count,fill,detail) VALUES(?,?,?,?,?,?,?,?)");
    insEventStmt.set(db, st);
  }
  st.run(e.sessionId, e.turnId, e.type, Math.round(e.at), Math.round(e.endAt), e.count, e.fill, JSON.stringify(e.detail));
}

/**
 * Retry / loop probes.
 * A repeated identical call is only a *retry* when the previous attempt failed (or
 * this one did) and both fall inside RETRY_WINDOW_MS — otherwise every re-read of
 * the same file would light up the marker layer.
 * LOOP_MIN_REPEATS identical calls in a row is a *loop* (the agent is stuck).
 */
export function buildEventProbes(
  sourceEvents: { sessionId: string; turnId: string | null; type: string; at: number; reason: string | null; detail: string | null; tokensBefore?: number | null; model?: string | null }[],
  assistantBySession: Map<string, TurnCalc[]>,
  opts: { enrichCompaction?: boolean } = {}
): Map<string, ProbeEvent[]> {
  const out = new Map<string, ProbeEvent[]>();
  for (const e of sourceEvents) {
    const list = out.get(e.sessionId) ?? [];
    const detail: Record<string, unknown> = { reason: e.reason };
    if (e.detail) detail.summary = e.detail;
    if (e.tokensBefore != null) detail.sourceTokens = e.tokensBefore;
    if (e.model) detail.model = e.model;
    list.push({ type: e.type, at: e.at, endAt: e.at, count: 1, turnId: e.turnId, detail });
    out.set(e.sessionId, list);
  }

  if (opts.enrichCompaction !== false) {
    for (const [sid, list] of out) {
      const ts = assistantBySession.get(sid);
      if (!ts) continue;
      for (const e of list) {
        if (e.type !== "compaction") continue;
        let idx = -1;
        for (let i = 0; i < ts.length; i++) {
          if (ts[i].created <= e.at) idx = i;
          else break;
        }
        const before = idx >= 0 ? ts[idx] : null;
        const after = idx + 1 < ts.length ? ts[idx + 1] : null;
        if (before) {
          e.detail.before = before.promptTotal;
          e.detail.model = e.detail.model ?? before.model;
        }
        if (after) e.detail.after = after.promptTotal;
        if (before && after) e.detail.delta = after.promptTotal - before.promptTotal;
      }
    }
  }

  for (const [sid, ts] of assistantBySession) {
    const lastSeen = new Map<string, { at: number; ok: boolean }>();
    const chains = new Map<string, { count: number; from: number; to: number }>();
    const probes: ProbeEvent[] = [];

    for (const t of ts) {
      for (const tool of t.tools) {
        const at = tool.started ?? t.created;
        const ok = tool.status !== "error";
        const prev = lastSeen.get(tool.sig);
        const dt = prev ? at - prev.at : null;
        const within = dt != null && dt >= 0 && dt <= RETRY_WINDOW_MS;

        if (prev && within && (!prev.ok || !ok)) {
          probes.push({
            type: "retry", at: prev.at, endAt: at, count: 1, turnId: t.id,
            detail: { tool: tool.name, title: tool.title, sig: tool.sig, first_failed: !prev.ok, span_ms: at - prev.at },
          });
        }

        let chain = chains.get(tool.sig);
        if (within && chain) {
          chain.count++;
          chain.to = at;
        } else {
          chain = { count: 1, from: at, to: at };
          chains.set(tool.sig, chain);
        }
        lastSeen.set(tool.sig, { at, ok });
      }
    }

    for (const [sig, chain] of chains) {
      if (chain.count >= LOOP_MIN_REPEATS) {
        probes.push({
          type: "loop", at: chain.from, endAt: chain.to, count: chain.count, turnId: null,
          detail: { sig, repeats: chain.count, span_ms: chain.to - chain.from },
        });
      }
    }

    if (probes.length) {
      const list = out.get(sid) ?? [];
      out.set(sid, [...list, ...probes]);
    }
  }

  for (const list of out.values()) list.sort((a, b) => a.at - b.at);
  return out;
}

/** Re-aggregate ECG flow cells for the given buckets straight from `turns`. */
export function recomputeFlow(db: DatabaseSync, buckets: Set<number>): number {
  if (!buckets.size) return 0;
  const list = [...buckets];
  const ph = list.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT project, bucket, session_id, model, input, output, reasoning, cache_read, cost, fill
       FROM turns WHERE role='assistant' AND bucket IN (${ph})`
    )
    .all(...list) as any[];

  const cells = new Map<string, {
    project: string; bucket: number; gen: number; cacheRead: number; cost: number;
    sessions: Set<string>; models: Map<string, number>; peak: number;
  }>();
  for (const r of rows) {
    const key = `${r.project}|${r.bucket}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { project: r.project, bucket: Number(r.bucket), gen: 0, cacheRead: 0, cost: 0, sessions: new Set(), models: new Map(), peak: 0 };
      cells.set(key, cell);
    }
    const gen = Number(r.input) + Number(r.output) + Number(r.reasoning);
    cell.gen += gen;
    cell.cacheRead += Number(r.cache_read ?? 0);
    cell.cost += Number(r.cost ?? 0);
    cell.sessions.add(String(r.session_id));
    cell.peak = Math.max(cell.peak, Number(r.fill ?? 0));
    const m = r.model ?? "unknown";
    cell.models.set(m, (cell.models.get(m) ?? 0) + gen);
  }

  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM flow WHERE bucket IN (${ph})`).run(...list);
    const ins = db.prepare(
      "INSERT INTO flow(project,bucket,tokens_gen,tokens_cache_read,cost,sessions,dominant_model,peak_fill) VALUES(?,?,?,?,?,?,?,?)"
    );
    for (const c of cells.values()) {
      let dominant = "unknown";
      let best = -1;
      for (const [k, v] of c.models) if (v > best) ((best = v), (dominant = k));
      ins.run(c.project, c.bucket, Math.round(c.gen), Math.round(c.cacheRead), c.cost, c.sessions.size, dominant, c.peak);
    }
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already gone */
    }
    throw e;
  }
  return cells.size;
}

/** Re-aggregate the circadian spectrogram for the given local days. */
export function recomputeHeat(db: DatabaseSync, days: Set<number>): number {
  if (!days.size) return 0;
  const list = [...days];
  const ph = list.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT project, day, hour, input, output, reasoning, cache_read, cost
       FROM turns WHERE role='assistant' AND day IN (${ph})`
    )
    .all(...list) as any[];

  const cells = new Map<string, { project: string; day: number; hour: number; gen: number; cacheRead: number; cost: number; turns: number }>();
  for (const r of rows) {
    const key = `${r.project}|${r.day}|${r.hour}`;
    let c = cells.get(key);
    if (!c) {
      c = { project: r.project, day: Number(r.day), hour: Number(r.hour), gen: 0, cacheRead: 0, cost: 0, turns: 0 };
      cells.set(key, c);
    }
    c.gen += Number(r.input) + Number(r.output) + Number(r.reasoning);
    c.cacheRead += Number(r.cache_read ?? 0);
    c.cost += Number(r.cost ?? 0);
    c.turns++;
  }

  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM heat WHERE day IN (${ph})`).run(...list);
    const ins = db.prepare("INSERT INTO heat(project,day,hour,tokens_gen,tokens_cache_read,cost,turns) VALUES(?,?,?,?,?,?,?)");
    for (const c of cells.values()) ins.run(c.project, c.day, c.hour, Math.round(c.gen), Math.round(c.cacheRead), c.cost, c.turns);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already gone */
    }
    throw e;
  }
  return cells.size;
}
