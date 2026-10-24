// Once-a-day registry lookups, kept out of bin/osm.js so the logic can be
// tested without spawning a server and without touching the network.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 1200;
const CACHE_FILE = "update-check.json";

/** `0.3.1`, `v0.3.1`, `0.3.1-rc.1` → parts; anything else → null. */
export function parseVersion(input) {
  if (typeof input !== "string") return null;
  const match = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? null,
  };
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  // A release outranks any prerelease of the same core: 0.3.1 > 0.3.1-rc.1.
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;

/** Scoped names must be percent-encoded on the `/latest` route. */
export function registryUrl(name, registry = DEFAULT_REGISTRY) {
  const base = (registry || DEFAULT_REGISTRY).replace(/\/+$/, "");
  return `${base}/${name.replace("/", "%2F")}/latest`;
}

export const cachePath = (dataDir) => path.join(dataDir, CACHE_FILE);

export function readCache(file, name, now = Date.now()) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || raw.package !== name || !Number.isFinite(raw.checkedAt)) return null;
    if (raw.latest !== null && typeof raw.latest !== "string") return null;
    return { latest: raw.latest, checkedAt: raw.checkedAt, fresh: now - raw.checkedAt < CHECK_INTERVAL_MS };
  } catch {
    return null;
  }
}

export function writeCache(file, name, latest, now = Date.now()) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ package: name, checkedAt: now, latest }, null, 2)}\n`);
  } catch {
    // A read-only or full data dir must not fail a command that was only checking.
  }
}

async function fetchLatest({ name, registry, fetchImpl, timeout }) {
  const res = await fetchImpl(registryUrl(name, registry), {
    signal: AbortSignal.timeout(timeout),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`registry → HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.version !== "string") throw new Error("registry response has no version");
  return body.version;
}

/**
 * The latest published version, from cache when it is under 24h old.
 *
 * `force` is for `osm upgrade`, where the user asked right now: it skips the
 * cache, the daily opt-out and the offline guard. Ambient calls stay silent on
 * failure and fall back to the last stored answer.
 *
 * A failure also writes the cache (`latest: null`, or the previous answer), so
 * an unreachable registry costs one timeout per day rather than one per command.
 */
export async function checkForUpdate({
  name,
  current,
  dataDir,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
  force = false,
  timeout = FETCH_TIMEOUT_MS,
}) {
  if (!force && (env.OSM_NO_UPDATE_CHECK || env.CI)) return null;

  const file = cachePath(dataDir);
  const cached = readCache(file, name, now);
  if (!force && cached?.fresh) {
    return cached.latest === null ? null : result(cached.latest, current, "cache");
  }

  if (!force && env.OSM_OFFLINE) {
    // Offline still honours a stored answer, but never opens a socket.
    return cached && cached.latest !== null ? result(cached.latest, current, "cache") : null;
  }

  try {
    const latest = await fetchLatest({
      name,
      registry: env.OSM_UPDATE_REGISTRY || env.npm_config_registry,
      fetchImpl,
      timeout,
    });
    writeCache(file, name, latest, now);
    return result(latest, current, "registry");
  } catch (error) {
    writeCache(file, name, cached?.latest ?? null, now);
    // Keep the error on the cached answer: an ambient notice ignores it, but
    // `osm upgrade --check` must not report stale data as a fresh answer.
    if (cached && cached.latest !== null) return { ...result(cached.latest, current, "cache"), error: error.message };
    return { error: error.message, current };
  }
}

function result(latest, current, from) {
  return { latest, current, from, newer: isNewer(latest, current) };
}
