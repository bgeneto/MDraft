// Measure the LaTeX live preview in the running application (Phase 0 of
// docs/plans/2026-11-12-latex-compile-cost.md).
//
//   node scripts/latex-performance-test.mjs <port>
//
// One fixture per launch: the harness opens the fixture as the launch document
// and selects it with MDRAFT_LATEX_PERF_FIXTURE (small, preamble, huge, book,
// book-flat). MDRAFT_LATEX_PERF_MODE=starvation runs the scripted-typing
// scenario instead of the timing matrix. MDRAFT_LATEX_PERF_RUNS sets the
// measured edits per scenario (default 5), MDRAFT_LATEX_PERF_OUT a directory to
// write the run JSON to; the same JSON is always printed on one
// `LATEX_PERF_JSON` line so a captured log is enough evidence.
//
// Every wait belongs to a named stage with its own timeout. A failure prints
// the stage, the preview state and the engine status and exits 1: a benchmark
// that was asked for and could not measure must not look like a pass. This is
// what the first version got wrong; see the trap record.
//
// Each edit replaces the character before "erformance probe paragraph <ID>"
// with a letter not used before in this scenario, so the content is always new
// and `latexStore` cannot serve the compile. A run that reports `stored` is
// still rejected.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { hostname, release } from "node:os";
import { join, relative } from "node:path";
import { openPage, sleep } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";
const root = process.cwd();
const fixtureName = process.env.MDRAFT_LATEX_PERF_FIXTURE ?? "small";
const mode = process.env.MDRAFT_LATEX_PERF_MODE ?? "matrix";
/**
 * Which preview backend is measured.
 *
 * `wasmtex` (the default) measures a full compile to PDF.js. `texpresso` keeps
 * the frame on screen and measures the frame's own edit-to-paint, while the
 * WasmTex compile still runs, at idle, as the shadow that export reads. The
 * comparison the plan requires runs both against the same fixtures.
 */
const backend = process.env.MDRAFT_LATEX_PERF_BACKEND === "texpresso" ? "texpresso" : "wasmtex";
const runs = Math.max(1, Number.parseInt(process.env.MDRAFT_LATEX_PERF_RUNS ?? "5", 10) || 5);
const outDir = process.env.MDRAFT_LATEX_PERF_OUT ?? null;
const base = join(root, "samples", "latex-perf");

const chapterScenarios = (dir, prefix) => [
  { id: "M0", file: `${dir}/main.tex`, position: 0 },
  { id: `${prefix}01`, file: `${dir}/chapters/ch01.tex`, position: 1 / 13 },
  { id: `${prefix}06`, file: `${dir}/chapters/ch06.tex`, position: 6 / 13 },
  { id: `${prefix}12`, file: `${dir}/chapters/ch12.tex`, position: 12 / 13 },
];
const FIXTURES = {
  small: {
    doc: "small.tex",
    hash: ["small.tex"],
    scenarios: [{ id: "S1", file: "small.tex", position: 0.1 }],
  },
  tikz: {
    doc: "tikz.tex",
    hash: ["tikz.tex"],
    scenarios: [{ id: "T1", file: "tikz.tex", position: 0.05 }],
  },
  // The same document with the SDK's per-document switch to externalization
  // "auto" (stage 6.1): one binary measures both sides of the decision.
  "tikz-auto": {
    doc: "tikz-auto.tex",
    hash: ["tikz-auto.tex"],
    scenarios: [{ id: "T1", file: "tikz-auto.tex", position: 0.05 }],
  },
  preamble: {
    doc: "preamble.tex",
    hash: ["preamble.tex"],
    scenarios: [{ id: "P1", file: "preamble.tex", position: 0 }],
  },
  huge: { doc: "huge/main.tex", hash: ["huge"], scenarios: chapterScenarios("huge", "C") },
  book: { doc: "book/main.tex", hash: ["book"], scenarios: chapterScenarios("book", "B") },
  "book-flat": {
    doc: "book-flat/main.tex",
    hash: ["book-flat"],
    scenarios: [
      { id: "M0", file: "book-flat/main.tex", position: 0 },
      { id: "F01", file: "book-flat/main.tex", position: 1 / 13 },
      { id: "F06", file: "book-flat/main.tex", position: 6 / 13 },
      { id: "F12", file: "book-flat/main.tex", position: 12 / 13 },
    ],
  },
  // The smallest LaTeX document in the repository: no probe paragraph, so the
  // edit lands at the end of the document (see `edit`). It is the fixture the
  // engine-choice layers share.
  plain: {
    doc: "../latex-engines/plain.tex",
    hash: ["../latex-engines/plain.tex"],
    needle: "\\documentclass",
    // No "performance probe paragraph" marker, so WasmTex cannot locate the
    // painted page; E2P is unavailable by design and E2C is still measured.
    noPaint: true,
    scenarios: [{ id: "P1", file: "../latex-engines/plain.tex", position: 0.5 }],
  },
};
const fixture = FIXTURES[fixtureName];
if (!fixture) {
  console.log(`FAIL unknown fixture ${fixtureName}; known: ${Object.keys(FIXTURES).join(", ")}`);
  process.exit(1);
}

const startedAt = Date.now();
const log = (message) =>
  console.log(`  [${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
let stage = "connect";
const page = await openPage(port);
const consoleErrors = [];
page.onException((text) => consoleErrors.push(text.split("\n")[0]));
page.onConsole((level, text) => {
  if (level === "error") consoleErrors.push(text);
});
const evaluate = (expression) => page.evaluate(expression);
const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then(JSON.stringify)`,
  ).then((text) => JSON.parse(text));

async function waitFor(expression, timeout, label) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(
    `timed out after ${Math.round(timeout / 1000)}s waiting for ${label}${lastError ? ` (${lastError.message})` : ""}`,
  );
}

async function diagnostics() {
  const safe = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      return `unavailable: ${error.message}`;
    }
  };
  return {
    stage,
    latexStatus: await safe(() => invoke("latex_status")),
    engine: await safe(() => invoke("latex_engine_status")),
    preview: await safe(() =>
      evaluate(`JSON.stringify({
        token: document.querySelector("#preview")?.dataset.latexCurrent ?? null,
        status: document.querySelector(".compiled-status, .latex-build-status")?.textContent?.trim() ?? null,
        note: document.querySelector(".typst-note-text")?.textContent?.trim() ?? null,
        pages: document.querySelectorAll(".typst-page").length
      })`).then(JSON.parse),
    ),
    consoleErrors: consoleErrors.slice(-5),
  };
}

async function fail(error) {
  console.log(`FAIL [${stage}] ${error.message}`);
  console.log(JSON.stringify(await diagnostics(), null, 2));
  page.close();
  process.exit(1);
}

const previewToken = () =>
  evaluate(`Number(document.querySelector("#preview")?.dataset.latexCurrent ?? 0)`);
const busy = () =>
  evaluate(`(document.querySelector(".compiled-compile")?.textContent ?? "Compile") !== "Compile"`);

/** Wait for a commit newer than `before`, then for the pane to go idle. */
async function waitCommit(before, timeout, label) {
  await waitFor(
    `Number(document.querySelector("#preview")?.dataset.latexCurrent ?? 0) > ${before}`,
    timeout,
    label,
  );
  await waitFor(
    `(document.querySelector(".compiled-compile")?.textContent ?? "Compile") === "Compile"`,
    timeout,
    `${label} to finish`,
  );
  return previewToken();
}

/**
 * Working set of the application's process tree (the app plus its WebView2
 * children), in bytes.
 *
 * PowerShell only lists the processes; the tree walk is here. The first probe
 * walked the tree in PowerShell and hung forever: `$next += (...).ProcessId`
 * appends `$null` for a leaf, so the frontier never empties. A timeout makes
 * any future sampler failure a missing number instead of a stalled benchmark.
 */
function rssTree(pid) {
  if (process.platform !== "win32" || !pid) return null;
  try {
    const rows = JSON.parse(
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] },
      ),
    );
    const children = new Map();
    for (const row of rows) {
      const list = children.get(row.ParentProcessId) ?? [];
      list.push(row);
      children.set(row.ParentProcessId, list);
    }
    const self = rows.find((row) => row.ProcessId === pid);
    if (!self) return null;
    let sum = 0;
    const seen = new Set();
    const stack = [self];
    while (stack.length) {
      const row = stack.pop();
      if (seen.has(row.ProcessId)) continue;
      seen.add(row.ProcessId);
      sum += Number(row.WorkingSetSize) || 0;
      stack.push(...(children.get(row.ProcessId) ?? []));
    }
    return sum;
  } catch {
    return null;
  }
}
const pid = Number(process.env.MDRAFT_TEST_PID ?? 0) || null;

function fixtureHash() {
  const hash = createHash("sha256");
  const visit = (path) => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    hash.update(relative(base, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(path));
  };
  for (const entry of fixture.hash) visit(join(base, entry));
  return hash.digest("hex");
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};

// ---------------------------------------------------------------------------

async function main() {
  try {
    stage = "editor";
    await waitFor('!!document.querySelector(".cm-content")', 30_000, "the editor");
    await evaluate(`(() => {
    const probe = (window.__latexPerfProbe = { long: [], renders: 0, commits: [] });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) probe.long.push([entry.startTime, entry.duration]);
      }).observe({ type: "longtask" });
    } catch {}
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "mdraft:latex:render-start") probe.renders += 1;
        if (entry.name === "mdraft:latex:commit") probe.commits.push(entry.startTime);
      }
    }).observe({ type: "mark" });
    return true;
  })()`);

    stage = "settings";
    const settings = await invoke("get_settings");
    if (settings.latexAutoCompile === false) throw new Error("latexAutoCompile is off");
    if (settings.viewMode === "source") {
      await evaluate(
        `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"menu",payload:"view.split"})`,
      );
      await sleep(500);
    }

    stage = "engine";
    if ((await invoke("latex_status")) !== true) {
      log("enabling the bundled engine in Preferences");
      await evaluate(`(async () => {
      const open = document.getElementById("btn-prefs");
      open?.click();
      await new Promise((r) => setTimeout(r, 500));
      [...document.querySelectorAll(".prefs-section")]
        .find((node) => node.textContent.trim() === "LaTeX")?.click();
      await new Promise((r) => setTimeout(r, 400));
      const row = [...document.querySelectorAll(".prefs-row")].find((node) =>
        /Enable bundled TeX/i.test(node.querySelector(".prefs-label")?.textContent ?? ""));
      const box = row?.querySelector("input[type=checkbox]");
      if (box && !box.checked) box.click();
      await new Promise((r) => setTimeout(r, 1500));
      open?.click();
    })()`);
      await sleep(1000);
    }
    if ((await invoke("latex_status")) !== true) {
      const engine = await invoke("latex_engine_status");
      if (engine.bundledEnabled && !engine.bundledInstalled) {
        // The installed files are missing or belong to another engine year. The
        // preview's own Retry setup is the reader's route to the active year.
        log(
          "engine files missing or out of date: pressing Retry setup (downloads the active year)",
        );
        stage = "engine-install";
        await waitFor(
          `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Retry setup")`,
          30_000,
          "the Retry setup button",
        );
        await evaluate(
          `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Retry setup").click()`,
        );
        const deadline = Date.now() + 900_000;
        while (Date.now() < deadline && (await invoke("latex_status")) !== true) {
          await sleep(5000);
          log(`installing: ${(await diagnostics()).preview?.note ?? "…"}`);
        }
      }
    }
    if ((await invoke("latex_status")) !== true)
      throw new Error("the bundled engine is not available");

    if (backend === "texpresso") {
      stage = "backend";
      log("switching the preview to TeXpresso");
      await evaluate(
        `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"menu",payload:"view.latexBackend.texpresso"})`,
      );
      await waitFor(
        `document.querySelector("#preview")?.dataset.texpressoReady === "1"`,
        180_000,
        "the TeXpresso frame",
      );
      const ready = await evaluate(
        `JSON.stringify({ chip: document.getElementById("status-latex-engine")?.textContent,
           backend: document.getElementById("status-latex-engine")?.dataset.previewBackend })`,
      ).then(JSON.parse);
      if (ready.backend !== "texpresso")
        throw new Error(`the chip did not accept TeXpresso: ${JSON.stringify(ready)}`);
      log(`TeXpresso ready (chip: ${ready.chip})`);
    }

    stage = "cold-compile";
    const coldSince = Date.now();
    let token = await previewToken();
    if (backend === "texpresso") {
      // The frame's first paint is the cold measure: the engine has just booted
      // and typeset the whole project. The shadow compile follows at idle.
      await waitFor(
        `document.querySelector("#preview")?.dataset.texpressoPainted ?? ""`,
        900_000,
        "the frame's first paint",
      );
      token = Number(
        (await evaluate(`document.querySelector("#preview")?.dataset.texpressoPainted ?? "0"`)) ||
          0,
      );
      log(`TeXpresso cold paint (paint ${token}, ${Date.now() - coldSince} ms)`);
    } else if (token === 0) {
      await sleep(3000);
      if ((await previewToken()) === 0 && !(await busy())) {
        log("no compile started on its own: sending Compile");
        await evaluate(
          `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"menu",payload:"view.latexCompile"})`,
        );
      }
      token = await waitCommit(0, 900_000, "the first compile");
    }
    const coldPhases = await evaluate(`JSON.stringify(performance.getEntriesByType("mark")
    .filter((e) => e.name === "mdraft:latex:phase").map((e) => e.detail?.message))`).then(
      JSON.parse,
    );
    const cold = await readRun(null);
    cold.wallMs = Date.now() - coldSince;
    cold.network = coldPhases.some((message) => /download/i.test(message ?? ""));
    log(
      `cold compile committed (token ${token}, render ${Math.round(cold.renderMs ?? -1)} ms${cold.network ? ", downloaded packages" : ""})`,
    );

    const environment = {
      fixture: fixtureName,
      mode,
      backend,
      host: hostname(),
      os: release(),
      commit: (() => {
        try {
          return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: root }).trim();
        } catch {
          return null;
        }
      })(),
      dirty: (() => {
        try {
          return (
            execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", cwd: root }).trim()
              .length > 0
          );
        } catch {
          return null;
        }
      })(),
      binarySha256: (() => {
        try {
          return process.env.MDRAFT_EXE
            ? createHash("sha256").update(readFileSync(process.env.MDRAFT_EXE)).digest("hex")
            : null;
        } catch {
          return null;
        }
      })(),
      engineYear: JSON.parse(readFileSync(join(root, "src-tauri", "latex-engine.json"), "utf8"))
        .active,
      mirror: await invoke("latex_cache_info").catch(() => null),
      fixtureSha256: fixtureHash(),
      settings: { viewMode: settings.viewMode, latexAutoCompile: settings.latexAutoCompile },
      devicePixelRatio: await evaluate("window.devicePixelRatio"),
      visibility: await evaluate("document.visibilityState"),
    };
    const rss = { afterCold: rssTree(pid) };

    const result =
      mode === "starvation"
        ? await starvation(fixture.scenarios[0])
        : mode === "profile"
          ? await profileEdit(fixture.scenarios[Math.min(2, fixture.scenarios.length - 1)])
          : mode === "soak"
            ? await soak(fixture.scenarios[Math.min(2, fixture.scenarios.length - 1)])
            : mode === "differential"
              ? await differential()
              : backend === "texpresso"
                ? { ...(await texpressoMatrix()), fidelity: await texpressoFidelity() }
                : await matrix();
    rss.afterRuns = rssTree(pid);
    const output = { schema: 1, ...environment, cold, rss, ...result, consoleErrors };
    const line = JSON.stringify(output);
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      const file = join(
        outDir,
        `${fixtureName}-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
      writeFileSync(file, JSON.stringify(output, null, 2));
      log(`wrote ${file}`);
    }
    console.log(`LATEX_PERF_JSON ${line}`);
    page.close();
    process.exit(result.valid === false ? 1 : 0);
  } catch (error) {
    await fail(error);
  }
}

// ---------------------------------------------------------------------------

/** Read the marks of the render that just committed, relative to `editAt`. */
async function readRun(editAt) {
  const raw = await evaluate(`JSON.stringify({
    marks: performance.getEntriesByType("mark")
      .filter((e) => e.name.startsWith("mdraft:latex:"))
      .map((e) => ({ name: e.name.slice(13), at: e.startTime, detail: e.detail ?? null })),
    measures: performance.getEntriesByType("measure")
      .filter((e) => e.name.startsWith("mdraft:latex:"))
      .map((e) => ({ name: e.name.slice(13), ms: e.duration, detail: e.detail ?? null })),
    dataMs: Number(document.querySelector("#preview")?.dataset.latexMs ?? "NaN"),
    texpressoPages: Number(document.querySelector("#preview")?.dataset.texpressoPages ?? "NaN"),
    pages: document.querySelectorAll(".typst-page").length
  })`);
  const { marks, measures, dataMs, pages, texpressoPages } = JSON.parse(raw);
  const mark = (name) => marks.find((m) => m.name === name) ?? null;
  const measure = (name) => measures.find((m) => m.name === name) ?? null;
  const renderStart = mark("render-start")?.at ?? null;
  const commit = mark("commit")?.at ?? null;
  return {
    tDelay: editAt === null || renderStart === null ? null : renderStart - editAt,
    e2c: editAt === null || commit === null ? null : commit - editAt,
    renderMs: measure("render")?.ms ?? null,
    engineStatusMs: measure("engine-status")?.ms ?? null,
    snapshotIpcMs: measure("snapshot-ipc")?.ms ?? null,
    snapshotDecodeMs: measure("snapshot-decode")?.ms ?? null,
    moduleMs: measure("module")?.ms ?? null,
    initMs: measure("init")?.ms ?? null,
    compileMs: measure("compile")?.ms ?? null,
    compileCallMs: measure("compile-call")?.ms ?? null,
    postMs: measure("post")?.ms ?? null,
    viewMs: measure("pdf")?.ms ?? null,
    stored: Boolean(measure("compile-call")?.detail?.stored),
    banners: measure("compile")?.detail?.banners ?? null,
    tikz: measure("compile")?.detail?.tikz ?? null,
    phase: measure("compile")?.detail?.phase ?? null,
    checkpoints: measure("compile")?.detail?.checkpoints ?? null,
    sdkCompileTime: measure("compile")?.detail?.compileTime ?? null,
    decodedBytes: measure("snapshot-decode")?.detail?.bytes ?? null,
    files: measure("snapshot-ipc")?.detail?.files ?? null,
    dataMs,
    pages: backend === "texpresso" && Number.isFinite(texpressoPages) ? texpressoPages : pages,
    paints: marks
      .filter((m) => m.name === "paint")
      .map((m) => ({ page: m.detail?.page, at: m.at })),
    commitAt: commit,
  };
}

/** The 1-based page whose text layer contains the scenario marker, or null. */
function markerPage(id) {
  return evaluate(`(() => {
    const needle = ${JSON.stringify(`erformance probe paragraph ${id}`)};
    const pages = [...document.querySelectorAll(".typst-page")];
    const index = pages.findIndex((p) =>
      (p.querySelector(".textLayer")?.textContent ?? "").replace(/\\s+/g, " ").includes(needle));
    return index < 0 ? null : index + 1;
  })()`);
}

async function revealMarker(id) {
  return evaluate(`(() => {
    const needle = ${JSON.stringify(`erformance probe paragraph ${id}`)};
    const pages = [...document.querySelectorAll(".typst-page")];
    const hit = pages.find((p) =>
      (p.querySelector(".textLayer")?.textContent ?? "").replace(/\\s+/g, " ").includes(needle));
    if (!hit) return false;
    hit.scrollIntoView({ block: "center" });
    return true;
  })()`);
}

async function openScenarioFile(scenario) {
  const path = join(base, scenario.file);
  const needle = fixture.needle ?? `erformance probe paragraph ${scenario.id}`;
  const already = await evaluate(
    `document.querySelector(".cm-content")?.cmTile?.root?.view?.state.doc.toString().includes(${JSON.stringify(needle)}) ?? false`,
  );
  if (already) return;
  stage = `open ${scenario.file}`;
  const before = await previewToken();
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"open-files",payload:${JSON.stringify([path])}})`,
  );
  await waitFor(
    `document.querySelector(".cm-content")?.cmTile?.root?.view?.state.doc.toString().includes(${JSON.stringify(needle)}) ?? false`,
    30_000,
    `the editor to show ${scenario.file}`,
  );
  // Opening a tab may recompile (the project root stays pinned). Let it finish
  // so the first measured edit does not overlap it.
  await sleep(1500);
  if ((await busy()) || (await previewToken()) !== before) {
    await waitFor(
      `(document.querySelector(".compiled-compile")?.textContent ?? "Compile") === "Compile"`,
      600_000,
      "the tab-switch compile",
    );
  }
}

const LETTERS = "ABCDEFGHIJKLMNOQRSTUVWXYZ";
const used = new Map();
/** Replace the slot before the marker with a letter this scenario has not used. */
async function edit(scenario, tag) {
  const count = used.get(scenario.id) ?? 0;
  used.set(scenario.id, count + 1);
  if (count >= LETTERS.length) throw new Error(`scenario ${scenario.id} ran out of fresh letters`);
  const letter = LETTERS[count];
  return evaluate(`(() => {
    const view = document.querySelector(".cm-content").cmTile.root.view;
    const text = view.state.doc.toString();
    const marker = ${JSON.stringify("erformance probe paragraph ")} + ${JSON.stringify(scenario.id)};
    const found = text.indexOf(marker);
    // A fixture without a probe paragraph (plain.tex) gets a comment at the end:
    // the edit still changes the document, which is all the probe measures.
    const at = found >= 0 ? found - 1 : text.length;
    if (found < 0 && !${JSON.stringify(fixtureName)}.includes("plain")) return { error: "marker not found" };
    for (const entry of performance.getEntriesByName("perf:edit")) performance.clearMarks("perf:edit");
    window.__latexPerfProbe.long = [];
    const mark = performance.mark("perf:edit", { detail: ${JSON.stringify({ scenario: scenario.id, tag })} });
    // The caret ends after the typed letter, as when a reader types: the
    // engine places its heap checkpoint at the caret (stage 3.3), so a probe
    // that left the caret at the top measured checkpoints in the wrong place.
    view.dispatch({
      changes:
        found >= 0
          ? { from: at, to: at + 1, insert: ${JSON.stringify(letter)} }
          : { from: at, insert: "\\n% " + ${JSON.stringify(tag)} + " " + ${JSON.stringify(letter)} + "\\n" },
      selection: { anchor: at + 1 },
    });
    return { at: mark.startTime };
  })()`);
}

async function measuredEdit(scenario, tag) {
  stage = `${scenario.id} ${tag}`;
  await revealMarker(scenario.id);
  await sleep(300);
  const before = await previewToken();
  const edited = await edit(scenario, tag);
  if (edited.error) throw new Error(edited.error);
  await waitCommit(before, 600_000, `the ${scenario.id} ${tag} compile`);
  const pageNumber = await markerPage(scenario.id);
  // The page with the edit paints once the new view is on screen. Give it a
  // bounded moment; no paint means the window is not rendering (hidden or
  // occluded) or the reading position moved, and E2P is then unknown.
  const deadline = Date.now() + 5000;
  let run = await readRun(edited.at);
  while (
    Date.now() < deadline &&
    !run.paints.some((p) => p.page === pageNumber && p.at > edited.at)
  ) {
    await sleep(100);
    run = await readRun(edited.at);
  }
  const paint = run.paints.find((p) => p.page === pageNumber && p.at > edited.at);
  const long = await evaluate("JSON.stringify(window.__latexPerfProbe.long)").then(JSON.parse);
  return {
    scenario: scenario.id,
    position: scenario.position,
    tag,
    ...run,
    markerPage: pageNumber,
    e2p: paint ? paint.at - edited.at : null,
    longTasks: long.length,
    longTaskMs: long.reduce((sum, [, duration]) => sum + duration, 0),
    paints: undefined,
  };
}

/**
 * The TeXpresso matrix: the same fixtures and edits, measured on the frame.
 *
 * WasmTex's E2P is the page paint after a full compile; TeXpresso's is its own
 * `data-texpresso-e2p`, which the host starts when the edit leaves the editor
 * and stops at the frame's paint. No compile is waited for: the shadow compile
 * runs separately, at idle, and is measured by `texpressoFidelity`.
 */
async function texpressoMatrix() {
  const rows = [];
  const invalid = [];
  for (const scenario of fixture.scenarios) {
    await openScenarioFile(scenario);
    await waitFor(
      `(() => {
        const frame = document.querySelector(".texpresso-frame");
        if (!frame) return false;
        return true;
      })() && document.querySelector("#preview")?.dataset.texpressoReady === "1"`,
      60_000,
      `the frame to be ready for ${scenario.file}`,
    );
    log(`${scenario.id}: warm-up`);
    await texpressoEdit(scenario, "warm-up");
    for (let run = 1; run <= runs; run += 1) {
      const row = await texpressoEdit(scenario, `run ${run}`);
      const problems = [];
      if (row.e2p === null) problems.push("the frame reported no paint");
      if (row.e2p !== null && row.e2p > 60_000) problems.push("the paint took over a minute");
      row.problems = problems;
      if (problems.length) invalid.push(`${scenario.id} run ${run}: ${problems.join("; ")}`);
      rows.push(row);
      log(
        `${scenario.id} #${run}: E2P ${fmt(row.e2p)}, pages ${row.pages}, shadow ${row.shadowToken}` +
          `${problems.length ? `  INVALID: ${problems.join("; ")}` : ""}`,
      );
    }
  }
  const summary = {};
  for (const scenario of fixture.scenarios) {
    const set = rows.filter((row) => row.scenario === scenario.id);
    const values = set.map((row) => row.e2p).filter(Number.isFinite);
    const sorted = [...values].sort((a, b) => a - b);
    summary[scenario.id] = {
      e2p: median(values),
      p95: sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
        : null,
      samples: values.length,
      pages: set.at(-1)?.pages ?? null,
    };
  }
  console.log(`\n${fixtureName}: ${rows.length} TeXpresso edits, ${invalid.length} invalid`);
  for (const [id, values] of Object.entries(summary))
    console.log(
      `  ${id.padEnd(4)} E2P ${fmt(values.e2p)}  p95 ${fmt(values.p95)}  pages ${values.pages}`,
    );
  return { runs: rows, summary, invalid, valid: invalid.length === 0 };
}

/** One measured edit on the frame. */
async function texpressoEdit(scenario, tag) {
  stage = `${scenario.id} ${tag}`;
  await revealMarker(scenario.id);
  await sleep(300);
  const before = Number(
    (await evaluate(`document.querySelector("#preview")?.dataset.texpressoPainted ?? "0"`)) || 0,
  );
  const edited = await edit(scenario, tag);
  if (edited.error) throw new Error(edited.error);
  await waitFor(
    `Number(document.querySelector("#preview")?.dataset.texpressoPainted ?? "0") > ${before}`,
    120_000,
    `the ${scenario.id} ${tag} paint`,
  );
  return {
    scenario: scenario.id,
    position: scenario.position,
    tag,
    e2p: Number(
      await evaluate(`document.querySelector("#preview")?.dataset.texpressoE2p ?? "NaN"`),
    ),
    pages: Number(
      await evaluate(`document.querySelector("#preview")?.dataset.texpressoPages ?? "0"`),
    ),
    shadowToken: await evaluate(`document.querySelector("#preview")?.dataset.latexShadow ?? null`),
  };
}

/**
 * Fidelity: TeXpresso's own `xdvipdfmx` export against the shadow compile's PDF.
 *
 * The shadow compile is the authority for export, print and Save PDF; its page
 * count and per-page text are compared with the frame's export so a DVI-mode
 * difference is a recorded number, not an assumption.
 */
async function texpressoFidelity() {
  stage = "fidelity";
  await waitFor(
    `document.querySelector("#preview")?.dataset.latexCurrent ?? ""`,
    600_000,
    "the shadow compile",
  );
  // The engine typesets page by page, around what is on screen. Scroll the
  // editor to the end first, so the frame reaches the last page and the export
  // is the whole document rather than the part that happened to be visible.
  await evaluate(`(() => {
    const view = document.querySelector(".cm-content").cmTile.root.view;
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    return true;
  })()`);
  await sleep(1500);
  // Then wait for the page count to stop moving.
  let last = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const pages = Number(
      (await evaluate(`document.querySelector("#preview")?.dataset.texpressoPages ?? "0"`)) || 0,
    );
    if (pages !== last) {
      last = pages;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > 5000) break;
    await sleep(500);
  }
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"menu",payload:"view.latexTexpressoExport"})`,
  );
  await waitFor(
    `Boolean(document.querySelector("#preview")?.dataset.texpressoExport)`,
    180_000,
    "the export comparison",
  );
  const outcome = await evaluate(
    `document.querySelector("#preview")?.dataset.texpressoExport ?? "null"`,
  ).then(JSON.parse);
  log(
    `fidelity: pages ${outcome.pages?.join(" vs ")}, identical text ${outcome.identicalText}, first differing page ${outcome.firstDifferentPage}, export ${outcome.ms} ms`,
  );
  return outcome;
}

async function matrix() {
  const rows = [];
  const invalid = [];
  for (const scenario of fixture.scenarios) {
    await openScenarioFile(scenario);
    log(`${scenario.id}: warm-up`);
    await measuredEdit(scenario, "warm-up");
    for (let run = 1; run <= runs; run += 1) {
      const row = await measuredEdit(scenario, `run ${run}`);
      const problems = [];
      if (row.stored) problems.push("served from latexStore");
      // The scheduler's configured delay is at most 800 ms (the old fixed
      // debounce; adaptive builds use 60-200 ms). Anything well above that means
      // the page's timers were throttled and the run measured the throttling.
      if (row.tDelay !== null && (row.tDelay < 0 || row.tDelay > 1300))
        problems.push(
          `scheduler delay ${Math.round(row.tDelay)} ms exceeds any configured delay (throttled timers?)`,
        );
      // A fixture with no probe paragraph (plain.tex) has no text layer to find
      // the edit in, so its paint cannot be located: report E2C only rather
      // than calling the run invalid.
      if (row.e2p === null && !fixture.noPaint) problems.push("the edited page was not painted");
      row.problems = problems;
      if (problems.length) invalid.push(`${scenario.id} run ${run}: ${problems.join("; ")}`);
      rows.push(row);
      log(
        `${scenario.id} #${run}: E2P ${fmt(row.e2p)}, E2C ${fmt(row.e2c)}, delay ${fmt(row.tDelay)}, init ${fmt(row.initMs)}, compile ${fmt(row.compileMs)}, view ${fmt(row.viewMs)}, pages ${row.pages}, page ${row.markerPage}${row.phase ? `, resume ${row.phase.resume}, restore ${fmt(row.phase.heapRestoreMs)}, tex ${fmt(row.phase.texRunMs)}, post ${fmt(row.phase.postProcessMs)}` : ""}${problems.length ? `  INVALID: ${problems.join("; ")}` : ""}`,
      );
    }
  }
  const summary = {};
  for (const scenario of fixture.scenarios) {
    const set = rows.filter((row) => row.scenario === scenario.id);
    summary[scenario.id] = Object.fromEntries(
      [
        "e2p",
        "e2c",
        "tDelay",
        "renderMs",
        "snapshotIpcMs",
        "snapshotDecodeMs",
        "initMs",
        "compileMs",
        "viewMs",
        "postMs",
      ].map((key) => [key, median(set.map((row) => row[key]))]),
    );
    summary[scenario.id].pages = set.at(-1)?.pages ?? null;
  }
  console.log(`\n${fixtureName}: ${rows.length} measured edits, ${invalid.length} invalid`);
  for (const [id, values] of Object.entries(summary)) {
    console.log(
      `  ${id.padEnd(4)} E2P ${fmt(values.e2p)}  E2C ${fmt(values.e2c)}  init ${fmt(values.initMs)}  compile ${fmt(values.compileMs)}  view ${fmt(values.viewMs)}  pages ${values.pages}`,
    );
  }
  for (const problem of invalid) console.log(`  invalid: ${problem}`);
  return { runs: rows, summary, invalid, valid: invalid.length === 0 };
}

/**
 * Scripted typing: bursts at about 6 keys/s, pauses drawn from 300-1500 ms,
 * for 60 s. Each key rewrites a scratch word to `Rn`, so the last committed PDF
 * shows whether the final revision ever reached the screen.
 */
async function starvation(scenario) {
  stage = "starvation";
  await openScenarioFile(scenario);
  const seedRandom = (() => {
    let state = 0x9e3779b9;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();
  const anchor = `erformance probe paragraph ${scenario.id}.`;
  await evaluate(`(() => {
    const view = document.querySelector(".cm-content").cmTile.root.view;
    const text = view.state.doc.toString();
    const at = text.indexOf(${JSON.stringify(anchor)}) + ${anchor.length};
    view.dispatch({ changes: { from: at, insert: " R0" } });
  })()`);
  const before = await evaluate("window.__latexPerfProbe.commits.length");
  const rendersBefore = await evaluate("window.__latexPerfProbe.renders");
  const begin = Date.now();
  let key = 0;
  let pauses = 0;
  let lastKeyAt = 0;
  while (Date.now() - begin < 60_000) {
    const burst = 3 + Math.floor(seedRandom() * 10);
    for (let i = 0; i < burst; i += 1) {
      key += 1;
      lastKeyAt = await evaluate(`(() => {
        const view = document.querySelector(".cm-content").cmTile.root.view;
        const text = view.state.doc.toString();
        const at = text.indexOf(${JSON.stringify(anchor)}) + ${anchor.length};
        const word = text.slice(at).match(/^ R\\d+/)[0];
        const next = " R${key}";
        view.dispatch({
          changes: { from: at, to: at + word.length, insert: next },
          selection: { anchor: at + next.length },
        });
        return performance.now();
      })()`);
      await sleep(167);
    }
    pauses += 1;
    await sleep(300 + Math.floor(seedRandom() * 1200));
  }
  const typingCommits = (await evaluate("window.__latexPerfProbe.commits.length")) - before;
  const typingRenders = (await evaluate("window.__latexPerfProbe.renders")) - rendersBefore;
  const commitTimes = await evaluate("JSON.stringify(window.__latexPerfProbe.commits)").then(
    JSON.parse,
  );
  const inWindow = commitTimes.slice(before);
  let maxGap = null;
  for (let i = 1; i < inWindow.length; i += 1)
    maxGap = Math.max(maxGap ?? 0, inWindow[i] - inWindow[i - 1]);
  log(
    `typing done: ${key} keys, ${pauses} pauses, ${typingRenders} renders started, ${typingCommits} commits`,
  );
  // Settle: the final word must reach the PDF.
  let settleMs = null;
  try {
    await waitFor(
      `[...document.querySelectorAll(".typst-page .textLayer")].some((t) => /\\bR${key}\\b/.test(t.textContent ?? ""))`,
      300_000,
      "the final revision in the PDF",
    );
    settleMs = (await evaluate("performance.now()")) - lastKeyAt;
  } catch {
    settleMs = null;
  }
  const summary = {
    keys: key,
    pauses,
    rendersStarted: typingRenders,
    commitsWhileTyping: typingCommits,
    maxGapBetweenCommitsMs: maxGap,
    finalRevisionShown: settleMs !== null,
    settleMs,
  };
  console.log(`\nstarvation: ${JSON.stringify(summary)}`);
  // Starvation is a measurement here, not a failure: Phase 0 expects to
  // reproduce it, and 1.1 turns the same numbers into its gate.
  return { starvation: summary, valid: true };
}

/**
 * One CPU-profiled edit (MDRAFT_LATEX_PERF_MODE=profile): where the main
 * thread spends an edit's time, by function self time. Worker time does not
 * appear here; a mostly idle main thread during a long compile means the cost
 * is inside the engine worker.
 */
async function profileEdit(scenario) {
  stage = "profile";
  await openScenarioFile(scenario);
  await measuredEdit(scenario, "warm-up");
  await page.send("Profiler.enable");
  await page.send("Profiler.setSamplingInterval", { interval: 500 });
  await page.send("Profiler.start");
  const row = await measuredEdit(scenario, "profiled");
  // `send` resolves with the whole CDP message; the payload is under `result`.
  const { profile } = (await page.send("Profiler.stop")).result;
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  let total = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const node = nodes.get(profile.samples[index]);
    const ms = (profile.timeDeltas[index] ?? 0) / 1000;
    total += ms;
    const frame = node.callFrame;
    const where = frame.url ? `${frame.url.split("/").pop()}:${frame.lineNumber + 1}` : "";
    const key = `${frame.functionName || "(anonymous)"} ${where}`.trim();
    self.set(key, (self.get(key) ?? 0) + ms);
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  const idle = (self.get("(idle)") ?? 0) + (self.get("(program)") ?? 0);
  console.log(`
profile: ${Math.round(total)} ms sampled, ${Math.round(total - idle)} ms busy on the main thread; E2P ${fmt(row.e2p)}, E2C ${fmt(row.e2c)}, compile ${fmt(row.compileMs)}`);
  for (const [name, ms] of top) console.log(`  ${String(Math.round(ms)).padStart(6)} ms  ${name}`);
  return { profile: { totalMs: total, busyMs: total - idle, top, row }, valid: true };
}

/**
 * Sustained use (MDRAFT_LATEX_PERF_MODE=soak, gate 4.3 of the plan): cycles of
 * scripted typing for MDRAFT_LATEX_SOAK_MINUTES (default 60). Each cycle types
 * bursts for about 40 s, then waits for its final revision to reach the PDF and
 * samples the process tree, the page's JS heap, commits and engine sessions.
 * Reports the memory slope over the second half, settle-time drift and every
 * cycle whose final revision never appeared (an unrecovered failure).
 */
async function soak(scenario) {
  stage = "soak";
  await openScenarioFile(scenario);
  const minutes = Number(process.env.MDRAFT_LATEX_SOAK_MINUTES ?? 60);
  const until = Date.now() + minutes * 60_000;
  const anchor = `erformance probe paragraph ${scenario.id}.`;
  await evaluate(`(() => {
    const view = document.querySelector(".cm-content").cmTile.root.view;
    const text = view.state.doc.toString();
    const at = text.indexOf(${JSON.stringify(anchor)}) + ${anchor.length};
    view.dispatch({ changes: { from: at, insert: " R0" }, selection: { anchor: at + 3 } });
    window.__latexSessions = new Set();
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "mdraft:latex:init" && entry.detail?.session)
          window.__latexSessions.add(entry.detail.session);
      }
    }).observe({ type: "measure" });
  })()`);
  let key = 0;
  let state = 0x2545f491;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const samples = [];
  const failures = [];
  const started = Date.now();
  while (Date.now() < until) {
    const cycleEnd = Date.now() + 40_000;
    let lastKeyAt = 0;
    while (Date.now() < cycleEnd) {
      const burst = 3 + Math.floor(random() * 10);
      for (let i = 0; i < burst; i += 1) {
        key += 1;
        lastKeyAt = await evaluate(`(() => {
          const view = document.querySelector(".cm-content").cmTile.root.view;
          const text = view.state.doc.toString();
          const at = text.indexOf(${JSON.stringify(anchor)}) + ${anchor.length};
          const word = text.slice(at).match(/^ R\\d+/)[0];
          const next = " R${key}";
          view.dispatch({ changes: { from: at, to: at + word.length, insert: next }, selection: { anchor: at + next.length } });
          return performance.now();
        })()`);
        await sleep(167);
      }
      await sleep(300 + Math.floor(random() * 1200));
    }
    let settleMs = null;
    try {
      await waitFor(
        `[...document.querySelectorAll(".typst-page .textLayer")].some((t) => /\\bR${key}\\b/.test(t.textContent ?? ""))`,
        60_000,
        "the cycle's final revision",
      );
      settleMs = (await evaluate("performance.now()")) - lastKeyAt;
    } catch {
      failures.push({ minute: (Date.now() - started) / 60_000, key });
    }
    const page = await evaluate(`JSON.stringify({
      heap: performance.memory ? performance.memory.usedJSHeapSize : null,
      commits: window.__latexPerfProbe.commits.length,
      sessions: window.__latexSessions.size
    })`).then(JSON.parse);
    const sample = {
      minute: (Date.now() - started) / 60_000,
      rssMb: (rssTree(pid) ?? NaN) / 1048576,
      heapMb: page.heap === null ? null : page.heap / 1048576,
      commits: page.commits,
      sessions: page.sessions,
      settleMs,
      keys: key,
    };
    samples.push(sample);
    log(
      `soak ${sample.minute.toFixed(1)} min: rss ${Math.round(sample.rssMb)} MB, heap ${sample.heapMb === null ? "n/a" : Math.round(sample.heapMb)} MB, commits ${sample.commits}, sessions ${sample.sessions}, settle ${fmt(settleMs)}`,
    );
  }
  const half = samples.slice(Math.floor(samples.length / 2));
  const slope = (rows, field) => {
    const points = rows.filter((row) => Number.isFinite(row[field]));
    if (points.length < 2) return null;
    const n = points.length;
    const sx = points.reduce((s, r) => s + r.minute, 0);
    const sy = points.reduce((s, r) => s + r[field], 0);
    const sxx = points.reduce((s, r) => s + r.minute * r.minute, 0);
    const sxy = points.reduce((s, r) => s + r.minute * r[field], 0);
    return (n * sxy - sx * sy) / (n * sxx - sx * sx);
  };
  const third = Math.max(1, Math.floor(samples.length / 3));
  const summary = {
    minutes,
    cycles: samples.length,
    keys: key,
    failures: failures.length,
    rssSlopeSecondHalfMbPerMin: slope(half, "rssMb"),
    heapSlopeSecondHalfMbPerMin: slope(half, "heapMb"),
    settleFirstThird: median(samples.slice(0, third).map((s) => s.settleMs)),
    settleLastThird: median(samples.slice(-third).map((s) => s.settleMs)),
    engineSessions: samples.at(-1)?.sessions ?? null,
  };
  console.log(`\nsoak: ${JSON.stringify(summary)}`);
  return { soak: { summary, samples, failures }, valid: failures.length === 0 };
}

/**
 * Differential verification (MDRAFT_LATEX_PERF_MODE=differential, stage 3.4):
 * seeded random edits across the fixture's files (letter swaps, inserted
 * sentences with a cross-reference, removals). After each edit settles, the
 * hidden `view.latexReanchor` command compares the warm, checkpoint-resumed
 * result with a fresh full compile, page text by page text. Any difference
 * fails the run and prints the seed and the step that reproduce it.
 */
async function differential() {
  stage = "differential";
  const steps = Number(process.env.MDRAFT_LATEX_DIFF_EDITS ?? 12);
  const seed = Number(process.env.MDRAFT_LATEX_DIFF_SEED ?? 20261112);
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  await evaluate(`(() => {
    window.__latexReanchors = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "mdraft:latex:recycle")
          (window.__latexRecycles ??= []).push(entry.detail ?? null);
        if (entry.name === "mdraft:latex:reanchor" || entry.name === "mdraft:latex:reanchor-skipped")
          window.__latexReanchors.push({ name: entry.name.slice(13), detail: entry.detail ?? null });
      }
    }).observe({ entryTypes: ["mark", "measure"] });
  })()`);
  const inserted = new Map();
  const outcomes = [];
  let recycled = null;
  for (let step = 1; step <= steps; step += 1) {
    // Halfway: swap the engine blue/green (Phase 4.1), then keep editing and
    // comparing, so the recycled engine is verified by the same oracle.
    if (step === Math.ceil(steps / 2) + 1) {
      await evaluate(
        `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"menu",payload:"view.latexRecycle"})`,
      );
      await waitFor("(window.__latexRecycles ?? []).length > 0", 600_000, "the engine recycle");
      recycled = await evaluate("JSON.stringify(window.__latexRecycles.at(-1))").then(JSON.parse);
      log(`engine recycled: ${JSON.stringify(recycled)}`);
    }
    const scenario = fixture.scenarios[Math.floor(random() * fixture.scenarios.length)];
    await openScenarioFile(scenario);
    const anchor = `erformance probe paragraph ${scenario.id}.`;
    const roll = random();
    const count = inserted.get(scenario.id) ?? 0;
    const op = roll < 0.4 ? "letter" : roll < 0.8 || count === 0 ? "insert" : "remove";
    const before = await previewToken();
    const sentence = ` Differential sentence ${step} refers to Equation~\\ref{${scenario.id === "M0" ? "eq:ch01:integral" : `eq:ch${scenario.id.slice(1)}:integral`}}.`;
    const applied = await evaluate(`(() => {
      const view = document.querySelector(".cm-content").cmTile.root.view;
      const text = view.state.doc.toString();
      const at = text.indexOf(${JSON.stringify(anchor)});
      if (at < 0) return "marker not found";
      const end = at + ${anchor.length};
      if (${JSON.stringify(op)} === "letter") {
        const letter = "ABCDEFGHIJKLMNOQRSTUVWXYZ"[Math.floor(${random()} * 25)];
        view.dispatch({ changes: { from: at - 1, to: at, insert: letter }, selection: { anchor: at } });
      } else if (${JSON.stringify(op)} === "insert") {
        const insert = ${JSON.stringify(sentence)};
        view.dispatch({ changes: { from: end, insert }, selection: { anchor: end + insert.length } });
      } else {
        const match = text.slice(end).match(/^ Differential sentence \\d+ refers to Equation~\\\\ref\\{[^}]+\\}\\./);
        if (!match) return "nothing to remove";
        view.dispatch({ changes: { from: end, to: end + match[0].length }, selection: { anchor: end } });
      }
      return "ok";
    })()`);
    if (applied !== "ok") {
      outcomes.push({ step, scenario: scenario.id, op, skipped: applied });
      continue;
    }
    if (op === "insert") inserted.set(scenario.id, count + 1);
    if (op === "remove") inserted.set(scenario.id, count - 1);
    await waitCommit(before, 600_000, `differential step ${step}`);
    // Let the commit settle so the compare sees the current result.
    await sleep(500);
    const seen = await evaluate("window.__latexReanchors.length");
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"menu",payload:"view.latexReanchor"})`,
    );
    await waitFor(
      `window.__latexReanchors.length > ${seen}`,
      600_000,
      `the compare for step ${step}`,
    );
    const outcome = await evaluate(`JSON.stringify(window.__latexReanchors.at(-1))`).then(
      JSON.parse,
    );
    const row = {
      step,
      scenario: scenario.id,
      op,
      result:
        outcome.name === "reanchor" ? (outcome.detail?.equal ? "equal" : "different") : "skipped",
      detail: outcome.detail,
    };
    outcomes.push(row);
    log(
      `differential ${step}/${steps}: ${scenario.id} ${op} → ${row.result}${row.result === "skipped" ? ` (${outcome.detail?.why})` : `, pages ${JSON.stringify(outcome.detail?.pages)}`}`,
    );
    if (row.result === "different") break;
  }
  const different = outcomes.filter((row) => row.result === "different");
  const equal = outcomes.filter((row) => row.result === "equal").length;
  const summary = {
    seed,
    steps,
    equal,
    different: different.length,
    skipped: outcomes.length - equal - different.length,
    recycled: recycled?.swapped ?? null,
  };
  console.log(`\ndifferential: ${JSON.stringify(summary)}`);
  for (const row of different)
    console.log(
      `  DIFFERENT at step ${row.step} (${row.scenario} ${row.op}, seed ${seed}): ${JSON.stringify(row.detail)}`,
    );
  return {
    differential: { summary, outcomes },
    valid: different.length === 0 && equal > 0 && recycled?.swapped === true,
  };
}

function fmt(value) {
  return value === null || value === undefined ? "n/a" : `${Math.round(value)}ms`;
}

await main();
