/**
 * Two stores, one process.
 *
 * The point of this file is that a source is a *scope*, not a filter: the same
 * route answers from a different database depending on one request header, and a
 * store that was never built says so instead of throwing `no such table`.
 *
 *   pnpm -F @osm/server test
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let failures = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "osm-sources-"));
process.env.OSM_DATA_DIR = path.join(dir, "data");
process.env.OSM_QODER_HOME = path.join(dir, "qoder");
process.env.OSM_SOURCE = "opencode";
process.env.OSM_SOURCE_DB = path.join(dir, "opencode.db");
process.env.OSM_OFFLINE = "1";

const T0 = Date.parse("2026-10-02T09:00:00.000Z");

/** The smallest Qoder transcript that still materializes one session and one turn. */
function seedQoder() {
  const projects = path.join(process.env.OSM_QODER_HOME!, "projects", "-tmp-switch");
  mkdirSync(projects, { recursive: true });
  const base = { sessionId: "s-qoder-1", cwd: "/tmp/switch", version: "1.1.76" };
  const lines = [
    { ...base, type: "runtime-config", model: "qfmodel", contextWindow: 200000, timestamp: T0 },
    { ...base, type: "ai-title", aiTitle: "Qoder session" },
    { ...base, type: "user", uuid: "u1", timestamp: new Date(T0 + 1000).toISOString(), message: { role: "user", content: "hi" } },
    {
      ...base, type: "assistant", uuid: "a1", timestamp: new Date(T0 + 2000).toISOString(), parentUuid: "u1",
      message: {
        id: "m1", model: "qfmodel", stop_reason: "end_turn",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 0, output_tokens: 0, credits: 1.5, original_credits: 1.5, context_usage_ratio: 0.4, request_id: "r1" },
      },
    },
  ];
  writeFileSync(path.join(projects, "s-qoder-1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

async function main() {
  seedQoder();

  const { createApp } = await import("../api");
  const { current, hasStore, rebuild } = await import("../metrics/store");
  const { metricsDbPath, SOURCE_KIND } = await import("../config");

  ok("the default source is the one the process resolved", SOURCE_KIND === "opencode", SOURCE_KIND);
  ok("each source owns its own file", metricsDbPath("opencode") !== metricsDbPath("qoder"),
    `${metricsDbPath("opencode")} vs ${metricsDbPath("qoder")}`);
  ok("neither store exists before the first build", !hasStore("opencode") && !hasStore("qoder"));

  const app = createApp({
    db: (kind) => current(kind),
    hasStore: (kind) => hasStore(kind),
    refresh: async (kind, full) => rebuild(kind, { full }),
  });
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const BASE = `http://127.0.0.1:${port}`;
  const get = async (p: string, kind?: string) => {
    const res = await fetch(`${BASE}${p}`, kind ? { headers: { "x-osm-source": kind } } : undefined);
    return { status: res.status, json: (await res.json()) as any };
  };
  const post = async (p: string, kind: string) => {
    const res = await fetch(`${BASE}${p}`, { method: "POST", headers: { "x-osm-source": kind, "content-type": "application/json" }, body: "{}" });
    return { status: res.status, json: (await res.json()) as any };
  };

  try {
    // ---- before anything is built ----
    const listed = await get("/api/sources");
    ok("the menu lists every source this process can read", listed.json.sources?.length === 2, JSON.stringify(listed.json));
    const qoderEntry = listed.json.sources.find((s: any) => s.kind === "qoder");
    ok("an available but unbuilt source is marked as such", qoderEntry?.available === true && qoderEntry?.ready === false,
      JSON.stringify(qoderEntry));
    ok("an unbuilt source reports no shape yet", qoderEntry?.tokenClasses === null, String(qoderEntry?.tokenClasses));
    ok("the opencode source is not available without its database",
      listed.json.sources.find((s: any) => s.kind === "opencode")?.available === false, JSON.stringify(listed.json.sources));
    ok("the server names its default source", listed.json.default === "opencode", listed.json.default);

    const loose = await get("/api/status");
    ok("status answers, but not ready, for a source with no store", loose.status === 200 && loose.json.ready === false,
      `${loose.status} ${JSON.stringify(loose.json)}`);
    ok("an unbuilt store reports zero counts instead of failing", loose.json.counts?.sessions === 0, JSON.stringify(loose.json.counts));
    ok("an unbuilt store claims no token classes", loose.json.tokenClasses === false, String(loose.json.tokenClasses));

    const blocked = await get("/api/top/facets");
    ok("analytics routes refuse an unbuilt store", blocked.status === 503 && blocked.json.source === "opencode",
      `${blocked.status} ${JSON.stringify(blocked.json)}`);

    // ---- build one source, leave the other alone ----
    const built = await post("/api/refresh", "qoder");
    ok("a refresh request builds the source it names", built.status === 200 && built.json.source === "qoder", JSON.stringify(built.json));
    ok("only the requested store was created", hasStore("qoder") && !hasStore("opencode"),
      `${hasStore("qoder")} ${hasStore("opencode")}`);

    const after = await get("/api/sources");
    const q2 = after.json.sources.find((s: any) => s.kind === "qoder");
    ok("the menu now shows the built store", q2?.ready === true && q2?.counts?.sessions === 1, JSON.stringify(q2));
    ok("the store declares its unit for the shell", q2?.unit === "credit", String(q2?.unit));
    // The Overview's default stack reads this from the boot list, before the first frame.
    ok("the menu reports the store's shape", q2?.tokenClasses === false, String(q2?.tokenClasses));

    // ---- the same route, two scopes ----
    const qStatus = await get("/api/status", "qoder");
    ok("a header selects the store", qStatus.json.ready === true && qStatus.json.counts.sessions === 1, JSON.stringify(qStatus.json));
    ok("the unit travels with the store, not the process", qStatus.json.unit === "credit", String(qStatus.json.unit));
    // Qoder records context occupancy, not token classes: there is nothing to stack.
    // The screen reads this to drop the "token class" option and default to model.
    ok("a store without token classes says so", qStatus.json.tokenClasses === false, String(qStatus.json.tokenClasses));

    const viaQuery = await get("/api/status?src=qoder");
    ok("?src= still works for curl", viaQuery.json.counts.sessions === 1, JSON.stringify(viaQuery.json.counts));

    const viaHeaderFacets = await get("/api/top/facets", "qoder");
    ok("a scoped read reaches the right database", viaHeaderFacets.status === 200 && viaHeaderFacets.json.counts.sessions === 1,
      `${viaHeaderFacets.status} ${JSON.stringify(viaHeaderFacets.json?.counts)}`);

    const unknown = await get("/api/status", "sqlite");
    ok("an unknown source falls back to the default", unknown.json.sourceKind === "opencode", String(unknown.json.sourceKind));

    // ---- counts are per store, so a scoped query cannot see the other one ----
    const sessions = await get("/api/top/sessions?limit=5", "qoder");
    ok("the session grid is scoped too", sessions.json.rows?.length === 1 && sessions.json.rows[0].id === "s-qoder-1",
      JSON.stringify(sessions.json.rows?.map((r: any) => r.id)));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall source checks passed");
  process.exit(failures ? 1 : 0);
}

void main();
