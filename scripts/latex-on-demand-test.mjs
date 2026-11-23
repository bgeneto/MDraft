// On-demand project files, through the real application.
//
//   node scripts/latex-on-demand-test.mjs <port>
//
// Opt-in layer `latex-on-demand`. The synthetic fixture names an image through
// a macro, so `collect_referenced` cannot predict it; the preview must fetch it
// from the project route after graphicx opens it.
//
// A second document is written to a temporary folder beside 30,000 other files
// and a folder nobody may list, the shape of a Downloads folder or C:\. It must
// compile, the snapshot must not walk the folder, and nothing may be written
// into it. The folder is removed afterwards; its permissions are restored first.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPage, sleep } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";

if (!process.env.MDRAFT_TEXPRESSO_MIRROR || !process.env.MDRAFT_TEXPRESSO_ENGINE) {
  console.log(
    "SKIP: the on-demand layer needs MDRAFT_TEXPRESSO_MIRROR and MDRAFT_TEXPRESSO_ENGINE so the runner can start the local origin server.",
  );
  process.exit(0);
}

const page = await openPage(port);
const checks = [];
const check = (ok, label, detail = "") => {
  checks.push({ ok, label });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
};
const evaluate = (expression) => page.evaluate(expression);
const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then(JSON.stringify)`,
  ).then(JSON.parse);

async function waitFor(test, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await test();
      if (value) return value;
    } catch {
      // The preview may be swapping its DOM.
    }
    await sleep(150);
  }
  console.log(`  (timed out after ${timeout / 1000}s waiting for ${label})`);
  return false;
}

const frameErrors = [];
let frame = null;
const frameEval = (expression) => frame.evaluate(expression);

async function enableAndCompile() {
  await evaluate(`(async () => {
    const status = await window.__TAURI_INTERNALS__.invoke("latex_engine_status");
    if (status.bundledEnabled && status.previewInstalled) return "already on";
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
    return "enabled";
  })()`);
}

try {
  await waitFor(
    () => evaluate(`Boolean(document.querySelector(".cm-content"))`),
    30_000,
    "the editor",
  );
  if (!(await invoke("latex_engine_status")).previewInstalled) {
    console.log("installing the preview engine from the local origin…");
    await evaluate("window.__TAURI_INTERNALS__.invoke('install_texpresso')");
  }
  check(
    (await invoke("latex_engine_status")).previewInstalled === true,
    "the preview engine and digest table are installed",
  );
  await enableAndCompile();
  const target = await waitFor(
    async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find(
        (entry) => entry.type === "iframe" && /mdraft-tex\.localhost\/texpresso\//.test(entry.url),
      );
    },
    120_000,
    "the TeXpresso debug target",
  );
  check(
    Boolean(target),
    "the frame is its own target on the mdraft-tex origin",
    target?.url ?? "none",
  );
  if (!target) throw new Error("the on-demand frame did not boot");
  frame = await openPage(port, { type: "iframe", match: /mdraft-tex\.localhost/ });
  frame.onException((text) => frameErrors.push(text.split("\n")[0]));
  frame.onConsole((level, text) => {
    if (level === "error") frameErrors.push(text);
  });
  const painted = await waitFor(
    () => evaluate(`Boolean(document.querySelector("#preview")?.dataset.texpressoPainted)`),
    360_000,
    "the first paint",
  );
  check(painted, "the fixture typesets");
  const paths = await frameEval(`JSON.stringify(globalThis.texpresso.project.paths())`).then(
    JSON.parse,
  );
  check(
    paths.includes("main.tex"),
    "the frame holds the synthetic project",
    `${paths.length} files`,
  );
  check(
    paths.includes("figures/dot.png"),
    "the macro-named image is fetched through the project route",
    paths.filter((path) => /\.(png|jpg|pdf)$/i.test(path)).join(", "),
  );
  check(paths.includes(".mdraft-project.json"), "the folder listings reach the worker");
  const problems = await frameEval(
    `JSON.stringify((globalThis.texpresso.problems() ?? []).filter((problem) => problem.severity === "error"))`,
  ).then(JSON.parse);
  check(
    problems.length === 0,
    "the fixture has no TeX errors",
    JSON.stringify(problems.slice(0, 3)),
  );
  const missing = frameErrors.filter((text) => /missing (image|native font|font file)/.test(text));
  check(missing.length === 0, "the renderer has the fetched image", missing.join(" | "));
  // PDF export is already covered by latex-texpresso; this layer proves the
  // macro-named image reached the frame and its renderer.
  console.log("  INFO  PDF export is covered by the latex-texpresso layer");

  await crowdedFolder();
} finally {
  if (frame) frame.close?.();
}

/** Deny listing a folder to everyone; the returned function restores it. */
function lockFolder(dir) {
  if (process.platform === "win32") {
    execFileSync("icacls", [dir, "/deny", "*S-1-1-0:(RD)"], { stdio: "ignore" });
    return () => execFileSync("icacls", [dir, "/remove:d", "*S-1-1-0"], { stdio: "ignore" });
  }
  fs.chmodSync(dir, 0o000);
  return () => fs.chmodSync(dir, 0o755);
}

/** The names directly in a folder, sorted, and the main file's bytes. */
function folderShape(dir) {
  return JSON.stringify({
    names: fs.readdirSync(dir).sort(),
    main: fs.readFileSync(path.join(dir, "main.tex"), "utf8"),
  });
}

async function crowdedFolder() {
  console.log("=== a document beside 30,000 files and a protected folder ===");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-crowded-"));
  const main = path.join(dir, "main.tex");
  let unlock = null;
  try {
    fs.writeFileSync(
      main,
      "\\documentclass{article}\n\\begin{document}\n\\input{chapter}\n\\end{document}\n",
    );
    fs.writeFileSync(path.join(dir, "chapter.tex"), "A crowded folder compiles.\n");
    for (let index = 0; index < 30_000; index += 1) {
      fs.writeFileSync(path.join(dir, `note-${String(index).padStart(5, "0")}.txt`), "x");
    }
    const deep = path.join(dir, "deep", "a", "b", "c", "d", "e", "f", "g");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "leaf.tex"), "\\undefined\n");
    const locked = path.join(dir, "private");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "secret.tex"), "x");
    unlock = lockFolder(locked);
    let listable = true;
    try {
      fs.readdirSync(locked);
    } catch {
      listable = false;
    }
    check(!listable, "the protected folder really refuses a listing");
    const before = folderShape(dir);

    const started = Date.now();
    const snapshot = await invoke("latex_project_snapshot", {
      path: main,
      overlays: [],
      includeLibraries: true,
      watch: [],
    });
    const elapsed = Date.now() - started;
    check(
      snapshot.files
        .map((file) => file.path)
        .sort()
        .join(",") === "chapter.tex,main.tex",
      "the snapshot carries what the document names, not the folder",
      snapshot.files.map((file) => file.path).join(", "),
    );
    const listed = snapshot.listings.map((listing) => listing.path);
    check(
      listed.length === 1 && listed[0] === "" && snapshot.listings[0].complete === false,
      "only the document's own folder is listed, and past its cap it says so",
      JSON.stringify(snapshot.listings.map((l) => [l.path, l.entries.length, l.complete])),
    );
    check(elapsed < 10_000, "the snapshot does not walk the folder", `${elapsed} ms`);

    const shownBefore = await evaluate(
      `document.querySelector("#preview")?.dataset.latexShown ?? ""`,
    );
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify([main])} })`,
    );
    const current = await waitFor(
      () =>
        evaluate(`(() => {
          const status = document.getElementById("status-file")?.textContent ?? "";
          const data = document.querySelector("#preview")?.dataset ?? {};
          return status.includes("main.tex") && Boolean(data.latexCurrent) &&
            data.latexShown !== ${JSON.stringify(shownBefore)};
        })()`),
      240_000,
      "the crowded document's PDF",
    );
    const status = await evaluate(
      `document.querySelector(".latex-build-status")?.textContent ?? ""`,
    );
    check(current, "the document compiles beside the crowd", status.slice(0, 300));
    check(
      !/Cannot list|Access is denied|file limit|too many files/i.test(status),
      "no error names the folder's size or a folder the document never read",
      status.slice(0, 300),
    );
    check(folderShape(dir) === before, "nothing is written into the folder");
  } finally {
    try {
      unlock?.();
    } catch (error) {
      console.log(`  WARN  could not restore the protected folder: ${error.message}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed${failed ? `, ${failed} failed` : ""} (on-demand)`,
);
process.exit(failed ? 1 : 0);
