// Step 13: measure a real LuaLaTeX compile.
//
//   node scripts/latex-measure.mjs
//
// The plan's step 13 asks for the first and warm compile, the memory the snapshot
// and the engine hold, and the installer delta.
//
// **The engine cannot run here.** `wasmtex/headless` drives the compiler through a
// Web Worker (`new Worker(...)` in `engine/worker-host.js`), and Node has no
// `Worker` global. So this probe reports the numbers it *can* take from disk —
// the engine's footprint, the snapshot size, the base64 the IPC would carry — and
// then says plainly that the compile timings need the application. A probe that
// printed a fabricated millisecond figure would be worse than one that stops.
//
// The compile itself is measured through `latex:project`, which runs a real isolated
// WebView2 instance. This file exists so the on-disk half is reproducible without
// launching the app.
//
// No application for the on-disk half.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FIXTURE = "samples/latex-project";

function engineDirectory() {
  // The same location the Rust side uses: the Tauri app-data directory.
  const candidates = [
    join(homedir(), "AppData", "Roaming", "io.github.bgeneto.mdraft", "latex"),
    join(homedir(), ".local", "share", "io.github.bgeneto.mdraft", "latex"),
    join(homedir(), "Library", "Application Support", "io.github.bgeneto.mdraft", "latex"),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(join(candidate, "assets")).isDirectory()) return candidate;
    } catch {
      // Not here; try the next.
    }
  }
  return null;
}

function directorySize(path) {
  let total = 0;
  let files = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        total += statSync(full).size;
        files += 1;
      }
    }
  };
  try {
    walk(path);
  } catch {
    return { total: 0, files: 0 };
  }
  return { total, files };
}

const engine = engineDirectory();
if (!engine) {
  console.log("SKIP: the LaTeX engine assets are not installed on this host.");
  console.log("      Enable the engine once in Preferences, then run this again.");
  console.log("0/0 measurements taken");
  process.exit(0);
}

const assets = directorySize(join(engine, "assets"));
console.log("=== the engine on disk ===");
console.log(`  engine directory      ${engine}`);
console.log(`  assets                ${(assets.total / 1048576).toFixed(1)} MiB in ${assets.files} files`);
for (const name of readdirSync(join(engine, "assets"))) {
  const size = statSync(join(engine, "assets", name)).size;
  if (size > 100 * 1024) console.log(`    ${name.padEnd(34)} ${(size / 1048576).toFixed(2)} MiB`);
}

// The project the compile reads, collected the way the snapshot collects it: the
// main file plus what it declares, not the whole directory.
const MAIN = process.env.MDRAFT_MEASURE_MAIN || join(FIXTURE, "main.tex");
const main = readFileSync(MAIN, "utf8");
const referenced = [MAIN];
for (const match of main.matchAll(/\\(?:input|include)\s*\{([^{}]*)\}/g)) {
  referenced.push(join(FIXTURE, `${match[1]}.tex`));
}
for (const match of main.matchAll(/\\bibliography\s*\{([^{}]*)\}/g)) {
  referenced.push(join(FIXTURE, `${match[1]}.bib`));
}
for (const match of main.matchAll(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g)) {
  const name = match[1];
  for (const suffix of ["", ".png", ".pdf", ".jpg"]) {
    try {
      const full = join(FIXTURE, `${name}${suffix}`);
      statSync(full);
      referenced.push(full);
      break;
    } catch {
      // Try the next suffix.
    }
  }
}

let snapshotBytes = 0;
console.log("\n=== the snapshot the compile receives ===");
for (const path of referenced) {
  const size = statSync(path).size;
  snapshotBytes += size;
  console.log(`  ${path.slice(FIXTURE.length + 1).padEnd(28)} ${size.toLocaleString().padStart(9)} bytes`);
}
console.log(`  total                 ${snapshotBytes.toLocaleString()} bytes (${(snapshotBytes / 1024).toFixed(1)} KiB)`);
// Base64 is 4 bytes per 3, and the IPC carries it as a JSON string.
const base64 = Math.ceil(snapshotBytes / 3) * 4;
console.log(`  base64 over IPC       ${base64.toLocaleString()} bytes (${((base64 / snapshotBytes - 1) * 100).toFixed(0)}% overhead)`);
console.log("  why step 9 matters    the old collector walked the directory; this is the");
console.log("                        referenced set only, which is what the snapshot now sends");

// What the whole directory would have cost, for the comparison step 9 claims.
const whole = directorySize(FIXTURE);
console.log("\n=== against the old directory walk ===");
console.log(`  whole directory       ${whole.total.toLocaleString()} bytes in ${whole.files} files`);
console.log(`  referenced set        ${snapshotBytes.toLocaleString()} bytes in ${referenced.length} files`);
if (whole.total > 0) {
  console.log(`  avoided               ${((1 - snapshotBytes / whole.total) * 100).toFixed(0)}% of the directory`);
}

console.log("\n=== the compile timings need the application ===");
console.log("  The engine drives a Web Worker, and Node has no `Worker` global:");
console.log("    ReferenceError: Worker is not defined (engine/worker-host.js)");
console.log("  Measure the first and warm compile through `npm run latex:project`, which");
console.log("  launches a real isolated WebView2 instance. This probe deliberately");
console.log("  reports no millisecond figure rather than a fabricated one.");
console.log("");
console.log("  When you do construct a compiler outside the app, pass the engine");
console.log("  explicitly: `new WasmTexCompiler({ engine: \"lualatex\", ... })`. Without");
console.log("  it, detection sees `fontspec` and resolves to XeLaTeX -- which this");
console.log("  build does not ship -- and the compile fails with");
console.log("    Document requires XeLaTeX, which is not available in this build.");
console.log("  LuaLaTeX supports `fontspec`; the engine is a preference, not a");
console.log("  requirement. See the trap in AGENTS.md.");

console.log("\nmeasurements complete");
