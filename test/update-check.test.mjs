import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CHECK_INTERVAL_MS,
  cachePath,
  checkForUpdate,
  compareVersions,
  isNewer,
  parseVersion,
  readCache,
  registryUrl,
  writeCache,
} from "../bin/update-check.js";

const NAME = "@kitsunemori96/open-session-metrics";
const NOW = 1_000_000_000_000;

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "osm-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (version) => async () => ({ ok: true, json: async () => ({ version }) });
const offline = () => async () => {
  throw new Error("offline");
};

test("parseVersion accepts v-prefixes and prereleases, rejects the rest", () => {
  assert.deepEqual(parseVersion("0.3.1"), { major: 0, minor: 3, patch: 1, pre: null });
  assert.deepEqual(parseVersion("v0.3.1"), { major: 0, minor: 3, patch: 1, pre: null });
  assert.equal(parseVersion("0.3.1-rc.2").pre, "rc.2");
  assert.equal(parseVersion("0.3"), null);
  assert.equal(parseVersion("latest"), null);
  assert.equal(parseVersion(null), null);
});

test("compareVersions orders numerically, not lexically", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.3.1", "0.3.1"), 0);
  assert.equal(compareVersions("0.3.1-rc.1", "0.3.1"), -1);
  assert.equal(compareVersions("0.3.1", "0.3.1-rc.1"), 1);
  assert.equal(compareVersions("0.3.1-rc.2", "0.3.1-rc.1"), 1);
  assert.equal(compareVersions("nonsense", "0.3.1"), 0);
});

test("isNewer is strict", () => {
  assert.equal(isNewer("0.3.1", "0.3.0"), true);
  assert.equal(isNewer("0.3.1", "0.3.1"), false);
  assert.equal(isNewer("0.3.0", "0.3.1"), false);
});

test("registryUrl encodes the scope and tolerates a trailing slash", () => {
  assert.equal(
    registryUrl(NAME),
    "https://registry.npmjs.org/@kitsunemori96%2Fopen-session-metrics/latest"
  );
  assert.equal(
    registryUrl(NAME, "https://npm.example/"),
    "https://npm.example/@kitsunemori96%2Fopen-session-metrics/latest"
  );
});

test("a fresh cache answers without touching the network", async (t) => {
  const dir = scratch(t);
  writeCache(cachePath(dir), NAME, "0.4.0", NOW);
  let calls = 0;
  const info = await checkForUpdate({
    name: NAME,
    current: "0.3.1",
    dataDir: dir,
    now: NOW + 1000,
    env: {},
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
  });
  assert.equal(calls, 0);
  assert.equal(info.from, "cache");
  assert.equal(info.latest, "0.4.0");
  assert.equal(info.newer, true);
});

test("a stale cache is refreshed and rewritten", async (t) => {
  const dir = scratch(t);
  const file = cachePath(dir);
  writeCache(file, NAME, "0.3.1", NOW);
  const info = await checkForUpdate({
    name: NAME,
    current: "0.3.1",
    dataDir: dir,
    now: NOW + CHECK_INTERVAL_MS + 1,
    env: {},
    fetchImpl: ok("0.4.0"),
  });
  assert.equal(info.from, "registry");
  assert.equal(info.latest, "0.4.0");
  assert.equal(readCache(file, NAME, NOW + CHECK_INTERVAL_MS + 1).latest, "0.4.0");
});

test("a failed refresh falls back to the last stored answer", async (t) => {
  const dir = scratch(t);
  writeCache(cachePath(dir), NAME, "0.3.5", NOW);
  const info = await checkForUpdate({
    name: NAME,
    current: "0.3.1",
    dataDir: dir,
    now: NOW + CHECK_INTERVAL_MS + 1,
    env: {},
    fetchImpl: offline(),
  });
  assert.equal(info.from, "cache");
  assert.equal(info.latest, "0.3.5");
  assert.equal(info.newer, true);
  // The stale answer still comes with the failure, so an explicit check can say so.
  assert.match(info.error, /offline/);
});

test("a failed first check reports the error instead of throwing", async (t) => {
  const info = await checkForUpdate({
    name: NAME,
    current: "0.3.1",
    dataDir: scratch(t),
    env: {},
    fetchImpl: offline(),
  });
  assert.match(info.error, /offline/);
  assert.equal(info.newer, undefined);
});

test("a failed check is remembered, so the next command does not retry", async (t) => {
  const dir = scratch(t);
  let calls = 0;
  const failFetch = async () => {
    calls += 1;
    throw new Error("offline");
  };
  const first = await checkForUpdate({ name: NAME, current: "0.3.1", dataDir: dir, now: NOW, env: {}, fetchImpl: failFetch });
  assert.match(first.error, /offline/);

  const second = await checkForUpdate({
    name: NAME,
    current: "0.3.1",
    dataDir: dir,
    now: NOW + 1000,
    env: {},
    fetchImpl: failFetch,
  });
  assert.equal(second, null);
  assert.equal(calls, 1);
  assert.equal(readCache(cachePath(dir), NAME, NOW).latest, null);

  // The negative cache expires like any other: after a day it tries again.
  const third = await checkForUpdate({
    name: NAME,
    current: "0.3.1",
    dataDir: dir,
    now: NOW + CHECK_INTERVAL_MS + 1,
    env: {},
    fetchImpl: failFetch,
  });
  assert.equal(calls, 2);
  assert.match(third.error, /offline/);
});

test("OSM_NO_UPDATE_CHECK and CI skip the check entirely", async (t) => {
  for (const env of [{ OSM_NO_UPDATE_CHECK: "1" }, { CI: "true" }]) {
    let calls = 0;
    const info = await checkForUpdate({
      name: NAME,
      current: "0.3.1",
      dataDir: scratch(t),
      env,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, json: async () => ({ version: "0.4.0" }) };
      },
    });
    assert.equal(info, null);
    assert.equal(calls, 0);
  }
});

test("OSM_OFFLINE never opens a socket but may reuse a cache entry", async (t) => {
  const dir = scratch(t);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("should not fetch");
  };
  const empty = await checkForUpdate({ name: NAME, current: "0.3.1", dataDir: dir, env: { OSM_OFFLINE: "1" }, fetchImpl });
  assert.equal(empty, null);

  writeCache(cachePath(dir), NAME, "0.4.0", NOW);
  const cached = await checkForUpdate({
    name: NAME,
    current: "0.3.1",
    dataDir: dir,
    now: NOW + CHECK_INTERVAL_MS + 1,
    env: { OSM_OFFLINE: "1" },
    fetchImpl,
  });
  assert.equal(cached.latest, "0.4.0");
  assert.equal(cached.from, "cache");
  assert.equal(calls, 0);
});

test("force bypasses the cache, the opt-out and offline", async (t) => {
  const dir = scratch(t);
  writeCache(cachePath(dir), NAME, "0.3.1", NOW);
  const info = await checkForUpdate({
    name: NAME,
    current: "0.3.1",
    dataDir: dir,
    now: NOW + 1,
    force: true,
    env: { OSM_NO_UPDATE_CHECK: "1", OSM_OFFLINE: "1" },
    fetchImpl: ok("0.4.0"),
  });
  assert.equal(info.from, "registry");
  assert.equal(info.latest, "0.4.0");
});

test("the registry can be overridden for mirrors", async (t) => {
  let seen = "";
  const info = await checkForUpdate({
    name: NAME,
    current: "0.3.1",
    dataDir: scratch(t),
    env: { OSM_UPDATE_REGISTRY: "https://mirror.example/" },
    fetchImpl: async (url) => {
      seen = url;
      return { ok: true, json: async () => ({ version: "0.4.0" }) };
    },
  });
  assert.equal(seen, "https://mirror.example/@kitsunemori96%2Fopen-session-metrics/latest");
  assert.equal(info.latest, "0.4.0");
});

test("an HTTP error is a failed check, not a version", async (t) => {
  const info = await checkForUpdate({
    name: NAME,
    current: "0.3.1",
    dataDir: scratch(t),
    env: {},
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.match(info.error, /HTTP 500/);
});

test("the cache file names its package and is ignored by another one", (t) => {
  const dir = scratch(t);
  const file = cachePath(dir);
  writeCache(file, NAME, "0.4.0", NOW);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    package: NAME,
    checkedAt: NOW,
    latest: "0.4.0",
  });
  assert.equal(readCache(file, "@someone/else", NOW), null);

  // `null` is a recorded failure, not a corrupt file.
  writeCache(file, NAME, null, NOW);
  assert.equal(readCache(file, NAME, NOW).latest, null);

  writeFileSync(file, "{not json");
  assert.equal(readCache(file, NAME, NOW), null);
});
