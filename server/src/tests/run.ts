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
  // The default "stack by" depends on this: an OpenCode store records all five token
  // classes, so the screen must offer the class stack. A store that answers `false`
  // here would only ever draw one band.
  await check("status declares token classes", "/api/status", (j) =>
    j.tokenClasses === true ? null : `tokenClasses=${JSON.stringify(j.tokenClasses)} (open the overview: the stack-by default would be model)`
  );

  // The facet list is what the slice bar and the search palette are built from, so every
  // dimension has to come back non-empty and every value has to be usable as a filter.
  const facets = await check("facets", "/api/top/facets", (j) => {
    if (!j.projects?.length) return "no projects";
    if (!j.models?.length) return "no models";
    if (!j.agents?.length) return "no agents";
    if (!j.tools?.length) return "no tools";
    if (!(j.extent?.from > 0 && j.extent.to > j.extent.from)) return `bad extent: ${JSON.stringify(j.extent)}`;
    if (!(j.counts.sessions > 0 && j.counts.turns > 0)) return `bad counts: ${JSON.stringify(j.counts)}`;
    return null;
  });

  // One grouped scan feeds the series, the model stack, the heatmap and the hourly
  // profile; if any of those arrays disagrees with `buckets`, the dashboard draws a lie.
  const all = await check("analytics (all time)", "/api/top/analytics?from=0", (j) => {
    if (!(j.totals.turns > 0)) return "no assistant turns";
    if (!(j.totals.total > 0)) return "zero tokens";
    if (j.totals.total !== j.totals.input + j.totals.output + j.totals.cacheRead + j.totals.cacheWrite)
      return "totals.total is not the sum of its classes";
    const buckets = j.series?.buckets ?? [];
    if (!buckets.length) return "empty series";
    const summed = buckets.reduce((a: number, b: any) => a + b.total, 0);
    if (summed !== j.totals.total) return `series total ${summed} != totals ${j.totals.total}`;
    const turns = buckets.reduce((a: number, b: any) => a + b.turns, 0);
    if (turns !== j.totals.turns) return `series turns ${turns} != totals ${j.totals.turns}`;
    if (j.series.modelTokens.some((row: number[]) => row.length !== buckets.length))
      return "the model stack is not one row per bucket";
    if (j.series.heat.length !== 7 || j.series.heat.some((row: any[]) => row.length !== 24)) return "heat is not 7x24";
    if (j.series.hourly.length !== 24) return `hourly profile: ${j.series.hourly.length}`;
    if (!(j.efficiency.cacheHit > 0 && j.efficiency.cacheHit <= 1)) return `cache hit: ${j.efficiency.cacheHit}`;
    if (!j.sessions?.length) return "no sessions";
    if (j.sessions.some((s: any) => s.tokens !== s.input + s.output + s.cacheRead + s.cacheWrite))
      return "a session's token total does not add up";
    if (!j.kpis || !j.models?.length || !j.tools?.length || !j.agents?.length) return "an overview table is empty";
    return null;
  });

  // A filter has to actually narrow the same slice the unfiltered call returned.
  const picked = facets?.agents?.[0]?.agent;
  if (picked) {
    await check(`analytics (agent=${picked})`, `/api/top/analytics?from=0&agent=${encodeURIComponent(picked)}`, (j) => {
      if (!(j.totals.turns > 0)) return "the filtered slice is empty";
      if (j.totals.turns >= all?.totals?.turns) return `filter did not narrow: ${j.totals.turns} of ${all?.totals?.turns}`;
      if (j.agents.some((a: any) => a.agent !== picked)) return "an agent filter leaked another agent";
      if (j.agents[0].turns !== j.totals.turns) return "the agent table disagrees with the totals";
      return null;
    });
  } else {
    failures++;
    console.log("FAIL analytics (agent filter): no agent facet to filter by");
  }

  // A brushed window that covers a shorter span must ask the server for finer buckets.
  await check("analytics granularity", `/api/top/analytics?from=${now - 3 * DAY}&to=${now}`, (j) =>
    j.series.gran === "hour" ? null : `a 3-day window should bucket hourly, got ${j.series.gran}`
  );

  // Latency is reported as percentiles precisely so p95 and max can differ from the mean.
  const busiestTool = facets?.tools?.[0]?.name ?? "bash";
  await check("tool detail", `/api/top/tool?name=${encodeURIComponent(busiestTool)}`, (j) => {
    if (!j.totals?.calls) return "no calls";
    if (!(j.totals.p50Ms > 0)) return "no median latency";
    if (!(j.totals.p95Ms >= j.totals.p50Ms)) return "p95 below p50";
    if (!(j.totals.maxMs >= j.totals.p95Ms)) return "max below p95";
    if (!j.latency?.length) return "no latency distribution";
    if (j.latency.reduce((a: number, b: any) => a + b.count, 0) !== j.totals.calls)
      return "the latency histogram does not account for every call";
    if (j.buckets.reduce((a: number, b: any) => a + b.calls, 0) !== j.totals.calls)
      return "the time buckets do not account for every call";
    if (!j.agents?.length || !j.projects?.length) return "missing the agent or project split";
    if (j.totals.errors === 0 && j.signatures.length) return "a tool with no failures has error signatures";
    return null;
  });

  // The error panel groups failures by message, so its rows are readable text: the input
  // hash it used to print is an id, and a successful call is not a signature at all.
  const failing = (all?.tools ?? []).find((t: any) => t.errors > 0);
  if (failing) {
    await check(`tool error signatures (${failing.name})`, `/api/top/tool?name=${encodeURIComponent(failing.name)}`, (j) => {
      if (!j.signatures.length) return "a tool with failures has no signatures";
      if (j.signatures.some((s: any) => !s.message || !s.sample)) return "a signature has no message";
      const counted = j.signatures.reduce((a: number, s: any) => a + s.count, 0);
      if (counted > j.totals.errors) return `signatures count ${counted} of ${j.totals.errors} failures`;
      return null;
    });
  } else {
    failures++;
    console.log("FAIL tool error signatures: no tool with failures in the slice");
  }

  // The transcript endpoint is the reason `parts` exists: assert a real one comes back.
  const busiest = [...(all?.sessions ?? [])].sort((a: any, b: any) => b.tools - a.tools)[0];
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
      // The transcript's default filter is prompts + replies, so the prompt half has to
      // be on the wire, in order, with its body.
      if (!Array.isArray(j.prompts)) return "the payload has no prompts array";
      if (!j.prompts.length) return "no user prompts in the transcript";
      if (j.prompts.some((p: any) => typeof p.created !== "number" || !p.text)) return "a prompt has no body or time";
      if (!j.prompts.every((p: any, i: number) => i === 0 || p.created >= j.prompts[i - 1].created)) return "prompts are out of order";
      // The per-turn timeline the session page draws needs a context reading per turn.
      if (!j.turns.some((t: any) => t.contextWindow > 0 && t.occupancy > 0)) return "no context occupancy per turn";
      return null;
    });
  } else {
    failures++;
    console.log("FAIL session transcript: no session with tool calls");
  }

  const query = facets?.tools?.[0]?.name ?? "edit";
  await check("search", `/api/top/search?q=${encodeURIComponent(query)}`, (j) => {
    if (j.query !== query) return `query echo mismatch: ${j.query}`;
    if (!j.hits?.length) return `no session mentions "${query}"`;
    return null;
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

void main();
