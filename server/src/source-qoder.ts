import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { QODER_LOGS, QODER_PROJECTS } from "./config";
import { qoderDesktopForks, qoderDesktopTitles } from "./qoder-titles";
import {
  bodyPart,
  hashSig,
  pathsOf,
  projectName,
  PART_CAP,
  type SourceLike,
  type SrcEvent,
  type SrcPart,
  type SrcSession,
  type SrcTool,
  type SrcTurn,
} from "./source";

/**
 * Qoder CLI source.
 *
 * Qoder has no session database: each session is a JSONL transcript under
 * `~/.qoder/projects/<encoded-cwd>/<sessionId>.jsonl`, and the SQLite files
 * next to it are IDE caches. Everything below is derived from those files.
 *
 * Two properties of the format drive the whole parser:
 *
 * 1. **One response is several events.** A single `message.id` is split into
 *    2–4 `assistant` rows, one content block each; only the last row carries
 *    `usage`. Grouping by id is what keeps the turn count honest (1 706 events
 *    → 782 turns in the sample session).
 * 2. **Tokens are not recorded.** `input/output/cache_*` are always 0. The
 *    only volume signal is `context_usage_ratio`, which becomes context tokens
 *    once multiplied by the ratio's denominator. Cost is `credits`, stored as
 *    integer micro-credits.
 * 3. **Some responses carry no usage at all.** When the model picker is on
 *    `auto`, the CLI omits `usage` from the assistant rows — no ratio, no
 *    credits. The transcript alone would show those turns as a confident zero;
 *    the encrypted `state.json` beside the transcript holds the CLI's own
 *    running token counter, and that is what `sessionTokenTotal` recovers.
 */

/**
 * The denominator of `context_usage_ratio`, per model alias.
 *
 * A ratio is **not** a share of the context window the model picker shows. The
 * CLI computes it as
 *
 *     context_usage_ratio = input_tokens / (parameters.context_length ?? model.max_input_tokens)
 *
 * and `context_length` is only put on the request when a window preference is
 * set (`if (l?.contextWindow !== void 0 && rS(D, l.contextWindow))`). Every
 * `runtime-config` in this machine's transcripts says `contextWindow: null`, so
 * the denominator falls back to the model's own limit:
 *
 *     Qwen3.8-Flash (qfmodel)   max_input_tokens 180 000
 *     DeepSeek-Flash (dfmodel)  max_input_tokens 200 000
 *
 * Compaction points prove both denominators without trusting the catalog. Qwen
 * sessions reset at ratio 0.82–0.93 (≈148–167 k tokens); DeepSeek sessions reset
 * at 0.79–0.83 (× 200 k = ≈158–166 k). Both models therefore hit the same
 * absolute budget near 166 k. Reading DeepSeek against 1 M would put its resets
 * at 790–830 k, impossible in the 200 k window the picker allows.
 */
export const QODER_MODEL_WINDOW: Record<string, number> = {
  qfmodel: 180_000,
  dfmodel: 200_000,
};

/** Only for a transcript that names a model the table above does not know. */
export const QODER_DEFAULT_WINDOW = 200_000;

/**
 * A compaction is a context reset, so it is detected in tokens, not in ratio:
 * the denominator changes with the model, and the same 167 k compaction is 0.93
 * of one window and 0.17 of another. Observed drops are 108–134 k tokens
 * (166 k → 30–44 k); the largest non-compaction drop on this machine is 8 k.
 */
export const COMPACTION_DROP_TOKENS = 50_000;

/**
 * Qoder's own state directory. Tool calls that touch it (memory notes, persisted
 * tool output) are real writes but say nothing about which *project* the session
 * belongs to — feeding them to `inferProject` would label a home-launched session
 * after the encoded project folder (`-home-kitsunemori`).
 */
const INTERNAL_PATH = /(^|\/)\.(qoder|opencode|osm)\//;

/**
 * Rows that are not a model: `<synthetic>` events carry no usage, and a session
 * that never got a response records an empty alias.
 */
const NOT_A_MODEL = new Set(["", "<synthetic>", "unknown"]);

/**
 * Alias → shipped name, confirmed from telemetry `hook_input.model` (which never
 * appears in the same event as the alias, so this is a session-level inference).
 */
export const QODER_MODELS: Record<string, string> = {
  qfmodel: "Qwen3.8-Flash",
  dfmodel: "DeepSeek-Flash",
};

/**
 * The window a ratio is measured against. A transcript can name its model either
 * way — the alias while parsing, the shipped name after `displayModel` renames a
 * single-model session — so both spellings resolve.
 */
export function modelWindow(model: string | null): number {
  if (!model) return QODER_DEFAULT_WINDOW;
  const alias =
    QODER_MODEL_WINDOW[model] !== undefined
      ? model
      : Object.keys(QODER_MODELS).find((a) => QODER_MODELS[a] === model);
  return QODER_MODEL_WINDOW[alias ?? model] ?? QODER_DEFAULT_WINDOW;
}

interface Usage {
  credits: number;
  original: number;
  ratio: number | null;
  request: string | null;
}

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: any;
}

interface Entry {
  id: string;
  /** First row's timestamp: when the response started arriving. */
  ts: number;
  /** Last row's timestamp: streaming end. Same as `ts` for a single-row response. */
  last: number;
  model: string | null;
  stop: string | null;
  /** Explicit window in force when this response was requested (0 = none). */
  window: number;
  blocks: Block[];
  usage: Usage | null;
}

interface ToolResult {
  text: string;
  error: boolean;
  ts: number;
}

interface Parsed {
  id: string;
  file: string;
  mtime: number;
  directory: string;
  title: string | null;
  /** `last-prompt` first line, used only when neither source has a real title. */
  promptTitle: string | null;
  created: number;
  updated: number;
  turns: SrcTurn[];
  compactions: SrcEvent[];
  paths: string[];
  models: string[];
  credits: number;
  creditsMicro: number;
  tInput: number;
  additions: number;
  deletions: number;
  files: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** ISO strings and epoch milliseconds both occur in a transcript. */
function ms(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

const micro = (credits: number): number => Math.round(credits * 1e6);

/**
 * Master key of Qoder's session-state sidecar. It is a constant in the CLI, not
 * a per-install secret: `state.json` is sealed only so a casual look does not
 * read it, and the key ships in every build.
 */
const STATE_KEY = Buffer.from([
  44, 6, 96, 159, 67, 137, 172, 134, 152, 52, 157, 248, 15, 219, 49, 114, 225, 17, 195, 37, 71,
  151, 145, 95, 214, 226, 9, 169, 250, 96, 125, 232,
]);

/**
 * The CLI's token counter for a session, from `<project>/<sessionId>/state.json`.
 *
 * `s0.total.input_tokens` equals Σ(ratio × window) exactly on sessions whose rows
 * all carry usage, which is what makes it the one trustworthy number for the
 * rows that carry none. Its `credits` counter is left out on purpose: it is
 * zero on most sessions, so it cannot be added to the transcript's per-turn
 * credits.
 *
 * The nonce/tag/ciphertext are sealed with AES-256-GCM; the AAD is the session
 * id, a SHA-256 of the session's cwd, and the segment name — the same tuple the
 * CLI binds the record to, so a record copied to another session will not open.
 */
function sessionTokenTotal(file: string, id: string, cwd: string): number | null {
  if (!cwd) return null;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path.join(path.dirname(file), id, "state.json"), "utf8"));
  } catch {
    return null;
  }
  const item = raw?.items?.s0;
  if (!item || typeof item.n !== "string" || typeof item.p !== "string" || typeof item.t !== "string")
    return null;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : id;
  // A WSL reader meets transcripts written by both plants, so the cwd has to be
  // canonicalised the way the writer's own platform did it: the CLI resolves with
  // the host's path module and lowercases the result on Windows, while a Linux
  // `path.resolve` would treat `D:\…` as a relative name and hash the wrong tree.
  const windows = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
  const root = windows
    ? path.win32.resolve(cwd).replace(/\\/g, "/").toLowerCase()
    : path.resolve(cwd).replace(/\\/g, "/");
  const projectHash = createHash("sha256").update(root, "utf8").digest("hex");
  const aad = JSON.stringify({ sessionId, projectHash, segmentKey: "s0" });
  try {
    const decipher = createDecipheriv("aes-256-gcm", STATE_KEY, Buffer.from(item.n, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(item.t, "base64"));
    const body = Buffer.concat([
      decipher.update(Buffer.from(item.p, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const input = num(JSON.parse(body)?.total?.input_tokens);
    return input > 0 ? input : null;
  } catch {
    return null;
  }
}

function lineCount(body: unknown): number {
  if (typeof body !== "string" || !body) return 0;
  return body.split("\n").length;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.type === "text" ? String(c.text ?? "") : ""))
      .join("\n");
  }
  return "";
}

/** A short human label for a tool row; the transcript shows it instead of raw JSON. */
export function toolTitle(name: string, input: any): string | null {
  if (!input || typeof input !== "object") return null;
  const raw =
    input.description ??
    input.file_path ??
    input.path ??
    input.toolName ??
    (typeof input.command === "string" ? input.command.split("\n")[0] : null) ??
    (typeof input.query === "string" ? input.query : null) ??
    (typeof input.subject === "string" ? input.subject : null);
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().slice(0, 160);
}

/** A path on a Windows drive, read through WSL's DrvFs. */
const MOUNTED = /^\/mnt\/[a-z]\//i;

/**
 * `active-leaf` is a UI cursor, not a conversation branch: its chain covers only
 * ~20% of events while every `isSidechain` seen so far is false. The transcript is
 * linear in practice, so the parser keeps file order and dedupes by `message.id`.
 */
export class QoderSource implements SourceLike {
  readonly kind = "qoder" as const;
  readonly unit = "credit" as const;
  readonly schema = "qoder-jsonl";
  readonly path: string;

  private cache = new Map<string, { sig: string; parsed: Parsed }>();
  private evidence = new Map<string, Set<string>>();
  private logDirs: string[] | null = null;
  private roots: string[];
  /**
   * The roots as one walk — see `snap()`. A reader is bound to one materialize.
   */
  private snapshot: Map<string, string[]> | null = null;

  constructor(root: string | readonly string[] = QODER_PROJECTS) {
    this.roots = typeof root === "string" ? [root] : [...root];
    this.path = this.roots[0] ?? "";
  }

  close() {
    this.cache.clear();
    this.evidence.clear();
    this.snapshot = null;
  }

  /**
   * Session id → its transcript files, across every root this machine has.
   *
   * A session owns `<root>/<encoded-cwd>/<sessionId>.jsonl` and, when it spawned
   * subagents, `<root>/<encoded-cwd>/<sessionId>/subagents/agent-*.jsonl`. Those
   * subagent rows carry the parent id in `sessionId` and bill to it, so they are
   * merged into the parent session rather than counted as sessions of their own.
   * In the corpus at hand that is 8 extra files, 131 turns and 8.7 credits — 1.3%
   * of the total, which silently missing would understate every session that
   * ever delegated work.
   *
   * qodercli writes to the transcript tree of whichever OS ran it, so a WSL
   * machine has its own tree plus one per Windows profile under `/mnt/<drive>`.
   * One account and one credit pool sit behind them, so the roots fold into one
   * session list — but a session id can still appear twice when Qoder migrates a
   * conversation between trees, and those are copies, not parts. The fuller, then
   * fresher, copy survives so no turn is billed twice.
   */
  private index(): Map<string, string[]> {
    if (this.roots.length < 2) return this.scan(this.roots[0] ?? "");
    const out = new Map<string, string[]>();
    const fresh = new Map<string, number>();
    for (const root of this.roots) {
      for (const [id, files] of this.scan(root)) {
        const held = out.get(id);
        if (!held) {
          out.set(id, files);
          fresh.set(id, this.newest(files));
          continue;
        }
        const stamp = this.newest(files);
        if (files.length > held.length || (files.length === held.length && stamp > (fresh.get(id) ?? 0))) {
          out.set(id, files);
          fresh.set(id, stamp);
        }
      }
    }
    return out;
  }

  /**
   * The tree as one snapshot, shared by every read this reader makes: a build
   * asks for sessions, turns, patches, events and the watermark, and re-walking
   * two DrvFs trees for each of those costs more than parsing them. Because the
   * watermark comes from the same walk as the parse, a file written while the
   * build was working stays above it and is re-read by the next tick instead of
   * being marked as materialized.
   */
  private snap(): Map<string, string[]> {
    if (!this.snapshot) this.snapshot = this.index();
    return this.snapshot;
  }

  /** The files one root holds for each session id it knows about. */
  private scan(root: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (!root || !existsSync(root)) return out;
    const add = (id: string, file: string) => {
      const list = out.get(id);
      if (list) list.push(file);
      else out.set(id, [file]);
    };
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const abs = path.join(root, dir.name);
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          add(entry.name.slice(0, -".jsonl".length), path.join(abs, entry.name));
          continue;
        }
        if (!entry.isDirectory()) continue;
        const subs = path.join(abs, entry.name, "subagents");
        if (!existsSync(subs)) continue;
        for (const sub of readdirSync(subs))
          if (sub.endsWith(".jsonl")) add(entry.name, path.join(subs, sub));
      }
    }
    return out;
  }

  private newest(files: string[]): number {
    let max = 0;
    for (const f of files) max = Math.max(max, this.stamp(f)?.mtime ?? 0);
    return max;
  }

  private stamp(file: string): { mtime: number; size: number } | null {
    try {
      const st = statSync(file);
      return { mtime: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  maxMessageTime(): number {
    let max = 0;
    for (const files of this.snap().values())
      for (const f of files) max = Math.max(max, this.stamp(f)?.mtime ?? 0);
    return max;
  }

  changedSessions(since: number): Set<string> {
    const out = new Set<string>();
    if (since <= 0) return out;
    for (const [id, files] of this.snap()) {
      for (const f of files) {
        const st = this.stamp(f);
        if (st && st.mtime > since) {
          out.add(id);
          break;
        }
      }
    }
    return out;
  }

  private all(sessionIds?: Set<string>): Parsed[] {
    const out: Parsed[] = [];
    for (const [id, files] of this.snap()) {
      if (sessionIds && !sessionIds.has(id)) continue;
      const p = this.load(id, files);
      if (p) out.push(p);
    }
    return out;
  }

  /** Every session id the roots hold, without parsing any transcript. */
  sessionIds(): string[] {
    return [...this.snap().keys()];
  }

  sessions(sessionIds?: Set<string>): SrcSession[] {
    return this.all(sessionIds).map((p) => this.sessionOf(p));
  }

  turns(sessionIds?: Set<string>): SrcTurn[] {
    return this.all(sessionIds).flatMap((p) => p.turns);
  }

  events(sessionIds?: Set<string>): SrcEvent[] {
    return this.all(sessionIds).flatMap((p) => p.compactions);
  }

  /** Files touched by edit/write calls; `build` uses these to infer the project lane. */
  patchFileCounts(sessionIds?: Set<string>): Map<string, { files: number; paths: string[] }> {
    const out = new Map<string, { files: number; paths: string[] }>();
    for (const p of this.all(sessionIds)) {
      if (p.paths.length) out.set(p.id, { files: p.paths.length, paths: p.paths });
    }
    return out;
  }

  private sessionOf(p: Parsed): SrcSession {
    const model = this.displayModel(p.id, p.models);
    // A transcript title wins; the desktop index fills the gap for sessions
    // whose title was generated by the app, and only then the first prompt.
    const title = p.title ?? qoderDesktopTitles().get(p.id) ?? p.promptTitle;
    return {
      id: p.id,
      parentId: null,
      project: projectName(p.directory),
      directory: p.directory,
      title,
      agent: null,
      provider: "qoder",
      model,
      variant: null,
      created: p.created,
      updated: p.updated,
      cost: p.credits,
      tInput: p.tInput,
      tOutput: 0,
      tReasoning: 0,
      tCacheRead: 0,
      tCacheWrite: 0,
      additions: p.additions,
      deletions: p.deletions,
      files: p.files,
      creditsMicro: p.creditsMicro,
    };
  }

  /**
   * Session-level model naming. The alias and the shipped name never appear in the
   * same telemetry event, so this is inference:
   *   - one alias + one real name → the real name;
   *   - one alias + no evidence → the global map;
   *   - several aliases (a mixed session) → all aliases, never a guess.
   */
  private displayModel(id: string, models: string[]): string {
    const aliases = [...new Set(models.filter((m) => !!m && !NOT_A_MODEL.has(m)))];
    if (aliases.length === 0) return "unknown";
    if (aliases.length > 1) return aliases.sort().join(" + ");
    const alias = aliases[0];
    const real = this.realModels(id);
    if (real.size === 1) return [...real][0];
    if (real.size === 0 && QODER_MODELS[alias]) return QODER_MODELS[alias];
    return alias;
  }

  /** Shipped names reported by hooks for this session (`hook_input.model`). */
  private realModels(sessionId: string): Set<string> {
    const hit = this.evidence.get(sessionId);
    if (hit) return hit;
    const out = new Set<string>();
    for (const enc of this.telemetryDirs()) {
      const dir = path.join(QODER_LOGS, enc, sessionId, "segments");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        let body = "";
        try {
          body = readFileSync(path.join(dir, f), "utf8");
        } catch {
          continue;
        }
        for (const line of body.split("\n")) {
          if (!line.includes("hook_input")) continue;
          try {
            const e = JSON.parse(line);
            const name = e?.data?.hook_input?.model;
            if (typeof name === "string" && name && name !== "unknown") out.add(name);
          } catch {
            /* a torn line is not evidence */
          }
        }
      }
    }
    this.evidence.set(sessionId, out);
    return out;
  }

  private telemetryDirs(): string[] {
    if (this.logDirs) return this.logDirs;
    this.logDirs = existsSync(QODER_LOGS)
      ? readdirSync(QODER_LOGS, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [];
    return this.logDirs;
  }

  /** Parse every file of a session and merge them; cached by the files' stamps. */
  private load(id: string, files: string[]): Parsed | null {
    const stamped = files
      .map((f) => ({ f, st: this.stamp(f) }))
      .filter((x): x is { f: string; st: { mtime: number; size: number } } => !!x.st)
      .sort((a, b) => a.f.localeCompare(b.f));
    if (!stamped.length) return null;
    const sig = stamped.map((x) => `${x.f}:${x.st.mtime}:${x.st.size}`).join("|");
    const hit = this.cache.get(id);
    if (hit && hit.sig === sig) return hit.parsed;

    const parts: Parsed[] = [];
    // A desktop side chat opens with a copy of its owner's transcript: identical
    // message ids and timestamps. Nothing before the fork's first own message was
    // billed to this session, so it is parsed out — otherwise every copied turn
    // would collide with the owner's row and be counted twice.
    const floor = qoderDesktopForks().get(id) ?? 0;
    for (const { f, st } of stamped) {
      let body = "";
      try {
        body = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      // A DrvFs read can catch qodercli writing mid-line, and the torn tail is not
      // valid JSON. Drop it rather than count a phantom half-turn: the next mtime
      // bump changes the size too, so the finished line arrives with its own rebuild.
      if (MOUNTED.test(f) && !body.endsWith("\n")) {
        const cut = body.lastIndexOf("\n");
        body = cut < 0 ? "" : body.slice(0, cut + 1);
      }
      parts.push(this.parse(id, f, st.mtime, body, floor));
    }
    if (!parts.length) return null;
    const parsed = parts.length === 1 ? parts[0] : this.merge(id, parts);
    // A session whose aliases all agree on one shipped model names its turns too,
    // so the model facets do not show `qfmodel` next to `Qwen3.8-Flash`. A mixed
    // session keeps its per-turn aliases — that is the only honest reading.
    const name = this.displayModel(id, parsed.models);
    if (name !== "unknown" && !name.includes(" + ")) {
      for (const t of parsed.turns) if (t.role === "assistant" && t.model) t.model = name;
    }
    // Keyed by id+sig, so an edited transcript simply replaces the entry.
    if (this.cache.size > 64) this.cache.clear();
    this.cache.set(id, { sig, parsed });
    return parsed;
  }

  /** A parent transcript plus its subagent transcripts, as one session. */
  private merge(id: string, parts: Parsed[]): Parsed {
    const seen = new Set<string>();
    const turns = parts
      .flatMap((p) => p.turns)
      .sort((a, b) => a.created - b.created)
      .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
      .map((t, i) => ({ ...t, seq: i }));
    const paths = new Set(parts.flatMap((p) => p.paths));
    const sum = (pick: (p: Parsed) => number) => parts.reduce((a, p) => a + pick(p), 0);
    const created = parts.map((p) => p.created).filter((t) => t > 0);
    return {
      id,
      file: parts[0].file,
      mtime: Math.max(...parts.map((p) => p.mtime)),
      directory: parts.find((p) => p.directory !== "/")?.directory ?? "/",
      title: parts.find((p) => p.title)?.title ?? null,
      promptTitle: parts.find((p) => p.promptTitle)?.promptTitle ?? null,
      created: created.length ? Math.min(...created) : 0,
      updated: Math.max(...parts.map((p) => p.updated)),
      turns,
      compactions: parts.flatMap((p) => p.compactions).sort((a, b) => a.at - b.at),
      paths: [...paths],
      models: parts.flatMap((p) => p.models),
      credits: sum((p) => p.credits),
      creditsMicro: sum((p) => p.creditsMicro),
      tInput: sum((p) => p.tInput),
      additions: sum((p) => p.additions),
      deletions: sum((p) => p.deletions),
      files: sum((p) => p.files),
    };
  }

  private parse(id: string, file: string, mtime: number, body: string, floor = 0): Parsed {
    const order: Entry[] = [];
    const byId = new Map<string, Entry>();
    const prompts: { id: string; ts: number; text: string }[] = [];
    const results = new Map<string, ToolResult>();
    const paths = new Set<string>();
    let title: string | null = null;
    let lastPrompt: string | null = null;
    let directory = "";
    /** Window the user pinned in the model picker; 0 means "use the catalog". */
    let explicit = 0;
    /**
     * Model the client asked for, from the last `runtime-config`. Under CLI
     * 1.1.86 a response row says `model: "auto"` — the routing placeholder —
     * even though the user picked a concrete model; this row keeps the pick.
     */
    let requested: string | null = null;
    let created = 0;
    let updated = 0;

    const touch = (ts: number) => {
      if (!ts) return;
      if (!created || ts < created) created = ts;
      if (ts > updated) updated = ts;
    };

    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const type = e?.type;
      if (typeof e?.cwd === "string" && e.cwd) directory = e.cwd;
      touch(ms(e?.timestamp));

      if (type === "assistant") {
        const m = e.message ?? {};
        const mid = typeof m.id === "string" && m.id ? m.id : e.uuid;
        if (!mid) continue;
        let entry = byId.get(mid);
        const rowTs = ms(e.timestamp);
        // "auto" is not a model, it is the label the runtime puts on a request
        // whose model the client chose; the pick itself is the last config.
        const rowModel = m.model === "auto" && requested ? requested : m.model ?? null;
        if (!entry) {
          entry = {
            id: mid,
            ts: rowTs,
            last: rowTs,
            model: rowModel,
            stop: m.stop_reason ?? null,
            window: explicit,
            blocks: [],
            usage: null,
          };
          byId.set(mid, entry);
          order.push(entry);
        }
        // The response arrives as several rows; the last one carries the completion
        // time, so the turn's streaming span is last − first rather than always 0.
        if (rowTs > entry.last) entry.last = rowTs;
        if (m.stop_reason) entry.stop = m.stop_reason;
        if (m.model) entry.model = rowModel;
        if (Array.isArray(m.content)) {
          for (const b of m.content) if (b && typeof b === "object" && b.type) entry.blocks.push(b as Block);
        }
        if (m.usage && typeof m.usage === "object") {
          entry.usage = {
            credits: num(m.usage.credits),
            original: num(m.usage.original_credits ?? m.usage.credits),
            ratio: typeof m.usage.context_usage_ratio === "number" ? m.usage.context_usage_ratio : null,
            request: typeof m.usage.request_id === "string" ? m.usage.request_id : null,
          };
        }
        continue;
      }

      if (type === "user") {
        const m = e.message ?? {};
        const content = m.content;
        const ts = ms(e.timestamp);
        if (typeof content === "string") {
          if (content.trim())
            prompts.push({
              id: String(e.uuid ?? `u${prompts.length}`),
              ts,
              text: content,
            });
          continue;
        }
        if (!Array.isArray(content)) continue;
        let text = "";
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text" && typeof b.text === "string") text += b.text;
          if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            results.set(b.tool_use_id, {
              text: resultText(b.content),
              error: b.is_error === true,
              ts,
            });
          }
        }
        if (text.trim())
          prompts.push({
            id: String(e.uuid ?? `u${prompts.length}`),
            ts,
            text,
          });
        continue;
      }

      if (type === "runtime-config") {
        // `null` is the normal state and means "no preference": the request then
        // carries no `context_length`, and the ratio falls back to the catalog.
        explicit = typeof e.contextWindow === "number" && e.contextWindow > 0 ? e.contextWindow : 0;
        if (typeof e.model === "string" && e.model) requested = e.model;
        continue;
      }
      if (type === "ai-title" && typeof e.aiTitle === "string") {
        title = e.aiTitle;
        continue;
      }
      if (type === "workspace-directories" && Array.isArray(e.directories) && e.directories[0]) {
        directory = String(e.directories[0]);
        continue;
      }
      if (type === "last-prompt" && typeof e.lastPrompt === "string") lastPrompt = e.lastPrompt;
    }

    const items: { ts: number; turn: SrcTurn }[] = [];
    /** Assistant turns whose row carried no usage — see `sessionTokenTotal`. */
    const blind: SrcTurn[] = [];
    const models: string[] = [];
    let credits = 0;
    let tInput = 0;
    let additions = 0;
    let deletions = 0;
    let files = 0;
    const ratios: { ts: number; tokens: number }[] = [];

    for (const entry of order) {
      if (floor && entry.ts < floor) continue;
      const usage = entry.usage;
      const ratio = usage?.ratio ?? null;
      // A pinned window beats the catalog; the ratio's denominator is whatever the
      // request actually carried. Resolved per entry, because a session can switch
      // model (and therefore denominator) mid-conversation.
      const contextWindow = entry.window || modelWindow(entry.model);
      // Context length is the only token-ish number the source records. It is the
      // prompt side of this call (cumulative), not a per-request billed input.
      const input = ratio == null ? 0 : Math.round(ratio * contextWindow);
      const toolCalls: SrcTool[] = [];
      const parts: SrcPart[] = [];
      const seenCalls = new Set<string>();
      let text = "";
      let add = 0;
      let del = 0;
      let fileCount = 0;
      let writeLines = 0;

      for (const b of entry.blocks) {
        if (b.type === "text") {
          const value = String(b.text ?? "");
          text += value;
          if (value.trim()) parts.push(bodyPart("text", value));
          continue;
        }
        if (b.type === "thinking") {
          const value = String(b.thinking ?? b.text ?? "");
          if (value.trim()) parts.push(bodyPart("reasoning", value));
          continue;
        }
        if (b.type !== "tool_use") continue;
        const callId = String(b.id ?? `${entry.id}:${toolCalls.length}`);
        if (seenCalls.has(callId)) continue;
        seenCalls.add(callId);
        const name = String(b.name ?? "unknown");
        const inputJson = b.input ?? {};
        const result = results.get(callId);
        const status = result ? (result.error ? "error" : "completed") : "pending";
        const filePath = typeof inputJson?.file_path === "string" ? inputJson.file_path : null;
        const touched = pathsOf(inputJson, null);
        for (const p of touched) if (!INTERNAL_PATH.test(p)) paths.add(p);
        const toolAdd = name === "Edit" ? lineCount(inputJson?.new_string) : 0;
        const toolDel = name === "Edit" ? lineCount(inputJson?.old_string) : 0;
        const write = name === "Write" ? lineCount(inputJson?.content) : 0;
        add += toolAdd;
        del += toolDel;
        writeLines += write;
        if (filePath) fileCount += 1;

        toolCalls.push({
          turnId: entry.id,
          sessionId: id,
          callId,
          name,
          status,
          started: entry.ts,
          ended: result?.ts ?? null,
          title: toolTitle(name, inputJson),
          outputChars: result?.text.length ?? 0,
          additions: toolAdd,
          deletions: toolDel,
          files: filePath ? 1 : 0,
          writeLines: write,
          error: result?.error ? result.text.slice(0, 500) || "tool error" : null,
          sig: hashSig(name, inputJson),
          inputPreview: inputJson ? JSON.stringify(inputJson).slice(0, 400) : null,
          targetSession: null,
          paths: touched.filter((p) => !INTERNAL_PATH.test(p)),
        });

        parts.push({
          kind: "tool",
          text: "",
          name,
          callId,
          status,
          title: toolTitle(name, inputJson),
          input: (inputJson ? JSON.stringify(inputJson) : "").slice(0, PART_CAP.input),
          output: (result?.text ?? "").slice(0, PART_CAP.output),
          exitCode: null,
          truncated: (result?.text.length ?? 0) > PART_CAP.output,
          started: entry.ts,
          ended: result?.ts ?? null,
          chars: result?.text.length ?? 0,
        });
      }

      const turnCredits = usage?.credits ?? 0;
      // `<synthetic>` rows are local notices — "credits exhausted", "unable to
      // connect" — not model output. They have no usage and must not create a
      // model lane or count as an assistant turn, but the text belongs in the
      // transcript where the user met it.
      const synthetic = entry.model === "<synthetic>";
      const turn: SrcTurn = {
        id: entry.id,
        sessionId: id,
        seq: 0,
        created: entry.ts,
        completed: entry.last,
        role: synthetic ? "system" : "assistant",
        provider: "qoder",
        model: entry.model && !NOT_A_MODEL.has(entry.model) ? entry.model : null,
        variant: null,
        agent: null,
        input,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: turnCredits,
        finish: entry.stop,
        text,
        tools: toolCalls,
        parts,
        prompt: null,
        creditsMicro: micro(turnCredits),
        contextWindow,
        _add: add,
        _del: del,
        _files: fileCount,
        _write: writeLines,
      };
      items.push({ ts: entry.ts, turn });
      if (!usage && !synthetic) blind.push(turn);
      if (entry.model) models.push(entry.model);
      credits += turnCredits;
      tInput += input;
      additions += add;
      deletions += del;
      files += fileCount;
      if (ratio != null) ratios.push({ ts: entry.ts, tokens: input });
    }

    // Responses without usage are not zero-token responses; they are responses
    // whose usage the CLI did not write down (`auto` mode). The sidecar counter
    // covers them session-wide, so the missing volume is spread over exactly the
    // blind turns: the per-turn split is even because nothing finer exists. Only
    // the session's main transcript does this; subagent files share the counter
    // and would count the delta twice.
    //
    // A turn cannot hold more context than its model's window, so that is also
    // the most a turn is ever given back. A session whose counter exceeds the
    // transcript by more than the blind turns can hold (retries the transcript
    // dropped, a compacted-away prefix) keeps the excess unattributed rather
    // than parking it all on one turn.
    if (blind.length && path.basename(file, ".jsonl") === id) {
      const total = sessionTokenTotal(file, id, directory);
      const missing = total == null ? 0 : total - tInput;
      if (missing > 0) {
        const even = Math.round(missing / blind.length);
        let left = missing;
        blind.forEach((turn, i) => {
          const room = turn.contextWindow || modelWindow(turn.model);
          const share = Math.min(i === blind.length - 1 ? left : even, room);
          turn.input += share;
          tInput += share;
          left -= share;
        });
      }
    }

    for (const p of prompts) {
      if (!p.ts || (floor && p.ts < floor)) continue;
      items.push({
        ts: p.ts,
        turn: {
          id: p.id,
          sessionId: id,
          seq: 0,
          created: p.ts,
          completed: p.ts,
          role: "user",
          provider: null,
          model: null,
          variant: null,
          agent: null,
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          finish: null,
          text: p.text,
          tools: [],
          parts: [],
          prompt: p.text.slice(0, 400),
          creditsMicro: 0,
        },
      });
    }

    items.sort((a, b) => a.ts - b.ts);
    const turns = items.map((it, i) => ({ ...it.turn, seq: i }));

    // Compaction = a context reset the source never writes down. A drop of more
    // than COMPACTION_DROP_TOKENS between consecutive turns is the only evidence
    // there is. Measured in tokens, so a model switch (each model has its own
    // ratio denominator) cannot fake one.
    const compactions: SrcEvent[] = [];
    let prev: { ts: number; tokens: number } | null = null;
    for (const r of ratios.sort((a, b) => a.ts - b.ts)) {
      if (prev && r.tokens < prev.tokens - COMPACTION_DROP_TOKENS) {
        compactions.push({
          sessionId: id,
          turnId: null,
          type: "compaction",
          // Sit between the two turns: `build` derives before/after from the turns
          // around the event, and the drop itself happened in that gap.
          at: Math.round((prev.ts + r.ts) / 2),
          reason: "auto",
          detail: "context reset (context drop)",
          tokensBefore: prev.tokens,
          tokensAfter: r.tokens,
          model: null,
        });
      }
      prev = r;
    }

    // The fork's own life starts at its first own message, not at the owner's
    // first turn that the copied prefix carries.
    if (floor && created < floor) created = floor;
    return {
      id,
      file,
      mtime,
      directory: directory || "/",
      title: title,
      promptTitle: lastPrompt ? lastPrompt.split("\n")[0].slice(0, 120) : null,
      created,
      updated,
      turns,
      compactions,
      paths: [...paths],
      models,
      credits,
      creditsMicro: micro(credits),
      tInput,
      additions,
      deletions,
      files,
    };
  }
}
