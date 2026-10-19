import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.OSM_BASE ?? "http://127.0.0.1:8787";
const DAY = 86400000;
const to = Date.now();
const from = to - 30 * DAY;
const qs = `from=${from}&to=${to}`;

let failures = 0;

async function check(name: string, path: string, assert: (json: any) => string | null) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    failures++;
    console.log(`FAIL ${name}: HTTP ${res.status}`);
    return;
  }
  const json: any = await res.json();
  const problem = assert(json);
  if (problem) {
    failures++;
    console.log(`FAIL ${name}: ${problem}`);
  } else {
    console.log(`ok   ${name}`);
  }
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
  await check("overview", `/api/overview?${qs}`, (j) => (j.byModel?.length ? null : "no model breakdown"));
  await check("ecg", `/api/ecg?${qs}`, (j) => (j.points?.length ? null : "empty ECG series"));
  await check("ecg ops", `/api/ecg/ops?${qs}`, (j) =>
    j.tools?.length && j.turns?.length ? null : `empty operation feed: ${JSON.stringify({ tools: j.tools?.length, turns: j.turns?.length })}`
  );
  await check("ecg daily", `/api/ecg/daily?${qs}`, (j) => {
    if (!j.lanes?.length) return "no daily lanes";
    if (!(j.bucketMs > 0)) return "missing bucket size";
    const lane = j.lanes[0];
    if (!lane.days?.length) return "lane has no buckets";
    // output must exist: the whole point of the diff fix is that days stop reading as zero
    const out = j.lanes.reduce((a: number, l: any) => a + l.totals.add + l.totals.write, 0);
    if (!(out > 0)) return "every lane reports zero output";
    return null;
  });
  await check("ecg daily (hour)", `/api/ecg/daily?from=${to - 3 * DAY}&to=${to}&bucket=hour`, (j) => {
    if (j.bucketMs !== 3600000) return `hourly bucket not applied: ${j.bucketMs}`;
    if (!j.lanes?.length) return "no hourly lanes";
    const buckets = j.lanes.reduce((a: number, l: any) => a + l.days.length, 0);
    // Guards the SQL trap this endpoint already fell into once: `GROUP BY day` resolves to
    // the table column, not the result alias, silently collapsing every hour into one row.
    if (!(buckets > j.lanes.length)) return `hourly buckets collapsed: ${buckets} buckets / ${j.lanes.length} lanes`;
    const cell = j.lanes[0].days[0];
    if (cell.fillAvg == null) return "no context occupancy on an hourly bucket";
    if (!(cell.fillAvg > 0 && cell.fillAvg <= 1)) return `occupancy out of range: ${cell.fillAvg}`;
    return null;
  });
  await check("sessions", `/api/sessions?${qs}`, (j) => (Array.isArray(j) && j.length ? null : "no sessions in window"));
  await check("heatmap", `/api/heatmap?${qs}`, (j) => (j.cells?.length ? null : "empty heatmap"));
  await check("focus", `/api/focus?${qs}`, (j) => (typeof j.p50 === "number" ? null : "no focus stats"));
  await check("conversion", `/api/conversion?${qs}`, (j) => (j.points?.length ? null : "no conversion points"));
  await check("models", "/api/models", (j) => (j.models?.length ? null : "empty catalog"));

  const sessions = (await (await fetch(`${BASE}/api/sessions?${qs}`)).json()) as any[];
  const withTurns = sessions.find((s) => s.turns > 3) ?? sessions[0];
  await check("session detail", `/api/session/${withTurns.id}`, (j) => {
    if (!j.session) return "missing session";
    const fills = (j.turns ?? []).map((t: any) => t.fill).filter((f: number) => f > 0);
    if (!fills.length) return "no context fill computed";
    if (Math.max(...fills) > 1) return `fill over 100%: ${Math.max(...fills)}`;
    return null;
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

void main();
