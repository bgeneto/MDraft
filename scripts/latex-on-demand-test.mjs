// The on-demand project manifest, through the real application.
//
//   node scripts/latex-on-demand-test.mjs <port>
//
// Opt-in layer `latex-on-demand`. The synthetic fixture names an image through
// a macro, so `collect_referenced` cannot predict it; the preview must fetch it
// from the project route after graphicx opens it.

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

async function waitFor(expression, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
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
    if (await window.__TAURI_INTERNALS__.invoke("latex_status")) return "already on";
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
  await waitFor(`Boolean(document.querySelector(".cm-content"))`, 30_000, "the editor");
  if (!(await invoke("latex_engine_status")).previewInstalled) {
    console.log("installing the preview engine from the local origin…");
    await evaluate("window.__TAURI_INTERNALS__.invoke('install_texpresso')");
  }
  check(
    (await invoke("latex_engine_status")).previewInstalled === true,
    "the preview engine and digest table are installed",
  );
  await enableAndCompile();
  const booted = await waitFor(
    `document.querySelector("#preview")?.dataset.texpresso === "1"`,
    120_000,
    "the TeXpresso frame",
  );
  if (!booted) {
    // The backend dataset uses the pane's backend name on current builds.
    await waitFor(
      `document.querySelector(".texpresso-frame") !== null`,
      120_000,
      "the TeXpresso iframe",
    );
  }
  const target = await (async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find(
      (entry) => entry.type === "iframe" && /mdraft-tex\.localhost\/texpresso\//.test(entry.url),
    );
  })();
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
    `document.querySelector("#preview")?.dataset.texpressoPainted ?? ""`,
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
  check(paths.includes(".mdraft-project.json"), "the manifest file reaches the worker");
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
} finally {
  if (frame) frame.close?.();
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed${failed ? `, ${failed} failed` : ""} (on-demand)`,
);
process.exit(failed ? 1 : 0);
