#!/usr/bin/env node
//! One command to produce installers: build, then stage into bin/<os>/<arch>/.
//!
//!   npm run dist
//!   npm run dist -- --bundles nsis          # a subset
//!   npm run dist -- --no-bundle             # compile only
//!   npm run dist -- --kill                  # close a running copy first
//!
//! On Windows the build runs inside `vcvars64.bat` through
//! `scripts/with-msvc.cmd`. That is not decoration: cargo discovers the Windows
//! SDK through the registry, and on a host whose registered SDK version and
//! on-disk version disagree it never exports INCLUDE/LIB, so the build dies with
//! `cannot open include file 'windows.h'`. Loading the environment first is the
//! portable fix, and it is harmless when discovery already works.
//!
//! The preflight exists because of a failure that is common and badly reported:
//! Windows keeps a running executable locked, so cargo cannot replace
//! `target/release/mdraft.exe` and dies with
//!
//!   error: failed to remove file ...\mdraft.exe
//!   Caused by: Access is denied. (os error 5)
//!
//! which says nothing about the app being open. Catching it up front turns a
//! confusing build error into one sentence and a command.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const passed = process.argv.slice(2);
const bundleOnly = passed.includes("--no-bundle");
const killFirst = passed.includes("--kill");
const forwarded = passed.filter(
  (arg) => arg !== "--no-bundle" && arg !== "--kill",
);

const APP = "mdraft";

/**
 * Run a build step without flashing console windows.
 *
 * `windowsHide` is not cosmetic on Windows. The build is a chain of batch files
 * — this script, `with-msvc.cmd`, `vcvars64.bat`, and then every `.bat` the MSVC
 * toolchain runs while compiling (`link.exe`, `rc.exe`, and the rest). Each one
 * that gets a console *of its own* also gets a window, which appears and
 * vanishes; a build produces dozens, and they are impossible to miss.
 *
 * With the flag, the outermost process runs in a console that has no window, and
 * every descendant inherits that windowless console instead of asking for a new
 * one. The output still arrives here through `stdio: "inherit"`.
 */
function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    windowsHide: true,
  });
  if (result.error) {
    console.error(`failed to start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * Copies of the app that would hold the output binary open, from the build
 * tree or from an installed package. Returns [] rather than throwing: a missing
 * `tasklist` or `pgrep` must not stop a build.
 */
function runningCopies() {
  try {
    if (process.platform === "win32") {
      const out = spawnSync(
        "tasklist",
        ["/FI", `IMAGENAME eq ${APP}.exe`, "/NH", "/FO", "CSV"],
        { encoding: "utf8", windowsHide: true },
      );
      if (out.status !== 0 || !out.stdout) return [];
      return out.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(`"${APP}.exe"`))
        .map((line) => {
          const [image, pid] = line.split('","');
          return { image: (image ?? "").replace(/"/g, ""), pid: (pid ?? "").replace(/"/g, "") };
        });
    }
    const out = spawnSync("pgrep", ["-x", APP], { encoding: "utf8" });
    if (out.status !== 0 || !out.stdout) return [];
    return out.stdout
      .split(/\s+/)
      .filter(Boolean)
      .map((pid) => ({ image: APP, pid }));
  } catch {
    return [];
  }
}

function terminate(copies) {
  for (const { pid } of copies) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
      } else {
        spawnSync("kill", ["-9", pid], { stdio: "ignore" });
      }
    } catch {
      // Reported by the re-check below.
    }
  }
}

function describe(copies) {
  return copies.map(({ image, pid }) => `    PID ${pid}  ${image}`).join("\n");
}

/** Synchronous sleep, so the preflight stays a straight-line script. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const launched = runningCopies();
if (launched.length > 0) {
  if (!killFirst) {
    console.error(`
${APP} is running, and a running executable cannot be replaced:

${describe(launched)}

Close it — including an installed copy started from the Start menu, not just
the one from target/release — then run this again. Or let this script do it:

    npm run dist -- --kill

`);
    process.exit(1);
  }

  console.log(`${APP} is running; closing ${launched.length} copy(ies) because --kill was given`);
  terminate(launched);

  // Windows releases the handle asynchronously; give it a moment and verify
  // rather than letting cargo fail on a lock that is about to disappear.
  let remaining = runningCopies();
  for (let attempt = 0; attempt < 20 && remaining.length > 0; attempt++) {
    sleepSync(150);
    remaining = runningCopies();
  }
  if (remaining.length > 0) {
    console.error(`still running after a kill request:\n${describe(remaining)}`);
    process.exit(1);
  }
}

const wrapper = join(repoRoot, "scripts", "with-msvc.cmd");
const tauriArgs = ["tauri", "build", ...forwarded];

const build =
  process.platform === "win32" && existsSync(wrapper)
    ? // A .cmd is not a PE image, so it has to go through the command
      // interpreter. `windowsHide` here is what keeps the entire batch-file
      // chain — vcvars64.bat, then every .bat MSVC runs — inside one console
      // that has no window.
      spawnSync("cmd.exe", ["/c", wrapper, "npx", ...tauriArgs], {
        stdio: "inherit",
        cwd: repoRoot,
        windowsHide: true,
      })
    : spawnSync("npx", tauriArgs, { stdio: "inherit", cwd: repoRoot });

if (build.error) {
  console.error(`failed to start the build: ${build.error.message}`);
  process.exit(1);
}

if (build.status !== 0) {
  // The app can also be started halfway through a build, so the same condition
  // gets a second check here instead of surfacing as a bare cargo error.
  const late = runningCopies();
  if (late.length > 0) {
    console.error(`
The build failed while ${APP} was running:

${describe(late)}

That is the usual cause of "failed to remove file ... Access is denied".
Close it and rebuild, or use: npm run dist -- --kill
`);
  } else {
    console.error(`
The build failed. If the output mentioned
"Blocking waiting for file lock on build directory", another cargo is holding
src-tauri/target — typically rust-analyzer in an editor, a second terminal, or a
build that was killed. Let it finish, or point the editor at its own target
directory with "rust-analyzer.cargo.targetDir": true in .vscode/settings.json.
`);
  }
  process.exit(build.status ?? 1);
}

if (!bundleOnly) {
  run(process.execPath, [join(repoRoot, "scripts", "stage-artifacts.mjs")]);
}
