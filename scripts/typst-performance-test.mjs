#!/usr/bin/env node
/**
 * CDP performance benchmark for MDraft's Typst preview pipeline.
 *
 * Measures End-to-Preview (E2P) latency, phase breakdowns, scheduler starvation,
 * tail-page repaint ratios, temp-file churn (`.mdraft-preview-*`), IPC payload
 * bytes, and optional `mdraft-typst-service` daemon RSS across representative
 * Typst fixtures and preview modes.
 *
 * Usage:
 *   node scripts/typst-performance-test.mjs [port]
 *     [--fixture=all|typ-small|typ-tour|typ-workspace|typ-large-20p|typ-math-heavy]
 *     [--mode=all|pages|document|starvation]
 *     [--matrix=focused|full]
 *     [--warmup=2] [--runs=10] [--burst=24] [--cadence=50]
 *
 * Environment overrides:
 *   MDRAFT_TYPST_PERF_FIXTURE   Fixture selector (default: all)
 *   MDRAFT_TYPST_PERF_MODE      Mode selector (default: all)
 *   MDRAFT_TYPST_PERF_MATRIX    "focused" (default) or "full"
 *
 * Outputs human-readable PASS/FAIL checks and one machine-readable JSON line:
 *   TYPST_PERF_JSON <json>
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPage, sleep } from "./cdp-page.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const PROBE_START = "// MDRAFT_TYPST_PERF_PROBE_BEGIN";
const PROBE_END = "// MDRAFT_TYPST_PERF_PROBE_END";

function parseArgs(argv) {
  let port = "9222";
  const opts = {
    fixture: process.env.MDRAFT_TYPST_PERF_FIXTURE ?? "all",
    mode: process.env.MDRAFT_TYPST_PERF_MODE ?? "all",
    matrix: process.env.MDRAFT_TYPST_PERF_MATRIX ?? "focused",
    warmup: 2,
    runs: 10,
    burst: 24,
    cadenceMs: 50,
    noCleanup: false,
    dryFixtures: false,
  };
  let portSet = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/typst-performance-test.mjs [port] " +
          "[--fixture=all|typ-small|typ-tour|typ-workspace|typ-large-20p|typ-math-heavy] " +
          "[--mode=all|pages|document|starvation] [--warmup=2] [--runs=10]",
      );
      process.exit(0);
    } else if (arg === "--no-cleanup") {
      opts.noCleanup = true;
    } else if (arg === "--dry-fixtures") {
      opts.dryFixtures = true;
    } else if (arg.startsWith("--fixture=")) {
      opts.fixture = arg.slice("--fixture=".length);
    } else if (arg.startsWith("--mode=")) {
      opts.mode = arg.slice("--mode=".length);
    } else if (arg.startsWith("--matrix=")) {
      opts.matrix = arg.slice("--matrix=".length);
    } else if (arg.startsWith("--warmup=")) {
      opts.warmup = Math.max(0, Number(arg.slice("--warmup=".length)) || 2);
    } else if (arg.startsWith("--runs=")) {
      opts.runs = Math.max(1, Number(arg.slice("--runs=".length)) || 10);
    } else if (arg.startsWith("--burst=")) {
      opts.burst = Math.max(4, Number(arg.slice("--burst=".length)) || 24);
    } else if (arg.startsWith("--cadence=")) {
      opts.cadenceMs = Math.max(10, Number(arg.slice("--cadence=".length)) || 50);
    } else if (!arg.startsWith("-") && !portSet) {
      port = arg;
      portSet = true;
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }
  return { port, opts };
}

/**
 * Deterministic 20-page multi-section Typst document with prose, tables,
 * equations, explicit page breaks, and an isolated final-page probe line.
 */
export function generateLarge20PageTypst() {
  const lines = [
    '#set page(paper: "a4", margin: (x: 20mm, y: 20mm))',
    "#set text(size: 10.5pt)",
    "#show heading: set block(below: 0.65em)",
    "",
    "= MDraft Typst 20-Page Benchmark Corpus",
    "",
    "Deterministic 20-page benchmark document exercising headings, `#lorem`, tables, and inline math across isolated pages.",
    "",
  ];
  for (let i = 1; i <= 20; i += 1) {
    lines.push(`== Section ${i}: Incremental Layout Verification`);
    lines.push("");
    lines.push(`#lorem(${110 + (i % 5) * 8})`);
    lines.push("");
    lines.push("#table(");
    lines.push("  columns: 4,");
    lines.push("  [Metric], [Section], [Baseline], [Target],");
    lines.push(`  [Incremental compile], [${i}], [195 ms], [35 ms],`);
    lines.push(`  [Delta PDF splice], [${i}], [120 ms], [20 ms],`);
    lines.push(")");
    lines.push("");
    lines.push(
      `Energy-sum invariant $E_${i} = m c^2 + sum_(k=1)^(${i}) frac(k^2, k + 1)$ for page ${i}.`,
    );
    lines.push("");
    if (i < 20) {
      lines.push("#pagebreak()");
      lines.push("");
    }
  }
  lines.push(PROBE_START);
  lines.push("Tail probe marker: baseline.");
  lines.push(PROBE_END);
  lines.push("");
  return lines.join("\n");
}

/**
 * Deterministic 250-equation Typst math stress fixture covering display math,
 * fractions, integrals, matrices, and user-defined `#let` math helpers.
 */
export function generateMathHeavyTypst() {
  const lines = [
    '#set page(paper: "a4", margin: (x: 18mm, y: 18mm))',
    "#set text(size: 10pt)",
    "#let vnorm(x) = $norm(#x)_2$",
    "",
    "= MDraft Typst 250-Equation Benchmark Corpus",
    "",
  ];
  let eqCount = 0;
  for (let sec = 1; sec <= 10; sec += 1) {
    lines.push(`== Math Section ${sec}`);
    lines.push("");
    for (let k = 1; k <= 25; k += 1) {
      eqCount += 1;
      const n = eqCount;
      const variant = n % 4;
      if (variant === 0) {
        lines.push(
          `$ F_(${n})(x) = integral_0^oo e^(-s t) sum_(j=1)^(${sec + 2}) frac(x^j, j!) dif t $`,
        );
      } else if (variant === 1) {
        lines.push(
          `$ M_(${n}) = mat(1, alpha_${sec}, 0; alpha_${sec}, ${k}, beta_${k}; 0, beta_${k}, ${n}) dot vnorm(v_${k}) $`,
        );
      } else if (variant === 2) {
        lines.push(`$ phi_(${n})(t) = cases(t^2 + ${k} &"if" t >= 0, -t^2 - ${sec} &"if" t < 0) $`);
      } else {
        lines.push(
          `$ lambda_(${n}) = frac(sqrt(${n} + k^2), 1 + product_(r=1)^(${(k % 4) + 1}) (r + alpha_${sec})) $`,
        );
      }
      lines.push("");
    }
  }
  lines.push(PROBE_START);
  lines.push("Tail math probe: $E_0 = m c^2$.");
  lines.push(PROBE_END);
  lines.push("");
  return lines.join("\n");
}

function resolveFixtures(scratchDir) {
  fs.mkdirSync(scratchDir, { recursive: true });
  const largePath = path.join(scratchDir, "typ-large-20p.typ");
  const mathPath = path.join(scratchDir, "typ-math-heavy.typ");
  fs.writeFileSync(largePath, generateLarge20PageTypst(), "utf8");
  fs.writeFileSync(mathPath, generateMathHeavyTypst(), "utf8");

  return {
    "typ-small": {
      id: "typ-small",
      path: path.resolve(REPO_ROOT, "samples", "typst-pages.typ"),
      generated: false,
      expectedSnippet: "A Two-Column Pendulum Paper",
      docFriendly: true,
    },
    "typ-tour": {
      id: "typ-tour",
      path: path.resolve(REPO_ROOT, "samples", "typst-tour.typ"),
      generated: false,
      expectedSnippet: "MDraft — Typst tour",
      docFriendly: true,
    },
    "typ-workspace": {
      id: "typ-workspace",
      path: path.resolve(REPO_ROOT, "samples", "workspace-typst", "chapters", "one.typ"),
      workspaceRoot: path.resolve(REPO_ROOT, "samples", "workspace-typst"),
      generated: false,
      expectedSnippet: "Chapter one",
      docFriendly: false,
    },
    "typ-large-20p": {
      id: "typ-large-20p",
      path: largePath,
      generated: true,
      expectedSnippet: "20-Page Benchmark Corpus",
      docFriendly: false,
    },
    "typ-math-heavy": {
      id: "typ-math-heavy",
      path: mathPath,
      generated: true,
      expectedSnippet: "250-Equation Benchmark Corpus",
      docFriendly: false,
    },
  };
}

function buildScenarioMatrix(fixtures, opts) {
  const validFixtures = Object.keys(fixtures);
  const selectedFixtures =
    opts.fixture === "all"
      ? validFixtures
      : opts.fixture
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

  for (const f of selectedFixtures) {
    if (!fixtures[f]) {
      throw new Error(`Unknown fixture '${f}'. Expected one of: ${validFixtures.join(", ")}, all`);
    }
    if (!fs.existsSync(fixtures[f].path)) {
      throw new Error(`Fixture file missing: ${fixtures[f].path}`);
    }
  }

  const validModes = ["pages", "document", "starvation"];
  const selectedModes =
    opts.mode === "all"
      ? validModes
      : opts.mode
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

  for (const m of selectedModes) {
    if (!validModes.includes(m)) {
      throw new Error(`Unknown mode '${m}'. Expected one of: ${validModes.join(", ")}, all`);
    }
  }

  const scenarios = [];
  if (opts.matrix === "full" || (opts.fixture !== "all" && opts.mode !== "all")) {
    for (const fixtureId of selectedFixtures) {
      for (const mode of selectedModes) {
        scenarios.push({ fixture: fixtures[fixtureId], mode });
      }
    }
    return scenarios;
  }

  // Focused matrix: run Pages across all selected fixtures, Document on
  // docFriendly fixtures (or all explicitly requested), and Starvation on
  // large-20p (or the chosen fixture when narrowed).
  for (const mode of selectedModes) {
    if (mode === "pages") {
      for (const fixtureId of selectedFixtures) {
        scenarios.push({ fixture: fixtures[fixtureId], mode: "pages" });
      }
    } else if (mode === "document") {
      const docTargets =
        opts.fixture === "all"
          ? selectedFixtures.filter((id) => fixtures[id].docFriendly)
          : selectedFixtures;
      for (const fixtureId of docTargets) {
        scenarios.push({ fixture: fixtures[fixtureId], mode: "document" });
      }
    } else if (mode === "starvation") {
      const starveTargets =
        opts.fixture === "all"
          ? selectedFixtures.includes("typ-large-20p")
            ? ["typ-large-20p"]
            : [selectedFixtures[0]]
          : selectedFixtures;
      for (const fixtureId of starveTargets) {
        scenarios.push({ fixture: fixtures[fixtureId], mode: "starvation" });
      }
    }
  }
  return scenarios;
}

function stats(arr) {
  if (!arr || arr.length === 0) {
    return { count: 0, min: null, median: null, p95: null, max: null, mean: null };
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p95Idx = Math.min(n - 1, Math.max(0, Math.ceil(n * 0.95) - 1));
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const r = (v) => Math.round(v * 100) / 100;
  return {
    count: n,
    min: r(sorted[0]),
    median: r(median),
    p95: r(sorted[p95Idx]),
    max: r(sorted[n - 1]),
    mean: r(sum / n),
  };
}

function medianOrNull(arr) {
  const valid = arr.filter((v) => typeof v === "number" && Number.isFinite(v));
  return valid.length ? stats(valid).median : null;
}

function readServiceRssMb() {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'mdraft-typst-service*' } | Measure-Object -Property WorkingSetSize -Sum | Select-Object -ExpandProperty Sum",
        ],
        { encoding: "utf8", timeout: 4000 },
      ).trim();
      if (!out) return null;
      const bytes = Number(out);
      if (!Number.isFinite(bytes) || bytes <= 0) return null;
      return Math.round((bytes / (1024 * 1024)) * 100) / 100;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync("pgrep", ["-f", "mdraft-typst-service"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    if (!out) return null;
    let totalKb = 0;
    for (const pid of out.split(/\s+/)) {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const m = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (m) totalKb += Number(m[1]);
    }
    return totalKb > 0 ? Math.round((totalKb / 1024) * 100) / 100 : null;
  } catch {
    return null;
  }
}

function createTempDirMonitor(dirPath) {
  const seen = new Set();
  let watcher = null;
  let timer = null;
  let active = false;

  const scan = () => {
    try {
      for (const name of fs.readdirSync(dirPath)) {
        if (name.startsWith(".mdraft-preview-")) {
          seen.add(name);
        }
      }
    } catch {
      // Directory might vanish only on cleanup.
    }
  };

  return {
    start() {
      seen.clear();
      active = true;
      scan();
      try {
        watcher = fs.watch(dirPath, (_evt, filename) => {
          if (active && filename && String(filename).startsWith(".mdraft-preview-")) {
            seen.add(String(filename));
          }
        });
      } catch {
        watcher = null;
      }
      timer = setInterval(scan, 15);
    },
    stop() {
      active = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      scan();
      return seen.size;
    },
  };
}

async function installPerfProbe(page) {
  await page.evaluate(`(() => {
    if (window.__mdraftTypstPerfHooked) return true;
    window.__mdraftTypstPerfHooked = true;
    const state = {
      compileSeq: 0,
      invokes: [],
      marks: [],
      seenCanvases: new WeakSet(),
      openFolder: null,
      activeWorkspaceRoot: null,
    };
    window.__mdraftTypstPerfState = state;

    if (typeof PerformanceObserver !== "undefined") {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (
            entry.name.startsWith("mdraft:typst:") ||
            entry.name.startsWith("mdraft:latex:")
          ) {
            state.marks.push({
              name: entry.name,
              startTime: entry.startTime,
              detail: entry.detail ?? null,
            });
            if (state.marks.length > 4000) {
              state.marks.splice(0, state.marks.length - 4000);
            }
          }
        }
      });
      try {
        po.observe({ type: "mark", buffered: false });
      } catch {
        // Older engines ignore buffered option or mark type.
      }
    }

    const origFetch = window.fetch.bind(window);
    window.fetch = async function (input, options) {
      let cmd = null;
      try {
        const rawUrl = typeof input === "string" ? input : input?.url;
        if (rawUrl) {
          const url = new URL(rawUrl, location.href);
          if (url.hostname === "ipc.localhost" || url.protocol === "ipc:") {
            cmd = decodeURIComponent(url.pathname.slice(1));
          }
        }
      } catch {
        cmd = null;
      }
      if (cmd === "plugin:dialog|open" && state.openFolder !== null) {
        return new Response(JSON.stringify(state.openFolder), {
          headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
        });
      }
      const isRender = cmd === "render_typst" || cmd === "render_typst_binary";
      if (!isRender && cmd !== "cancel_typst_preview") {
        return origFetch(input, options);
      }
      const startMs = performance.now();
      let reqBytes = 0;
      const body = options?.body;
      if (typeof body === "string") {
        reqBytes = new TextEncoder().encode(body).length;
      } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        reqBytes = body.byteLength;
      }
      try {
        const response = await origFetch(input, options);
        const clone = response.clone();
        const buf = await clone.arrayBuffer();
        const endMs = performance.now();
        const resBytes = buf.byteLength;
        const tauriStatus = response.headers.get("Tauri-Response") ?? (response.ok ? "ok" : "error");
        let kind = null;
        let backendKind = null;
        let ignoredCount = 0;
        let hasOutput = false;
        let errorMsg = null;
        let cancelled = false;
        if (tauriStatus !== "ok") {
          const text = new TextDecoder().decode(new Uint8Array(buf));
          try {
            const parsed = JSON.parse(text);
            errorMsg = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
          } catch {
            errorMsg = text || ("IPC error status " + response.status);
          }
          cancelled = errorMsg.toLowerCase().includes("cancel");
        } else if (cmd === "render_typst_binary") {
          const bytes = new Uint8Array(buf);
          if (bytes.byteLength >= 4) {
            const metaLen = new DataView(
              bytes.buffer,
              bytes.byteOffset,
              bytes.byteLength,
            ).getUint32(0, false);
            const metaEnd = Math.min(bytes.byteLength, 4 + metaLen);
            const metaJson = new TextDecoder().decode(bytes.subarray(4, metaEnd));
            const meta = JSON.parse(metaJson);
            kind = meta?.kind ?? null;
            backendKind = meta?.backendKind ?? null;
            ignoredCount = Array.isArray(meta?.ignored) ? meta.ignored.length : 0;
            hasOutput = bytes.byteLength > metaEnd || Boolean(meta?.pdf || meta?.html);
          }
        } else if (cmd === "render_typst") {
          const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
          kind = parsed?.kind ?? null;
          backendKind = parsed?.backendKind ?? null;
          ignoredCount = Array.isArray(parsed?.ignored) ? parsed.ignored.length : 0;
          hasOutput = Boolean(parsed?.pdf || parsed?.html);
        }
        if (isRender) {
          state.compileSeq += 1;
        }
        state.invokes.push({
          seq: state.compileSeq,
          cmd,
          startMs,
          endMs,
          wallMs: endMs - startMs,
          reqBytes,
          resBytes,
          totalBytes: reqBytes + resBytes,
          kind,
          backendKind,
          ignoredCount,
          hasOutput,
          cancelled,
          error: errorMsg,
        });
        if (state.invokes.length > 500) {
          state.invokes.splice(0, state.invokes.length - 500);
        }
        return response;
      } catch (err) {
        const endMs = performance.now();
        const msg = String(err?.message ?? err ?? "unknown");
        if (isRender) {
          state.compileSeq += 1;
        }
        state.invokes.push({
          seq: state.compileSeq,
          cmd,
          startMs,
          endMs,
          wallMs: endMs - startMs,
          reqBytes,
          resBytes: 0,
          totalBytes: reqBytes,
          kind: null,
          backendKind: null,
          ignoredCount: 0,
          hasOutput: false,
          cancelled: msg.toLowerCase().includes("cancel"),
          error: msg,
        });
        throw err;
      }
    };
    return true;
  })()`);
}

async function openFixtureAndConfigure(page, fixture, mode) {
  const targetRoot = fixture.workspaceRoot ?? null;
  await page.evaluate(
    `(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const state = window.__mdraftTypstPerfState;
      const targetRoot = ${JSON.stringify(targetRoot)};
      const norm = (value) =>
        value
          ? value.split(String.fromCharCode(92)).join("/").replace(new RegExp("/+$"), "").toLowerCase()
          : null;
      const before = await invoke("get_settings");
      const currentRoot = before?.workspaceFolder ?? null;
      const waitWorkspace = async (wantOpen) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const settings = await invoke("get_settings");
          if (wantOpen ? Boolean(settings?.workspaceFolder) : !settings?.workspaceFolder) {
            return settings;
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        throw new Error(wantOpen ? "Timed out opening Typst workspace folder" : "Timed out closing Typst workspace folder");
      };
      if (targetRoot && norm(currentRoot) !== norm(targetRoot)) {
        state.openFolder = targetRoot;
        try {
          await invoke("plugin:event|emit", { event: "menu", payload: "file.openFolder" });
          const after = await waitWorkspace(true);
          if (after?.sidebarVisible && !before?.sidebarVisible) {
            await invoke("plugin:event|emit", { event: "menu", payload: "view.sidebar" });
            const sidebarDeadline = Date.now() + 2000;
            while (Date.now() < sidebarDeadline) {
              const latest = await invoke("get_settings");
              if (!latest?.sidebarVisible) break;
              await new Promise((resolve) => setTimeout(resolve, 40));
            }
          }
        } finally {
          state.openFolder = null;
        }
      } else if (!targetRoot && currentRoot) {
        await invoke("plugin:event|emit", { event: "menu", payload: "file.closeFolder" });
        await waitWorkspace(false);
      }
      state.activeWorkspaceRoot = targetRoot;
      await invoke("plugin:event|emit", { event: "open-files", payload: [${JSON.stringify(fixture.path)}] });
      await invoke("plugin:event|emit", { event: "menu", payload: "view.split" });
    })()`,
  );

  // Wait until CodeMirror displays the opened fixture content and tab title.
  const expectedFileName = path.basename(fixture.path);
  const deadline = Date.now() + 12000;
  let loaded = false;
  while (Date.now() < deadline) {
    loaded = await page.evaluate(
      `(() => {
        if (!document.title.includes(${JSON.stringify(expectedFileName)})) return false;
        const cm = document.querySelector(".cm-content");
        const view = cm?.cmTile?.root?.view ?? cm?.closest(".cm-editor")?.cmView?.view;
        if (!view) return false;
        return view.state.doc.toString().includes(${JSON.stringify(fixture.expectedSnippet)});
      })()`,
    );
    if (loaded) break;
    await sleep(60);
  }
  if (!loaded) {
    throw new Error(`Timed out opening fixture '${fixture.id}' (${fixture.path})`);
  }

  // Ensure Auto-compile switch is ON and switch to target Typst view mode.
  const menuMode = mode === "document" ? "view.typstDocument" : "view.typstPages";
  await page.evaluate(
    `(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const auto = document.querySelector(".compiled-auto input");
      if (auto && !auto.checked) {
        auto.click();
      }
      await invoke("plugin:event|emit", { event: "menu", payload: ${JSON.stringify(menuMode)} });
    })()`,
  );
  // Allow mode switch / initial compile state transition to enter `busy` before polling.
  await sleep(120);

  // Wait for initial preview settle cleanly (allows startup pre-warmed / cached initial views).
  const settled = await waitForPreviewSettled(page, {
    minCompileSeq: 0,
    requireInvoke: false,
    timeoutMs: 30000,
    expectedMode: mode === "document" ? "document" : "pages",
  });
  return settled;
}

async function waitForPreviewSettled(
  page,
  {
    minCompileSeq,
    minStartMs = 0,
    requireInvoke = minCompileSeq > 0,
    timeoutMs = 25000,
    expectedMode = "pages",
  },
) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    const res = await page.evaluate(
      `(async () => {
        const state = window.__mdraftTypstPerfState;
        const label = document.querySelector(".compiled-state-label")?.textContent?.trim() ?? "";
        const compileBtn = document.querySelector(".compiled-compile");
        const busy = Boolean(compileBtn?.textContent?.trim() === "Stop" || compileBtn?.getAttribute("aria-busy") === "true");
        const seq = state?.compileSeq ?? 0;
        const lastInvoke = [...(state?.invokes ?? [])]
          .reverse()
          .find(
            (x) =>
              (x.cmd === "render_typst" || x.cmd === "render_typst_binary") &&
              x.seq >= ${minCompileSeq} &&
              x.startMs >= ${minStartMs} &&
              (!${JSON.stringify(requireInvoke)} || !x.cancelled),
          );

        if (seq < ${minCompileSeq} || (${JSON.stringify(requireInvoke)} && !lastInvoke) || busy) {
          return { ready: false, seq, label, busy, invokesLen: state?.invokes?.length ?? 0 };
        }
        if (label !== "PDF ready" && label !== "Document ready" && label !== "Failed") {
          return { ready: false, seq, label, busy, invokesLen: state?.invokes?.length ?? 0 };
        }

        const docPane = document.querySelector("#preview .typst-document");
        const pagesRoot = document.querySelector(".typst-preview:not([style*='hidden'])");
        const canvases = pagesRoot ? [...pagesRoot.querySelectorAll(".typst-page canvas")] : [];
        const pageShells = pagesRoot ? pagesRoot.querySelectorAll(".typst-page-shell").length : 0;

        if (${JSON.stringify(expectedMode)} === "pages") {
          if (label !== "PDF ready" && label !== "Failed") {
            return { ready: false, seq, label, busy, reason: "awaiting-pages-mode" };
          }
          if (label === "PDF ready") {
            if (!pagesRoot || (canvases.length === 0 && pageShells === 0)) {
              return { ready: false, seq, label, busy, reason: "missing-pages-root" };
            }
            if (canvases.length > 0 && canvases.every((c) => c.width === 0 || c.height === 0)) {
              return { ready: false, seq, label, busy, reason: "canvas-zero" };
            }
          }
        } else if (label === "Document ready") {
          if (!docPane) {
            return { ready: false, seq, label, busy, reason: "missing-doc-pane" };
          }
        } else if (label === "PDF ready" && !lastInvoke) {
          return { ready: false, seq, label, busy, reason: "awaiting-doc-mode" };
        }

        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const paintNowMs = performance.now();

        let newCanvasCount = 0;
        for (const c of canvases) {
          if (!state.seenCanvases.has(c)) {
            state.seenCanvases.add(c);
            newCanvasCount += 1;
          }
        }

        return {
          ready: true,
          seq,
          label,
          failed: label === "Failed" || Boolean(lastInvoke?.error),
          effectiveKind: docPane && label === "Document ready" ? "document" : (lastInvoke?.kind ?? "pages"),
          paintNowMs,
          pageShells,
          canvasCount: canvases.length,
          newCanvasCount,
          lastInvoke: lastInvoke ?? null,
          docTextLen: docPane ? (docPane.textContent?.length ?? 0) : 0,
        };
      })()`,
    );
    if (res?.ready) return res;
    lastState = res;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for Typst preview settle (>${timeoutMs} ms, seq >= ${minCompileSeq}, mode=${expectedMode}, lastState=${JSON.stringify(lastState)})`,
  );
}

async function prepareProbeBaseline(page) {
  return page.evaluate(`(() => {
    const cm = document.querySelector(".cm-content");
    const view = cm?.cmTile?.root?.view ?? cm?.closest(".cm-editor")?.cmView?.view;
    if (!view) throw new Error("CodeMirror view not found");
    const originalText = view.state.doc.toString();
    return { originalText, docLen: originalText.length };
  })()`);
}

async function applyNonRepeatingEdit(page, originalText, tokenText) {
  return page.evaluate(
    `(() => {
      const state = window.__mdraftTypstPerfState;
      const cm = document.querySelector(".cm-content");
      const view = cm?.cmTile?.root?.view ?? cm?.closest(".cm-editor")?.cmView?.view;
      if (!view) throw new Error("CodeMirror view not found");

      const docText = view.state.doc.toString();
      const startMarker = ${JSON.stringify(PROBE_START)};
      const endMarker = ${JSON.stringify(PROBE_END)};
      const replacementBlock = startMarker + "\\n" + ${JSON.stringify(tokenText)} + "\\n" + endMarker;

      let from = docText.indexOf(startMarker);
      let to = from >= 0 ? docText.indexOf(endMarker, from) : -1;
      let insert = replacementBlock;
      if (from >= 0 && to >= from) {
        to += endMarker.length;
      } else {
        from = docText.length;
        to = docText.length;
        insert = "\\n\\n" + replacementBlock + "\\n";
      }

      const markBaselineIdx = state.marks.length;
      const invokeBaselineIdx = state.invokes.length;
      const targetSeq = state.compileSeq + 1;
      const editDispatchMs = performance.now();

      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        userEvent: "input.type",
        scrollIntoView: true,
      });

      return { editDispatchMs, targetSeq, markBaselineIdx, invokeBaselineIdx };
    })()`,
  );
}

async function restoreEditorText(page, originalText) {
  await page.evaluate(
    `(async () => {
      const cm = document.querySelector(".cm-content");
      const view = cm?.cmTile?.root?.view ?? cm?.closest(".cm-editor")?.cmView?.view;
      if (!view) return;
      const cur = view.state.doc.toString();
      if (cur !== ${JSON.stringify(originalText)}) {
        view.dispatch({
          changes: { from: 0, to: cur.length, insert: ${JSON.stringify(originalText)} },
          userEvent: "input.type",
        });
      }
    })()`,
  );
  await sleep(150);
}

function extractMarksSlice(marks) {
  const byName = new Map();
  const paintedPages = new Set();
  for (const m of marks) {
    if (!byName.has(m.name)) byName.set(m.name, []);
    byName.get(m.name).push(m);
    if (
      (m.name === "mdraft:typst:paint" || m.name === "mdraft:latex:paint") &&
      m.detail &&
      typeof m.detail.page === "number"
    ) {
      paintedPages.add(m.detail.page);
    }
  }
  const spanBetween = (startName, endName) => {
    const s = byName.get(startName);
    const e = byName.get(endName);
    if (!s?.length || !e?.length) return null;
    const diff = e[e.length - 1].startTime - s[0].startTime;
    return diff >= 0 ? Math.round(diff * 100) / 100 : null;
  };
  const numericDetail = (markName, field) => {
    const list = byName.get(markName);
    if (!list?.length) return null;
    const val = list[list.length - 1]?.detail?.[field];
    return typeof val === "number" && Number.isFinite(val) ? val : null;
  };
  return {
    paintedPagesCount: paintedPages.size,
    spliceRepainted: numericDetail("mdraft:typst:splice-hashes", "repainted"),
    spawnOrRpcMs:
      numericDetail("mdraft:typst:compile:end", "spawnOrRpcMs") ??
      spanBetween("mdraft:typst:rpc:start", "mdraft:typst:rpc:end"),
    vfsSyncMs: numericDetail("mdraft:typst:compile:end", "vfsSyncMs"),
    typstCompileMs:
      numericDetail("mdraft:typst:compile:end", "typstCompileMs") ??
      spanBetween("mdraft:typst:compile:start", "mdraft:typst:compile:end"),
    pdfEncodeMs: numericDetail("mdraft:typst:compile:end", "pdfEncodeMs"),
    ipcTransferAndDecodeMs: spanBetween("mdraft:typst:decode:start", "mdraft:typst:decode:end"),
    pdfPaintMs:
      spanBetween("mdraft:typst:paint:start", "mdraft:typst:paint:end") ??
      spanBetween("mdraft:typst:paint", "mdraft:typst:paint:end"),
    sourceMapMs: spanBetween("mdraft:typst:map:start", "mdraft:typst:map:end"),
  };
}

async function runSequentialScenario(page, fixture, mode, opts) {
  const dirMonitor = createTempDirMonitor(path.dirname(fixture.path));
  await openFixtureAndConfigure(page, fixture, mode);
  const { originalText } = await prepareProbeBaseline(page);

  const e2pSamples = [];
  const schedulerWaitSamples = [];
  const compileWallSamples = [];
  const ipcBytesSamples = [];
  const repaintRatios = [];
  const docFallbackSamples = [];
  const spawnOrRpcSamples = [];
  const vfsSyncSamples = [];
  const typstCompileSamples = [];
  const pdfEncodeSamples = [];
  const decodeSamples = [];
  const paintSamples = [];
  const sourceMapSamples = [];

  let totalIterations = opts.warmup + opts.runs;
  let lastPageCount = 0;
  let lastEffectiveKind = mode;
  let lastBackendKind = null;
  let editErrors = 0;

  dirMonitor.start();
  try {
    for (let i = 0; i < totalIterations; i += 1) {
      const isWarmup = i < opts.warmup;
      const token = `Live typst bench probe token #${i}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.`;
      const editInfo = await applyNonRepeatingEdit(page, originalText, token);
      const settled = await waitForPreviewSettled(page, {
        minCompileSeq: editInfo.targetSeq,
        timeoutMs: 30000,
        expectedMode: mode,
      });

      const slice = await page.evaluate(
        `(() => {
          const s = window.__mdraftTypstPerfState;
          return {
            invokes: s.invokes.slice(${editInfo.invokeBaselineIdx}),
            marks: s.marks.slice(${editInfo.markBaselineIdx}),
          };
        })()`,
      );

      if (settled.failed) {
        editErrors += 1;
      }

      if (!isWarmup) {
        const e2p = settled.paintNowMs - editInfo.editDispatchMs;
        e2pSamples.push(e2p);
        const lastRender = [...slice.invokes]
          .reverse()
          .find(
            (inv) =>
              (inv.cmd === "render_typst" || inv.cmd === "render_typst_binary") && !inv.cancelled,
          );
        if (lastRender) {
          schedulerWaitSamples.push(Math.max(0, lastRender.startMs - editInfo.editDispatchMs));
          compileWallSamples.push(lastRender.wallMs);
          ipcBytesSamples.push(lastRender.totalBytes);
          if (lastRender.backendKind) lastBackendKind = lastRender.backendKind;
        }
        const marks = extractMarksSlice(slice.marks);
        const totalPages = settled.pageShells || settled.canvasCount || 0;
        if (totalPages > 0) {
          lastPageCount = totalPages;
          const paintedCount =
            marks.spliceRepainted != null
              ? marks.spliceRepainted
              : marks.paintedPagesCount > 0
                ? marks.paintedPagesCount
                : settled.newCanvasCount;
          repaintRatios.push(Math.min(1, paintedCount / totalPages));
        }
        lastEffectiveKind = settled.effectiveKind;
        if (mode === "document" && settled.effectiveKind !== "document") {
          docFallbackSamples.push(e2p);
        }
        if (marks.spawnOrRpcMs != null) spawnOrRpcSamples.push(marks.spawnOrRpcMs);
        if (marks.vfsSyncMs != null) vfsSyncSamples.push(marks.vfsSyncMs);
        if (marks.typstCompileMs != null) typstCompileSamples.push(marks.typstCompileMs);
        if (marks.pdfEncodeMs != null) pdfEncodeSamples.push(marks.pdfEncodeMs);
        if (marks.ipcTransferAndDecodeMs != null) {
          decodeSamples.push(marks.ipcTransferAndDecodeMs);
        }
        if (marks.pdfPaintMs != null) paintSamples.push(marks.pdfPaintMs);
        if (marks.sourceMapMs != null) sourceMapSamples.push(marks.sourceMapMs);
      }
    }
  } finally {
    var diskTempWritesCount = dirMonitor.stop();
    await restoreEditorText(page, originalText);
  }

  const e2pStats = stats(e2pSamples);
  return {
    fixture: fixture.id,
    mode,
    effectiveKind: lastEffectiveKind,
    backendKind: lastBackendKind,
    warmupRuns: opts.warmup,
    measuredRuns: opts.runs,
    editErrors,
    e2pMedianMs: e2pStats.median,
    e2pP95Ms: e2pStats.p95,
    e2pMinMs: e2pStats.min,
    e2pMaxMs: e2pStats.max,
    schedulerWaitMs: medianOrNull(schedulerWaitSamples),
    compileWallMs: medianOrNull(compileWallSamples),
    spawnOrRpcMs: medianOrNull(spawnOrRpcSamples),
    vfsSyncMs: medianOrNull(vfsSyncSamples),
    typstCompileMs: medianOrNull(typstCompileSamples),
    pdfEncodeMs: medianOrNull(pdfEncodeSamples),
    ipcTransferAndDecodeMs: medianOrNull(decodeSamples),
    pdfPaintMs: medianOrNull(paintSamples),
    sourceMapMs: medianOrNull(sourceMapSamples),
    docModeFallbackMs: medianOrNull(docFallbackSamples),
    pagesRepaintedRatio: medianOrNull(repaintRatios),
    diskTempWritesCount,
    ipcBytesTransferred: medianOrNull(ipcBytesSamples),
    pageCount: lastPageCount,
    serviceRssMb: readServiceRssMb(),
    samplesMs: e2pSamples.map((v) => Math.round(v * 100) / 100),
  };
}

async function runStarvationScenario(page, fixture, opts) {
  const dirMonitor = createTempDirMonitor(path.dirname(fixture.path));
  await openFixtureAndConfigure(page, fixture, "pages");
  const { originalText } = await prepareProbeBaseline(page);

  // Record baseline compile index & marks before burst.
  const baseline = await page.evaluate(`(() => {
    const s = window.__mdraftTypstPerfState;
    return { compileSeq: s.compileSeq, invokeLen: s.invokes.length, markLen: s.marks.length };
  })()`);

  const keystrokes = [];
  dirMonitor.start();
  try {
    for (let i = 0; i < opts.burst; i += 1) {
      const token = `Starvation burst step ${i}/${opts.burst} (${Date.now()})`;
      const editInfo = await applyNonRepeatingEdit(page, originalText, token);
      keystrokes.push({
        index: i,
        tsMs: editInfo.editDispatchMs,
        seqAtDispatch: editInfo.targetSeq - 1,
      });
      await sleep(opts.cadenceMs);
    }
    // Wait for final burst render to finish painting.
    const settled = await waitForPreviewSettled(page, {
      minCompileSeq: baseline.compileSeq + 1,
      minStartMs: keystrokes[keystrokes.length - 1].tsMs - 2,
      timeoutMs: 35000,
      expectedMode: "pages",
    });

    const post = await page.evaluate(
      `(() => {
        const s = window.__mdraftTypstPerfState;
        return {
          invokes: s.invokes.slice(${baseline.invokeLen}),
          marks: s.marks.slice(${baseline.markLen}),
          nowMs: performance.now(),
        };
      })()`,
    );

    const diskTempWritesCount = dirMonitor.stop();
    await restoreEditorText(page, originalText);

    const renderInvokes = post.invokes.filter(
      (inv) => inv.cmd === "render_typst" || inv.cmd === "render_typst_binary",
    );
    const completedPaints = renderInvokes
      .filter((inv) => !inv.cancelled && inv.hasOutput)
      .map((inv) => inv.endMs);
    if (!completedPaints.length) {
      completedPaints.push(settled.paintNowMs);
    }

    // For each buffered keystroke during continuous burst typing, find the
    // first completed paint after that keystroke landed in the editor.
    const ages = keystrokes.map((k) => {
      const covering = completedPaints.find((t) => t >= k.tsMs) ?? settled.paintNowMs;
      return Math.max(0, covering - k.tsMs);
    });
    const ageStats = stats(ages);

    // Longest silent interval without a completed preview paint during the burst window.
    const burstStart = keystrokes[0].tsMs;
    const timeline = [
      burstStart,
      ...completedPaints.filter((t) => t >= burstStart && t <= settled.paintNowMs),
      settled.paintNowMs,
    ];
    timeline.sort((a, b) => a - b);
    let maxGap = 0;
    for (let j = 1; j < timeline.length; j += 1) {
      maxGap = Math.max(maxGap, timeline[j] - timeline[j - 1]);
    }

    const wastedCompilesPerBurst = renderInvokes.filter(
      (inv) => inv.cancelled || (!inv.hasOutput && inv.error),
    ).length;

    return {
      fixture: fixture.id,
      mode: "starvation",
      burstKeystrokes: opts.burst,
      cadenceMs: opts.cadenceMs,
      rendersStarted: renderInvokes.length,
      rendersCompletedWithOutput: renderInvokes.filter((i) => !i.cancelled && i.hasOutput).length,
      wastedCompilesPerBurst,
      keydownAgeP50Ms: ageStats.median,
      keydownAgeP95Ms: ageStats.p95,
      keydownAgeMaxMs: ageStats.max,
      staleCapPaintMs: Math.round(maxGap * 100) / 100,
      diskTempWritesCount,
      ipcBytesTransferred: medianOrNull(renderInvokes.map((i) => i.totalBytes)),
      serviceRssMb: readServiceRssMb(),
    };
  } catch (err) {
    dirMonitor.stop();
    await restoreEditorText(page, originalText).catch(() => {});
    throw err;
  }
}

async function main() {
  const { port, opts } = parseArgs(process.argv.slice(2));
  const scratchDir = path.join(os.tmpdir(), `mdraft-typst-perf-${process.pid}`);
  const fixtures = resolveFixtures(scratchDir);

  if (opts.dryFixtures) {
    console.log(`Generated scratch fixtures in ${scratchDir}`);
    for (const [k, v] of Object.entries(fixtures)) {
      console.log(`  ${k}: ${v.path} (${fs.statSync(v.path).size} bytes)`);
    }
    return;
  }

  const scenarios = buildScenarioMatrix(fixtures, opts);
  let passed = 0;
  let total = 0;
  const check = (ok, label) => {
    total += 1;
    if (ok) {
      passed += 1;
      console.log(`  PASS  ${label}`);
    } else {
      console.log(`  FAIL  ${label}`);
    }
    return ok;
  };

  let page = null;
  const results = [];
  try {
    page = await openPage(port);
    await installPerfProbe(page);

    const status = await page.evaluate(`window.__TAURI_INTERNALS__.invoke("typst_status")`);
    const hasTypst = Boolean(status?.found);
    check(
      hasTypst,
      `Typst compiler detected (${status?.version ?? "missing"} via ${status?.source ?? "none"})`,
    );
    if (!hasTypst) {
      throw new Error(`Typst compiler not found on host: ${status?.hint ?? "unknown"}`);
    }

    for (const sc of scenarios) {
      if (sc.mode === "starvation") {
        const res = await runStarvationScenario(page, sc.fixture, opts);
        results.push(res);
        const ok =
          Number.isFinite(res.keydownAgeP95Ms) &&
          res.rendersCompletedWithOutput >= 1 &&
          Number.isFinite(res.staleCapPaintMs);
        check(
          ok,
          `${res.fixture} [starvation]: keydownAgeP50=${res.keydownAgeP50Ms}ms, ` +
            `p95=${res.keydownAgeP95Ms}ms, staleCap=${res.staleCapPaintMs}ms, ` +
            `wasted=${res.wastedCompilesPerBurst}, tempWrites=${res.diskTempWritesCount}`,
        );
      } else {
        const res = await runSequentialScenario(page, sc.fixture, sc.mode, opts);
        results.push(res);
        const ok =
          res.editErrors === 0 && typeof res.e2pMedianMs === "number" && res.e2pMedianMs > 0;
        check(
          ok,
          `${res.fixture} [${res.mode}->${res.effectiveKind}]: e2pMedian=${res.e2pMedianMs}ms, ` +
            `e2pP95=${res.e2pP95Ms}ms, compileWall=${res.compileWallMs}ms, ` +
            `repaintRatio=${res.pagesRepaintedRatio ?? "n/a"}, tempWrites=${res.diskTempWritesCount}, ` +
            `ipcBytes=${res.ipcBytesTransferred ?? "n/a"}`,
        );
      }
    }

    const summary = {
      timestamp: new Date().toISOString(),
      typstVersion: status?.version ?? null,
      serviceRssMb: readServiceRssMb(),
      scenarios: results,
    };
    const jsonLine = JSON.stringify(summary);
    if (process.env.MDRAFT_TYPST_PERF_OUT) {
      fs.writeFileSync(process.env.MDRAFT_TYPST_PERF_OUT, `${jsonLine}\n`, "utf8");
    }
    console.log(`TYPST_PERF_JSON ${jsonLine}`);
    console.log(`${passed}/${total} checks passed`);
    if (passed !== total) {
      process.exitCode = 1;
    }
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Ignore teardown close errors so original failures surface.
      }
    }
    if (!opts.noCleanup) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`  FAIL  typst-performance-test aborted: ${err?.stack ?? err}`);
    process.exitCode = 1;
  });
}
