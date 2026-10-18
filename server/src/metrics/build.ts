import type { DatabaseSync } from "node:sqlite";
import { BUCKET_MS, SOURCE_DB } from "../config";
import { SourceReader, type SrcTurn, type SrcSession } from "../source";
import { initSchema, setMeta } from "./schema";
import { catalogKey, loadCatalog, type Catalog } from "./catalog";

const isWin = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

interface TurnCalc extends SrcTurn {
  _add?: number;
  _del?: number;
  _files?: number;
  promptTotal: number;
  occupancy: number;
  contextWindow: number;
  fill: number;
  costComputed: number;
}

function localDayHour(ts: number): { dow: number; hour: number } {
  const d = new Date(ts);
  return { dow: (d.getDay() + 7) % 7, hour: d.getHours() };
}

export interface BuildReport {
  schema: string;
  sessions: number;
  turns: number;
  tools: number;
  events: number;
  flow: number;
  models: number;
  ms: number;
}

export async function build(db: DatabaseSync): Promise<BuildReport> {
  const t0 = Date.now();
  const src = new SourceReader(SOURCE_DB);
  try {
    initSchema(db);
    db.exec("BEGIN");

    const srcSessions = src.sessions();
    const sessionById = new Map<string, SrcSession>(srcSessions.map((s) => [s.id, s]));
    const turnsRaw = src.turns();
    const events = src.events();

    const wanted = new Set<string>();
    for (const s of srcSessions) if (s.model) wanted.add(catalogKey(s.provider, s.model));
    for (const t of turnsRaw) if (t.role === "assistant" && t.model) wanted.add(catalogKey(t.provider, t.model));
    const catalog: Catalog = await loadCatalog(wanted);

    const info = (provider: string | null | undefined, model: string | null | undefined) =>
      catalog[catalogKey(provider, model)] ?? catalog[catalogKey("opencode", model)] ?? null;

    // ---- turns ----
    const turns: TurnCalc[] = [];
    for (const t of turnsRaw) {
      if (t.role !== "assistant") {
        turns.push({ ...t, promptTotal: 0, occupancy: 0, contextWindow: 0, fill: 0, costComputed: 0 });
        continue;
      }
      const m = info(t.provider, t.model);
      const promptTotal = t.input + t.cacheRead + t.cacheWrite;
      const occupancy = promptTotal + t.output + t.reasoning;
      const contextWindow = m?.context ?? 128000;
      const costComputed = m
        ? (t.input * m.costInput + t.output * m.costOutput + t.reasoning * m.costOutput +
            t.cacheRead * m.costCacheRead + t.cacheWrite * m.costCacheWrite) / 1e6
        : 0;
      turns.push({
        ...t,
        promptTotal,
        occupancy,
        contextWindow,
        fill: contextWindow > 0 ? Math.min(1, occupancy / contextWindow) : 0,
        costComputed: Math.max(t.cost, costComputed),
      });
    }

    const assistantTurns = turns.filter((t) => t.role === "assistant" && (t.occupancy > 0 || t.tools.length > 0));
    // ---- tools + retry/error events ----
    const toolRows: any[] = [];
    const eventRows: any[] = [];
    const retryCount = new Map<string, number>();
    const seenSig = new Map<string, string>();

    for (const t of assistantTurns) {
      for (const tool of t.tools) {
        const dur = tool.started && tool.ended ? Math.max(0, tool.ended - tool.started) : null;
        toolRows.push([
          tool.sessionId, t.id, tool.callId, tool.name, tool.status, tool.started, tool.ended, dur,
          tool.title, tool.outputChars, tool.additions, tool.deletions, tool.files, tool.error, tool.sig,
        ]);
        const key = `${tool.sessionId}|${tool.sig}`;
        if (seenSig.has(key)) {
          retryCount.set(tool.sessionId, (retryCount.get(tool.sessionId) ?? 0) + 1);
          eventRows.push([tool.sessionId, t.id, "retry", tool.started ?? t.created, t.fill, JSON.stringify({ tool: tool.name, title: tool.title })]);
        } else {
          seenSig.set(key, tool.turnId);
        }
        if (tool.status === "error") {
          eventRows.push([tool.sessionId, t.id, "failure", tool.started ?? t.created, t.fill, JSON.stringify({ tool: tool.name, error: (tool.error ?? "").slice(0, 300) })]);
        }
      }
    }

    for (const e of events) {
      const sessionTurns = assistantTurns.filter((t) => t.sessionId === e.sessionId);
      let fill = 0;
      for (const t of sessionTurns) if (t.created <= e.at) fill = Math.max(fill, t.fill);
      eventRows.push([e.sessionId, e.turnId, e.type, e.at, fill, JSON.stringify({ reason: e.reason, detail: (e.detail ?? "").slice(0, 500) })]);
    }

    // ---- sessions ----
    const aggTurns = new Map<string, TurnCalc[]>();
    for (const t of assistantTurns) {
      if (!aggTurns.has(t.sessionId)) aggTurns.set(t.sessionId, []);
      aggTurns.get(t.sessionId)!.push(t);
    }
    const userPromptBySession = new Map<string, string>();
    for (const t of turnsRaw) {
      if (t.role === "user" && t.text && !userPromptBySession.has(t.sessionId)) {
        userPromptBySession.set(t.sessionId, t.text.replace(/\s+/g, " ").trim().slice(0, 300));
      }
    }

    const depthOf = (s: SrcSession): number => {
      let d = 0;
      let cur = s.parentId ? sessionById.get(s.parentId) : null;
      while (cur && d < 10) {
        d++;
        cur = cur.parentId ? sessionById.get(cur.parentId) : null;
      }
      return d;
    };

    const sessionRows: any[] = [];
    for (const s of srcSessions) {
      const ts = aggTurns.get(s.id) ?? [];
      const sum = (f: (t: TurnCalc) => number) => ts.reduce((a, t) => f(t) + a, 0);
      const tInput = s.tInput || sum((t) => t.input);
      const tOutput = s.tOutput || sum((t) => t.output);
      const tReasoning = s.tReasoning || sum((t) => t.reasoning);
      const tCacheRead = s.tCacheRead || sum((t) => t.cacheRead);
      const tCacheWrite = s.tCacheWrite || sum((t) => t.cacheWrite);
      const promptTotal = tInput + tCacheRead + tCacheWrite;
      const additions = s.additions || sum((t) => t._add ?? 0);
      const deletions = s.deletions || sum((t) => t._del ?? 0);
      const filesChanged = sum((t) => t._files ?? 0);
      const toolCalls = ts.reduce((a, t) => a + t.tools.length, 0);
      const toolErrors = ts.reduce((a, t) => a + t.tools.filter((x) => x.status === "error").length, 0);
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

      const compactions = events.filter((e) => e.sessionId === s.id && e.type === "compaction").length;
      sessionRows.push([
        s.id, s.project, s.directory, s.title, s.agent, s.provider, s.model, s.variant, s.parentId, depthOf(s),
        s.created, s.updated,
        tInput, tOutput, tReasoning, tCacheRead, tCacheWrite,
        Math.max(s.cost, sum((t) => t.costComputed)), ts.length, toolCalls, toolErrors, compactions, retryCount.get(s.id) ?? 0,
        additions, deletions, filesChanged, peak, avg, eff, lines > 0 ? totalTokens / lines : null,
        userPromptBySession.get(s.id) ?? null, s.updated - s.created, dominant,
      ]);
    }

    // ---- flow (ECG) + heat ----
    const flowAgg = new Map<number, Map<string, { tokens: number; cost: number; sessions: Set<string>; models: Map<string, number>; peak: number }>>();
    const heatAgg = new Map<string, { project: string; dow: number; hour: number; tokens: number; cost: number; turns: number }>();
    for (const t of assistantTurns) {
      const s = sessionById.get(t.sessionId);
      const project = s?.project ?? "unknown";
      const bucket = Math.floor(t.created / BUCKET_MS) * BUCKET_MS;
      const flowTokens = t.input + t.output + t.reasoning;
      if (!flowAgg.has(bucket)) flowAgg.set(bucket, new Map());
      const perProject = flowAgg.get(bucket)!;
      let cell = perProject.get(project);
      if (!cell) perProject.set(project, (cell = { tokens: 0, cost: 0, sessions: new Set(), models: new Map(), peak: 0 }));
      cell.tokens += flowTokens;
      cell.cost += t.costComputed;
      cell.sessions.add(t.sessionId);
      cell.models.set(t.model ?? "unknown", (cell.models.get(t.model ?? "unknown") ?? 0) + flowTokens);
      cell.peak = Math.max(cell.peak, t.fill);

      const { dow, hour } = localDayHour(t.created);
      const hk = `${project}|${dow}|${hour}`;
      const hc = heatAgg.get(hk) ?? { project, dow, hour, tokens: 0, cost: 0, turns: 0 };
      hc.tokens += flowTokens + t.cacheRead;
      hc.cost += t.costComputed;
      hc.turns += 1;
      heatAgg.set(hk, hc);
    }

    const flowRows: any[] = [];
    for (const [bucket, perProject] of [...flowAgg.entries()].sort((a, b) => a[0] - b[0])) {
      for (const [project, cell] of perProject) {
        let dominant = "unknown";
        let bestV = -1;
        for (const [k, v] of cell.models) if (v > bestV) ((bestV = v), (dominant = k));
        flowRows.push([project, bucket, cell.tokens, cell.cost, cell.sessions.size, dominant, cell.peak]);
      }
    }

    // ---- write ----
    const insert = (table: string, cols: string[]) =>
      db.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`);

    const turnCols = [
      "id", "session_id", "project", "seq", "created", "completed", "dur_ms", "role", "provider", "model",
      "variant", "agent", "input", "output", "reasoning", "cache_read", "cache_write", "cost", "prompt_total",
      "occupancy", "context_window", "fill", "finish", "has_error", "tool_calls", "tool_errors", "additions", "deletions", "text",
    ];
    const insTurn = insert("turns", turnCols);
    for (const t of turns) {
      const s = sessionById.get(t.sessionId);
      insTurn.run(
        t.id, t.sessionId, s?.project ?? "unknown", t.seq, t.created, t.completed,
        t.created && t.completed ? Math.max(0, t.completed - t.created) : null,
        t.role, t.provider, t.model, t.variant, t.agent,
        t.input, t.output, t.reasoning, t.cacheRead, t.cacheWrite, t.costComputed,
        t.promptTotal, t.occupancy, t.contextWindow, t.fill, t.finish,
        t.tools.some((x) => x.status === "error") ? 1 : 0, t.tools.length,
        t.tools.filter((x) => x.status === "error").length, t._add ?? 0, t._del ?? 0,
        (t.text ?? "").slice(0, 2000)
      );
    }
    const insTool = insert("tools", [
      "session_id", "turn_id", "call_id", "name", "status", "started", "ended", "dur_ms", "title",
      "output_chars", "additions", "deletions", "files", "error", "sig",
    ]);
    for (const r of toolRows) insTool.run(...r);
    const insEvent = insert("events", ["session_id", "turn_id", "type", "at", "fill", "detail"]);
    for (const r of eventRows) insEvent.run(...r);
    const insSession = insert("sessions", [
      "id", "project", "directory", "title", "agent", "provider", "model", "variant", "parent_id", "depth",
      "created", "updated", "t_input", "t_output", "t_reasoning", "t_cache_read", "t_cache_write", "cost",
      "turns", "tool_calls", "tool_errors", "compactions", "retries", "additions", "deletions", "files_changed",
      "peak_fill", "avg_fill", "eff_score", "tokens_per_line", "first_prompt", "duration_ms", "dominant_model",
    ]);
    for (const r of sessionRows) insSession.run(...r);
    const insFlow = insert("flow", ["project", "bucket", "tokens", "cost", "sessions", "dominant_model", "peak_fill"]);
    for (const r of flowRows) insFlow.run(...r);
    const insHeat = insert("heat", ["project", "dow", "hour", "tokens", "cost", "turns"]);
    for (const h of heatAgg.values()) insHeat.run(h.project, h.dow, h.hour, h.tokens, h.cost, h.turns);
    const insModel = insert("models", [
      "id", "provider", "label", "context", "cost_input", "cost_output", "cost_cache_read", "cost_cache_write",
    ]);
    for (const [key, m] of Object.entries(catalog)) insModel.run(key, m.provider, m.label, m.context, m.costInput, m.costOutput, m.costCacheRead, m.costCacheWrite);

    db.exec("COMMIT");
    setMeta(db, "sourceDb", SOURCE_DB);
    setMeta(db, "sourceSchema", src.schema);
    setMeta(db, "sourceMaxTime", String(src.maxMessageTime()));
    setMeta(db, "materializedAt", String(Date.now()));
    setMeta(db, "bucketMs", String(BUCKET_MS));

    return {
      schema: src.schema,
      sessions: sessionRows.length,
      turns: turns.length,
      tools: toolRows.length,
      events: eventRows.length,
      flow: flowRows.length,
      models: Object.keys(catalog).length,
      ms: Date.now() - t0,
    };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already gone */
    }
    throw e;
  } finally {
    src.close();
  }
}
