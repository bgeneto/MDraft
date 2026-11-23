// What the TeXpresso preview cannot do, said where the reader looks.
//
//   node scripts/latex-texpresso-limits-test.mjs <port>
//
// Opt-in layer `latex-texpresso-limits`. It needs the local origin server, so
// the harness starts one when `MDRAFT_TEXPRESSO_MIRROR` and
// `MDRAFT_TEXPRESSO_ENGINE` are set; otherwise it prints one SKIP line.
//
// What it proves, in order:
//   1. the XeLaTeX preview draws virtual fonts: the fixture's T1 Times and
//      Charter (ptmr8t, bchr8t) put text on the page canvas and no "cannot
//      draw the font" warning reaches Logs (release-0-133-g454f1bc drew none
//      of it and warned for both);
//   2. a build the engine abandons is never "PDF ready": with the frame's own
//      verdict `Failed after …: The engine ran out of memory` (forced at the
//      export, because a real out-of-memory run takes a 400-page book and a
//      minute), the status reads "PDF with errors", the pages typeset are the
//      partial PDF (Save PDF on, Export › PDF and Print off), and Logs offers
//      the installed-distribution route;
//   3. that verdict releases the frame, whose engine is dead weight by then,
//      and the partial PDF is drawn with PDF.js; an edit then starts no build,
//      because every build of that project would stop at the same place;
//   4. Compile starts a new frame and reads "PDF ready" again, and edits build
//      again;
//   5. a frame whose main thread blocks during the export (forced there for
//      120 s; the real case is a long document set in nullfont) ends the
//      export within about 30 s: the status names it, Logs says what to do,
//      the frame is released, edits wait, and Compile exports in a new frame.

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
const dataset = (name) =>
  evaluate(`document.querySelector("#preview")?.dataset[${JSON.stringify(name)}] ?? null`);
const editor = (body) =>
  evaluate(`(() => {
    const view = document.querySelector(".cm-content").cmTile.root.view;
    ${body}
  })()`);
// A comment line typed at the end and removed again, so the fixture's buffer
// ends equal to the file (and clean) whatever the checks find.
const EDIT = "\n% limits: an edit after the verdict\n";
let edited = false;
async function undoEdit() {
  await editor(`
    const text = view.state.doc.toString();
    const at = text.lastIndexOf(${JSON.stringify(EDIT)});
    if (at >= 0) view.dispatch({ changes: { from: at, to: at + ${EDIT.length} } });
  `);
  edited = false;
}
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

  console.log("=== virtual fonts under XeLaTeX ===");
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
  const fontRows = (await logRows()).filter((row) => /cannot (draw|load) the font/.test(row));
  check(
    fontRows.length === 0,
    "no font of the fixture is reported as undrawable",
    JSON.stringify(fontRows.slice(0, 3)),
  );
  // Every glyph of the fixture is in a virtual font, the formula included.
  // The VF-capable build measured 1,039 inked pixels on 2026-11-17
  // (anti-aliased, mean channel below 200); the assertion is a floor.
  const ink = await frameEval(`(() => {
    const canvas = document.querySelector("#pages .page canvas");
    if (!canvas) return -1;
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let inked = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 3] > 0 && data[i] + data[i + 1] + data[i + 2] < 600) inked += 1;
    return inked;
  })()`);
  check(ink > 300, "the virtual-font text is drawn on the page canvas", `${ink} inked pixels`);
  check(
    (await menuEnabled("export.pdf")) && (await menuEnabled("file.print")),
    "a finished build enables Export › PDF and Print",
  );

  console.log("=== a build the engine abandons ===");
  // The memory verdict releases this frame, so the wrapper goes with it and the
  // next frame exports unmodified.
  const wrapped = await frameEval(`(() => {
    const t = globalThis.texpresso;
    const original = t.exportPdf;
    t.exportPdf = async function (...args) {
      const out = await original.apply(this, args);
      const status = document.getElementById("status");
      if (status) status.title = "Failed after 51234 ms: The engine ran out of memory";
      return out;
    };
    return t.exportPdf !== original;
  })()`);
  check(wrapped, "the frame's export can be made to end in the app's failure verdict");
  const sessionBefore = await dataset("texpressoSession");
  await compile();
  // Not "Rendering PDF with errors…", the step that draws the partial PDF once
  // the frame is gone.
  const failed = await waitFor(
    `(() => {
      const text = document.querySelector(".compiled-toolbar")?.innerText ?? "";
      return /PDF with errors/.test(text) && !/Rendering/.test(text);
    })()`,
    120_000,
    "the abandoned build's status",
  );
  check(failed, "an abandoned build reads PDF with errors, not PDF ready", await toolbar());
  const status = await evaluate(
    `JSON.stringify({ partial: document.querySelector("#preview")?.dataset.latexPartial ?? null, current: document.querySelector("#preview")?.dataset.latexCurrent ?? null })`,
  ).then(JSON.parse);
  check(
    status.partial !== null && status.current === null,
    "the pages typeset are the partial PDF, not the current result",
    JSON.stringify(status),
  );
  // Out of memory releases the frame (its engine held about 5 GB on a long
  // book) and draws the partial PDF with PDF.js instead.
  check(
    await waitFor(
      `document.querySelectorAll("iframe.texpresso-frame").length === 0`,
      10_000,
      "the frame's release",
    ),
    "the out-of-memory verdict releases the preview frame",
  );
  check(
    await waitFor(
      `document.querySelectorAll("#preview .typst-page").length > 0`,
      20_000,
      "the partial PDF's pages",
    ),
    "the partial PDF is drawn without the frame",
    await evaluate(`String(document.querySelectorAll("#preview .typst-page").length)`),
  );
  check(await saveEnabled(), "Save PDF stays available for the partial PDF");
  check(
    !(await menuEnabled("export.pdf")) && !(await menuEnabled("file.print")),
    "Export › PDF and Print are off for a partial PDF",
  );
  const failureRows = (await logRows()).filter((row) => /ran out of memory/.test(row));
  check(
    failureRows.some(
      (row) =>
        /after page \d+/.test(row) &&
        /installed TeX distribution/.test(row) &&
        /select Compile/.test(row),
    ),
    "Logs says the engine ran out of memory after which page, the way out, and that edits wait for Compile",
    JSON.stringify(failureRows.slice(0, 1)),
  );
  check(
    (await evaluate(`Boolean(document.querySelector(".latex-installed-tex"))`)) === true,
    "Logs offers the installed-distribution preferences",
  );

  console.log("=== an edit after the memory verdict ===");
  // Every build of that project would start again from page 1 and stop at the
  // same place, so an edit marks the preview out of date and starts none. The
  // edit is undone afterwards, which leaves the fixture's buffer clean.
  await editor(
    `view.dispatch({ changes: { from: view.state.doc.length, insert: ${JSON.stringify(EDIT)} } });`,
  );
  edited = true;
  // Longer than auto-compile's debounce.
  await sleep(4000);
  const held = await evaluate(
    `JSON.stringify({ toolbar: (document.querySelector(".compiled-toolbar")?.innerText ?? "").replace(/\\s+/g, " "), busy: Boolean(document.querySelector(".compiled-toolbar .compiled-compile.latex-cancel")), frames: document.querySelectorAll("iframe.texpresso-frame").length, session: document.querySelector("#preview")?.dataset.texpressoSession ?? null })`,
  ).then(JSON.parse);
  check(
    !held.busy && held.frames === 0 && held.session === sessionBefore,
    "an edit after the memory verdict starts no build and no frame",
    JSON.stringify(held),
  );
  check(
    /Out of date/.test(held.toolbar) && /select Compile/.test(held.toolbar),
    "the status says the preview is out of date and that Compile retries",
    held.toolbar,
  );
  await undoEdit();

  console.log("=== the next finished build ===");
  await compile();
  const recovered = await waitFor(
    `/PDF ready/.test(document.querySelector(".compiled-toolbar")?.innerText ?? "")`,
    120_000,
    "a finished build after the failure",
  );
  check(recovered, "Compile starts a new frame and reads PDF ready again", await toolbar());
  check(
    (await dataset("texpressoSession")) !== sessionBefore &&
      (await evaluate(`document.querySelectorAll("iframe.texpresso-frame").length`)) === 1,
    "the build ran in a new frame",
  );
  check(
    (await menuEnabled("export.pdf")) && (await menuEnabled("file.print")),
    "Export › PDF and Print return with it",
  );
  // Compile lifted the hold: an edit builds again.
  await editor(
    `view.dispatch({ changes: { from: view.state.doc.length, insert: ${JSON.stringify(EDIT)} } });`,
  );
  edited = true;
  check(
    await waitFor(
      `Boolean(document.querySelector(".compiled-toolbar .compiled-compile.latex-cancel")) || !/PDF ready/.test(document.querySelector(".compiled-toolbar")?.innerText ?? "")`,
      10_000,
      "a build after the edit",
    ),
    "after Compile, an edit starts a build again",
    await toolbar(),
  );
  await undoEdit();
  await waitFor(
    `/PDF ready/.test(document.querySelector(".compiled-toolbar")?.innerText ?? "")`,
    120_000,
    "the build of the restored text",
  );

  console.log("=== a frame that stops answering ===");
  // A 106-page book whose \setmainfont names a missing font blocks the frame's
  // main thread for good, 6 s into the export (measured 2026-11-23). This
  // blocks it at the same point for 120 s, so the layer needs no long
  // document. The frame is the one Compile started above.
  frame.close?.();
  frame = await openPage(port, { type: "iframe", match: /mdraft-tex\.localhost/ });
  const blocking = await frameEval(`(() => {
    const t = globalThis.texpresso;
    t.exportPdf = function () {
      setTimeout(() => {
        const end = performance.now() + 120000;
        while (performance.now() < end);
      }, 0);
      return new Promise(() => {});
    };
    return true;
  })()`);
  check(blocking, "the frame's export can be made to block its main thread");
  const liveSession = await dataset("texpressoSession");
  const askedAt = Date.now();
  await compile();
  const unresponsive = await waitFor(
    `/could not be prepared/.test(document.querySelector(".compiled-toolbar")?.innerText ?? "")`,
    60_000,
    "the verdict on the blocked frame",
  );
  const verdictSeconds = (Date.now() - askedAt) / 1000;
  const verdictText = await toolbar();
  check(
    unresponsive && verdictSeconds < 50 && /stopped responding/.test(verdictText),
    "a frame that stops answering ends the export, within about 30 s, naming the cause",
    `${verdictSeconds.toFixed(1)} s · ${verdictText}`,
  );
  check(
    await waitFor(
      `document.querySelectorAll("iframe.texpresso-frame").length === 0`,
      10_000,
      "the blocked frame's release",
    ),
    "the blocked frame is released",
  );
  const frozenRows = (await logRows()).filter((row) => /stopped responding/.test(row));
  check(
    frozenRows.some((row) => /Fix the errors, then select Compile/.test(row)),
    "Logs says the preview stopped responding and what to do",
    JSON.stringify(frozenRows.slice(0, 1)),
  );
  check(
    !(await saveEnabled()) &&
      !(await menuEnabled("export.pdf")) &&
      !(await menuEnabled("file.print")),
    "Save PDF, Export › PDF and Print are off without a PDF",
  );
  await editor(
    `view.dispatch({ changes: { from: view.state.doc.length, insert: ${JSON.stringify(EDIT)} } });`,
  );
  edited = true;
  // Longer than auto-compile's debounce.
  await sleep(4000);
  const heldFrozen = await evaluate(
    `JSON.stringify({ toolbar: (document.querySelector(".compiled-toolbar")?.innerText ?? "").replace(/\\s+/g, " "), busy: Boolean(document.querySelector(".compiled-toolbar .compiled-compile.latex-cancel")), frames: document.querySelectorAll("iframe.texpresso-frame").length })`,
  ).then(JSON.parse);
  check(
    !heldFrozen.busy &&
      heldFrozen.frames === 0 &&
      /Out of date/.test(heldFrozen.toolbar) &&
      /stopped responding/.test(heldFrozen.toolbar),
    "an edit after that verdict starts no frame, and the status says why",
    JSON.stringify(heldFrozen),
  );
  await undoEdit();
  await compile();
  // The released frame's process outlives it by about 11 s, and a frame
  // mounted meanwhile is placed in it, still blocked. This Compile comes
  // about 8 s after the verdict, so it waits first.
  check(
    await waitFor(
      `/Closing the preview that stopped responding/.test(document.querySelector(".compiled-toolbar")?.innerText ?? "") && document.querySelectorAll("iframe.texpresso-frame").length === 0`,
      5_000,
      "the wait for the blocked frame's process",
    ),
    "a Compile soon after the verdict waits for the blocked frame's process to end",
    await toolbar(),
  );
  check(
    await waitFor(
      `/PDF ready/.test(document.querySelector(".compiled-toolbar")?.innerText ?? "")`,
      120_000,
      "a finished build after the blocked frame",
    ),
    "Compile starts a new frame that exports again",
    await toolbar(),
  );
  check(
    (await dataset("texpressoSession")) !== liveSession,
    "the build after the blocked frame ran in a new frame",
  );
} finally {
  if (edited) await undoEdit().catch(() => {});
  if (frame) frame.close?.();
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed${failed ? `, ${failed} failed` : ""} (texpresso limits)`,
);
process.exit(failed ? 1 : 0);
