//! Assemble docs/audits/latex-compile-baseline.json from probe runs.
//!
//!   node scripts/latex-perf-baseline.mjs <runs-dir> [--out=docs/audits/latex-compile-baseline.json]
//!
//! <runs-dir> holds the JSON files written by latex-performance-test.mjs
//! (MDRAFT_LATEX_PERF_OUT) and by latex-perf-native.mjs (--out). Each fixture
//! needs two matrix launches: the noise band of
//! docs/plans/2026-11-12-latex-compile-cost.md is
//! `max(|median launch 1 - median launch 2|, 2 x MAD of the pooled runs)`, per
//! scenario and metric. The output keeps every raw run, so a later stage can be
//! compared against the evidence, not against this script's summary.
//!
//! It also fits `compile ≈ F + k · pages` over the fixtures' medians (least
//! squares), for the application and for native latexmk: LuaLaTeX reports no
//! per-pass timings, so the fixed cost F (engine, format, preamble) and the
//! per-page cost k come from the fixtures instead.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args.find((arg) => !arg.startsWith("--"));
if (!dir) {
  console.error("usage: node scripts/latex-perf-baseline.mjs <runs-dir> [--out=path]");
  process.exit(2);
}
const out =
  args.find((arg) => arg.startsWith("--out="))?.slice(6) ??
  join("docs", "audits", "latex-compile-baseline.json");

const METRICS = [
  "e2p",
  "e2c",
  "tDelay",
  "renderMs",
  "engineStatusMs",
  "snapshotIpcMs",
  "snapshotDecodeMs",
  "initMs",
  "compileMs",
  "postMs",
  "viewMs",
  "longTaskMs",
];

const sorted = (values) => values.filter(Number.isFinite).sort((a, b) => a - b);
const quantile = (values, q) => {
  const s = sorted(values);
  if (!s.length) return null;
  const position = (s.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return s[low] + (s[high] - s[low]) * (position - low);
};
const median = (values) => quantile(values, 0.5);
const mad = (values) => {
  const m = median(values);
  return m === null ? null : median(values.filter(Number.isFinite).map((v) => Math.abs(v - m)));
};
const round = (value) =>
  value === null || value === undefined ? null : Math.round(value * 10) / 10;

const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
const app = [];
const native = [];
for (const name of files.sort()) {
  const data = JSON.parse(readFileSync(join(dir, name), "utf8"));
  if (data.engine && data.results) native.push({ file: name, ...data });
  else if (data.fixture) app.push({ file: name, ...data });
}

const fixtures = {};
for (const launch of app.filter((entry) => entry.mode === "matrix")) {
  (fixtures[launch.fixture] ??= { launches: [] }).launches.push(launch);
}
const problems = [];
for (const [name, entry] of Object.entries(fixtures)) {
  if (entry.launches.length < 2)
    problems.push(`${name}: ${entry.launches.length} launch(es); the noise band needs 2`);
  const hashes = new Set(entry.launches.map((launch) => launch.fixtureSha256));
  if (hashes.size > 1) problems.push(`${name}: fixture hash differs between launches`);
  const scenarios = {};
  for (const launch of entry.launches) {
    for (const run of launch.runs)
      (scenarios[run.scenario] ??= []).push({ launch: launch.file, ...run });
  }
  entry.scenarios = {};
  for (const [id, rows] of Object.entries(scenarios)) {
    const stats = {};
    for (const metric of METRICS) {
      const values = rows.map((row) => row[metric]);
      const perLaunch = entry.launches.map((launch) =>
        median(rows.filter((row) => row.launch === launch.file).map((row) => row[metric])),
      );
      const between =
        perLaunch.length >= 2 && perLaunch.every((value) => value !== null)
          ? Math.abs(perLaunch[0] - perLaunch[1])
          : null;
      const spread = mad(values);
      stats[metric] = {
        median: round(median(values)),
        p95: round(quantile(values, 0.95)),
        min: round(sorted(values)[0] ?? null),
        launchMedians: perLaunch.map(round),
        mad: round(spread),
        noiseBand:
          between === null || spread === null ? null : round(Math.max(between, 2 * spread)),
      };
    }
    const invalid = rows.filter((row) => row.problems?.length);
    entry.scenarios[id] = {
      runs: rows.length,
      invalid: invalid.length,
      position: rows[0]?.position ?? null,
      pages: rows.at(-1)?.pages ?? null,
      stats,
    };
    if (invalid.length) problems.push(`${name} ${id}: ${invalid.length} invalid run(s)`);
  }
}

/** Least-squares fit y = F + k·x over (pages, median) points. */
function fit(points) {
  const usable = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (usable.length < 2) return null;
  const n = usable.length;
  const sx = usable.reduce((s, [x]) => s + x, 0);
  const sy = usable.reduce((s, [, y]) => s + y, 0);
  const sxx = usable.reduce((s, [x]) => s + x * x, 0);
  const sxy = usable.reduce((s, [x, y]) => s + x * y, 0);
  const k = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { fixedMs: round((sy - k * sx) / n), perPageMs: round(k), points: usable };
}
const appPoints = Object.values(fixtures).flatMap((entry) =>
  Object.values(entry.scenarios).map((scenario) => [
    scenario.pages,
    scenario.stats.compileMs.median,
  ]),
);
const viewPoints = Object.values(fixtures).flatMap((entry) =>
  Object.values(entry.scenarios).map((scenario) => [scenario.pages, scenario.stats.viewMs.median]),
);
const latestNative = native.at(-1) ?? null;
const nativePoints = latestNative
  ? latestNative.results.map((row) => [row.pages, row.editMedianMs])
  : [];

const starvation = app
  .filter((entry) => entry.mode === "starvation")
  .map((entry) => ({ file: entry.file, fixture: entry.fixture, ...entry.starvation }));

const first = app[0] ?? {};
const baseline = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  plan: "docs/plans/2026-11-12-latex-compile-cost.md",
  method:
    "Probe: scripts/latex-performance-test.mjs, one fixture per launch, 1 warm-up + N measured edits per scenario. Noise band = max(|launch1 - launch2|, 2 x MAD of pooled runs). Times in ms from page performance marks.",
  environment: {
    host: first.host ?? null,
    os: first.os ?? null,
    commit: first.commit ?? null,
    dirty: first.dirty ?? null,
    binarySha256: first.binarySha256 ?? null,
    engineYear: first.engineYear ?? null,
    mirror: first.mirror ?? null,
    visibility: first.visibility ?? null,
    devicePixelRatio: first.devicePixelRatio ?? null,
  },
  problems,
  decomposition: {
    app: { compile: fit(appPoints), view: fit(viewPoints) },
    native: latestNative
      ? { engine: latestNative.engine, version: latestNative.version, edit: fit(nativePoints) }
      : null,
  },
  fixtures,
  starvation,
  native: native.map(({ file, ...rest }) => ({ file, ...rest })),
};
writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`wrote ${out}`);
for (const [name, entry] of Object.entries(fixtures)) {
  for (const [id, scenario] of Object.entries(entry.scenarios)) {
    const s = scenario.stats;
    console.log(
      `${name.padEnd(10)} ${id.padEnd(4)} pages ${String(scenario.pages).padStart(4)}  E2P ${s.e2p.median} (band ${s.e2p.noiseBand})  E2C ${s.e2c.median}  compile ${s.compileMs.median}  init ${s.initMs.median}  view ${s.viewMs.median}`,
    );
  }
}
if (baseline.decomposition.app.compile)
  console.log(
    `app compile ≈ ${baseline.decomposition.app.compile.fixedMs} + ${baseline.decomposition.app.compile.perPageMs}·pages`,
  );
if (baseline.decomposition.native?.edit)
  console.log(
    `native edit ≈ ${baseline.decomposition.native.edit.fixedMs} + ${baseline.decomposition.native.edit.perPageMs}·pages`,
  );
for (const problem of problems) console.log(`problem: ${problem}`);
