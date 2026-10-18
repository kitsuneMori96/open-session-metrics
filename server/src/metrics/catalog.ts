import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { MODEL_CATALOG } from "../config";

export interface ModelInfo {
  id: string;
  provider: string;
  label: string;
  context: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
}

export type Catalog = Record<string, ModelInfo>;

const FALLBACK_CONTEXT = 128000;

/** Key used in the catalog: `${provider}/${model}` (models.dev convention). */
export const catalogKey = (provider: string | null | undefined, model: string | null | undefined) =>
  `${provider ?? "unknown"}/${model ?? "unknown"}`;

function fromModelsDev(api: any, wanted: Set<string>): Catalog {
  const out: Catalog = {};
  for (const [providerID, provider] of Object.entries<any>(api ?? {})) {
    for (const [modelID, m] of Object.entries<any>(provider?.models ?? {})) {
      const key = `${providerID}/${modelID}`;
      if (!wanted.has(key)) continue;
      out[key] = normalize(modelID, providerID, m);
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
  };
}

export function readCache(): Catalog {
  if (!existsSync(MODEL_CATALOG)) return {};
  try {
    return JSON.parse(readFileSync(MODEL_CATALOG, "utf8")) as Catalog;
  } catch {
    return {};
  }
}

/**
 * Refresh the catalog for the model ids actually present in the database.
 * Network failures are non-fatal: the on-disk cache (or fallback) is used instead.
 */
export async function loadCatalog(wanted: Set<string>): Promise<Catalog> {
  const cache = readCache();
  const missing = [...wanted].filter((k) => !cache[k]);
  if (missing.length === 0) return cache;

  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    const api = await res.json();
    const fresh = fromModelsDev(api, wanted);
    const merged: Catalog = { ...cache, ...fresh };
    for (const key of wanted) if (!merged[key]) merged[key] = normalize(key.split("/")[1] ?? key, key.split("/")[0] ?? "unknown", null);
    writeFileSync(MODEL_CATALOG, JSON.stringify(merged));
    return merged;
  } catch (err) {
    const merged: Catalog = { ...cache };
    for (const key of wanted) if (!merged[key]) merged[key] = normalize(key.split("/")[1] ?? key, key.split("/")[0] ?? "unknown", null);
    writeFileSync(MODEL_CATALOG, JSON.stringify(merged));
    console.warn(`[catalog] models.dev unavailable (${(err as Error).message}); using cache/fallback`);
    return merged;
  }
}
