/**
 * Motion audit.
 *
 * The interface has one motion language (see `web/src/motion.css`): four
 * durations, one curve, six verbs, and no layout properties. That is only true
 * as long as nobody adds "just a quick 300ms ease-in" in a component, so the
 * rules are checked here rather than remembered in review.
 *
 * Run with `pnpm -F @osm/web test` (part of the root `pnpm test`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const MOTION_CSS = "motion.css";

/**
 * 0 is a reset, 1ms the reduced-motion override, 12ms the stagger token,
 * 1600ms the one loop (the sync pulse).
 */
const ALLOWED_MS = new Set([0, 1, 12, 60, 90, 120, 170, 260, 1600]);

const problems = [];
const add = (file, line, message) => problems.push(`${file}:${line} ${message}`);

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(css|tsx?|jsx?)$/.test(entry.name)) files.push(full);
  }
})(SRC);

const lines = (text) => text.split("\n");

for (const full of files) {
  const rel = relative(SRC, full);
  const text = readFileSync(full, "utf8");
  const isCss = full.endsWith(".css");

  lines(text).forEach((line, i) => {
    const at = i + 1;
    // One duration set, no shorthand that sweeps layout into the transition.
    if (/\btransition-all\b/.test(line) || /transition\s*:\s*all\b/.test(line)) {
      add(rel, at, "transition-all is banned — name the properties");
    }
    // The curve is a token; a browser keyword means a second timing function
    // crept in. Only transitions and animations are inspected — `linear-gradient`
    // and `scaleLinear` are not motion.
    if (isCss) {
      const decl = line.match(/\b(?:transition|animation)(?:-timing-function)?\s*:\s*([^;]+)/);
      if (decl && /\b(?:ease-in|ease-out|linear)\b/.test(decl[1]) && !decl[1].includes("var(--ease-")) {
        add(rel, at, "raw easing keyword — use var(--ease-mech) / var(--ease-track)");
      }
    }
    // Tailwind's stock animations are not instrument motion.
    if (/\banimate-(pulse|spin|bounce|ping)\b/.test(line)) {
      add(rel, at, "stock Tailwind animation — use .pulse / .ink / .turn");
    }
    if (rel !== MOTION_CSS && /@keyframes/.test(line)) {
      add(rel, at, "keyframes live in motion.css");
    }
    // Arbitrary Tailwind durations are the usual way a 300ms sneaks in.
    const tw = line.match(/\bduration-\[?(\d+)\]?\b/);
    if (tw && !ALLOWED_MS.has(Number(tw[1]))) {
      add(rel, at, `duration-${tw[1]} is outside the motion scale`);
    }
    if (isCss) {
      for (const m of line.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
        const ms = m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
        if (!ALLOWED_MS.has(ms)) add(rel, at, `${m[0]} is outside the motion scale`);
      }
    }
  });

  // Animation must not move layout: a keyframe that animates width/height/top/left
  // reflows the page every frame, which is exactly what the system forbids.
  if (isCss) {
    for (const block of text.matchAll(/@keyframes[^{]*\{([\s\S]*?\n\})/g)) {
      const start = text.slice(0, block.index).split("\n").length;
      block[1].split("\n").forEach((line, i) => {
        const prop = line.match(/^\s*(width|height|top|left|right|bottom|margin|padding)\s*:/);
        if (prop) add(rel, start + i, `keyframes animate ${prop[1]} — use transform/opacity/clip-path`);
      });
    }
  }
}

// The safety net has to be present, or all of the above is decoration.
const motionCss = readFileSync(join(SRC, MOTION_CSS), "utf8");
for (const needed of ["prefers-reduced-motion", "--motion-fast", "--motion-base", "--motion-slow", "--ease-mech"]) {
  if (!motionCss.includes(needed)) add(MOTION_CSS, 0, `missing ${needed}`);
}
const indexCss = readFileSync(join(SRC, "index.css"), "utf8");
if (!indexCss.includes('@import "./motion.css"')) add("index.css", 0, "motion.css is not imported");

if (problems.length) {
  console.error(`motion audit: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`motion audit: ${files.length} files, one curve, four durations — clean`);
