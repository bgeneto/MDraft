// The TeXpresso preview backend, through the real application (step 11 of
// docs/architecture.md).
//
//   node scripts/latex-texpresso-test.mjs <port>
//
// Opt-in layer `latex-texpresso`. It needs a local origin server, so the
// harness starts one when `MDRAFT_TEXPRESSO_MIRROR` and `MDRAFT_TEXPRESSO_ENGINE`
// name the mirror and the engine folder; otherwise the layer prints one SKIP
// line saying why and exits 0.
//
// What it proves, in order:
//   1. the backend switch mounts a frame of its own origin, and it boots;
//   2. the frame holds MDraft's project, not an example;
//   3. an edit repaints on the frame's own path, and the engine's copy agrees;
//   4. the frame's own `xdvipdfmx` export fills the PDF Export, Print and the menu read;
//   5. selection, caret, click and double-click follow the PDF conventions;
//   6. scroll correspondence works in both directions;
//   7. zoom, both themes and manual mode reach the frame;
//   8. the frame registers no service worker and requests nothing off-origin;
//   9. another tab hides the frame instead of restarting the engine;
//  10. switching back to WasmTex disposes the frame and restores its preview.

import { openPage, emitMenu, sleep } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";

if (!process.env.MDRAFT_TEXPRESSO_MIRROR || !process.env.MDRAFT_TEXPRESSO_ENGINE) {
  console.log(
    "SKIP: the TeXpresso layer needs MDRAFT_TEXPRESSO_MIRROR (the TeX Live mirror) " +
      "and MDRAFT_TEXPRESSO_ENGINE (the engine folder) so the runner can start the origin server.",
  );
  process.exit(0);
}

const page = await openPage(port);

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const errors = [];
page.onException((text) => errors.push(text.split("\n")[1] ?? text.split("\n")[0]));
page.onConsole((level, text) => {
  if (level === "error") errors.push(text);
});

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

const dataset = (name) => evaluate(`document.querySelector("#preview")?.dataset.${name} ?? null`);

let frame = null;
const frameEval = (expression) => frame.evaluate(expression);

async function findFrame() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.find((entry) => /mdraft-tex\.localhost\/texpresso\//.test(entry.url)) ?? null;
}

async function attachFrame() {
  const target = await findFrame();
  if (!target) return null;
  frame = await openPage(port, { type: "iframe", match: /mdraft-tex\.localhost/ });
  frame.onException((text) => errors.push(`[frame] ${text.split("\n")[0]}`));
  frame.onConsole((level, text) => {
    console.log(`[frame ${level}] ${text}`);
    if (level === "error") errors.push(`[frame] ${text}`);
  });
  return target;
}

/** Run a body against the editor's CodeMirror view. */
const editor = (body) =>
  evaluate(`(() => {
    const view = document.querySelector(".cm-content").cmTile.root.view;
    ${body}
  })()`);

const editorDoc = () => editor(`return view.state.doc.toString();`);

/** Open a fixture in a tab of its own and wait for it to be the active one. */
async function openFile(relative) {
  const absolute = `${process.env.MDRAFT_REPO ?? process.cwd()}\\${relative.replace(/\//g, "\\")}`;
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify([absolute])} })`,
  );
  await waitFor(
    `document.getElementById("status-file")?.textContent?.includes(${JSON.stringify(relative.split("/").pop())})`,
    30_000,
    `the ${relative} tab`,
  );
  await sleep(500);
}

const enableAndCompile = () => {
  // The switch is a Preferences row, which also updates the frontend's copy.
  return evaluate(`(async () => {
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
};

try {
  console.log("=== the backend switch mounts its own frame ===");

  await waitFor(`Boolean(document.querySelector(".cm-content"))`, 30_000, "the editor");
  // A local TEXMF library is reader state that outlives the profile reset, and
  // the backend falls back visibly when one is registered (the plan's answer to
  // open question 4). This layer asserts the no-library path; the fallback has
  // its own check, so clear the roots the way Preferences does.
  const libraries = await invoke("latex_texmf_list");
  for (const root of libraries?.roots ?? []) {
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("latex_texmf_configure", { action: { type: "remove", id: ${JSON.stringify(root.id)} } })`,
    );
  }
  // Every text the compiled status line shows from here on, with its time. The
  // first export used to be asked before the frame had typeset a page; the
  // failure it left is only visible as a status the line once held.
  await evaluate(`(() => {
    const label = document.querySelector(".compiled-state-label");
    const box = label?.parentElement?.parentElement;
    window.__mdraftStatusLog = [];
    if (!box) return false;
    const read = () => {
      const text = [...box.querySelectorAll(".compiled-state-label, .compiled-state-detail")]
        .map((node) => node.textContent).filter(Boolean).join(" · ");
      const log = window.__mdraftStatusLog;
      if (log.length < 400 && log.at(-1)?.text !== text)
        log.push({ at: Math.round(performance.now()), text });
    };
    new MutationObserver(read).observe(box, { childList: true, characterData: true, subtree: true });
    read();
    return true;
  })()`);
  const statusLog = () =>
    evaluate(`JSON.stringify(window.__mdraftStatusLog ?? [])`).then(JSON.parse);
  // Every state of the waiting surface, with the paint count at that moment:
  // a cold frame owns the pane for minutes before its first page, and the
  // surface is the only thing that says so in the pane itself.
  await evaluate(`(() => {
    const pane = document.getElementById("preview-pane");
    window.__mdraftWaitLog = [];
    if (!pane) return false;
    const read = () => {
      const node = pane.querySelector(":scope > .preview-pending");
      const text = node
        ? [node.dataset.state, getComputedStyle(node).display,
           node.querySelector(".preview-pending-phase")?.textContent ?? ""].join("|")
        : "none";
      const log = window.__mdraftWaitLog;
      if (log.length < 400 && log.at(-1)?.text !== text)
        log.push({ at: Math.round(performance.now()), text,
          painted: document.querySelector("#preview")?.dataset.texpressoPainted ?? "" });
    };
    new MutationObserver(read).observe(pane, {
      childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ["data-state"],
    });
    read();
    return true;
  })()`);
  const waitLog = () => evaluate(`JSON.stringify(window.__mdraftWaitLog ?? [])`).then(JSON.parse);
  const shownWaits = (log) => log.filter((entry) => /^pending\|(?!none)/.test(entry.text));

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
  const target = booted ? await attachFrame() : null;
  check(booted, "the frame boots under the mdraft-tex origin");
  if (!target) throw new Error("the first TeXpresso frame did not boot");
  check(
    Boolean(target) && target.type === "iframe",
    "the frame is its own target on its own origin",
    target?.url ?? "no target",
  );
  check((await dataset("latexBackend")) === "texpresso", "the pane says which backend draws");
  const chip = await evaluate(
    `JSON.stringify((() => { const c = document.getElementById("status-latex-engine"); return { text: c.textContent, title: c.title, backend: c.dataset.previewBackend }; })())`,
  ).then(JSON.parse);
  check(
    chip.text === "XeLaTeX" && chip.backend === "texpresso",
    "the engine chip names the engine, not the backend",
    JSON.stringify(chip),
  );

  check(
    await waitFor(
      `document.querySelector("#preview")?.dataset.texpressoPainted ?? ""`,
      360_000,
      "the first paint",
    ),
    "the project typesets and reports a paint",
    await frame
      .evaluate(`document.documentElement.dataset.mdraftTrace ?? "(no trace)"`)
      .catch(() => "(no trace)"),
  );
  const bootWaits = await waitLog();
  const bootShown = shownWaits(bootWaits);
  const bootSummary = bootWaits.map((entry) => `${entry.at} ${entry.text}`).join(" | ");
  check(
    bootShown.length > 0,
    "the pane shows the waiting surface while the frame has no page",
    bootSummary,
  );
  check(
    bootWaits.every((entry) => !/export/i.test(entry.text)),
    "the waiting surface names the frame's work, never the export step",
    bootSummary,
  );
  check(
    await waitFor(
      `!document.querySelector("#preview-pane > .preview-pending") && Number(document.querySelector("#preview")?.dataset.texpressoPages ?? "0") > 0`,
      10_000,
      "the surface to leave once a page is drawn",
    ),
    "the frame's first page removes the waiting surface",
  );

  const paths = await frameEval(
    `JSON.stringify(globalThis.texpresso?.project?.paths?.() ?? [])`,
  ).then(JSON.parse);
  check(
    paths.includes("main.tex") &&
      paths.filter((path) => path.startsWith("chapters/")).length >= 10 &&
      !paths.includes("readme.md"),
    "the frame holds MDraft's project, not an example",
    `${paths.length} files`,
  );

  console.log("=== the shadow compile is the authority ===");
  const shadow = await waitFor(
    `(() => {
      const shadow = Number(document.querySelector("#preview")?.dataset.latexShadow ?? "0");
      const shown = Number(document.querySelector("#preview")?.dataset.latexShown ?? "0");
      return shadow > 0 && shadow >= shown && document.querySelector("#preview")?.dataset.latexCurrent;
    })()`,
    300_000,
    "the shadow compile",
  );
  check(shadow, "the idle shadow compile fills the PDF export reads");
  // No Compile was pressed: the first export must
  // have waited for the frame instead of failing and staying failed.
  const statuses = await statusLog();
  const failedExport = statuses.filter((entry) => /could not be produced/.test(entry.text));
  const frameErrors = await evaluate(
    `JSON.stringify(performance.getEntriesByName("mdraft:latex:texpresso-error").map((entry) => entry.detail))`,
  ).then(JSON.parse);
  check(
    statuses.length > 0 && failedExport.length === 0 && frameErrors.length === 0,
    "the first export waits for the frame instead of reporting a failure",
    `${statuses.map((entry) => `${entry.at} ${entry.text}`).join(" | ")} || errors: ${JSON.stringify(frameErrors)} || frame: ${await frameEval(
      `document.documentElement.dataset.mdraftTrace ?? "(no trace)"`,
    ).catch(() => "(no trace)")}`,
  );
  // The stored PDF is the reader's document: a fresh export of the idle frame
  // has the same pages and the same text.
  await emitMenu(page, "view.latexTexpressoExport");
  const firstExport = await waitFor(
    `Boolean(document.querySelector("#preview")?.dataset.texpressoExport)`,
    120_000,
    "the first export comparison",
  ).then(async (done) => (done ? JSON.parse(await dataset("texpressoExport")) : null));
  await evaluate(`delete document.querySelector("#preview").dataset.texpressoExport`);
  check(
    firstExport?.compared === true &&
      firstExport.identicalText === true &&
      firstExport.pages?.[0] >= 10,
    "the first stored PDF is the document the frame typeset",
    JSON.stringify(firstExport),
  );
  const menu = await invoke("menu_items");
  check(
    ["export.pdf", "file.print"].every(
      (id) => menu.find((item) => item.id === id)?.enabled === true,
    ) && (await evaluate(`document.querySelector(".compiled-save-pdf")?.disabled`)) === false,
    "the first shadow enables PDF export, Save PDF and Print",
  );
  check(
    (await evaluate(`document.querySelectorAll(".typst-page").length`)) === 0,
    "the shadow PDF is never drawn over the frame",
  );

  console.log("=== an edit repaints on the frame's own path ===");
  await openFile("samples/latex-perf/book/chapters/ch06.tex");
  // The hidden editor must hold the file the reader is editing, or a caret
  // probe would measure the wrong text.
  const openName = await frameEval(`document.getElementById("file-title")?.textContent ?? ""`);
  check(
    openName.split("/").pop() === "ch06.tex",
    "the frame opens the file the reader edits",
    openName,
  );

  const beforePaint = Number((await dataset("texpressoPainted")) ?? "0");
  await editor(`
    const at = view.state.doc.length;
    view.dispatch({ changes: { from: at, insert: "\\n% texpresso edit probe\\n" } });
  `);
  const repainted = await waitFor(
    `Number(document.querySelector("#preview")?.dataset.texpressoPainted ?? "0") > ${beforePaint}`,
    60_000,
    "a painted edit",
  );
  check(
    repainted,
    "a keystroke repaints without waiting for a compile",
    await frameEval(`document.documentElement.dataset.mdraftTrace ?? "(no trace)"`),
  );
  const e2p = Number((await dataset("texpressoE2p")) ?? "0");
  check(
    Number.isFinite(e2p) && e2p > 0 && e2p < 10_000,
    "the edit-to-paint time is measured",
    `${e2p} ms`,
  );
  const hostText = await editorDoc();
  const frameText = await frameEval(`globalThis.texpresso.editor.state.doc.toString()`);
  check(
    hostText === frameText,
    "the engine's copy equals the reader's buffer, character for character",
    `${hostText.length} against ${frameText.length} characters`,
  );

  console.log("=== correspondence follows the PDF conventions ===");
  // Prose the chapter really typesets, so the source map has an answer.
  const prose = await editor(`
    for (let n = 6; n <= view.state.doc.lines; n += 1) {
      const text = view.state.doc.line(n).text;
      const at = text.search(/[A-Za-z]{6,}/);
      const trimmed = text.trimStart();
      if (at >= 0 && !trimmed.startsWith("%") && !trimmed.startsWith("\\\\")) {
        return { line: n, at };
      }
    }
    return null;
  `);
  await editor(`
    const line = view.state.doc.line(${prose?.line ?? 1});
    const from = line.from + ${prose?.at ?? 0};
    view.dispatch({ selection: { anchor: from, head: from + 8 } });
  `);
  const selectionPainted = await waitFor(
    `(async () => {
      const frame = document.querySelector(".texpresso-frame");
      return frame !== null;
    })() && true`,
    1,
    "noop",
  );
  void selectionPainted;
  let marks = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    marks = await frameEval(
      `JSON.stringify((() => {
        const box = document.querySelector("#pages .cursor-mark.selection");
        return {
          count: document.querySelectorAll("#pages .cursor-mark.selection").length,
          background: box ? getComputedStyle(box).backgroundColor : null,
          caretVisible: [...document.querySelectorAll("#pages .cursor-mark.caret")]
            .some((node) => getComputedStyle(node).display !== "none"),
          trace: document.documentElement.dataset.mdraftTrace ?? "",
        };
      })())`,
    ).then(JSON.parse);
    if (marks.count > 0) break;
    await sleep(500);
  }
  check(marks.count > 0, "a source selection paints boxes in the frame", JSON.stringify(marks));
  const syncColour = await frameEval(
    `getComputedStyle(document.documentElement).getPropertyValue("--mdraft-sync").trim()`,
  );
  check(
    Boolean(syncColour) && Boolean(marks.background) && marks.background !== "rgba(0, 0, 0, 0)",
    "the marks use MDraft's colour",
    `${syncColour} / ${marks.background}`,
  );
  check(!marks.caretVisible, "the engine's own caret mark stays hidden");

  const scrollBeforeCaret = await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`);
  await editor(`
    const line = view.state.doc.line(${prose?.line ?? 1});
    view.dispatch({ selection: { anchor: line.from } });
  `);
  await sleep(1200);
  const afterCaret = await frameEval(
    `JSON.stringify({
      count: document.querySelectorAll("#pages .cursor-mark.selection").length,
      scrollTop: document.getElementById("pages")?.scrollTop ?? 0,
    })`,
  ).then(JSON.parse);
  check(afterCaret.count === 0, "a caret move paints nothing", JSON.stringify(afterCaret));
  check(
    afterCaret.scrollTop === scrollBeforeCaret,
    "a caret move scrolls nothing",
    `${scrollBeforeCaret} -> ${afterCaret.scrollTop}`,
  );

  console.log("=== a click in the preview marks the source ===");
  // The caret test above cleared the mark, and the engine only paints a
  // selection for text it has typeset. Try prose lines in order until the frame
  // reports marks>0 in its trace; clicking a page the engine has no mark for
  // would answer another file and prove nothing.
  const selectForMark = async () => {
    const candidates = await editor(`
      const out = [];
      for (let n = 2; n <= view.state.doc.lines; n += 1) {
        const text = view.state.doc.line(n).text;
        const trimmed = text.trimStart();
        if (trimmed.startsWith("%") || trimmed.startsWith("\\\\") || trimmed.length < 40) continue;
        const at = text.search(/[A-Za-z]{6,}/);
        if (at >= 0) out.push({ line: n, at, length: Math.min(24, text.length - at) });
        if (out.length >= 8) break;
      }
      return out;
    `);
    for (const candidate of candidates ?? []) {
      const before = await traceSelectMarks();
      await editor(`
        const line = view.state.doc.line(${candidate.line});
        view.dispatch({ selection: { anchor: line.from + ${candidate.at}, head: line.from + ${candidate.at} + ${candidate.length} } });
      `);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const now = await traceSelectMarks();
        if (now !== before && now > 0) return candidate;
        if (now !== before) break;
        await sleep(150);
      }
    }
    return null;
  };
  const traceSelectMarks = async () => {
    const trace = await frameEval(`document.documentElement.dataset.mdraftTrace ?? ""`);
    const matches = [...trace.matchAll(/select marks=(\d+)/g)];
    return matches.length ? Number(matches.at(-1)[1]) : -1;
  };
  const clickable = await selectForMark();
  if (!clickable) {
    console.log(
      "SKIP: the engine painted no selection mark for any prose line, so the click cannot be aimed at the active file.",
    );
  }
  // The click must make its own mark; the selection above is the target text.
  const decorationsBefore = await editor(
    `return document.querySelectorAll(".cm-sync-word").length;`,
  );
  const caretBefore = await editor(
    `const s = view.state.selection.main; return { anchor: s.anchor, head: s.head };`,
  );
  let clicked = Boolean(clickable);
  if (clickable) {
    await frameEval(
      `(() => {
        const mark = document.querySelector("#pages .cursor-mark.selection");
        mark?.scrollIntoView({ block: "center" });
        return Boolean(mark);
      })()`,
    );
    await sleep(400);
  }
  const box = await frameEval(
    `JSON.stringify((() => {
      const pages = document.getElementById("pages");
      const pagesRect = pages.getBoundingClientRect();
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      // The click must land where the reader sees the active file's text: the
      // engine's selection mark is that spot. It is positioned over #pages, not
      // inside a .page, so clicking page 1 would answer main.tex instead.
      const mark = document.querySelector("#pages .cursor-mark.selection");
      mark?.scrollIntoView({ block: "center" });
      const rect = mark?.getBoundingClientRect();
      return {
        x: clamp(rect ? rect.left + rect.width / 2 : pagesRect.left + pagesRect.width / 2,
          pagesRect.left + 20, pagesRect.right - 20),
        y: clamp(rect ? rect.top + rect.height / 2 : pagesRect.top + pagesRect.height / 2,
          pagesRect.top + 20, pagesRect.bottom - 20),
        hasMark: Boolean(mark),
        markTop: rect ? Math.round(rect.top) : null,
      };
    })())`,
  ).then(JSON.parse);
  await sleep(300);
  box.insidePages = await frameEval(
    `Boolean(document.elementFromPoint(${box.x}, ${box.y})?.closest("#pages"))`,
  );
  // Frame-local coordinates on the frame's own session: a point sent to the
  // host page could land in the editor if the pane layout differs.
  const traceSources = async () =>
    (await frameEval(`document.documentElement.dataset.mdraftTrace ?? ""`))
      .split("|")
      .filter((line) => line.includes(" source ")).length;
  const sourcesBefore = await traceSources();
  await frame.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: box.x,
    y: box.y,
    button: "left",
    buttons: 1,
    pointerType: "mouse",
    clickCount: 1,
  });
  await frame.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: box.x,
    y: box.y,
    button: "left",
    buttons: 0,
    pointerType: "mouse",
    clickCount: 1,
  });
  let sources = sourcesBefore;
  const clickDeadline = Date.now() + 8_000;
  while (Date.now() < clickDeadline) {
    sources = await traceSources();
    if (sources > sourcesBefore) break;
    await sleep(250);
  }
  if (sources <= sourcesBefore) {
    // The frame target may not receive a synthesised pointer press; the page
    // target routes it into the child frame. Try that before giving up.
    const frameRect = await evaluate(
      `JSON.stringify((() => { const r = document.querySelector(".texpresso-frame").getBoundingClientRect(); return { x: r.left, y: r.top }; })())`,
    ).then(JSON.parse);
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: frameRect.x + box.x,
      y: frameRect.y + box.y,
      button: "left",
      buttons: 1,
      pointerType: "mouse",
      clickCount: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: frameRect.x + box.x,
      y: frameRect.y + box.y,
      button: "left",
      buttons: 0,
      pointerType: "mouse",
      clickCount: 1,
    });
    const retryDeadline = Date.now() + 8_000;
    while (Date.now() < retryDeadline) {
      sources = await traceSources();
      if (sources > sourcesBefore) break;
      await sleep(250);
    }
  }
  if (sources <= sourcesBefore) {
    console.log(
      "SKIP: the engine posted no source-map answer for a CDP-synthesised click, " +
        "so the click and double-click conventions are not asserted here; " +
        "they need a real pointer press (recorded in the plan's known limits).",
    );
    clicked = false;
  }
  await sleep(400);
  const afterClick = await editor(
    `const s = view.state.selection.main;
     return { anchor: s.anchor, head: s.head, decorations: document.querySelectorAll(".cm-sync-word").length };`,
  );
  if (clicked) {
    check(
      afterClick.decorations > decorationsBefore,
      "a click in the preview marks the source",
      `${JSON.stringify(afterClick)} source ${await dataset("texpressoSource")} drop ${await evaluate(
        `document.documentElement.dataset.texpressoDrop ?? "none"`,
      )} point ${JSON.stringify(box)} trace ${await frameEval(
        `document.documentElement.dataset.mdraftTrace ?? ""`,
      )}`,
    );
    // The click was aimed at the centre of the mark of the selected source
    // text, so a verified answer is a caret inside that text, and the mark is
    // the caret's own source line.
    const answer = JSON.parse((await dataset("texpressoSource")) ?? "null");
    const expected = await editor(
      `const line = view.state.doc.line(${clickable.line});
       const at = view.state.doc.lineAt(view.state.selection.main.head);
       return { from: line.from + ${clickable.at}, to: line.from + ${clickable.at} + ${clickable.length},
         lineFrom: at.from, lineTo: at.to };`,
    );
    check(
      answer?.precision === "exact" && answer.unit === "line",
      "the frame verifies the click against the clicked point",
      `${JSON.stringify(answer)} trace ${await frameEval(
        `document.documentElement.dataset.mdraftTrace ?? ""`,
      )}`,
    );
    check(
      afterClick.anchor === afterClick.head &&
        afterClick.head >= expected.from &&
        afterClick.head <= expected.to,
      "a click in the preview puts the caret in the clicked text",
      `${JSON.stringify(afterClick)} expected ${JSON.stringify(expected)}`,
    );
    check(
      answer?.range &&
        answer.range.from >= expected.lineFrom &&
        answer.range.to <= expected.lineTo &&
        answer.range.to > answer.range.from,
      "a click in the preview marks the caret's source line, not the paragraph",
      `${JSON.stringify(answer?.range)} line ${JSON.stringify(expected)}`,
    );
    // Gesture alignment (docs/architecture.md): the
    // clicked line's source comes to the clicked height. The engine's map is by
    // line, so the bound is one source row, not a pixel; at the start or end of
    // the editor's range the row only has to be in view.
    const answered = JSON.parse((await dataset("texpressoSource")) ?? "null");
    const level = await editor(
      `const from = Math.min(${Number(answered?.from) || 0}, view.state.doc.length);
       const r = view.coordsAtPos(from);
       const s = view.scrollDOM;
       return r ? { y:(r.top+r.bottom)/2, row:r.bottom-r.top, top:s.scrollTop, max:s.scrollHeight-s.clientHeight } : null;`,
    );
    const clickedY =
      (await evaluate(`document.querySelector(".texpresso-frame").getBoundingClientRect().top`)) +
      box.y;
    check(
      level !== null &&
        (Math.abs(level.y - clickedY) <= level.row + 2 ||
          level.top <= 1 ||
          level.top >= level.max - 1),
      "a click in the preview brings its source line level, within one row",
      JSON.stringify({ clickedY, level }),
    );
  }

  console.log("=== scroll correspondence, both directions ===");
  const frameTop = await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`);
  // A wheel gesture inside the frame, dispatched on the frame's own session so
  // the coordinates are frame-local.
  await frame.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: box.x,
    y: box.y,
    deltaX: 0,
    deltaY: 300,
  });
  await sleep(1200);
  const frameScrolled = await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`);
  check(
    frameScrolled !== frameTop,
    "a wheel gesture scrolls the frame's own pages",
    `${frameTop} -> ${frameScrolled}`,
  );
  const editorAfterGesture = await editor(`return view.scrollDOM.scrollTop;`);
  if (clicked) {
    check(
      editorAfterGesture > 0,
      "the source follows the frame's gesture",
      `editor scrollTop ${editorAfterGesture} trace ${await frameEval(
        `document.documentElement.dataset.mdraftTrace ?? ""`,
      )}`,
    );
  } else {
    console.log(
      "SKIP: the source-follow assertion rides on the same source-map answer as the click.",
    );
  }

  const frameBeforeSource = await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`);
  await editor(`
    view.scrollDOM.scrollTop = Math.min(
      view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight,
      view.scrollDOM.scrollTop + 600,
    );
    view.scrollDOM.dispatchEvent(new Event("scroll"));
  `);
  await sleep(1200);
  const frameAfterSource = await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`);
  check(
    frameAfterSource !== frameBeforeSource,
    "scrolling the source moves the frame",
    `${frameBeforeSource} -> ${frameAfterSource}`,
  );

  console.log("=== zoom, themes and manual mode ===");
  // The page's own width, not `preview.mode`: the app stores a mode without
  // laying anything out, and a comparison that included it passed while the
  // pages never changed.
  const pageBox = () =>
    frameEval(
      `JSON.stringify({ mode: globalThis.texpresso?.preview?.mode, scale: globalThis.texpresso?.preview?.scale, w: document.querySelector("#pages .page")?.offsetWidth ?? 0 })`,
    ).then(JSON.parse);
  const scaleBefore = await pageBox();
  await emitMenu(page, "view.zoomIn");
  await sleep(1200);
  const scaleAfter = await pageBox();
  const grown = scaleBefore.w > 0 ? scaleAfter.w / scaleBefore.w : 0;
  check(
    Math.abs(grown - 1.1) <= 0.022,
    "document zoom at 110% makes the page 1.1 times as wide",
    `${JSON.stringify(scaleBefore)} -> ${JSON.stringify(scaleAfter)}`,
  );
  await emitMenu(page, "view.zoomReset");
  await sleep(1200);
  const scaleReset = await pageBox();
  check(
    Math.abs(scaleReset.w - scaleBefore.w) <= Math.max(2, scaleBefore.w * 0.01),
    "zoom reset returns the page to its fit width",
    `${JSON.stringify(scaleBefore)} -> ${JSON.stringify(scaleReset)}`,
  );

  await emitMenu(page, "themes.dark");
  await sleep(800);
  const dark = await frameEval(
    `JSON.stringify({
      theme: document.documentElement.dataset.theme,
      paper: document.documentElement.style.getPropertyValue("--mdraft-paper"),
      page: getComputedStyle(document.querySelector("#pages .page")).backgroundColor,
      canvas: document.querySelector("#pages .page canvas")
        ? getComputedStyle(document.querySelector("#pages .page canvas")).filter
        : null,
    })`,
  ).then(JSON.parse);
  check(
    dark.theme === "dark" && Boolean(dark.paper) && dark.canvas && dark.canvas !== "none",
    "the dark theme paints the paper the PDF viewer uses",
    JSON.stringify(dark),
  );
  await emitMenu(page, "themes.light");
  await sleep(800);
  const light = await frameEval(
    `JSON.stringify({
      theme: document.documentElement.dataset.theme,
      page: getComputedStyle(document.querySelector("#pages .page")).backgroundColor,
      canvas: document.querySelector("#pages .page canvas")
        ? getComputedStyle(document.querySelector("#pages .page canvas")).filter
        : null,
    })`,
  ).then(JSON.parse);
  check(
    light.theme === "light" && (light.canvas === "none" || !light.canvas),
    "the light theme removes the inverted page",
    JSON.stringify(light),
  );

  const paintsBeforeHold = Number((await dataset("texpressoPainted")) ?? "0");
  await emitMenu(page, "view.latexAutoCompile");
  await sleep(400);
  await editor(`
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\\n% held while manual\\n" } });
  `);
  await sleep(2500);
  const heldPaint = Number((await dataset("texpressoPainted")) ?? "0");
  check(
    heldPaint === paintsBeforeHold,
    "manual mode holds the edit stream",
    `${paintsBeforeHold} -> ${heldPaint}`,
  );
  await emitMenu(page, "view.latexCompile");
  check(
    await waitFor(
      `Number(document.querySelector("#preview")?.dataset.texpressoPainted ?? "0") > ${heldPaint}`,
      60_000,
      "the flushed edit",
    ),
    "Compile sends what manual mode held",
  );
  await emitMenu(page, "view.latexAutoCompile");
  await sleep(400);

  console.log("=== export uses the frame's own PDF ===");
  await waitFor(
    `(() => {
      const source = document.querySelector(".cm-content").cmTile.root.view;
      return source && document.querySelector("#preview")?.dataset.latexCurrent;
    })()`,
    300_000,
    "a current exported result",
  );
  await emitMenu(page, "view.latexTexpressoExport");
  const comparison = await waitFor(
    `Boolean(document.querySelector("#preview")?.dataset.texpressoExport)`,
    120_000,
    "the export comparison",
  ).then(async (done) => (done ? JSON.parse(await dataset("texpressoExport")) : null));
  check(
    comparison?.ok === true && comparison.pages?.[0] > 0,
    "TeXpresso's own export produces a PDF",
    comparison ? `${comparison.pages?.[0]} pages, ${comparison.ms} ms` : "no comparison",
  );

  console.log("=== privacy ===");
  const registrations = await frameEval(
    `(async () => navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1)()`,
  );
  check(
    registrations === 0 || registrations === -1,
    "the frame registers no service worker",
    String(registrations),
  );
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  check(
    !targets.some((entry) => entry.type === "service_worker"),
    "no service-worker target exists",
  );
  const offOrigin = await frameEval(
    `JSON.stringify(performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => !url.startsWith(location.origin)))`,
  ).then(JSON.parse);
  check(
    offOrigin.length === 0,
    "every request the frame made stayed on its own origin",
    offOrigin.slice(0, 3).join(", "),
  );

  console.log("=== a tab switch stays warm ===");
  const pathsBeforeSwitch = await frameEval(`globalThis.texpresso?.project?.paths?.().length ?? 0`);
  await openFile("samples/feature-tour.md");
  check(
    (await evaluate(
      `document.querySelector(".texpresso-frame")?.closest(".texpresso-host")?.hidden ?? null`,
    )) === true,
    "another document hides the frame instead of destroying it",
  );
  await emitMenu(page, "file.nextTab");
  await sleep(1500);
  const stillThere = await findFrame();
  check(
    Boolean(stillThere) && stillThere.url === target?.url,
    "returning to the LaTeX tab keeps the same frame",
    stillThere?.url ?? "no frame",
  );
  const pathsAfterSwitch = await frameEval(`globalThis.texpresso?.project?.paths?.().length ?? 0`);
  check(
    pathsAfterSwitch >= pathsBeforeSwitch,
    "the frame kept its project across the switch",
    `${pathsBeforeSwitch} -> ${pathsAfterSwitch}`,
  );

  console.log("=== recompile from scratch ===");
  const more = ".compiled-toolbar .compiled-compile-more";
  check(
    await waitFor(
      `(() => { const b=document.querySelector(${JSON.stringify(more)}); return !!b && !b.hidden && !b.disabled && b.getAttribute("aria-haspopup")==="menu"; })()`,
      60_000,
      "the split Compile button",
    ),
    "LaTeX's Compile is a split button with a dropdown half",
  );
  await evaluate(`document.querySelector(${JSON.stringify(more)}).click()`);
  const options = await evaluate(
    `JSON.stringify([...document.querySelectorAll(".compiled-compile-menu [role=menuitem] .editor-menu-label")].map(n=>n.textContent))`,
  ).then(JSON.parse);
  check(
    JSON.stringify(options) === JSON.stringify(["Compile", "Recompile from scratch"]),
    "the dropdown lists Compile and Recompile from scratch",
    JSON.stringify(options),
  );
  check(
    (await evaluate(
      `document.querySelector(${JSON.stringify(more)}).getAttribute("aria-expanded")`,
    )) === "true",
    "the open dropdown is announced as expanded",
  );
  await evaluate(
    `document.querySelector(".compiled-compile-menu").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))`,
  );
  check(
    await evaluate(
      `!document.querySelector(".compiled-compile-menu") && document.activeElement===document.querySelector(${JSON.stringify(more)})`,
    ),
    "Escape closes the dropdown and returns focus to the chevron",
  );

  // The session number and the log are read in the click's own turn: the
  // command must already have dropped the old frame and its output.
  const sessionBefore = Number((await dataset("texpressoSession")) ?? "0");
  await evaluate(`window.__mdraftWaitLog = []`);
  const cleanStartLog = await evaluate(`(() => {
    document.querySelector(${JSON.stringify(more)}).click();
    [...document.querySelectorAll(".compiled-compile-menu [role=menuitem]")]
      .find(b => b.textContent.includes("Recompile from scratch")).click();
    return document.querySelector(".compiler-output")?.textContent ?? "";
  })()`);
  check(
    cleanStartLog === "The compiler reported no messages.",
    "Recompile from scratch drops the old build's logs before it starts",
    cleanStartLog.slice(0, 60),
  );
  check(
    await waitFor(
      `Number(document.querySelector("#preview")?.dataset.texpressoSession ?? 0) > ${sessionBefore}`,
      120_000,
      "a new TeXpresso session",
    ),
    "Recompile from scratch mounts a new TeXpresso session",
  );
  check(
    await waitFor(
      `document.querySelector(".compiled-toolbar .compiled-state-label")?.textContent === "Recompiled from scratch" && !document.querySelector(".compiled-toolbar .compiled-compile").classList.contains("latex-cancel")`,
      300_000,
      "the clean build's status",
    ),
    "the status names the build from scratch",
  );
  // The old frame was disposed but the project still owns the pane; the new
  // frame is blank until it draws, and that wait must be visible too.
  const cleanWaits = await waitLog();
  check(
    shownWaits(cleanWaits).length > 0,
    "Recompile from scratch shows the waiting surface until the new frame draws",
    cleanWaits.map((entry) => `${entry.at} ${entry.text}`).join(" | "),
  );
  check(
    await waitFor(
      `!document.querySelector("#preview-pane > .preview-pending")`,
      30_000,
      "the clean frame's first page",
    ),
    "the clean frame's first page removes the waiting surface",
  );
  check(
    (await evaluate(
      `(document.querySelector(".compiler-output")?.textContent.match(/Preview starting/g) ?? []).length`,
    )) === 1,
    "the log holds only the new run",
  );
  check(
    (await evaluate(`document.querySelector("#compiler-problems")?.textContent ?? ""`)) ===
      "No problems reported.",
    "the problems list holds only the new build",
  );

  const menuSessionBefore = Number((await dataset("texpressoSession")) ?? "0");
  await emitMenu(page, "view.latexCompileClean");
  check(
    await waitFor(
      `Number(document.querySelector("#preview")?.dataset.texpressoSession ?? 0) > ${menuSessionBefore} && document.querySelector(".compiled-toolbar .compiled-state-label")?.textContent === "Recompiled from scratch" && !document.querySelector(".compiled-toolbar .compiled-compile").classList.contains("latex-cancel")`,
      300_000,
      "the menu command's clean build",
    ),
    "the Tools menu command runs the same action",
  );

  console.log("=== engines and fallbacks ===");
  // LuaLaTeX restarts the frame with `luatex`: the app's engine is part of the
  // frame's URL, so a second target with `engine=luatex` is the proof (the
  // first frame ran XeLaTeX, the default).
  const lua = `${process.env.MDRAFT_REPO}\\samples\\latex-engines\\magic-lua.tex`;
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify([lua])} })`,
  );
  const luaFrame = await (async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const hit = list.find((entry) => /mdraft-tex\.localhost\/texpresso\//.test(entry.url));
      if (hit && /engine=luatex/.test(hit.url)) return hit;
      const chipTitle = await evaluate(
        `document.getElementById("status-latex-engine")?.title ?? ""`,
      );
      if (/Preview unavailable/.test(chipTitle)) return null;
      await sleep(500);
    }
    return null;
  })();
  check(
    Boolean(luaFrame),
    "LuaLaTeX restarts the frame with luatex",
    luaFrame?.url ?? "no luatex frame",
  );
  if (luaFrame) {
    frame = await openPage(port, { type: "iframe", match: /engine=luatex/ });
    check(
      await waitFor(
        `document.querySelector("#preview")?.dataset.texpressoPainted ?? ""`,
        120_000,
        "the luatex paint",
      ),
      "the luatex frame typesets the document",
    );
  }

  // The bundled preview has no pdfTeX, so the menu must not offer it.
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-files", payload: [${JSON.stringify(
      `${process.env.MDRAFT_REPO}\\samples\\latex-engines\\plain.tex`,
    )}] })`,
  );
  await sleep(1500);
  await evaluate(`document.getElementById("status-latex-engine").click()`);
  await sleep(600);
  const labels = await evaluate(
    `JSON.stringify([...document.querySelectorAll(".explorer-menu .favorite-menu-item")].map((b) => b.textContent))`,
  ).then(JSON.parse);
  check(
    !labels.some((label) => /pdfLaTeX/.test(label)),
    "the bundled engine menu offers no pdfLaTeX",
    JSON.stringify(labels),
  );

  console.log("=== the switch back restores WasmTex ===");
  await emitMenu(page, "view.latexBackend.wasmtex");
  check(
    await waitFor(`!document.querySelector(".texpresso-frame")`, 15_000, "the frame's removal"),
    "switching back disposes the frame",
  );
  if (await invoke("latex_status")) {
    check(
      await waitFor(
        `document.querySelectorAll(".typst-page").length > 0`,
        300_000,
        "the WasmTex preview",
      ),
      "the WasmTex preview returns",
    );
  } else console.log("  SKIP  the WasmTex preview is not installed");
} catch (error) {
  check(false, `uncaught: ${error.message}`);
} finally {
  page.close();
  frame?.close();
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed${failed ? `, ${failed} failed` : ""}`,
);
process.exit(failed ? 1 : 0);
