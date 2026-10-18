#!/usr/bin/env node
// Run every test layer, in the order AGENTS.md prescribes, doing the setup each
// layer silently depends on.
//
//   npm run test:all
//   node scripts/test-all.mjs --only smoke,syntax --no-build
//   node scripts/test-all.mjs --list
//
// Why this exists: `npm run smoke` on its own fails with a bare
// `connect ECONNREFUSED 127.0.0.1:9222`, because it is a CDP client that expects
// an already-running window showing the right document. Running the layers by
// hand means knowing six things that no single script owns:
//
//   1. the release binary must exist and must be newer than the sources;
//   2. each CDP layer needs its **own** freshly launched instance — a suite that
//      replaced the document broke the next one (see the Traps section);
//   3. that instance needs `--remote-debugging-port` via the WebView2 env var;
//   4. each layer needs its specific fixture document;
//   5. a persisted `settings.json` changes what the UI layers see, so every
//      instance has to start from first-run state;
//   6. nothing may be left running, or the next `npm run dist` fails with
//      "Access is denied" replacing a locked executable.
//
// Two Windows details are handled here rather than repeated by hand:
//
//   * the release binary is **staged outside the workspace** before it runs.
//     Executables launched from inside the workspace run under a file sandbox
//     that cannot write to `%APPDATA%`, so the close test's window-state check
//     fails for a reason that is not the code. Running the staged copy is the
//     workaround AGENTS.md documents, and it makes the result match a real
//     launch.
//   * `TEMP`/`TMP` are pointed at workspace-local directories for cargo, and at
//     the staging directory for the app, so a machine whose temp directory is
//     unusable (a disconnected drive, a sandbox) cannot turn into a compiler
//     error or 13 phantom test failures.
//
// The layers keep their own contracts: each prints `N/M checks passed` and exits
// non-zero on failure. This script only orchestrates, summarises, and cleans up.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const isWindows = process.platform === "win32";

const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
);
const identifier = tauriConfig.identifier;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The instance this run started, so an interrupt can still close it. Leaving one
// behind is what makes the next build fail on a locked executable.
let activeApp = null;

// ---------------------------------------------------------------------------
// The layers, in the order they should run: cheap and independent first, UI
// last. `doc` is the fixture the layer asserts against — the wrong document
// produces a wall of failures that look like regressions.
// ---------------------------------------------------------------------------
const SUITES = [
  {
    id: "rust",
    title: "Rust unit tests",
    kind: "rust",
    detail: "cargo test",
  },
  {
    // The only layer that needs neither the application nor a build: the session
    // store is plain logic, and Node runs the TypeScript module directly.
    id: "sessions",
    title: "Session store (unit)",
    kind: "node",
    script: "sessions-test.mjs",
  },
  {
    // The conversion matrix: pure logic, the same TypeScript modules the editor
    // imports, and no application. Node runs them directly.
    id: "paste-convert",
    title: "Rich paste conversion (unit)",
    kind: "node",
    script: "paste-convert-test.mjs",
  },
  {
    id: "smoke",
    title: "DOM smoke",
    kind: "cdp",
    script: "dom-smoke.mjs",
    doc: "samples/feature-tour.md",
  },
  {
    id: "word-sync",
    title: "Word-level sync",
    kind: "cdp",
    script: "word-sync-test.mjs",
    doc: "samples/word-sync.md",
    writesDoc: true,
  },
  {
    id: "paste",
    title: "Rich paste",
    kind: "cdp",
    script: "rich-paste-test.mjs",
    doc: "samples/feature-tour.md",
  },
  {
    id: "asciidoc",
    title: "AsciiDoc",
    kind: "cdp",
    script: "asciidoc-test.mjs",
    doc: "samples/asciidoc-tour.adoc",
  },
  {
    id: "image-syntax",
    title: "Image syntax in Typst",
    kind: "cdp",
    script: "image-syntax-test.mjs",
    doc: "samples/typst-tour.typ",
  },
  {
    id: "math",
    title: "Math rendering",
    kind: "cdp",
    script: "math-render-check.mjs",
    doc: "docs/samples/physrevb_70_035307.md",
  },
  {
    id: "syntax",
    title: "Syntax highlighting",
    kind: "cdp",
    script: "syntax-theme-test.mjs",
    doc: "samples/feature-tour.md",
  },
  {
    id: "html",
    title: "HTML guest preview",
    kind: "cdp",
    script: "html-preview-test.mjs",
    doc: "samples/html-tour/index.html",
  },
  {
    id: "spellcheck",
    title: "Spelling",
    kind: "cdp",
    script: "spellcheck-test.mjs",
    doc: "samples/feature-tour.md",
  },
  {
    id: "shortcuts",
    title: "Menu accelerators",
    kind: "cdp",
    script: "shortcut-test.mjs",
    doc: "samples/feature-tour.md",
    // This layer watches the document on disk for the Ctrl+S write, so it has to
    // be told which file the instance was given.
    docArg: true,
    writesDoc: true,
  },
  {
    id: "typography",
    title: "Typography",
    kind: "cdp",
    script: "typography-test.mjs",
    doc: "samples/feature-tour.md",
  },
  {
    // The plan's acceptance criteria and the three list-walking paths: the disk
    // poll, Auto Save, and the caret/scroll a tab gets back. Needs its own
    // instance: it opens README.md as the large document and writes temporary
    // files for the poll and Auto Save.
    id: "tabs",
    title: "Document tabs",
    kind: "cdp",
    script: "document-tabs-test.mjs",
    doc: "samples/feature-tour.md",
  },
  {
    id: "licence",
    title: "Font licences",
    kind: "cdp",
    script: "licence-test.mjs",
    doc: "samples/feature-tour.md",
  },
  {
    id: "close",
    title: "Window close",
    kind: "close",
    doc: "samples/feature-tour.md",
    windowsOnly: true,
  },
  // Opt-in: these need something from outside the repository.
  {
    id: "image-path",
    title: "Relative image path paste",
    kind: "cdp",
    script: "image-path-paste-test.mjs",
    doc: "samples/feature-tour.md",
    optIn: true,
    writesDoc: true,
  },
  {
    id: "export",
    title: "Pandoc exports",
    kind: "cdp",
    script: "export-test.mjs",
    doc: "samples/feature-tour.md",
    optIn: true,
    requires: "pandoc",
  },
];

// `scripts/image-paste-test.mjs` is deliberately absent: it needs a fixture
// server plus a URL and a local path, and it exits 0 whatever it measured, so
// including it would only manufacture a green line. `audit-document.mjs` is not
// a test either — it prints metrics for a human to compare.

const CDP_CAPABLE = isWindows;
// WebKitGTK has no CDP endpoint at all (see Traps), so on Linux and macOS the
// automated coverage is `cargo test` plus a manual launch.

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const options = { only: null, skip: new Set(), all: false, build: true, verbose: false, keep: false, kill: false, port: 9222, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--only": options.only = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--skip": for (const id of next().split(",")) options.skip.add(id.trim()); break;
      case "--all": options.all = true; break;
      case "--no-build": options.build = false; break;
      case "--verbose": options.verbose = true; break;
      case "--keep": options.keep = true; break;
      case "--kill": options.kill = true; break;
      case "--port": options.port = Number(next()); break;
      case "--list": options.list = true; break;
      case "--help":
      case "-h": options.help = true; break;
      default:
        fail(`unknown argument: ${arg}\nRun with --list to see the suite ids, or --help for usage.`);
    }
  }
  return options;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const HELP = `
Usage: node scripts/test-all.mjs [options]

  --only <a,b>    run only these suites (ids from --list)
  --skip <a,b>    run everything except these
  --all           include the opt-in suites (image-path, export)
  --no-build      test the binary already in src-tauri/target/release
  --port <n>      first CDP port; each instance gets its own (default 9222)
  --verbose       stream each layer's output instead of capturing it
  --keep          keep the staging directory and the per-suite logs
  --kill          close a running MDraft instead of refusing to start
  --list          print the suites and exit
`.trim();

function selectedSuites(options) {
  const known = new Set(SUITES.map((s) => s.id));
  if (options.only) {
    const unknown = options.only.filter((id) => !known.has(id));
    if (unknown.length) fail(`unknown suite id(s): ${unknown.join(", ")}\nRun with --list.`);
  }
  return SUITES.filter((suite) => {
    if (options.only) return options.only.includes(suite.id);
    if (options.skip.has(suite.id)) return false;
    if (suite.optIn && !options.all) return false;
    return true;
  });
}

function printSuites() {
  const rows = [
    ["id", "kind", "document", "runs"],
    ...SUITES.map((s) => [s.id, s.kind, s.doc ?? "–", s.optIn ? "opt-in" : "default"]),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const row of rows) {
    console.log("  " + row.map((cell, i) => cell.padEnd(widths[i])).join("  "));
  }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

// Runs a program and collects its output. `shell` is only for the .cmd wrappers,
// which cannot be executed directly on Windows.
//
// `stream` echoes as it goes but **still captures**: the layers are parsed from
// their output (the Rust summary line, the `N/M checks passed` line), and an
// inherited stdio leaves `out` empty. That made `npm test -- --verbose` report
// the Rust layer as "cargo test exited 0 without a result line" while cargo had
// printed a clean pass — a harness false failure blamed on the code.
function run(file, args, { cwd = repoRoot, env = process.env, stream = false, shell = false } = {}) {
  // A shell needs one command string. Every argument passed here is a literal
  // with no spaces (`cargo`, `build`, `--no-bundle`, a relative .cmd path), so
  // joining them is exact; passing an argv alongside `shell: true` instead is
  // what Node deprecates as DEP0190.
  const command = shell ? [file, ...args].join(" ") : file;
  const commandArgs = shell ? [] : args;
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (stream) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
      if (stream) process.stderr.write(chunk);
    });
    child.on("error", (error) => resolve({ code: -1, out, err: `${err}\n${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

// The wrappers live in the repository, so a relative path avoids the quoting
// rules that make `cmd /c "C:\a b\w.cmd"` fail.
function runWrapped(command, args, options) {
  if (isWindows && fs.existsSync(path.join(repoRoot, "scripts", "with-msvc.cmd"))) {
    return run(`scripts\\${command}.cmd`, args, { ...options, shell: true });
  }
  return run(command, args, options);
}

// `tauri build` itself has to run inside the MSVC environment, so the wrapper
// wraps `npm`, not the other way round. `--no-bundle` skips the installers: the
// tests need the executable, and bundling adds minutes for nothing.
function runTauriBuild(options) {
  const args = ["run", "tauri", "--", "build", "--no-bundle"];
  const env = { ...process.env, MDRAFT_QUIET: "1" };
  if (isWindows && fs.existsSync(path.join(repoRoot, "scripts", "with-msvc.cmd"))) {
    return run("scripts\\with-msvc.cmd", ["npm", ...args], { env, stream: options.verbose, shell: true });
  }
  return run("npm", args, { env, stream: options.verbose });
}

function appConfigDir() {
  if (isWindows) {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), identifier);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", identifier);
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), identifier);
}

// Windows keeps a running executable locked, so a leftover instance makes the
// next build fail with "Access is denied" on a file cargo cannot replace.
// CloseMainWindow (WM_CLOSE) is the same path the title-bar X takes and leaves
// the WebView2 profile intact; force-killing it can corrupt the profile.
//
// Only instances this script started are closed without being asked: they live
// in a `mdraft-test-*` staging directory. A copy the developer opened is left
// alone — closing it would discard unsaved work — and the run stops with the
// PID list instead, the same contract `dist.mjs` uses.
async function listRunningInstances() {
  if (!isWindows) {
    const result = await run("pgrep", ["-af", "mdraf[t]"]);
    return result.out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => ({ pid: Number(line.split(/\s+/)[0]), path: line }));
  }
  const query =
    "Get-CimInstance Win32_Process -Filter \"Name='mdraft.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress";
  const result = await run("pwsh", ["-NoProfile", "-Command", query]);
  const text = result.out.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    pid: entry.ProcessId,
    path: entry.ExecutablePath ?? "",
  }));
}

async function closeInstances(instances) {
  for (const { pid } of instances) {
    if (isWindows) await run("taskkill", ["/PID", String(pid)]);
    else await run("kill", [String(pid)]);
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const still = await listRunningInstances();
    const left = still.filter((instance) => instances.some((gone) => gone.pid === instance.pid));
    if (!left.length) return;
    await sleep(500);
  }
  for (const { pid } of instances) {
    if (isWindows) await run("taskkill", ["/PID", String(pid), "/F"]);
    else await run("kill", ["-9", String(pid)]);
  }
  await sleep(500);
}

async function prepareForRun(options) {
  const instances = await listRunningInstances();
  if (!instances.length) return;
  const ours = instances.filter((instance) => /mdraft-test-/.test(instance.path));
  if (ours.length) {
    console.log(`closing ${ours.length} leftover test instance(s): ${ours.map((i) => i.pid).join(", ")}`);
    await closeInstances(ours);
  }
  // Only a copy running out of `target/release` holds the file cargo has to
  // replace. An instance started anywhere else — another checkout, a staged
  // copy — cannot block the build, so it is left running and its ports avoided.
  const releaseDir = path.join(repoRoot, "src-tauri", "target", "release").toLowerCase();
  const locking = instances.filter(
    (instance) => !ours.includes(instance) && instance.path.toLowerCase().startsWith(releaseDir),
  );
  if (!locking.length) return;
  // The lock only matters when the binary is about to be replaced. Without a
  // build the staged copy is a separate file, so an open editor is harmless —
  // and closing someone's window to run tests would be a strange price.
  if (!options.build) {
    console.log(`note: ${locking.length} instance(s) running from target/release; not building, leaving them alone`);
    return;
  }
  if (options.kill) {
    console.log(`closing ${locking.length} running instance(s) (--kill): ${locking.map((i) => i.pid).join(", ")}`);
    await closeInstances(locking);
    return;
  }
  fail(
    `MDraft is running from ${path.relative(repoRoot, releaseDir)} (pid ${locking.map((i) => i.pid).join(", ")}).\n` +
      `Windows locks that executable, so the build cannot replace it. Close it, or re-run with --kill.`,
  );
}

async function waitForExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await sleep(200);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return;
  if (isWindows) {
    // Without /F, taskkill posts WM_CLOSE, which is what a user clicking the X
    // sends — the graceful path the close test exists to protect.
    await run("taskkill", ["/PID", String(child.pid)]);
  } else {
    child.kill("SIGTERM");
  }
  if (await waitForExit(child, 10000)) return;
  if (isWindows) await run("taskkill", ["/PID", String(child.pid), "/F"]);
  else child.kill("SIGKILL");
  await waitForExit(child, 5000);
}

// Every instance needs a port nothing else is listening on. If another window
// already answers on 9222 — a second checkout, another agent's test run — the
// readiness poll would connect to *that* window and every assertion would be
// measuring the wrong document while still passing. Ask the OS for a free port
// instead of trusting the default.
function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const attempt = (port) => {
      if (port > start + 200) {
        reject(new Error(`no free port in ${start}..${start + 200}`));
        return;
      }
      const server = net.createServer();
      server.unref();
      server.once("error", () => attempt(port + 1));
      server.listen(port, "127.0.0.1", () => {
        const { port: free } = server.address();
        server.close(() => resolve(free));
      });
    };
    attempt(start);
  });
}

// The debug port answers as soon as WebView2 starts, which is well before the
// document is loaded. A suite started at that moment reads the pre-load page
// title (`MDraft`, from index.html) instead of `feature-tour.md — MDraft`, and
// the export layer derives its expected output name from that title: it looked
// for `MDraft.html` while the application had written `feature-tour.html`.
// Wait for the title to name the document the instance was given.
async function waitForCdp(port, child, documentName, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let pageSeenAt = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the application exited with code ${child.exitCode} before opening port ${port}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page) {
        if (!documentName) return targets;
        if ((page.title ?? "").includes(documentName)) return targets;
        // The window exists but does not name the document yet. Bound the wait
        // rather than hanging on a title that never arrives.
        if (!pageSeenAt) pageSeenAt = Date.now();
        if (Date.now() - pageSeenAt > 25000) return targets;
      }
    } catch {
      // Not listening yet; WebView2 answers a few seconds after the window opens.
    }
    await sleep(400);
  }
  throw new Error(`no CDP page target on port ${port} after ${timeoutMs} ms`);
}

// ---------------------------------------------------------------------------
// Result parsing. The layers own their counts; this script must not repeat them,
// because a count hard-coded here would drift the moment a check is added.
// ---------------------------------------------------------------------------
function parseChecks(output) {
  const matches = [...output.matchAll(/(\d+)\/(\d+) checks passed/g)];
  if (!matches.length) return null;
  const last = matches.at(-1);
  return { passed: Number(last[1]), total: Number(last[2]) };
}

function parseCounts(output) {
  const pass = (output.match(/^\s+PASS\s/gm) ?? []).length;
  const fail = (output.match(/^\s+FAIL\s/gm) ?? []).length;
  return pass + fail ? { passed: pass, total: pass + fail } : null;
}

function parseRustResult(output) {
  const match = output.match(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored/);
  if (!match) return null;
  return { ok: match[1] === "ok", passed: Number(match[2]), failed: Number(match[3]), ignored: Number(match[4]) };
}

function failureLines(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => /\bFAIL\b|panicked|error\[|^error\b|Error:/.test(line))
    .slice(0, 25);
}

// ---------------------------------------------------------------------------
// Setup steps
// ---------------------------------------------------------------------------
function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
}

function findReleaseBinary() {
  const dir = path.join(repoRoot, "src-tauri", "target", "release");
  if (!fs.existsSync(dir)) return null;
  const cargoToml = fs.readFileSync(path.join(repoRoot, "src-tauri", "Cargo.toml"), "utf8");
  const packageName = cargoToml.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  // The binary is named after the Cargo package, not productName; Tauri renames
  // it only inside a bundle. Match case-insensitively, as Windows does.
  const wanted = new Set(
    [tauriConfig.mainBinaryName, tauriConfig.productName, packageName]
      .filter(Boolean)
      .map((name) => name.toLowerCase()),
  );
  const candidates = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.toLowerCase().includes("portable"))
    .filter((name) => wanted.has(name.replace(/\.exe$/i, "").toLowerCase()));
  if (!candidates.length) return null;
  const name = candidates.sort((a, b) => a.length - b.length)[0];
  return path.join(dir, name);
}

function stageBinary(binary, stage) {
  const staged = path.join(stage, path.basename(binary));
  fs.copyFileSync(binary, staged);
  return staged;
}

// The tests must see first-run state: a persisted viewMode, theme or syntaxTheme
// from an earlier run changes what they measure. The originals are moved aside
// and put back in the finally, so running the suite does not cost the developer
// their preferences.
const USER_FILES = ["settings.json", ".window-state.json"];

function takeUserState(destination) {
  const saved = [];
  fs.mkdirSync(destination, { recursive: true });
  for (const name of USER_FILES) {
    const from = path.join(appConfigDir(), name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(destination, name);
    // copy+unlink rather than rename: the temp directory may be on another volume.
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
    saved.push({ name, backup: to });
  }
  return saved;
}

function restoreUserState(saved) {
  const dir = appConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of USER_FILES) fs.rmSync(path.join(dir, name), { force: true });
  for (const { name, backup } of saved) {
    if (fs.existsSync(backup)) fs.copyFileSync(backup, path.join(dir, name));
  }
}

function resetAppState() {
  for (const name of USER_FILES) fs.rmSync(path.join(appConfigDir(), name), { force: true });
}

// Two layers write the fixture they are given: the shortcut test saves it to
// prove Ctrl+S works, the image paste test replaces a placeholder. One of them
// can fail halfway and leave the change behind, so those documents — and only
// those, so an unrelated edit made during the run is never reverted — are
// snapshotted and put back.
function snapshotFixtures(suites) {
  const snapshots = new Map();
  for (const suite of suites) {
    if (!suite.writesDoc || !suite.doc) continue;
    const file = path.join(repoRoot, suite.doc);
    if (fs.existsSync(file)) snapshots.set(file, fs.readFileSync(file));
  }
  return snapshots;
}

function restoreFixtures(snapshots) {
  for (const [file, bytes] of snapshots) {
    try {
      if (!fs.readFileSync(file).equals(bytes)) {
        fs.writeFileSync(file, bytes);
        console.log(`restored fixture ${path.relative(repoRoot, file)}`);
      }
    } catch {
      // A missing fixture is the next run's problem, not this one's.
    }
  }
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------
async function runRustSuite(options) {
  // Executables in the workspace may only write inside it, so the machine's
  // temp directory is not necessarily usable by the test binaries or by cl.exe
  // (which is how a missing temp directory turns into "D8050: cannot execute
  // c1.dll"). Give cargo a temp directory it certainly owns.
  const temp = path.join(repoRoot, "src-tauri", "target", "test-tmp", "cargo");
  fs.mkdirSync(temp, { recursive: true });
  const env = { ...process.env, TEMP: temp, TMP: temp, MDRAFT_QUIET: "1" };
  const result = await runWrapped("cargo-vcvars", ["test", "--manifest-path", "src-tauri/Cargo.toml"], {
    env,
    stream: options.verbose,
  });
  const parsed = parseRustResult(result.out);
  if (!parsed) {
    return { ok: false, detail: `cargo test exited ${result.code} without a result line`, output: result.out + result.err };
  }
  const ok = result.code === 0 && parsed.failed === 0;
  return {
    ok,
    detail: `${parsed.passed} passed, ${parsed.ignored} ignored`,
    output: result.out + result.err,
  };
}

async function launchApp(suite, port, context, { temp, userData }) {
  const doc = path.join(repoRoot, suite.doc);
  if (!fs.existsSync(doc)) throw new Error(`missing fixture: ${suite.doc}`);

  const outFd = fs.openSync(path.join(context.logDir, `${suite.id}.app.out.log`), "w");
  const errFd = fs.openSync(path.join(context.logDir, `${suite.id}.app.err.log`), "w");
  const child = spawn(context.staged, [doc], {
    cwd: context.stage,
    env: {
      ...process.env,
      TEMP: temp,
      TMP: temp,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      // One browser process per user-data folder, so a private folder per suite
      // is what lets suites run back to back (and keeps a bad run away from the
      // developer's real profile).
      WEBVIEW2_USER_DATA_FOLDER: userData,
    },
    // The window owns no console, but a pipe on stdout would still be held open
    // by the child and stall anything reading our output.
    stdio: ["ignore", outFd, errFd],
    windowsHide: false,
  });
    // Whether the step prints its own line is a human concern, not a reason to
    // give up the captured copy that the summary is built from.
    child.on("error", () => {});
  activeApp = child;
  try {
    await waitForCdp(port, child, path.basename(suite.doc));
  } catch (error) {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    throw error;
  }
  return { child, outFd, errFd };
}

/** A layer that runs without the application: plain Node against the sources. */
async function runNodeSuite(suite, options) {
  const result = await run(process.execPath, [path.join("scripts", suite.script)], {
    stream: options.verbose,
  });
  const output = result.out + result.err;
  const checks = parseChecks(output) ?? parseCounts(output);
  const ok = result.code === 0 && (!checks || checks.passed === checks.total);
  return {
    ok,
    detail: checks ? checks.passed + "/" + checks.total + " checks" : "exit " + result.code + ", no check line",
    output,
  };
}

async function runCdpSuite(suite, port, options, context) {
  resetAppState();
  // The application and the suite must agree on the temporary directory: the
  // export layer looks for the print document the application wrote, under
  // `os.tmpdir()` on one side and `std::env::temp_dir()` on the other. Giving
  // both the same one also keeps everything they write inside the staging
  // directory, which is removed afterwards.
  const temp = path.join(context.stage, "tmp", suite.id);
  const userData = path.join(context.stage, "webview", suite.id);
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const env = { ...process.env, TEMP: temp, TMP: temp };

  // A window that dies before its debug port opens is almost always a transient:
  // the previous instance's WebView2 teardown still holding the debug port. One
  // retry distinguishes that from a real failure to start.
  let launched = null;
  for (let attempt = 1; attempt <= 2 && !launched; attempt += 1) {
    try {
      launched = await launchApp(suite, port, context, { temp, userData });
    } catch (error) {
      if (attempt === 2) throw error;
      console.log(`(retrying ${suite.id}: ${error.message})`);
      await sleep(1500);
    }
  }
  const { child, outFd, errFd } = launched;
  try {
    const args = [path.join("scripts", suite.script), String(port)];
    if (suite.docArg) args.push(path.join(repoRoot, suite.doc));
    const result = await run(process.execPath, args, { env, stream: options.verbose });
    const output = result.out + result.err;
    const checks = parseChecks(output) ?? parseCounts(output);
    const ok = result.code === 0 && (!checks || checks.passed === checks.total);
    return {
      ok,
      detail: checks ? `${checks.passed}/${checks.total} checks` : `exit ${result.code}, no check line`,
      output,
    };
  } finally {
    await stopApp(child);
    activeApp = null;
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

async function runCloseSuite(options, context) {
  // The PowerShell layer launches the binary itself; hand it the staged copy and
  // the same private WebView2 folder, or it inherits the developer's profile.
  const env = {
    ...process.env,
    TEMP: path.join(context.stage, "tmp", "close"),
    TMP: path.join(context.stage, "tmp", "close"),
    WEBVIEW2_USER_DATA_FOLDER: path.join(context.stage, "webview", "close"),
  };
  fs.mkdirSync(env.TEMP, { recursive: true });
  fs.mkdirSync(env.WEBVIEW2_USER_DATA_FOLDER, { recursive: true });
  const result = await run(
    "pwsh",
    ["-NoProfile", "-File", path.join("scripts", "test-close.ps1"), "-Exe", context.staged, "-Doc", path.join(repoRoot, "samples", "feature-tour.md")],
    { env, stream: options.verbose },
  );
  const output = result.out + result.err;
  const counts = parseCounts(output);
  return {
    ok: result.code === 0,
    detail: counts ? `${counts.passed}/${counts.total} checks` : `exit ${result.code}`,
    output,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.list) {
    printSuites();
    return 0;
  }

  let suites = selectedSuites(options);
  if (!CDP_CAPABLE) {
    const skipped = suites.filter((suite) => suite.kind === "cdp" || suite.kind === "close");
    if (skipped.length) {
      console.log(`note: ${skipped.length} UI layer(s) cannot run on ${process.platform} — WebKitGTK has no CDP endpoint.`);
      suites = suites.filter((suite) => suite.kind === "rust" || suite.kind === "node");
    }
  }
  if (!suites.length) {
    console.log("nothing to run");
    return 0;
  }

  console.log(`MDraft test suite  ·  ${process.platform}/${process.arch}`);
  console.log(`repository         ${repoRoot}\n`);

  const results = [];
  let context = null;
  let savedUserState = [];
  let fixtures = new Map();

  try {
    // Before anything else: a leftover window locks the release binary (so the
    // build cannot replace it) and would hold a CDP port the suites need.
    await prepareForRun(options);

    if (options.build) {
      process.stdout.write("building  ... ");
      const build = await runTauriBuild(options);
      if (build.code !== 0) {
        console.log("FAIL");
        console.log((build.out + build.err).split(/\r?\n/).slice(-30).join("\n"));
        results.push({ suite: { id: "build", title: "Build" }, ok: false, detail: "build failed" });
        printSummary(results);
        return 1;
      }
      console.log("PASS");
    }

    // A run that only touches Rust needs neither a release binary nor the
    // developer's application profile; do not copy or move either for it.
    const touchesApp = suites.some((suite) => suite.kind === "cdp" || suite.kind === "close");
    const binary = touchesApp ? findReleaseBinary() : null;
    if (touchesApp && !binary) {
      fail("no release binary in src-tauri/target/release — run without --no-build, or: npm run dist");
    }

    context = { stage: fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-test-")), logDir: "" };
    context.logDir = path.join(context.stage, "logs");
    fs.mkdirSync(context.logDir, { recursive: true });

    if (touchesApp) {
      context.staged = stageBinary(binary, context.stage);
      const size = (fs.statSync(binary).size / 1024 / 1024).toFixed(1);
      console.log(`binary   ${path.relative(repoRoot, binary)}  ${size} MB  sha256 ${sha256(binary)}`);
      console.log(`staged   ${context.stage}  (the sandbox cannot reach %APPDATA% from inside the workspace)\n`);

      savedUserState = takeUserState(path.join(context.stage, "user-state"));
      fixtures = snapshotFixtures(suites);
    }

    let portCursor = options.port;
    for (const suite of suites) {
      const started = Date.now();
      process.stdout.write(`${suite.id.padEnd(10)} ... `);
      let result;
      // A layer whose fixture is not in this checkout, or whose external tool is
      // not installed, could never pass; failing it would read as a regression.
      const missingFixture = suite.doc && !fs.existsSync(path.join(repoRoot, suite.doc));
      const missingTool = suite.requires === "pandoc" && (await run("pandoc", ["--version"])).code !== 0;
      if (missingFixture || missingTool) {
        result = {
          ok: true,
          skipped: true,
          detail: `skipped — ${missingFixture ? `${suite.doc} is not in this checkout` : "pandoc is not installed"}`,
        };
      } else {
        try {
          if (suite.kind === "rust") result = await runRustSuite(options);
          else if (suite.kind === "node") result = await runNodeSuite(suite, options);
          else if (suite.kind === "close") result = await runCloseSuite(options, context);
          else {
            const port = await findFreePort(portCursor);
            portCursor = port + 1; // one port per instance, so a slow close cannot collide
            result = await runCdpSuite(suite, port, options, context);
          }
        } catch (error) {
          result = { ok: false, detail: error.message, output: "" };
        }
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const label = result.skipped ? "SKIP" : result.ok ? "PASS" : "FAIL";
      console.log(`${label}  ${result.detail}  ${seconds}s`);

      if (!result.skipped) {
        const logFile = path.join(context.logDir, `${suite.id}.log`);
        fs.writeFileSync(logFile, result.output ?? "");
        if (!result.ok) {
          const lines = failureLines(result.output ?? "");
          if (lines.length) console.log(lines.map((line) => `  | ${line}`).join("\n"));
          console.log(`  log: ${logFile}`);
        }
      }
      results.push({ suite, ...result });
    }
  } finally {
    // Every exit path has to clean up: a leftover window breaks the next build,
    // and the developer's own settings have to come back. Only instances this
    // run started are swept — never one the developer opened.
    const leftovers = (await listRunningInstances()).filter((instance) => /mdraft-test-/.test(instance.path));
    if (leftovers.length) await closeInstances(leftovers);
    if (savedUserState.length) restoreUserState(savedUserState);
    if (fixtures.size) restoreFixtures(fixtures);
    if (context) {
      if (options.keep) {
        console.log(`\nstaging kept at ${context.stage}`);
      } else {
        // A WebView2 profile directory can stay locked for a moment after the
        // window closes; failing to delete the staging folder is not a test
        // result, so retry and then say so instead of throwing an EPERM that
        // hides the summary.
        try {
          fs.rmSync(context.stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        } catch (error) {
          console.log(`\nnote: could not remove the staging folder ${context.stage}: ${error.code ?? error}`);
        }
      }
    }
  }

  printSummary(results);
  return results.every((result) => result.ok) ? 0 : 1;
}

function printSummary(results) {
  if (!results.length) return;
  console.log("\nsummary");
  for (const { suite, ok, skipped, detail } of results) {
    const label = skipped ? "SKIP" : ok ? "PASS" : "FAIL";
    console.log(`  ${label}  ${suite.id.padEnd(10)} ${detail ?? ""}`);
  }
  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.filter((result) => !result.ok).length;
  const passed = results.length - failed - skipped;
  const tail = skipped ? `, ${skipped} skipped` : "";
  console.log(`\n${results.length} layer(s): ${passed} passed, ${failed} failed${tail}`);
}

process.on("SIGINT", async () => {
  console.log("\ninterrupted — closing the instance this run started");
  // The finally in main() does not run once the process exits from here, and a
  // window left open locks the executable the next build has to replace.
  if (activeApp) await stopApp(activeApp);
  process.exit(130);
});

const code = await main();
process.exit(code);
