import { DatabaseSync } from "node:sqlite";
import { metricsDbPath, type SourceKind } from "../config";
import { hasStore } from "../metrics/store";

/**
 * `osm plans` — what a subscription buys, priced by this machine's own meter.
 *
 * Both stores carry a `cost` column, so the unit price of a source is a measurement,
 * not a claim: dollars for OpenCode (list price of the model, or the shadow price in
 * `model-overrides.json` when the catalog says $0) and credits for Qoder. A plan is
 * then just a price for a quota, and the only thing it changes is the unit price:
 *
 *     effective = list × price / quota
 *
 * Go's `$10 → $80` is ×0.125, Qoder's `$20 → 2,000 credits` is ×0.01 per credit —
 * which is the plan's own definition of a credit, not an exchange rate we invented.
 *
 * Read-only by construction: a store that was never built is skipped, never created.
 */

const DAY = 86_400_000;

/**
 * The trailing window coverage is measured over. Days without metered usage are
 * excluded from the divisor rather than counted as zero-burn days: a fortnight away
 * from the machine should not make a plan look like it lasts longer.
 */
const BURN_DAYS = 30;

interface Plan {
  readonly id: string;
  readonly label: string;
  readonly price: number;
  /** What `price` buys, in the unit the source bills in. */
  readonly quota: number;
  readonly source: SourceKind;
}

const PLANS: readonly Plan[] = [
  { id: "go", label: "opencode Go", price: 10, quota: 80, source: "opencode" },
  { id: "qoder", label: "Qoder", price: 20, quota: 2000, source: "qoder" },
];

interface Sum {
  turns: number;
  tokens: number;
  cost: number;
}

interface Meter {
  kind: SourceKind;
  unit: "usd" | "credit";
  /** Every assistant turn, including the ones the store prices at zero. */
  all: Sum;
  /** Turns with a non-zero cost — the only ones a list price can be derived from. */
  metered: Sum;
  sessions: number;
  meteredSessions: number;
  /** Distinct local days with metered usage inside the trailing window. */
  burnDays: number;
  burn: Sum;
  /**
   * True when a turn carries one reconstructed occupancy number rather than the five
   * token classes (the same probe `/api/status` answers). Only such a store needs the
   * thin-session check below, because only there is the token count derived.
   */
  reconstructed: boolean;
  /** Sessions whose recorded occupancy is implausibly small for a turn. */
  thinSessions: number;
  /** The same meter with those sessions removed. */
  withoutThin: Sum;
}

const SUM = `COUNT(*) AS turns,
             COALESCE(SUM(input + output + reasoning + cache_read + cache_write), 0) AS tokens,
             COALESCE(SUM(cost), 0) AS cost`;
const WHERE = "role = 'assistant'";

/**
 * A Qoder turn's `input` is `context_usage_ratio × contextWindow`, reconstructed at
 * ingestion — so a session that lost its ratio or its window reports a fraction of
 * the context it actually pushed. Those sessions still carry full credit charges,
 * which inflates credits-per-token. The per-turn price is immune to this, which is
 * why it is the primary unit in the report and tokens are the cross-check.
 */
const THIN_TOKENS = 80_000;

function meter(kind: SourceKind): Meter | null {
  if (!hasStore(kind)) return null;
  const db = new DatabaseSync(metricsDbPath(kind), { readOnly: true });
  const one = <T>(sql: string, ...args: (number | string)[]): T => db.prepare(sql).get(...args) as T;
  const meta = (key: string) => one<{ value: string } | undefined>("SELECT value FROM meta WHERE key = ?", key)?.value;
  const last = one<{ t: number | null }>("SELECT MAX(created) AS t FROM turns");
  const since = (last.t ?? Date.now()) - BURN_DAYS * DAY;

  const thin = `SELECT session_id FROM turns WHERE ${WHERE}
                GROUP BY session_id
                HAVING 1.0 * SUM(input + output + reasoning + cache_read + cache_write) / COUNT(*) < ${THIN_TOKENS}`;
  const m: Meter = {
    kind,
    unit: meta("unit") === "credit" ? "credit" : "usd",
    all: one<Sum>(`SELECT ${SUM} FROM turns WHERE ${WHERE}`),
    metered: one<Sum>(`SELECT ${SUM} FROM turns WHERE ${WHERE} AND cost > 0`),
    sessions: one<{ n: number }>("SELECT COUNT(*) AS n FROM sessions").n,
    meteredSessions: one<{ n: number }>(
      `SELECT COUNT(DISTINCT session_id) AS n FROM turns WHERE ${WHERE} AND cost > 0`
    ).n,
    burnDays: one<{ n: number }>(
      `SELECT COUNT(DISTINCT date(created / 1000, 'unixepoch', 'localtime')) AS n
       FROM turns WHERE ${WHERE} AND cost > 0 AND created >= ?`,
      since
    ).n,
    burn: one<Sum>(`SELECT ${SUM} FROM turns WHERE ${WHERE} AND cost > 0 AND created >= ?`, since),
    reconstructed: !one<{ hit: number } | undefined>(
      `SELECT 1 AS hit FROM turns WHERE ${WHERE}
         AND (output > 0 OR cache_read > 0 OR cache_write > 0 OR reasoning > 0) LIMIT 1`
    ),
    thinSessions: one<{ n: number }>(`SELECT COUNT(*) AS n FROM (${thin})`).n,
    withoutThin: one<Sum>(`SELECT ${SUM} FROM turns WHERE ${WHERE} AND session_id NOT IN (${thin})`),
  };
  db.close();
  return m;
}

interface Price {
  /** The source's own measured price, in `unit` per turn or per million tokens. */
  readonly perTurn: number;
  readonly perMtok: number;
}

const priceOf = (s: Sum): Price => ({
  perTurn: s.cost / s.turns,
  perMtok: s.cost / (s.tokens / 1e6),
});

/** A plan grants `quota / price` units of face value, so the unit price scales by its inverse. */
const effective = (list: number, plan: Plan): number => list * (plan.price / plan.quota);

const num = (n: number, digits = 2): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const int = (n: number): string => Math.round(n).toLocaleString("en-US");

function table(head: string[], rows: string[][], aligns: ("l" | "r")[]): string {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const cell = (s: string, i: number) =>
    aligns[i] === "r" ? s.padStart(w[i]) : s.padEnd(w[i]);
  return all.map((r) => r.map(cell).join("  ").trimEnd()).join("\n");
}

/**
 * Why a blended dollar price sits far below the model's sticker: the bill by token
 * class, priced by the store's own `models` rows. A cache-heavy workload pays
 * cache-read rates for nine of every ten tokens, so the plan comparison is really a
 * comparison of caches.
 *
 * `models.id` is `provider/key` while `turns.model` holds the bare key (the same way
 * the facets screen matches them), so the lookup tries the full id first.
 */
function billSplit(kind: SourceKind, list: Price): string[] {
  const db = new DatabaseSync(metricsDbPath(kind), { readOnly: true });
  const turns = db
    .prepare(
      `SELECT model, SUM(input) AS i, SUM(output) AS o, SUM(reasoning) AS re,
              SUM(cache_read) AS cr, SUM(cache_write) AS cw
       FROM turns WHERE ${WHERE} AND cost > 0 GROUP BY model`
    )
    .all() as Record<string, number | string>[];
  const priced = db
    .prepare("SELECT id, cost_input, cost_output, cost_cache_read, cost_cache_write FROM models")
    .all() as Record<string, number | string>[];
  db.close();
  const byId = new Map(priced.map((r) => [String(r.id), r]));
  const byBare = new Map(priced.map((r) => [String(r.id).split("/").pop(), r]));
  /**
   * Per class: tokens and dollars, accumulated model by model. Dollars cannot be
   * recovered from a token total and one price — the store prices each model
   * separately, and the paid tier here is six of them.
   */
  const parts = ["input", "output", "reasoning", "cache read", "cache write"].map((name) => ({
    name, tokens: 0, cost: 0,
  }));
  for (const t of turns) {
    const model = String(t.model);
    const p = byId.get(model) ?? byBare.get(model.split("/").pop() ?? model);
    if (!p) continue;
    // Reasoning bills at the output rate, which is how the store priced it too.
    const add = (i: number, tokens: number, rate: number) => {
      parts[i].tokens += tokens;
      parts[i].cost += (tokens * rate) / 1e6;
    };
    add(0, Number(t.i), Number(p.cost_input));
    add(1, Number(t.o), Number(p.cost_output));
    add(2, Number(t.re), Number(p.cost_output));
    add(3, Number(t.cr), Number(p.cost_cache_read));
    add(4, Number(t.cw), Number(p.cost_cache_write));
  }
  const total = parts.reduce((a, p) => a + p.cost, 0);
  const tokens = parts.reduce((a, p) => a + p.tokens, 0);
  if (!total || !tokens) return [];
  const body = table(
    ["class", "Mtok", "$/Mtok", "$", "% of bill", "% of tokens"],
    parts
      .filter((p) => p.tokens > 0)
      .map((p) => [
        p.name,
        num(p.tokens / 1e6, 1),
        num(p.cost / (p.tokens / 1e6), 3),
        num(p.cost, 2),
        num((p.cost / total) * 100, 1),
        num((p.tokens / tokens) * 100, 1),
      ]),
    ["l", "r", "r", "r", "r", "r"]
  );
  /**
   * `turns.cost` is what the store recorded when it built the row; the split re-prices
   * at today's catalog, so a price that changed since then shows up as a gap. Worth
   * printing rather than hiding: it is the difference between a bill and an estimate.
   */
  return [
    "  bill by token class (today's catalog prices)",
    ...body.split("\n").map((l) => `  ${l}`),
    `  recorded ${num(list.perMtok, 5)}/Mtok · re-priced ${num(total / (tokens / 1e6), 5)}/Mtok` +
      (Math.abs(1 - total / (tokens / 1e6) / list.perMtok) > 0.005
        ? " — the gap is rows built before a catalog change"
        : ""),
  ];
}

const meters = new Map<SourceKind, Meter>();
for (const plan of PLANS) {
  if (meters.has(plan.source)) continue;
  const m = meter(plan.source);
  if (m) meters.set(plan.source, m);
}

if (!meters.size) {
  console.log("[osm] no store has been built yet — run `pnpm materialize` first");
  process.exit(0);
}

console.log("[osm] measured list prices\n");
for (const m of meters.values()) {
  const list = priceOf(m.metered);
  const zero = m.all.turns - m.metered.turns;
  console.log(
    table(
      ["store", "sessions", "turns", "Mtok", m.unit === "usd" ? "$" : "credits", "per turn", "per Mtok"],
      [
        [
          `${m.kind} metered`,
          int(m.meteredSessions),
          int(m.metered.turns),
          num(m.metered.tokens / 1e6, 1),
          num(m.metered.cost, 3),
          num(list.perTurn, 6),
          num(list.perMtok, 5),
        ],
        [
          `${m.kind} all`,
          int(m.sessions),
          int(m.all.turns),
          num(m.all.tokens / 1e6, 1),
          num(m.all.cost, 3),
          num(m.all.cost / m.all.turns, 6),
          num(m.all.cost / (m.all.tokens / 1e6), 5),
        ],
      ],
      ["l", "r", "r", "r", "r", "r", "r"]
    )
  );
  if (zero > 0 && zero / m.all.turns >= 0.01) {
    console.log(
      `  ${int(zero)} turns (${num((zero / m.all.turns) * 100, 1)}%) are priced at zero — ` +
        `${num(((m.all.tokens - m.metered.tokens) / m.all.tokens) * 100, 1)}% of the tokens`
    );
  }
  console.log(`  ${m.burnDays} metered days in the last ${BURN_DAYS} · ` +
    `${num(m.burn.cost / Math.max(m.burnDays, 1), 3)} ${m.unit === "usd" ? "$" : "cr"}/day · ` +
    `${int(m.burn.turns / Math.max(m.burnDays, 1))} turns/day`);
  if (m.reconstructed && m.thinSessions > 0) {
    const clean = priceOf(m.withoutThin);
    console.log(
      `  ${m.thinSessions} session(s) of ${int(m.sessions)} record <${int(THIN_TOKENS)} tok/turn; ` +
        `without them ${num(clean.perMtok, 5)}/Mtok, ${num(clean.perTurn, 6)}/turn`
    );
  }
  // Only a store that bills in dollars has a price per class to show.
  if (m.unit === "usd") for (const line of billSplit(m.kind, list)) console.log(line);
  console.log("");
}

const rows: string[][] = [];
const comparable: { plan: Plan; list: Price; unit: "usd" | "credit"; turn: number; mtok: number }[] = [];
for (const plan of PLANS) {
  const m = meters.get(plan.source);
  if (!m) {
    rows.push([plan.label, `$${plan.price}`, `${int(plan.quota)}`, "—", "store not built", "", "", "", ""]);
    continue;
  }
  const list = priceOf(m.metered);
  const perTurn = effective(list.perTurn, plan);
  const perMtok = effective(list.perMtok, plan);
  const perDay = m.burn.cost / Math.max(m.burnDays, 1);
  comparable.push({ plan, list, unit: m.unit, turn: perTurn, mtok: perMtok });
  rows.push([
    plan.label,
    `$${plan.price}`,
    `${int(plan.quota)}${m.unit === "credit" ? " cr" : ""}`,
    num(perTurn, 6),
    num(perMtok, 5),
    int(plan.quota / list.perTurn),
    int(plan.quota / list.perMtok),
    num(perDay ? plan.quota / perDay : NaN, 1),
    num(perDay ? (30 * perDay * plan.price) / plan.quota : NaN, 2),
  ]);
}

console.log("[osm] what each plan buys\n");
console.log(
  table(
    ["plan", "price", "quota", "per turn $", "per Mtok $", "buys turns", "buys Mtok", "covers days", "$/30d*"],
    rows,
    ["l", "r", "r", "r", "r", "r", "r", "r", "r"]
  )
);
console.log("\n  * at that source's own observed load — the two loads differ, so compare the");
console.log("    unit prices or the per-dollar figures, not the 30-day column.");

if (comparable.length === 2) {
  const [a, b] = comparable;
  console.log(`\n  ${b.plan.label} costs ${num(b.mtok / a.mtok, 2)}× per Mtok and ${num(b.turn / a.turn, 2)}× per turn.`);
  /**
   * Both list prices in dollars: credits convert at the plan's own definition
   * ($0.01), never at a discount. The discount is what the plan adds on top, and it
   * is the only reason the ordering can flip — so it is worth printing separately.
   */
  const inUsd = (c: (typeof comparable)[number]) =>
    c.unit === "usd" ? c.list.perMtok : c.list.perMtok * (c.plan.price / c.plan.quota);
  const [la, lb] = [inUsd(a), inUsd(b)];
  const cheaper = la > lb ? b : a;
  const listRatio = la > lb ? la / lb : lb / la;
  console.log(`  At list, before any plan: ${cheaper.plan.source} is ${num(listRatio, 2)}× cheaper per Mtok.`);
  const breakEven = a.turn / b.list.perTurn;
  console.log(
    `  Break-even: one of ${b.plan.label}'s credits must cost $${num(breakEven, 5)} ` +
      `(now $${num(b.plan.price / b.plan.quota, 5)}), i.e. $${b.plan.price} must buy ` +
      `${int(b.plan.price / breakEven)} credits.`
  );
}
