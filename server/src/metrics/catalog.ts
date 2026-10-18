import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { MODEL_CATALOG, MODEL_OVERRIDES } from "../config";

export interface ModelInfo {
  id: string;
  provider: string;
  label: string;
  context: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  /** where the numbers came from: models.dev | cache | fallback | override */
  source: string;
}

export type Catalog = Record<string, ModelInfo>;

interface CacheFile {
  fetchedAt?: number;
  models?: Catalog;
}

const FALLBACK_CONTEXT = 128000;
/** Refresh pricing/context from models.dev at most this often. */
const CATALOG_TTL_MS = 7 * 86400000;

/** Key used in the catalog: `${provider}/${model}` (models.dev convention). */
export const catalogKey = (provider: string | null | undefined, model: string | null | undefined) =>
  `${provider ?? "unknown"}/${model ?? "unknown"}`;

function fromModelsDev(api: any, wanted: Set<string>): Catalog {
  const out: Catalog = {};
  for (const [providerID, provider] of Object.entries<any>(api ?? {})) {
    for (const [modelID, m] of Object.entries<any>(provider?.models ?? {})) {
      const key = `${providerID}/${modelID}`;
      if (!wanted.has(key)) continue;
      out[key] = { ...normalize(modelID, providerID, m), source: "models.dev" };
    }
  }
  return out;
}

function normalize(modelID: string, providerID: string, m: any): ModelInfo {
  const cost = m?.cost ?? {};
  const cache = cost.cache ?? {};
  return {
    id: modelID,
    provider: providerID,
    label: m?.name ?? modelID,
    context: Number(m?.limit?.context) || FALLBACK_CONTEXT,
    costInput: Number(cost.input) || 0,
    costOutput: Number(cost.output) || 0,
    costCacheRead: Number(cache.read) || 0,
    costCacheWrite: Number(cache.write) || 0,
    source: "cache",
  };
}

function readCache(): { fetchedAt: number; models: Catalog } {
  if (!existsSync(MODEL_CATALOG)) return { fetchedAt: 0, models: {} };
  try {
    const parsed = JSON.parse(readFileSync(MODEL_CATALOG, "utf8")) as CacheFile & Catalog;
    // tolerate both shapes: a bare catalog (v1) and {fetchedAt, models} (v2)
    if (parsed && typeof parsed === "object" && "models" in parsed && parsed.models) {
      return { fetchedAt: Number(parsed.fetchedAt ?? 0), models: parsed.models as Catalog };
    }
    return { fetchedAt: 0, models: parsed as Catalog };
  } catch {
    return { fetchedAt: 0, models: {} };
  }
}

export function readOverrides(): Catalog {
  if (!existsSync(MODEL_OVERRIDES)) return {};
  try {
    return JSON.parse(readFileSync(MODEL_OVERRIDES, "utf8")) as Catalog;
  } catch {
    return {};
  }
}

/** Manual price/context corrections (free-tier models price as 0 on models.dev). */
export function writeOverride(key: string, patch: Partial<ModelInfo>): ModelInfo {
  const all = readOverrides();
  const base: ModelInfo = all[key] ?? {
    id: key.split("/")[1] ?? key,
    provider: key.split("/")[0] ?? "unknown",
    label: key,
    context: FALLBACK_CONTEXT,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    source: "override",
  };
  const next: ModelInfo = { ...base, ...patch, source: "override" };
  all[key] = next;
  writeFileSync(MODEL_OVERRIDES, JSON.stringify(all, null, 2));
  return next;
}

function fallbackEntry(key: string): ModelInfo {
  const provider = key.split("/")[0] ?? "unknown";
  const model = key.split("/")[1] ?? key;
  return { ...normalize(model, provider, null), source: "fallback" };
}

/**
 * Catalog for the model ids actually present in the database.
 * Order of authority: manual override > models.dev (TTL-refreshed) > on-disk cache > zeroed fallback.
 */
export async function loadCatalog(wanted: Set<string>): Promise<Catalog> {
  const cache = readCache();
  const overrides = readOverrides();
  const stale = Date.now() - cache.fetchedAt > CATALOG_TTL_MS;
  const missing = [...wanted].filter((k) => !cache.models[k]);

  let fresh: Catalog = {};
  const offline = process.env.HOLO_OFFLINE === "1";
  if ((missing.length > 0 || stale) && !offline) {
    try {
      const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
      fresh = fromModelsDev(await res.json(), wanted);
      writeFileSync(MODEL_CATALOG, JSON.stringify({ fetchedAt: Date.now(), models: { ...cache.models, ...fresh } }));
    } catch (err) {
      if (!cache.fetchedAt) {
        writeFileSync(MODEL_CATALOG, JSON.stringify({ fetchedAt: Date.now(), models: cache.models }));
      }
      console.warn(`[catalog] models.dev unavailable (${(err as Error).message}); using cache/fallback`);
    }
  }

  const merged: Catalog = {};
  for (const key of wanted) {
    // cached entries may predate the `source` field — normalise before use
    const cached = cache.models[key];
    merged[key] = fresh[key] ?? (cached ? { ...fallbackEntry(key), ...cached, source: cached.source ?? "cache" } : fallbackEntry(key));
  }
  for (const [key, patch] of Object.entries(overrides)) {
    if (!wanted.has(key)) continue;
    merged[key] = { ...merged[key], ...patch, source: "override" };
  }
  return merged;
}
