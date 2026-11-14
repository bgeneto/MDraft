//! Native `latexmk` reference timings for the LaTeX live-preview benchmark.
//!
//!   node scripts/latex-perf-native.mjs [--runs=5] [--engine=lualatex] [--out=dir]
//!
//! The competitive row of docs/architecture.md: what a
//! desktop editor that runs latexmk on save makes the reader wait, without its
//! viewer reload. Each fixture is copied to a scratch directory on the Linux
//! side (inside WSL on Windows: /mnt/c is far too slow for TeX's many small
//! reads), built clean once, then edited one letter at a time at the fixture's
//! mid-document marker and rebuilt. Output: a table and one LATEX_NATIVE_JSON
//! line. Requires latexmk and the engine on PATH (TeX Live in WSL on Windows).
//! It never touches the application or its profile.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runs = Math.max(1, Number.parseInt(option("runs", "5"), 10) || 5);
const engine = option("engine", "lualatex");
const out = option("out", null);
const root = process.cwd();

const fixtures = [
  ["small", "small.tex", "small.tex", "S1"],
  ["preamble", "preamble.tex", "preamble.tex", "P1"],
  ["huge", "huge", "chapters/ch06.tex", "C06"],
  ["book", "book", "chapters/ch06.tex", "B06"],
  ["book-flat", "book-flat", "main.tex", "F06"],
];

const windows = process.platform === "win32";
const toPosix = (path) =>
  windows ? `/mnt/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}` : path;
function sh(script) {
  return windows
    ? execFileSync("wsl", ["-e", "bash", "-lc", script], { encoding: "utf8" })
    : execFileSync("bash", ["-lc", script], { encoding: "utf8" });
}

const version = sh(`${engine} --version | head -1`).trim();
const results = [];
for (const [name, source, editFile, marker] of fixtures) {
  const sourcePath = toPosix(join(root, "samples", "latex-perf", source));
  const isFile = source.endsWith(".tex");
  const main = isFile ? source : "main.tex";
  const work = `$HOME/.cache/mdraft-perf/${name}`;
  const setup = isFile
    ? `rm -rf ${work} && mkdir -p ${work} && cp '${sourcePath}' ${work}/`
    : `rm -rf ${work} && mkdir -p ${work} && cp -r '${sourcePath}/.' ${work}/`;
  const build = `cd ${work} && s=$(date +%s%N); latexmk -${engine === "pdflatex" ? "pdf" : engine} -interaction=nonstopmode -halt-on-error ${main} >build.log 2>&1; rc=$?; e=$(date +%s%N); echo "$rc $(( (e-s)/1000000 ))"`;
  const parse = (output) => {
    // A login shell may print its own noise (pyenv, motd) on stdout; the status
    // is the one line of two integers.
    const line = output.split("\n").find((entry) => /^\d+ \d+$/.test(entry.trim())) ?? "";
    const [rc, ms] = line.trim().split(/\s+/).map(Number);
    if (rc !== 0) throw new Error(`${name}: latexmk failed (rc ${rc}); see ${work}/build.log`);
    return ms;
  };
  const clean = parse(sh(`${setup} && ${build}`));
  const pages = Number(
    sh(`cd ${work} && pdfinfo ${main.replace(/\.tex$/, ".pdf")} | awk '/^Pages:/ {print $2}'`)
      .split("\n")
      .find((entry) => /^\d+$/.test(entry.trim())) ?? "NaN",
  );
  const letters = "ABCDEFGHIJKLMNOQRSTUVWXYZ";
  const edits = [];
  for (let run = 0; run < runs; run += 1) {
    const letter = letters[run];
    sh(
      `cd ${work} && sed -i -E 's/.erformance probe paragraph ${marker}/${letter}erformance probe paragraph ${marker}/' ${editFile}`,
    );
    edits.push(parse(sh(build)));
  }
  const sorted = [...edits].sort((a, b) => a - b);
  const row = {
    fixture: name,
    pages,
    cleanMs: clean,
    editMs: edits,
    editMedianMs: sorted[(sorted.length - 1) >> 1],
  };
  results.push(row);
  console.log(
    `${name.padEnd(10)} pages ${String(pages).padStart(4)}  clean ${String(clean).padStart(6)} ms  edit median ${String(row.editMedianMs).padStart(6)} ms  (${edits.join(", ")})`,
  );
}
const output = { schema: 1, engine, version, platform: process.platform, runs, results };
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `native-${engine}-${Date.now()}.json`), JSON.stringify(output, null, 2));
}
console.log(`LATEX_NATIVE_JSON ${JSON.stringify(output)}`);
