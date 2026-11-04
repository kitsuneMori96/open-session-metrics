import type { DatabaseSync } from "node:sqlite";
import { BUCKET_MS, type SourceKind } from "../config";
import { type SrcTurn, type SrcSession, type SrcTool, type SrcPart, type SourceLike } from "../source";
import { openSource } from "../source-select";
import { getMetaNumber, initSchema, setMeta } from "./schema";
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
  "home",
  "root",
  "users",
  "usr",
  "tmp",
  "var",
  "srv",
  "opt",
  "bin",
  "lib",
  "src",
  "dist",
  "data",
  "log",
  "logs",
  "cache",
  "config",
  "appdata",
  "desktop",
  "documents",
  "downloads",
  "program",
  "programs",
  "programdata",
  "node_modules",
  "versions",
  "share",
  "code",
]);

const isJunkLane = (project: string, accounts: Set<string>) =>
  !project || project === "/" || project === "unknown" || accounts.has(project);

/** `D:\Code\x` and `/mnt/c/Users/x` both have to reach the voters below. */
const toPosix = (raw: string) => raw.replace(/\\/g, "/").replace(/^[A-Za-z]:\//, "/");

export function inferProject(paths: string[], fallback: string, accounts: Set<string>): string {
  const votes = new Map<string, number>();
  const vote = (label: string | null | undefined, weight: number) => {
    if (!label) return;
    const l = label.toLowerCase();
    if (l.startsWith(".") || l.length < 3 || IGNORED.has(l)) return;
    votes.set(label, (votes.get(label) ?? 0) + weight);
  };
  for (const raw of paths) {
    const p = toPosix(raw).replace(/^\/mnt\/[a-zA-Z]\//, "/");
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
 * - `mode: "incremental"` rewrites the tail of those sessions, then re-aggregates
 *   the flow/heat cells their turns touched. Session rows are always rewritten
 *   whole, because their totals are summed over the full transcript.
 */
/**
 * A turn's row in the store stops changing once its response ends, so an
 * incremental tick rewrites only the tail of the sessions it touched: everything
 * the watermark already covers minus this grace. The grace is generous because
 * both sources keep updating an assistant row while it streams, and a torn tail
 * line is repaired by a later build.
 */
const TAIL_GRACE_MS = 6 * 3600_000;
/** Turns inserted between these chunks hand the event loop back to HTTP. */
const CHUNK_TURNS = 500;

const yieldToEventLoop = () => new Promise<void>((res) => setImmediate(() => res()));

export async function build(
  db: DatabaseSync,
  opts: {
    sessionIds?: Set<string>;
    mode?: "full" | "incremental";
    kind?: SourceKind;
    /** A reader already walked this tick. `build` closes only the one it opened. */
    reader?: SourceLike;
  } = {},
): Promise<BuildReport> {
  const t0 = Date.now();
  const mode = opts.mode ?? "full";
  const ownsSource = !opts.reader;
  const src = opts.reader ?? openSource(opts.kind);
  try {
    initSchema(db, { drop: mode === "full" });
    ensureRollups(db);

    const prevWatermark = getMetaNumber(db, "sourceMaxTime");
    const scope = mode === "incremental" && opts.sessionIds ? opts.sessionIds : null;
    const tailFrom = scope && prevWatermark > 0 ? prevWatermark - TAIL_GRACE_MS : 0;

    // Only the sessions this tick owns are parsed; everything else about them —
    // the parent chain a sub-agent borrows its lane from, the account names that
    // make a directory a junk lane — is already materialized in the store.
    // A full build walks the corpus one session at a time, because the whole
    // corpus in one call is seventeen seconds of event loop nobody else can have.
    const walk = async <T>(pick: (ids: Set<string>) => T[], only?: Set<string>): Promise<T[]> => {
      if (only) return pick(only);
      const out: T[] = [];
      for (const id of src.sessionIds()) {
        out.push(...pick(new Set([id])));
        await yieldToEventLoop();
      }
      return out;
    };
    const parsed = await walk<SrcSession>((ids) => src.sessions(ids), scope ?? undefined);
    const allById = new Map<string, SrcSession>(parsed.map((s) => [s.id, s]));
    // `accounts` must keep naming the same directories it did on the full build;
    // a scoped tick sees only its own sessions, so it borrows the rest from the store.
    const directories: string[] = parsed.map((s) => s.directory);
    if (scope) {
      const stored = db.prepare("SELECT id, parent_id, project, directory FROM sessions").all() as any[];
      for (const r of stored) directories.push(String(r.directory ?? "/"));
      const chain = new Map(stored.map((r) => [String(r.id), r]));
      for (const s of [...allById.values()]) {
        let parent = s.parentId ? chain.get(s.parentId) : null;
        while (parent && !allById.has(String(parent.id))) {
          allById.set(
            String(parent.id),
            stubSession(String(parent.id), parent.project, parent.directory, parent.parent_id),
          );
          directories.push(parent.directory ?? "/");
          parent = chain.get(String(parent.parent_id ?? "")) ?? null;
        }
      }
    }

    const targetIds = scope ?? new Set(parsed.map((s) => s.id));
    const sessionById = new Map<string, SrcSession>();
    for (const id of targetIds) {
      const s = allById.get(id);
      if (s) sessionById.set(id, s);
    }

    const wanted = new Set<string>();
    for (const s of sessionById.values()) if (s.model) wanted.add(catalogKey(s.provider, s.model));
    const turnsRaw = await walk<SrcTurn>((ids) => src.turns(ids), scope ?? undefined);
    // A message id is the turn's identity, so it may enter the store once. Desktop
    // side chats copy their owner's transcript (same ids, same usage), and a source
    // without a fork index cannot tell the copy from the original: the row that is
    // already stored — or came first in this build — keeps it, and the copy's
    // contribution is taken back out of its session totals instead of colliding.
    const droppedBySession = dropRepeatedTurns(db, turnsRaw);
    for (const [sid, d] of droppedBySession) {
      const s = sessionById.get(sid);
      if (!s) continue;
      s.tInput = Math.max(0, s.tInput - d.input);
      s.cost = Math.max(0, s.cost - d.cost);
      s.creditsMicro = Math.max(0, (s.creditsMicro ?? 0) - d.credits);
      s.additions = Math.max(0, s.additions - d.add);
      s.deletions = Math.max(0, s.deletions - d.del);
      s.files = Math.max(0, s.files - d.files);
    }
    for (const t of turnsRaw)
      if (t.role === "assistant" && t.model) wanted.add(catalogKey(t.provider, t.model));
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
    const accounts = new Set(directories.map((d) => accountOf(d)).filter((a): a is string => !!a));
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
        return {
          ...t,
          promptTotal: 0,
          occupancy: 0,
          contextWindow: 0,
          fill: 0,
          fillAfter: 0,
          costComputed: 0,
          bucket,
          day,
          hour,
        };
      }
      const m = info(t.provider, t.model);
      // What the provider actually received = the real context occupancy for this call.
      const promptTotal = t.input + t.cacheRead + t.cacheWrite;
      const occupancy = promptTotal + t.output + t.reasoning;
      const contextWindow = t.contextWindow ?? m?.context ?? 128000;
      const costComputed = m
        ? (t.input * m.costInput +
            t.output * m.costOutput +
            t.reasoning * m.costOutput +
            t.cacheRead * m.costCacheRead +
            t.cacheWrite * m.costCacheWrite) /
          1e6
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
    for (const list of assistantBySession.values())
      list.sort((a, b) => a.created - b.created || a.seq - b.seq);

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
    const ph = idList.map(() => "?").join(",");
    if (idList.length) {
      const oldCells =
        tailFrom > 0
          ? (db
              .prepare(`SELECT DISTINCT bucket, day FROM turns WHERE session_id IN (${ph}) AND created >= ?`)
              .all(...idList, tailFrom) as any[])
          : (db.prepare(`SELECT DISTINCT bucket, day FROM turns WHERE session_id IN (${ph})`).all(...idList) as any[]);
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
        // With a tail window only the rows inside it are replaced: the rows below
        // `tailFrom` are final, and re-writing them is what made every tick pay for
        // the whole transcript. `sessions` is always rewritten from full aggregates.
        if (tailFrom > 0) {
          const tail = `session_id IN (${ph}) AND turn_id IN (SELECT id FROM turns WHERE session_id IN (${ph}) AND created >= ?)`;
          db.prepare(`DELETE FROM tools WHERE ${tail}`).run(...idList, ...idList, tailFrom);
          db.prepare(`DELETE FROM parts WHERE ${tail}`).run(...idList, ...idList, tailFrom);
          db.prepare(`DELETE FROM events WHERE session_id IN (${ph}) AND at >= ?`).run(...idList, tailFrom);
          db.prepare(`DELETE FROM turns WHERE session_id IN (${ph}) AND created >= ?`).run(...idList, tailFrom);
        } else {
          db.prepare(`DELETE FROM tools WHERE session_id IN (${ph})`).run(...idList);
          db.prepare(`DELETE FROM parts WHERE session_id IN (${ph})`).run(...idList);
          db.prepare(`DELETE FROM events WHERE session_id IN (${ph})`).run(...idList);
          db.prepare(`DELETE FROM turns WHERE session_id IN (${ph})`).run(...idList);
        }
        db.prepare(`DELETE FROM sessions WHERE id IN (${ph})`).run(...idList);
      }

      const turnCols = [
        "id",
        "session_id",
        "project",
        "seq",
        "created",
        "completed",
        "dur_ms",
        "chars",
        "role",
        "provider",
        "model",
        "variant",
        "agent",
        "input",
        "output",
        "reasoning",
        "cache_read",
        "cache_write",
        "cost",
        "credits_micro",
        "prompt_total",
        "occupancy",
        "context_window",
        "fill",
        "fill_after",
        "bucket",
        "day",
        "hour",
        "finish",
        "has_error",
        "tool_calls",
        "tool_errors",
        "additions",
        "deletions",
        "write_lines",
        "text",
      ];
      const insTurn = db.prepare(
        `INSERT INTO turns(${turnCols.join(",")}) VALUES(${turnCols.map(() => "?").join(",")})`,
      );
      const insTool = db.prepare(
        `INSERT INTO tools(session_id,turn_id,call_id,name,status,started,ended,dur_ms,title,output_chars,additions,deletions,files,write_lines,error,sig,input_preview,target_session)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const insPart = db.prepare(
        `INSERT INTO parts(session_id,turn_id,ordinal,kind,text,name,call_id,status,title,input,output,exit_code,truncated,started,ended,chars)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );

      for (const t of turns) {
        const s = sessionById.get(t.sessionId);
        if (!s) continue;
        if (tailFrom > 0 && t.created < tailFrom) continue;
        if (turnCount > 0 && turnCount % CHUNK_TURNS === 0) await yieldToEventLoop();
        // dur_ms = first → last event of the response (streaming span).
        const durMs = t.created && t.completed ? Math.max(0, t.completed - t.created) : null;
        const bodyChars =
          t.parts.reduce((a: number, p: SrcPart) => (p.kind === "tool" ? a : a + p.chars), 0) || null;
        insTurn.run(
          t.id,
          t.sessionId,
          s.project,
          t.seq,
          t.created,
          t.completed,
          durMs,
          bodyChars,
          t.role,
          t.provider,
          t.model,
          t.variant,
          t.agent,
          t.input,
          t.output,
          t.reasoning,
          t.cacheRead,
          t.cacheWrite,
          t.costComputed,
          t.creditsMicro ?? 0,
          t.promptTotal,
          t.occupancy,
          t.contextWindow,
          t.fill,
          t.fillAfter,
          t.bucket,
          t.day,
          t.hour,
          t.finish,
          t.tools.some((x: SrcTool) => x.status === "error") ? 1 : 0,
          t.tools.length,
          t.tools.filter((x: SrcTool) => x.status === "error").length,
          t._add ?? 0,
          t._del ?? 0,
          t._write ?? 0,
          (t.text ?? "").slice(0, 2000),
        );
        turnCount++;
        affectedBuckets.add(t.bucket);
        affectedDays.add(t.day);
        for (const tool of t.tools) {
          insTool.run(
            tool.sessionId,
            t.id,
            tool.callId,
            tool.name,
            tool.status,
            tool.started,
            tool.ended,
            tool.started && tool.ended ? Math.max(0, tool.ended - tool.started) : null,
            tool.title,
            tool.outputChars,
            tool.additions,
            tool.deletions,
            tool.files,
            tool.writeLines,
            tool.error ? tool.error.slice(0, 2000) : null,
            tool.sig,
            tool.inputPreview,
            tool.targetSession,
          );
          toolCount++;
          if (tool.status === "error") {
            insertEvent(db, {
              sessionId: tool.sessionId,
              turnId: t.id,
              type: "failure",
              at: tool.started ?? t.created,
              endAt: tool.ended ?? tool.started ?? t.created,
              count: 1,
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
            t.sessionId,
            t.id,
            i,
            p.kind,
            p.text || null,
            p.name || null,
            p.callId || null,
            p.status || null,
            p.title,
            p.input || null,
            p.output || null,
            p.exitCode,
            p.truncated ? 1 : 0,
            p.started,
            p.ended,
            p.chars,
          );
          partCount++;
        }
      }

      for (const [sid, list] of eventsBySession) {
        const ts = assistantBySession.get(sid) ?? [];
        for (const e of list) {
          if (tailFrom > 0 && e.at < tailFrom) continue;
          // Fill at the moment of the event = the last turn that had already been sent.
          let fill = 0;
          for (const t of ts) {
            if (t.created <= e.at) fill = t.fill;
            else break;
          }
          insertEvent(db, {
            sessionId: sid,
            turnId: e.turnId,
            type: e.type,
            at: e.at,
            endAt: e.endAt,
            count: e.count,
            fill,
            detail: e.detail,
          });
          eventCount++;
        }
      }

      // ---- sessions ----
      const sessionCols = [
        "id",
        "project",
        "directory",
        "title",
        "agent",
        "provider",
        "model",
        "variant",
        "parent_id",
        "depth",
        "created",
        "updated",
        "t_input",
        "t_output",
        "t_reasoning",
        "t_cache_read",
        "t_cache_write",
        "cost",
        "credits_micro",
        "turns",
        "tool_calls",
        "tool_errors",
        "compactions",
        "retries",
        "loops",
        "additions",
        "deletions",
        "files_changed",
        "peak_fill",
        "avg_fill",
        "eff_score",
        "tokens_per_line",
        "first_prompt",
        "duration_ms",
        "msg_span_ms",
        "dominant_model",
        "output_rate",
      ];
      const insSession = db.prepare(
        `INSERT INTO sessions(${sessionCols.join(",")}) VALUES(${sessionCols.map(() => "?").join(",")})`,
      );

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
        const filesChanged = Math.max(
          sum((t) => t._files ?? 0),
          patches?.files ?? 0,
        );
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
          .map((t) =>
            t.output > 0 && t.completed && t.created && t.completed > t.created
              ? t.output / ((t.completed - t.created) / 1000)
              : 0,
          )
          .filter((r) => r > 0)
          .sort((a, b) => a - b);
        const mid = Math.floor(rates.length / 2);
        const outputRate =
          rates.length === 0 ? 0 : rates.length % 2 !== 0 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;

        const sessionEvents = eventsBySession.get(s.id) ?? [];
        const compactions = sessionEvents.filter((e) => e.type === "compaction").length;
        const retries = sessionEvents.filter((e) => e.type === "retry").length;
        const loops = sessionEvents.filter((e) => e.type === "loop").length;
        const creditsMicro = s.creditsMicro || ts.reduce((a, t) => a + (t.creditsMicro ?? 0), 0);

        insSession.run(
          s.id,
          s.project,
          s.directory,
          s.title,
          s.agent,
          s.provider,
          s.model,
          s.variant,
          s.parentId,
          depthOf(s, allById),
          s.created,
          s.updated,
          tInput,
          tOutput,
          tReasoning,
          tCacheRead,
          tCacheWrite,
          Math.max(
            s.cost,
            ts.reduce((a, t) => a + t.costComputed, 0),
          ),
          creditsMicro,
          ts.length,
          toolCalls,
          toolErrors,
          compactions,
          retries,
          loops,
          additions,
          deletions,
          filesChanged,
          peak,
          avg,
          eff,
          lines > 0 ? totalTokens / lines : null,
          firstPromptBySession.get(s.id) ?? null,
          s.updated - s.created,
          // Message span: first assistant evidence to the last response's end, from
          // API timestamps rather than file times — the wall duration minus the idle.
          (() => {
            const first = ts.length ? Math.min(...ts.map((t) => t.created)) : 0;
            const last = ts.reduce((a, t) => Math.max(a, t.completed ?? t.created), 0);
            return first && last > first ? last - first : null;
          })(),
          dominant,
          outputRate,
        );
        sessionCount++;
      }

      // ---- model catalog upsert ----
      const upModel = db.prepare(
        `INSERT INTO models(id,provider,label,context,cost_input,cost_output,cost_cache_read,cost_cache_write,source)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, context=excluded.context,
           cost_input=excluded.cost_input, cost_output=excluded.cost_output,
           cost_cache_read=excluded.cost_cache_read, cost_cache_write=excluded.cost_cache_write, source=excluded.source`,
      );
      for (const [key, m] of Object.entries(catalog)) {
        upModel.run(
          key,
          m.provider,
          m.label,
          m.context,
          m.costInput,
          m.costOutput,
          m.costCacheRead,
          m.costCacheWrite,
          m.source,
        );
      }

      // Derived tables commit with their facts: a crash can never leave the rollups
      // describing a build that did not happen.
      refreshRollups(db, idList, [...affectedDays], mode === "full");
      setMeta(db, "sourceDb", src.path);
      setMeta(db, "sourceSchema", src.schema);
      setMeta(db, "sourceKind", src.kind);
      setMeta(db, "unit", src.unit);
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
    if (ownsSource) src.close();
  }
}

/**
 * Keep one turn per message id, in place. A turn id already stored under another
 * session belongs to that session; an id already kept in this batch belongs to
 * the first session that carried it. Returns, per session, what the dropped
 * copies would have contributed — their totals are then corrected by it.
 */
function dropRepeatedTurns(
  db: DatabaseSync,
  turns: SrcTurn[],
): Map<string, { input: number; cost: number; credits: number; add: number; del: number; files: number }> {
  const owner = new Map<string, string>();
  const ids = [...new Set(turns.map((t) => t.id))];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT id, session_id FROM turns WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as { id: string; session_id: string }[];
    for (const r of rows) owner.set(String(r.id), String(r.session_id));
  }

  const seen = new Set<string>();
  const dropped = new Map<
    string,
    { input: number; cost: number; credits: number; add: number; del: number; files: number }
  >();
  let kept = 0;
  for (const t of turns) {
    const prior = owner.get(t.id);
    if ((prior !== undefined && prior !== t.sessionId) || seen.has(t.id)) {
      const d = dropped.get(t.sessionId) ?? { input: 0, cost: 0, credits: 0, add: 0, del: 0, files: 0 };
      d.input += t.input;
      d.cost += t.cost;
      d.credits += t.creditsMicro ?? 0;
      d.add += t._add ?? 0;
      d.del += t._del ?? 0;
      d.files += t._files ?? 0;
      dropped.set(t.sessionId, d);
      continue;
    }
    seen.add(t.id);
    turns[kept++] = t;
  }
  turns.length = kept;
  return dropped;
}

/** A session the store knows about but this tick did not parse: lane and parent only. */
function stubSession(id: string, project: string, directory: string, parentId: string | null): SrcSession {
  return {
    id,
    parentId,
    project,
    directory,
    title: null,
    agent: null,
    provider: null,
    model: null,
    variant: null,
    created: 0,
    updated: 0,
    cost: 0,
    tInput: 0,
    tOutput: 0,
    tReasoning: 0,
    tCacheRead: 0,
    tCacheWrite: 0,
    additions: 0,
    deletions: 0,
    files: 0,
  };
}

function depthOf(s: SrcSession, byId: Map<string, SrcSession>): number {  let d = 0;
  let cur = s.parentId ? byId.get(s.parentId) : null;
  while (cur && d < 10) {
    d++;
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return d;
}

const insEventStmt = new WeakMap<DatabaseSync, ReturnType<DatabaseSync["prepare"]>>();
function insertEvent(
  db: DatabaseSync,
  e: {
    sessionId: string;
    turnId: string | null;
    type: string;
    at: number;
    endAt: number;
    count: number;
    fill: number;
    detail: Record<string, unknown>;
  },
) {
  let st = insEventStmt.get(db);
  if (!st) {
    st = db.prepare(
      "INSERT INTO events(session_id,turn_id,type,at,end_at,count,fill,detail) VALUES(?,?,?,?,?,?,?,?)",
    );
    insEventStmt.set(db, st);
  }
  st.run(
    e.sessionId,
    e.turnId,
    e.type,
    Math.round(e.at),
    Math.round(e.endAt),
    e.count,
    e.fill,
    JSON.stringify(e.detail),
  );
}

/**
 * Retry / loop probes.
 * A repeated identical call is only a *retry* when the previous attempt failed (or
 * this one did) and both fall inside RETRY_WINDOW_MS — otherwise every re-read of
 * the same file would light up the marker layer.
 * LOOP_MIN_REPEATS identical calls in a row is a *loop* (the agent is stuck).
 */
export function buildEventProbes(
  sourceEvents: {
    sessionId: string;
    turnId: string | null;
    type: string;
    at: number;
    reason: string | null;
    detail: string | null;
    tokensBefore?: number | null;
    model?: string | null;
  }[],
  assistantBySession: Map<string, TurnCalc[]>,
  opts: { enrichCompaction?: boolean } = {},
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
            type: "retry",
            at: prev.at,
            endAt: at,
            count: 1,
            turnId: t.id,
            detail: {
              tool: tool.name,
              title: tool.title,
              sig: tool.sig,
              first_failed: !prev.ok,
              span_ms: at - prev.at,
            },
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
          type: "loop",
          at: chain.from,
          endAt: chain.to,
          count: chain.count,
          turnId: null,
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
       FROM turns WHERE role='assistant' AND bucket IN (${ph})`,
    )
    .all(...list) as any[];

  const cells = new Map<
    string,
    {
      project: string;
      bucket: number;
      gen: number;
      cacheRead: number;
      cost: number;
      sessions: Set<string>;
      models: Map<string, number>;
      peak: number;
    }
  >();
  for (const r of rows) {
    const key = `${r.project}|${r.bucket}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        project: r.project,
        bucket: Number(r.bucket),
        gen: 0,
        cacheRead: 0,
        cost: 0,
        sessions: new Set(),
        models: new Map(),
        peak: 0,
      };
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
      "INSERT INTO flow(project,bucket,tokens_gen,tokens_cache_read,cost,sessions,dominant_model,peak_fill) VALUES(?,?,?,?,?,?,?,?)",
    );
    for (const c of cells.values()) {
      let dominant = "unknown";
      let best = -1;
      for (const [k, v] of c.models) if (v > best) ((best = v), (dominant = k));
      ins.run(
        c.project,
        c.bucket,
        Math.round(c.gen),
        Math.round(c.cacheRead),
        c.cost,
        c.sessions.size,
        dominant,
        c.peak,
      );
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
       FROM turns WHERE role='assistant' AND day IN (${ph})`,
    )
    .all(...list) as any[];

  const cells = new Map<
    string,
    {
      project: string;
      day: number;
      hour: number;
      gen: number;
      cacheRead: number;
      cost: number;
      turns: number;
    }
  >();
  for (const r of rows) {
    const key = `${r.project}|${r.day}|${r.hour}`;
    let c = cells.get(key);
    if (!c) {
      c = {
        project: r.project,
        day: Number(r.day),
        hour: Number(r.hour),
        gen: 0,
        cacheRead: 0,
        cost: 0,
        turns: 0,
      };
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
    const ins = db.prepare(
      "INSERT INTO heat(project,day,hour,tokens_gen,tokens_cache_read,cost,turns) VALUES(?,?,?,?,?,?,?)",
    );
    for (const c of cells.values())
      ins.run(c.project, c.day, c.hour, Math.round(c.gen), Math.round(c.cacheRead), c.cost, c.turns);
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
