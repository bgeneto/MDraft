// Main-document resolution in the running application (GAP-034).
//
//   node scripts/latex-root-test.mjs <port>
//
// The harness launches MDraft with samples/latex-root/chapters/body.tex as the
// only document. That chapter names its main file with `% !TeX root`, so the
// preview must be the main document's PDF, the main file must open as a
// background tab while the chapter stays active, and a chapter that no main
// file names (orphan.tex) must say so instead of compiling alone.
//
// Read-only: no fixture is saved. Skips cleanly without the bundled engine.

import { join } from "node:path";
import { openPage, sleep } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";
const page = await openPage(port);
const evaluate = (expression) => page.evaluate(expression);
const invoke = (command) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}).then(JSON.stringify)`,
  ).then(JSON.parse);
let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
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

try {
  await waitFor('!!document.querySelector(".cm-content")', 30_000, "the editor");
  if ((await invoke("latex_status")) !== true) {
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
    console.log("SKIP: the bundled LaTeX engine is not available.");
    page.close();
    process.exit(0);
  }
  if ((await evaluate(`document.querySelector("#preview")?.dataset.latexCurrent ?? ""`)) === "") {
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"menu",payload:"view.latexCompile"})`,
    );
  }
  const compiled = await waitFor(
    `[...document.querySelectorAll(".typst-page .textLayer")].some((t) => /Root marker sentence/.test(t.textContent ?? ""))`,
    300_000,
    "the main document's PDF",
  );
  check("a chapter with % !TeX root previews its main document", compiled);
  const pdfText = await evaluate(
    `[...document.querySelectorAll(".typst-page .textLayer")].map((t) => t.textContent).join(" ")`,
  );
  check("the chapter's own text is in that PDF", /Chapter marker sentence/.test(pdfText));
  const tabs = await evaluate(
    `JSON.stringify([...document.querySelectorAll("[role=tab]")].map((t) => ({ name: t.textContent.trim(), selected: t.getAttribute("aria-selected") })))`,
  ).then(JSON.parse);
  check(
    "the main file opened as a background tab",
    tabs.some((tab) => /main\.tex/.test(tab.name) && tab.selected !== "true"),
    JSON.stringify(tabs),
  );
  check(
    "the chapter stays the active tab",
    tabs.some((tab) => /body\.tex/.test(tab.name) && tab.selected === "true"),
  );

  // An orphan chapter: no magic comment, no \documentclass, no pinned project.
  const orphan = join(process.cwd(), "samples", "latex-root", "chapters", "orphan.tex");
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"open-files",payload:${JSON.stringify([orphan])}})`,
  );
  await waitFor(
    `document.querySelector(".cm-content")?.cmTile?.root?.view?.state.doc.toString().includes("Orphan marker") ?? false`,
    20_000,
    "the orphan chapter",
  );
  // The status chip and the Logs panel carry the explanation; both live in the
  // compiled-preview chrome, outside #preview-pane.
  const told = await waitFor(
    `/No main document for this file/.test(document.body.textContent ?? "")`,
    30_000,
    "the missing-main status",
  );
  check("a chapter with no main document says so in the status", told);
  check(
    "the Logs panel says how to name the main document",
    await evaluate(`/% !TeX root = \\.\\.\\/main\\.tex/.test(document.body.textContent ?? "")`),
  );
  const orphanPdf = await evaluate(
    `[...document.querySelectorAll(".typst-page .textLayer")].some((t) => /Orphan marker/.test(t.textContent ?? ""))`,
  );
  check("the orphan chapter is not compiled alone", !orphanPdf);
} catch (error) {
  failed += 1;
  console.log(`FAIL  ${error.message}`);
} finally {
  page.close();
}
console.log(`\n${failed ? "some" : "all"} checks done; ${failed} failed`);
process.exit(failed ? 1 : 0);
