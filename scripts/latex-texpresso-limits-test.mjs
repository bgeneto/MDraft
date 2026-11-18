// What the TeXpresso preview cannot do, said where the reader looks.
//
//   node scripts/latex-texpresso-limits-test.mjs <port>
//
// Opt-in layer `latex-texpresso-limits`. It needs the local origin server, so
// the harness starts one when `MDRAFT_TEXPRESSO_MIRROR` and
// `MDRAFT_TEXPRESSO_ENGINE` are set; otherwise it prints one SKIP line.
//
// What it proves, in order:
//   1. a font the renderer cannot draw reaches Logs as a warning naming it,
//      and a finished build still reads "PDF ready" (on the pinned release the
//      fixture's T1 Times is the virtual font ptmr8t, blank under XeLaTeX);
//   2. a build the engine abandons is never "PDF ready": with the frame's own
//      verdict `Failed after …: The engine ran out of memory` (forced at the
//      export, because a real out-of-memory run takes a 200-page book and a
//      minute), the status reads "PDF with errors", the frame's pages are the
//      partial PDF (Save PDF on, Export › PDF and Print off), and Logs offers
//      the installed-distribution route;
//   3. the next finished build reads "PDF ready" again.

import { openPage, sleep } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";

if (!process.env.MDRAFT_TEXPRESSO_MIRROR || !process.env.MDRAFT_TEXPRESSO_ENGINE) {
  console.log(
    "SKIP: the limits layer needs MDRAFT_TEXPRESSO_MIRROR and MDRAFT_TEXPRESSO_ENGINE so the runner can start the local origin server.",
  );
  process.exit(0);
}

const page = await openPage(port);
const checks = [];
const check = (ok, label, detail = "") => {
  checks.push({ ok, label });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
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

let frame = null;
const frameEval = (expression) => frame.evaluate(expression);
const toolbar = () =>
  evaluate(`(document.querySelector(".compiled-toolbar")?.innerText ?? "").replace(/\\s+/g, " ")`);
const logRows = () =>
  evaluate(
    `JSON.stringify([...document.querySelectorAll(".latex-problem")].map((row) => row.textContent.replace(/\\s+/g, " ").trim()))`,
  ).then(JSON.parse);
const menuEnabled = async (id) =>
  (await invoke("menu_items")).find((item) => item.id === id)?.enabled === true;
const saveEnabled = () =>
  evaluate(`document.querySelector(".compiled-save-pdf")?.disabled === false`);
const compile = () =>
  evaluate(`document.querySelector(".compiled-toolbar .compiled-compile")?.click()`);

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
    `document.querySelector("#preview")?.dataset.texpressoReady === "1"`,
    120_000,
    "the TeXpresso frame",
  );
  check(booted, "the frame boots under the mdraft-tex origin");
  if (!booted) throw new Error("the TeXpresso frame did not boot");
  frame = await openPage(port, { type: "iframe", match: /mdraft-tex\.localhost/ });

  console.log("=== a font the renderer cannot draw ===");
  const ready = await waitFor(
    `/PDF ready/.test(document.querySelector(".compiled-toolbar")?.innerText ?? "")`,
    360_000,
    "the first finished build",
  );
  check(ready, "the fixture builds", await toolbar());
  check(
    (await evaluate(`document.getElementById("status-latex-engine")?.textContent ?? ""`)) ===
      "XeLaTeX",
    "the magic comment selects XeLaTeX",
  );
  const fontRows = (await logRows()).filter((row) => /cannot draw the font/.test(row));
  check(
    fontRows.some((row) => /\bptmr8t\b/.test(row) && /virtual font/.test(row)),
    "Logs names the virtual font ptmr8t the XeLaTeX preview leaves blank",
    JSON.stringify(fontRows.slice(0, 3)),
  );
  check(
    fontRows.some((row) => /\bbchr8t\b/.test(row)),
    "Logs names the Charter font bchr8t too",
  );
  check(
    (await menuEnabled("export.pdf")) && (await menuEnabled("file.print")),
    "a finished build with a font warning still enables Export › PDF and Print",
  );

  console.log("=== a build the engine abandons ===");
  // The app writes its status only when it typesets, so the forced verdict is
  // undone with the title it replaced: a Compile with unchanged inputs would
  // otherwise, rightly, keep reporting the frame's output as abandoned.
  const wrapped = await frameEval(`(() => {
    const t = globalThis.texpresso;
    if (!t.__limitsExport) {
      t.__limitsExport = t.exportPdf;
      t.__limitsTitle = document.getElementById("status")?.title ?? "";
    }
    t.exportPdf = async function (...args) {
      const out = await t.__limitsExport.apply(this, args);
      const status = document.getElementById("status");
      if (status) status.title = "Failed after 51234 ms: The engine ran out of memory";
      return out;
    };
    return t.exportPdf !== t.__limitsExport;
  })()`);
  check(wrapped, "the frame's export can be made to end in the app's failure verdict");
  await compile();
  const failed = await waitFor(
    `/PDF with errors/.test(document.querySelector(".compiled-toolbar")?.innerText ?? "")`,
    120_000,
    "the abandoned build's status",
  );
  check(failed, "an abandoned build reads PDF with errors, not PDF ready", await toolbar());
  const status = await evaluate(
    `JSON.stringify({ partial: document.querySelector("#preview")?.dataset.latexPartial ?? null, current: document.querySelector("#preview")?.dataset.latexCurrent ?? null })`,
  ).then(JSON.parse);
  check(
    status.partial !== null && status.current === null,
    "the frame's pages are the partial PDF, not the current result",
    JSON.stringify(status),
  );
  check(await saveEnabled(), "Save PDF stays available for the partial PDF");
  check(
    !(await menuEnabled("export.pdf")) && !(await menuEnabled("file.print")),
    "Export › PDF and Print are off for a partial PDF",
  );
  const failureRows = (await logRows()).filter((row) => /ran out of memory/.test(row));
  check(
    failureRows.some((row) => /after page \d+/.test(row) && /installed TeX distribution/.test(row)),
    "Logs says the engine ran out of memory after which page, and the way out",
    JSON.stringify(failureRows.slice(0, 1)),
  );
  check(
    (await evaluate(`Boolean(document.querySelector(".latex-installed-tex"))`)) === true,
    "Logs offers the installed-distribution preferences",
  );
  check(
    (await frameEval(`document.querySelectorAll("#pages .page").length`)) > 0,
    "the frame keeps showing the pages it typeset",
  );

  console.log("=== the next finished build ===");
  await frameEval(`(() => {
    const t = globalThis.texpresso;
    if (t.__limitsExport) t.exportPdf = t.__limitsExport;
    const status = document.getElementById("status");
    if (status && t.__limitsTitle !== undefined) status.title = t.__limitsTitle;
    delete t.__limitsExport;
    delete t.__limitsTitle;
    return true;
  })()`);
  await compile();
  const recovered = await waitFor(
    `/PDF ready/.test(document.querySelector(".compiled-toolbar")?.innerText ?? "")`,
    120_000,
    "a finished build after the failure",
  );
  check(recovered, "the next finished build reads PDF ready again", await toolbar());
  check(
    (await menuEnabled("export.pdf")) && (await menuEnabled("file.print")),
    "Export › PDF and Print return with it",
  );
} finally {
  if (frame) frame.close?.();
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed${failed ? `, ${failed} failed` : ""} (texpresso limits)`,
);
process.exit(failed ? 1 : 0);
