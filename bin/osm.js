#!/usr/bin/env node
// osm — start the session-metrics cockpit from anywhere.
//
//   osm                 start the server in the background and open the browser
//   osm run             run in the foreground (Ctrl-C to stop)
//   osm open            open the browser only
//   osm stop            stop the background server
//   osm status          what is running, where the data lives
//   osm logs            follow the server log
//
// One process, one port: Express serves both the API and the built web bundle.
// State goes to the XDG data dir (`~/.local/share/opencode-holo-cockpit`), never
// into the package directory, so `npm i -g` upgrades cannot delete it.
import { spawn } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  watchFile,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const SERVER_ENTRY = path.join(ROOT, "server", "dist", "index.js");
const WEB_INDEX = path.join(ROOT, "web", "dist", "index.html");

const USAGE = `osm ${PKG.version} — local web cockpit for OpenCode session metrics

Usage
  osm [start] [options]   start in the background, then open the browser
  osm run [options]       run in the foreground (Ctrl-C to stop)
  osm stop                stop the background server
  osm status              process, URL, data dir, source db, bundle age
  osm logs [-n N]         follow the server log (default: last 40 lines)
  osm open                open the browser only

Options
  --port <n>     listen port (default: $OSM_PORT or 8787)
  --host <addr>  bind address (default: $OSM_HOST or 127.0.0.1)
  --data <dir>   data dir (default: $OSM_DATA_DIR or the XDG data dir)
  --source <db>  OpenCode database (default: $OSM_SOURCE_DB or ~/.local/share/opencode/opencode.db)
  --no-open      do not open a browser
  -f, --foreground  same as \`osm run\`
  -v, --version  print the version
  -h, --help     print this help
`;

const argv = process.argv.slice(2);
const flags = { open: true, foreground: false };
const positional = [];
let logLines = 40;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  switch (arg) {
    case "-h":
    case "--help":
      positional.push("help");
      break;
    case "-v":
    case "--version":
      positional.push("version");
      break;
    case "--port":
      flags.port = Number(argv[(i += 1)]);
      break;
    case "--host":
      flags.host = argv[(i += 1)];
      break;
    case "--data":
      flags.data = argv[(i += 1)];
      break;
    case "--source":
      flags.source = argv[(i += 1)];
      break;
    case "--no-open":
      flags.open = false;
      break;
    case "--open":
      flags.open = true;
      break;
    case "-f":
    case "--foreground":
      flags.foreground = true;
      break;
    case "-n":
      logLines = Number(argv[(i += 1)]);
      break;
    default:
      if (arg.startsWith("-")) fail(`unknown option: ${arg} (try: osm --help)`);
      positional.push(arg);
  }
}

const command = positional[0] ?? "start";
if (positional.length > 1) fail(`unexpected argument: ${positional[1]}`);

const HOST = flags.host ?? process.env.OSM_HOST ?? "127.0.0.1";
const PORT = flags.port ?? Number(process.env.OSM_PORT ?? 8787);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`invalid port: ${flags.port ?? process.env.OSM_PORT}`);
// Same rule as server/src/config.ts: a checkout keeps state in `<repo>/.data`,
// a global install goes to the XDG data dir.
const INSTALLED = `${path.sep}node_modules${path.sep}`;
const DEFAULT_DATA_DIR = ROOT.includes(INSTALLED)
  ? path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), PKG.name)
  : path.join(ROOT, ".data");
const DATA_DIR = path.resolve(flags.data ?? process.env.OSM_DATA_DIR ?? DEFAULT_DATA_DIR);
const SOURCE_DB =
  flags.source ??
  process.env.OSM_SOURCE_DB ??
  path.join(homedir(), ".local", "share", "opencode", "opencode.db");
const BROWSE_HOST = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
const URL = `http://${BROWSE_HOST.includes(":") ? `[${BROWSE_HOST}]` : BROWSE_HOST}:${PORT}`;

const PID_FILE = path.join(DATA_DIR, "osm.pid");
const LOG_FILE = path.join(DATA_DIR, "osm.log");

function fail(message) {
  process.stderr.write(`osm: ${message}\n`);
  process.exit(1);
}

function note(message) {
  process.stdout.write(`osm: ${message}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isUp(timeout = 1200) {
  try {
    const res = await fetch(`${URL}/api/status`, { signal: AbortSignal.timeout(timeout) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(state, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await isUp(700)) === state) return true;
    await sleep(250);
  }
  return (await isUp(700)) === state;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** A recycled pid must not cost an unrelated process its life. */
function isOurServer(pid) {
  if (process.platform !== "linux") return true;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("server/dist/index.js") || cmdline.includes("server/src/index.ts");
  } catch {
    return true;
  }
}

function onPath(bin) {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => dir && existsSync(path.join(dir, bin)));
}

function openBrowser() {
  if (!flags.open) {
    note(`open ${URL}`);
    return;
  }
  let cmd;
  if (process.platform === "darwin") cmd = ["open", [URL]];
  else if (process.platform === "win32") cmd = ["cmd", ["/c", "start", "", URL]];
  else if (existsSync("/proc/version") && readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft") && onPath("wslview"))
    cmd = ["wslview", [URL]];
  else if (onPath("xdg-open")) cmd = ["xdg-open", [URL]];
  if (!cmd) {
    note(`open ${URL}`);
    return;
  }
  const child = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
  child.on("error", () => note(`open ${URL}`));
  child.unref();
}

function childEnv() {
  return {
    ...process.env,
    OSM_HOST: HOST,
    OSM_PORT: String(PORT),
    OSM_DATA_DIR: DATA_DIR,
    OSM_SOURCE_DB: SOURCE_DB,
  };
}

function lastLines(file, count) {
  const size = statSync(file).size;
  const start = Math.max(0, size - 64 * 1024);
  const lines = readFileSync(file).subarray(start).toString("utf8").split("\n");
  if (start > 0) lines.shift();
  return lines.slice(-count).join("\n").trimEnd();
}

function checkInstall() {
  if (!existsSync(SERVER_ENTRY)) fail(`server bundle missing (${SERVER_ENTRY}) — reinstall: npm i -g ${PKG.name}`);
  if (!existsSync(WEB_INDEX)) fail(`web bundle missing (${WEB_INDEX}) — reinstall: npm i -g ${PKG.name}`);
}

async function start(foreground) {
  checkInstall();

  if (await isUp()) {
    note(`already running — ${URL}`);
    openBrowser();
    return;
  }

  const stale = readPid();
  if (stale) {
    if (!isOurServer(stale)) {
      note(`pid ${stale} is not this server — clearing ${PID_FILE}`);
      try {
        unlinkSync(PID_FILE);
      } catch {}
    } else if (await waitFor(true, 15000)) {
      note(`up — ${URL}`);
      openBrowser();
      return;
    } else {
      fail(`pid ${stale} is alive but ${URL} does not answer — osm stop, then retry`);
    }
  }

  mkdirSync(DATA_DIR, { recursive: true });

  if (foreground) {
    note(`serving ${URL} (data: ${DATA_DIR}) — Ctrl-C to stop`);
    const child = spawn(process.execPath, [SERVER_ENTRY], { stdio: "inherit", env: childEnv(), cwd: ROOT });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => child.kill(signal));
    }
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    return;
  }

  const log = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    detached: true,
    stdio: ["ignore", log, log],
    env: childEnv(),
    cwd: ROOT,
  });
  child.unref();
  writeFileSync(PID_FILE, `${child.pid}\n`);

  if (!(await waitFor(true, 20000))) {
    const tail = existsSync(LOG_FILE) ? lastLines(LOG_FILE, 20) : "";
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {}
    fail(`server did not come up (log: ${LOG_FILE})${tail ? `\n${tail}` : ""}`);
  }

  note(`up — ${URL} (pid ${child.pid}, data ${DATA_DIR})`);
  openBrowser();
}

async function stop() {
  const pid = readPid();
  if (!pid) {
    if (await isUp()) {
      note(`${URL} answers, but it was not started by osm — leaving it alone`);
      return;
    }
    note("not running");
    try {
      unlinkSync(PID_FILE);
    } catch {}
    return;
  }

  if (!isOurServer(pid)) {
    note(`pid ${pid} is not this server — leaving it alone`);
    try {
      unlinkSync(PID_FILE);
    } catch {}
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  if (!(await waitFor(false, 8000))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    await waitFor(false, 2000);
  }
  try {
    unlinkSync(PID_FILE);
  } catch {}
  note(`stopped (pid ${pid})`);
}

async function status() {
  const pid = readPid();
  const up = await isUp();
  note(`${up ? "up" : "down"} — ${URL}`);
  if (pid) note(`  pid     ${pid}`);
  else if (up) note("  pid     unknown (not started by osm)");
  note(`  data    ${DATA_DIR}${existsSync(path.join(DATA_DIR, "metrics.db")) ? "" : " (no metrics.db yet)"}`);
  note(`  source  ${SOURCE_DB}${existsSync(SOURCE_DB) ? "" : " (missing)"}`);
  if (existsSync(WEB_INDEX)) {
    note(`  bundle  ${statSync(WEB_INDEX).mtime.toISOString().slice(0, 16).replace("T", " ")}`);
  } else {
    note("  bundle  missing");
  }
}

function follow() {
  if (!existsSync(LOG_FILE)) {
    note(`no log yet (${LOG_FILE})`);
    return;
  }
  process.stdout.write(`${lastLines(LOG_FILE, logLines)}\n`);
  let size = statSync(LOG_FILE).size;
  watchFile(LOG_FILE, { interval: 400 }, (current) => {
    if (current.size < size) size = 0;
    if (current.size <= size) return;
    createReadStream(LOG_FILE, { start: size, end: current.size - 1 }).pipe(process.stdout, { end: false });
    size = current.size;
  });
}

async function restart() {
  await stop();
  await start(flags.foreground);
}

switch (command) {
  case "start":
    await start(flags.foreground);
    break;
  case "run":
    await start(true);
    break;
  case "restart":
    await restart();
    break;
  case "stop":
    await stop();
    break;
  case "status":
    await status();
    break;
  case "logs":
  case "log":
    follow();
    break;
  case "open":
    openBrowser();
    break;
  case "version":
    process.stdout.write(`${PKG.version}\n`);
    break;
  case "help":
    process.stdout.write(USAGE);
    break;
  default:
    fail(`unknown command: ${command} (try: osm --help)`);
}
