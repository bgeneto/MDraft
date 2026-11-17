// A PDF figure in the TeXpresso preview, through the real application.
//
//   node scripts/latex-pdf-image-test.mjs <port>
//
// Opt-in layer `latex-pdf-image`. The preview's renderer draws a PDF image with
// pdf.js, which it loads from the engine's `vendor/pdfjs/` folder; when that
// load fails it logs "renderer: cannot load image" and shows the file name in
// a frame. The fixture's figure is a magenta square with the word "PDF" in
// Helvetica, which the PDF does not embed, so pdf.js also needs its standard
// fonts. The frame's own export reads the PDF through xdvipdfmx instead, and
// must carry the figure as well. The document includes it twice, the second
// time as `FIGURES/swatch.pdf` for the folder `figures/`: the engine finds that
// name case-insensitively, and the export must too (the worker patch's export
// fallback), so the export's text holds "PDF" twice.

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPage, sleep } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";

if (!process.env.MDRAFT_TEXPRESSO_MIRROR || !process.env.MDRAFT_TEXPRESSO_ENGINE) {
  console.log(
    "SKIP: the PDF image layer needs MDRAFT_TEXPRESSO_MIRROR and MDRAFT_TEXPRESSO_ENGINE so the runner can start the local origin server.",
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

async function waitFor(read, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await read()) return true;
    } catch {
      // The preview may be swapping its DOM.
    }
    await sleep(250);
  }
  console.log(`  (timed out after ${timeout / 1000}s waiting for ${label})`);
  return false;
}

const frameLog = [];
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

/** Magenta pixels on the frame's page canvases: the figure, drawn by pdf.js. */
const magenta = () =>
  frameEval(`(() => {
    let count = 0;
    for (const canvas of document.querySelectorAll("#pages canvas")) {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context || !canvas.width || !canvas.height) continue;
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4)
        if (data[i] > 200 && data[i + 1] < 70 && data[i + 2] > 200) count += 1;
    }
    return count;
  })()`);

try {
  await waitFor(
    () => evaluate(`Boolean(document.querySelector(".cm-content"))`),
    30_000,
    "the editor",
  );
  if (!(await invoke("latex_engine_status")).previewInstalled) {
    console.log("installing the preview engine from the local origin…");
    const failure = await evaluate(
      "window.__TAURI_INTERNALS__.invoke('install_texpresso').then(() => '', (error) => String(error))",
    );
    if (failure) console.log(`  install failed: ${failure}`);
  }
  check(
    (await invoke("latex_engine_status")).previewInstalled === true,
    "the preview engine is installed",
  );
  await enableAndCompile();
  // A first boot after an install can take a while.
  const booted = await waitFor(
    () => evaluate(`document.querySelector(".texpresso-frame") !== null`),
    240_000,
    "the TeXpresso iframe",
  );
  if (!booted)
    console.log(
      `  status: ${await evaluate(
        `JSON.stringify({ status: document.getElementById("status-file")?.textContent, preview: { ...document.querySelector("#preview")?.dataset }, latex: document.querySelector(".latex-status, #status-latex")?.textContent })`,
      )}`,
    );
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find(
    (entry) => entry.type === "iframe" && /mdraft-tex\.localhost\/texpresso\//.test(entry.url),
  );
  check(Boolean(target), "the frame is its own target on the mdraft-tex origin");
  if (!target) throw new Error("the frame did not boot");
  frame = await openPage(port, { type: "iframe", match: /mdraft-tex\.localhost/ });
  frame.onException((text) => frameLog.push(`exception: ${text.split("\n")[0]}`));
  frame.onConsole((level, text) => frameLog.push(`${level}: ${text}`));
  const painted = await waitFor(
    () => evaluate(`document.querySelector("#preview")?.dataset.texpressoPainted ?? ""`),
    360_000,
    "the first paint",
  );
  check(painted, "the fixture typesets");

  // The figure is decoded asynchronously after the page is first painted.
  let pixels = 0;
  await waitFor(async () => (pixels = await magenta()) > 1000, 60_000, "the PDF figure's pixels");
  const unloaded = frameLog.filter((line) => /renderer: (cannot load|missing) image/.test(line));
  check(unloaded.length === 0, "the renderer loads the PDF image", unloaded.join(" | "));
  check(pixels > 1000, "the PDF figure is drawn on the page", `${pixels} magenta pixels`);

  // xdvipdfmx may put the figure's objects in a compressed object stream, so
  // the export is read with pdf.js rather than searched as text.
  const base64 = await frameEval(`(async () => {
    const out = await globalThis.texpresso.exportPdf({ download: false });
    const bytes = new Uint8Array(out.pdf);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  })()`);
  const pdf = Buffer.from(base64, "base64");
  const saved = join(tmpdir(), "mdraft-pdf-image-export.pdf");
  writeFileSync(saved, pdf);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
  const text = (await (await document.getPage(1)).getTextContent()).items
    .map((item) => item.str)
    .join(" ");
  const figures = text.match(/\bPDF\b/g)?.length ?? 0;
  check(
    figures >= 1,
    "the frame's own export carries the PDF figure",
    `${pdf.length} bytes, saved to ${saved}`,
  );
  check(
    figures >= 2,
    "the export carries the figure named in the wrong letter case",
    `${figures} of 2 figures`,
  );
} finally {
  if (frame) frame.close?.();
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed${failed ? `, ${failed} failed` : ""} (PDF image)`,
);
process.exit(failed ? 1 : 0);
