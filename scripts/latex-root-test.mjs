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
let total = 0;
const check = (label, ok, detail = "") => {
  total += 1;
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

async function readPdfText() {
  const backend = await evaluate(`document.querySelector("#preview")?.dataset.latexBackend`);
  if (backend !== "texpresso") {
    return evaluate(
      `[...document.querySelectorAll(".typst-page .textLayer")].map((t) => t.textContent).join(" ")`,
    );
  }

  // The live frame draws to canvas, so inspect the PDF it actually typeset.
  const frame = await openPage(port, { type: "iframe", match: /mdraft-tex\.localhost/ });
  try {
    const base64 = await frame.evaluate(`(async () => {
      const { pdf } = await globalThis.texpresso.exportPdf({ download: false });
      const bytes = new Uint8Array(pdf);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    })()`);
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(Buffer.from(base64, "base64")) });
    try {
      const document = await task.promise;
      const { items } = await (await document.getPage(1)).getTextContent();
      return items.map((item) => item.str).join(" ");
    } finally {
      await task.destroy();
    }
  } finally {
    frame.close();
  }
}

try {
  await waitFor('!!document.querySelector(".cm-content")', 30_000, "the editor");
  if ((await invoke("latex_engine_status")).previewInstalled !== true) {
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
  if ((await invoke("latex_engine_status")).previewInstalled !== true) {
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
    `(() => {
      const preview = document.querySelector("#preview");
      return preview?.dataset.latexBackend === "texpresso"
        ? Boolean(preview.dataset.texpressoPainted && preview.dataset.latexCurrent)
        : Boolean(preview?.querySelector(".typst-page .textLayer span"));
    })()`,
    300_000,
    "the main document's PDF",
  );
  const pdfText = compiled ? await readPdfText() : "";
  check(
    "a chapter with % !TeX root previews its main document",
    /Root marker sentence/.test(pdfText),
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
    `Boolean(document.querySelector("#preview")?.dataset.latexCurrent)`,
  );
  check("the orphan chapter is not compiled alone", !orphanPdf);
} catch (error) {
  check(error.message, false);
} finally {
  page.close();
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
