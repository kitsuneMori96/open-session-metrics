import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.HOLO_BASE ?? "http://127.0.0.1:8787";
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
