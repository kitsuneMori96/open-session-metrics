import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.OSM_BASE ?? "http://127.0.0.1:8787";
const DAY = 86400000;
const now = Date.now();

let failures = 0;

async function check(name: string, path: string, assert: (json: any) => string | null) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    failures++;
    console.log(`FAIL ${name}: HTTP ${res.status}`);
    return undefined;
  }
  const json: any = await res.json();
  const problem = assert(json);
  if (problem) {
    failures++;
    console.log(`FAIL ${name}: ${problem}`);
  } else {
    console.log(`ok   ${name}`);
  }
  return json;
}

async function main() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }

  await check("status", "/api/status", (j) => (j.counts.sessions > 0 ? null : `no sessions materialized: ${JSON.stringify(j.counts)}`));
  await check("status has transcript", "/api/status", (j) =>
    j.counts.parts > 0 ? null : `no parts materialized (transcript would be empty): ${j.counts.parts}`
  );

  const sessions = await check("top sessions", "/api/top/sessions", (j) => {
    if (!j.sessions?.length) return "no sessions";
    const billed = j.sessions.filter((s: any) => s.tokens.total > 0);
    if (!billed.length) return "every session reports zero tokens";
    const withCtx = billed.filter((s: any) => s.contextPct > 0 && s.contextPct <= 1);
    if (!withCtx.length) return "no session has a sane context ratio";
    if (!j.sessions.some((s: any) => s.tools?.length)) return "no session has tool usage";
    return null;
  });

  // The messages panel is the reason `parts` exists: assert a real transcript comes back.
  const busiest = (sessions?.sessions ?? []).filter((s: any) => s.calls > 3).sort((a: any, b: any) => b.calls - a.calls)[0];
  if (busiest) {
    await check("session transcript", `/api/top/session/${busiest.id}/messages`, (j) => {
      if (!j.session) return "missing session";
      if (!j.turns?.length) return "no assistant turns";
      const kinds = new Set(j.turns.flatMap((t: any) => t.parts.map((p: any) => p.kind)));
      if (!kinds.has("tool")) return `no tool parts: ${[...kinds].join(",")}`;
      const tool = j.turns.flatMap((t: any) => t.parts).find((p: any) => p.kind === "tool" && p.name);
      if (!tool) return "tool part without a name";
      const tool2 = j.turns.flatMap((t: any) => t.parts).find((p: any) => p.kind === "tool" && p.input);
      if (!tool2) return "no tool input was captured";
      if (!kinds.has("text")) return "no assistant text parts";
      const ordered = j.turns.every((t: any, i: number) => i === 0 || t.created >= j.turns[i - 1].created);
      if (!ordered) return "turns are not in chronological order";
      return null;
    });
  } else {
    failures++;
    console.log("FAIL session transcript: no session with more than 3 turns");
  }

  const tools = await check("top tools", "/api/top/tools", (j) => {
    if (!j.tools?.length) return "no tools";
    const total = j.tools.reduce((a: number, t: any) => a + t.calls, 0);
    if (!(total > 0)) return "zero tool calls";
    const bad = j.tools.find((t: any) => t.successes + t.failures > t.calls);
    if (bad) return `${bad.name} reports more outcomes than calls`;
    return null;
  });

  await check("top overview (all time)", "/api/top/overview", (j) => {
    if (!j.totals.total) return "zero total tokens";
    if (!j.models?.length) return "no model breakdown";
    if (!(j.tokenTrend?.values?.length > 0)) return "empty token trend";
    if (!(j.sessionTrend?.values?.length > 0)) return "empty session trend";
    if (j.hourly?.length !== 24) return `hourly buckets: ${j.hourly?.length}`;
    if (!(j.activity?.roots?.shown > 0)) return "no active roots";
    if (j.activity.shown > j.activity.total) return "shown exceeds total";
    return null;
  });

  await check("top overview (today)", "/api/top/overview?from=" + new Date().setHours(0, 0, 0, 0), (j) =>
    j.tokenTrend?.mode === "hour" ? null : `today should bucket hourly, got ${j.tokenTrend?.mode}`
  );

  await check("top overview (window)", `/api/top/overview?from=${now - 7 * DAY}`, (j) =>
    j.tokenTrend?.mode === "day" && j.tokenTrend.values.length <= 8 ? null : `7d trend: ${j.tokenTrend?.mode}/${j.tokenTrend?.values.length}`
  );

  const query = tools?.tools?.[0]?.name ?? "edit";
  await check("top search", `/api/top/search?q=${encodeURIComponent(query)}`, (j) => {
    if (j.query !== query) return `query echo mismatch: ${j.query}`;
    if (!j.hits?.length) return `no session mentions "${query}"`;
    return null;
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

void main();
