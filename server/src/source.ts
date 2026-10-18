import { DatabaseSync } from "node:sqlite";

/** Normalized records read from an OpenCode database (v1 `session/message/part` or v2 `session_v2/session_message`). */
export interface SrcSession {
  id: string;
  parentId: string | null;
  project: string;
  directory: string;
  title: string | null;
  agent: string | null;
  provider: string | null;
  model: string | null;
  variant: string | null;
  created: number;
  updated: number;
  cost: number;
  tInput: number;
  tOutput: number;
  tReasoning: number;
  tCacheRead: number;
  tCacheWrite: number;
  additions: number;
  deletions: number;
  files: number;
}

export interface SrcTurn {
  id: string;
  sessionId: string;
  seq: number;
  created: number;
  completed: number | null;
  role: "assistant" | "user" | "system" | "other";
  provider: string | null;
  model: string | null;
  variant: string | null;
  agent: string | null;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  finish: string | null;
  text: string;
  tools: SrcTool[];
  prompt: string | null;
  /** per-turn diff stats collected from tool metadata (set by the reader) */
  _add?: number;
  _del?: number;
  _files?: number;
}

export interface SrcTool {
  turnId: string;
  sessionId: string;
  callId: string;
  name: string;
  status: string;
  started: number | null;
  ended: number | null;
  title: string | null;
  outputChars: number;
  additions: number;
  deletions: number;
  files: number;
  error: string | null;
  sig: string;
  /** first bytes of the JSON input — enough to recognise a `task` tool's target session */
  inputPreview: string | null;
  /** child session id when this tool spawned a sub-agent (`task`/`subagent`) */
  targetSession: string | null;
}

export interface SrcEvent {
  sessionId: string;
  turnId: string | null;
  type: "compaction" | "idle" | "switch" | "error";
  at: number;
  reason: string | null;
  detail: string | null;
  /** compaction bookkeeping (source-provided, when present) */
  tokensBefore?: number | null;
  tokensAfter?: number | null;
  model?: string | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parse(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Last path segment of a worktree/directory, used as the ECG lane name. */
export function projectName(directory: string | null | undefined): string {
  if (!directory) return "unknown";
  const trimmed = directory.replace(/[\\/]+$/, "");
  if (!trimmed || trimmed === "/") return "/";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function fileStats(files: any): { additions: number; deletions: number; files: number } {
  if (!Array.isArray(files)) return { additions: 0, deletions: 0, files: 0 };
  let a = 0;
  let d = 0;
  for (const f of files) {
    a += num(f?.additions);
    d += num(f?.deletions);
  }
  return { additions: a, deletions: d, files: files.length };
}

function hashSig(name: string, input: unknown): string {
  const raw = JSON.stringify(input ?? {});
  let h = 2166136261;
  const key = name + "|" + raw.slice(0, 400);
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${name}:${(h >>> 0).toString(36)}`;
}

const SESSION_ID_RE = /ses_[A-Za-z0-9]{4,}/;

export class SourceReader {
  private db: DatabaseSync;
  readonly schema: "v1" | "v2";

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    const hasV2 = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'")
      .get();
    const rows = hasV2
      ? (this.db.prepare("SELECT COUNT(*) AS c FROM session_v2").get() as { c: number }).c
      : 0;
    this.schema = rows > 0 ? "v2" : "v1";
  }

  close() {
    this.db.close();
  }

  /**
   * Watermark: the newest source timestamp, covering both message writes and
   * session-row updates. Only when *both* are below it is the metrics db fresh —
   * otherwise a session whose row was touched without a new message would be
   * re-materialized on every tick, forever.
   */
  maxMessageTime(): number {
    const msgTable = this.schema === "v2" ? "session_message" : "message";
    const msgCol = this.schema === "v2" ? "time_updated" : "time_created";
    const msgMax = (this.db.prepare(`SELECT MAX(${msgCol}) AS m FROM ${msgTable}`).get() as { m: number | null })?.m ?? 0;
    let sessMax = 0;
    try {
      sessMax = (this.db.prepare("SELECT MAX(time_updated) AS m FROM session_v2").get() as { m: number | null })?.m ?? 0;
    } catch {
      /* legacy schema */
    }
    return Math.max(msgMax, sessMax);
  }

  /**
   * Sessions touched after `since` (message writes + session row updates).
   * Used to re-materialize only what changed instead of reparsing 500 MB.
   */
  changedSessions(since: number): Set<string> {
    const out = new Set<string>();
    if (since <= 0) return out;
    const msgTable = this.schema === "v2" ? "session_message" : "message";
    const msgCol = this.schema === "v2" ? "time_updated" : "time_created";
    for (const r of this.db
      .prepare(`SELECT DISTINCT session_id FROM ${msgTable} WHERE ${msgCol} > ?`)
      .all(since) as any[]) {
      if (r.session_id) out.add(String(r.session_id));
    }
    const sessTable = this.schema === "v2" ? "session_v2" : "session";
    try {
      for (const r of this.db
        .prepare(`SELECT id FROM ${sessTable} WHERE time_updated > ?`)
        .all(since) as any[]) {
        if (r.id) out.add(String(r.id));
      }
    } catch {
      /* legacy schema without time_updated on session — message scan above is enough */
    }
    return out;
  }

  sessions(): SrcSession[] {
    const table = this.schema === "v2" ? "session_v2" : "session";
    const rows = this.db
      .prepare(
        `SELECT s.id, s.parent_id, s.project_id, s.title, s.directory, s.agent, s.model,
                s.time_created, s.time_updated, s.cost,
                p.name AS project_name, p.worktree AS project_worktree
         FROM ${table} s LEFT JOIN project p ON p.id = s.project_id`
      )
      .all() as any[];

    const agg = new Map<string, { input: number; output: number; reasoning: number; cr: number; cw: number; a: number; d: number }>();
    if (this.schema === "v2") {
      for (const r of this.db
        .prepare(
          `SELECT id AS sid, tokens_input AS i, tokens_output AS o, tokens_reasoning AS r,
                  tokens_cache_read AS cr, tokens_cache_write AS cw,
                  summary_additions AS a, summary_deletions AS d
           FROM session_v2`)
        .all() as any[]) {
        agg.set(r.sid, { input: num(r.i), output: num(r.o), reasoning: num(r.r), cr: num(r.cr), cw: num(r.cw), a: num(r.a), d: num(r.d) });
      }
    }

    return rows.map((r) => {
      const model = this.schema === "v2" ? parse(r.model) : null;
      const a = agg.get(r.id);
      const directory = r.directory ?? r.project_worktree ?? "/";
      return {
        id: r.id,
        parentId: r.parent_id ?? null,
        project: r.project_name?.trim() || projectName(directory),
        directory,
        title: r.title ?? null,
        agent: r.agent ?? null,
        provider: model?.providerID ?? null,
        model: model?.id ?? (typeof r.model === "string" ? r.model : null),
        variant: model?.variant ?? null,
        created: num(r.time_created),
        updated: num(r.time_updated),
        cost: num(r.cost),
        tInput: a?.input ?? 0,
        tOutput: a?.output ?? 0,
        tReasoning: a?.reasoning ?? 0,
        tCacheRead: a?.cr ?? 0,
        tCacheWrite: a?.cw ?? 0,
        additions: a?.a ?? 0,
        deletions: a?.d ?? 0,
        files: 0,
      } satisfies SrcSession;
    });
  }

  turns(sessionIds?: Set<string>): SrcTurn[] {
    return this.schema === "v2" ? this.turnsV2(sessionIds) : this.turnsV1(sessionIds);
  }

  /**
   * Files touched per session, recovered from v1 `part` patch records.
   * The v2 message stream has no patch parts, but the legacy table is still
   * populated for sessions that started life on v1 — worth reading because it is
   * the only diff signal for ~46 sessions.
   */
  patchFileCounts(sessionIds?: Set<string>): Map<string, { files: number; paths: string[] }> {
    const out = new Map<string, { files: number; paths: string[] }>();
    const has = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='part'")
      .get();
    if (!has) return out;
    let rows: any[] = [];
    try {
      const where = sessionIds ? `WHERE session_id IN (${[...sessionIds].map(() => "?").join(",")}) AND ` : "WHERE ";
      const args = sessionIds ? [...sessionIds] : [];
      rows = this.db
        .prepare(`${where}data LIKE '%"patch"%'`)
        .all(...args) as any[];
    } catch {
      return out;
    }
    for (const row of rows) {
      const d = parse(row.data);
      if (!d || d.type !== "patch") continue;
      const files = Array.isArray(d.files) ? d.files.map((f: unknown) => String(f)) : [];
      if (!files.length) continue;
      const cur = out.get(row.session_id) ?? { files: 0, paths: [] };
      for (const f of files) if (!cur.paths.includes(f)) cur.paths.push(f);
      cur.files = cur.paths.length;
      out.set(row.session_id, cur);
    }
    return out;
  }

  private turnsV2(sessionIds?: Set<string>): SrcTurn[] {
    const where = sessionIds ? `WHERE session_id IN (${[...sessionIds].map(() => "?").join(",")})` : "";
    const args = sessionIds ? [...sessionIds] : [];
    const rows = this.db
      .prepare(`SELECT id, session_id, seq, type, time_created, time_updated, data FROM session_message ${where} ORDER BY time_created ASC, seq ASC`)
      .all(...args) as any[];

    const out: SrcTurn[] = [];
    for (const row of rows) {
      const d = parse(row.data);
      if (!d) continue;
      const type: string = row.type;
      if (type === "compaction" || type === "idle" || type === "model-switched" || type === "agent-switched") continue;

      const isUser = type === "user";
      const content = Array.isArray(d.content) ? d.content : [];
      const tools: SrcTool[] = [];
      let text = "";
      let additions = 0;
      let deletions = 0;
      let files = 0;

      for (const item of content) {
        if (item?.type === "text") text += item.text ?? "";
        if (item?.type === "tool") {
          const st = item.state ?? {};
          const fs = fileStats(st.metadata?.files);
          additions += fs.additions;
          deletions += fs.deletions;
          files += fs.files;
          const outputText =
            st.error?.message ?? st.metadata?.output ?? st.output ?? (st.content ?? []).map((c: any) => c?.text ?? "").join("\n");
          const started = item.time?.created ?? st.time?.start ?? st.time?.created ?? null;
          const ended = item.time?.completed ?? st.time?.end ?? st.time?.completed ?? null;
          const inputPreview = st.input ? JSON.stringify(st.input).slice(0, 400) : null;
          tools.push({
            turnId: row.id,
            sessionId: row.session_id,
            callId: item.id ?? "",
            name: item.name ?? "unknown",
            status: st.status ?? "pending",
            started,
            ended,
            title: st.title ?? null,
            outputChars: typeof outputText === "string" ? outputText.length : 0,
            additions: fs.additions,
            deletions: fs.deletions,
            files: fs.files,
            error: st.status === "error" ? (st.error?.message ?? "tool error") : null,
            sig: hashSig(item.name ?? "unknown", st.input),
            inputPreview,
            targetSession: inputPreview ? SESSION_ID_RE.exec(inputPreview)?.[0] ?? null : null,
          });
        }
      }

      const tk = d.tokens ?? {};
      const created = d.time?.created ?? row.time_created;
      const completed = d.time?.completed ?? d.time?.streamed ?? (type === "assistant" ? null : created);
      if (isUser) {
        out.push({
          id: row.id, sessionId: row.session_id, seq: num(row.seq), created, completed,
          role: "user", provider: null, model: d.model?.id ?? null, variant: null, agent: d.agent ?? null,
          input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
          finish: null, text: d.text ?? text, tools: [], prompt: (d.text ?? text).slice(0, 400),
        });
        continue;
      }
      if (type !== "assistant") continue;

      out.push({
        id: row.id, sessionId: row.session_id, seq: num(row.seq), created, completed,
        role: "assistant", provider: d.model?.providerID ?? null, model: d.model?.id ?? null,
        variant: d.model?.variant ?? null, agent: d.agent ?? null,
        input: num(tk.input), output: num(tk.output), reasoning: num(tk.reasoning),
        cacheRead: num(tk.cache?.read), cacheWrite: num(tk.cache?.write), cost: num(d.cost),
        finish: d.finish ?? d.rawFinish ?? null,
        text, tools,
        prompt: null,
        _add: additions,
        _del: deletions,
        _files: files,
      });
    }
    return out;
  }

  private turnsV1(sessionIds?: Set<string>): SrcTurn[] {
    const where = sessionIds ? `WHERE m.session_id IN (${[...sessionIds].map(() => "?").join(",")})` : "";
    const args = sessionIds ? [...sessionIds] : [];
    const msgs = this.db
      .prepare(`SELECT m.id, m.session_id, m.data, m.time_created FROM message m ${where} ORDER BY m.time_created ASC`)
      .all(...args) as any[];

    const partsByMsg = new Map<string, any[]>();
    if (msgs.length) {
      const ids = msgs.map((m) => m.id);
      const ph = ids.map(() => "?").join(",");
      for (const p of this.db.prepare(`SELECT message_id, data FROM part WHERE message_id IN (${ph}) ORDER BY rowid ASC`).all(...ids) as any[]) {
        const d = parse(p.data);
        if (!d) continue;
        if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, []);
        partsByMsg.get(p.message_id)!.push(d);
      }
    }

    const out: SrcTurn[] = [];
    for (const row of msgs) {
      const d = parse(row.data);
      if (!d) continue;
      const parts = partsByMsg.get(row.id) ?? [];
      const role: string = d.role ?? "assistant";
      const tools: SrcTool[] = [];
      let text = "";
      let files = 0;
      for (const p of parts) {
        if (p.type === "text") text += p.text ?? "";
        if (p.type === "tool") {
          const st = p.state ?? {};
          const started = st.time?.start ?? p.time?.start ?? null;
          const ended = st.time?.end ?? p.time?.end ?? null;
          const inputPreview = st.input ? JSON.stringify(st.input).slice(0, 400) : null;
          files += Array.isArray(p.files) ? p.files.length : 0;
          tools.push({
            turnId: row.id, sessionId: row.session_id, callId: p.callID ?? "",
            name: p.tool ?? "unknown", status: st.status ?? "pending", started, ended,
            title: st.title ?? null, outputChars: (st.output ?? "").length,
            additions: 0, deletions: 0, files: Array.isArray(p.files) ? p.files.length : 0,
            error: st.status === "error" ? (st.error ?? st.output ?? "tool error") : null,
            sig: hashSig(p.tool ?? "unknown", st.input),
            inputPreview,
            targetSession: inputPreview ? SESSION_ID_RE.exec(inputPreview)?.[0] ?? null : null,
          });
        }
      }
      const tk = d.tokens ?? {};
      out.push({
        id: row.id, sessionId: row.session_id, seq: out.length, created: d.time?.created ?? row.time_created,
        completed: d.time?.completed ?? null,
        role: role === "user" ? "user" : role === "assistant" ? "assistant" : "other",
        provider: d.providerID ?? null, model: d.modelID ?? d.model ?? null, variant: null, agent: d.agent ?? null,
        input: tk.input ?? d.usage?.input_tokens ?? 0, output: tk.output ?? d.usage?.output_tokens ?? 0,
        reasoning: tk.reasoning ?? 0, cacheRead: tk.cache?.read ?? d.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: tk.cache?.write ?? d.usage?.cache_write_input_tokens ?? 0, cost: num(d.cost),
        finish: d.finish ?? d.stop_reason ?? null, text, tools,
        prompt: role === "user" ? text.slice(0, 400) : null,
        _add: 0, _del: 0, _files: files,
      } as SrcTurn);
    }
    return out;
  }

  events(sessionIds?: Set<string>): SrcEvent[] {
    const out: SrcEvent[] = [];
    if (this.schema === "v2") {
      const where = sessionIds ? `WHERE session_id IN (${[...sessionIds].map(() => "?").join(",")}) AND` : "WHERE";
      const args = sessionIds ? [...sessionIds] : [];
      const rows = this.db
        .prepare(
          `SELECT id, session_id, seq, type, time_created, data FROM session_message
           ${where} type IN ('compaction','idle','model-switched','agent-switched') ORDER BY time_created ASC`
        )
        .all(...args) as any[];
      for (const r of rows) {
        const d = parse(r.data) ?? {};
        const type: SrcEvent["type"] =
          r.type === "compaction" ? "compaction" : r.type === "idle" ? (d.outcome === "failed" ? "error" : "idle") : "switch";
        out.push({
          sessionId: r.session_id,
          turnId: null,
          type,
          at: d.time?.created ?? r.time_created,
          reason: d.reason ?? d.outcome ?? d.error?.type ?? null,
          detail: r.type === "compaction" ? (d.summary ?? "").slice(0, 600) : (d.error?.message ?? d.outcome ?? null),
          tokensBefore: num(d.tokens?.input) || num(d.tokens?.cache?.read) || null,
          model: d.model?.id ?? null,
        });
      }
    } else {
      const rows = this.db.prepare("SELECT session_id, message_id, data FROM part WHERE data LIKE '%\"compaction\"%' LIMIT 20000").all() as any[];
      for (const r of rows) {
        const d = parse(r.data);
        if (d?.type !== "compaction") continue;
        if (sessionIds && !sessionIds.has(r.session_id)) continue;
        out.push({ sessionId: r.session_id, turnId: r.message_id, type: "compaction", at: d.time?.created ?? 0, reason: d.reason ?? null, detail: (d.text ?? "").slice(0, 600) });
      }
    }
    return out;
  }
}
