#!/usr/bin/env node
// The pre-rename package name, kept alive as a bridge. It does not carry a
// second copy of the app: it resolves the renamed package that npm installed
// as our dependency and runs its `osm` entry with the same arguments, stdio and
// exit code. `npm update -g @kitsunemori96/opencode-session-metrics` therefore
// lands existing users on the new code without a manual reinstall.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let entry;
try {
  entry = require.resolve("@kitsunemori96/open-session-metrics/bin/osm.js");
} catch {
  process.stderr.write(
    "osm: the renamed package is missing — run: npm i -g @kitsunemori96/open-session-metrics\n"
  );
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("error", (error) => {
  process.stderr.write(`osm: ${error.message}\n`);
  process.exit(1);
});
// The terminal already signals the whole foreground group; forwarding covers
// the case where only this wrapper is signalled (service managers, scripts).
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 1));
