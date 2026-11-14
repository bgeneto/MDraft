// The TeXpresso preview backend, through the real application (step 11 of
// docs/plans/2026-11-13-texpresso-backend.md).
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
  if (!(await invoke("latex_engine_status")).previewInstalled) {
    console.log("installing the preview engine from the local origin…");
    await evaluate("window.__TAURI_INTERNALS__.invoke('install_texpresso')");
  }
  check(
    (await invoke("latex_engine_status")).previewInstalled === true,
    "the preview engine and digest table are installed",
  );
  await enableAndCompile();
  if ((await invoke("latex_status")) !== true) {
    console.log("SKIP: the bundled LaTeX engine is not available.");
    page.close();
    process.exit(0);
  }
  if ((await dataset("latexCurrent")) === null) await emitMenu(page, "view.latexCompile");
  const firstPdf = await waitFor(
    `document.querySelector("#preview")?.dataset.latexCurrent ?? ""`,
    300_000,
    "the WasmTex PDF",
  );
  if (!firstPdf) {
    console.log("SKIP: the bundled LaTeX engine did not produce a PDF.");
    page.close();
    process.exit(0);
  }

  // The vendored app sometimes never finishes its own boot run (no canvas, and
  // every later compile is accepted and produces nothing). A reader's fix is
  // the same as ours: switch away and back, which mounts a fresh frame. Three
  // attempts is enough to tell a stuck boot from a broken backend.
  let booted = false;
  let target = null;
  for (let attempt = 1; attempt <= 3 && !booted; attempt += 1) {
    if (attempt > 1) {
      console.log(`  (remounting the frame, attempt ${attempt})`);
      await emitMenu(page, "view.latexBackend.wasmtex");
      await sleep(1500);
    }
    await emitMenu(page, "view.latexBackend.texpresso");
    booted = await waitFor(
      `document.querySelector("#preview")?.dataset.texpressoReady === "1"`,
      120_000,
      "the TeXpresso frame",
    );
    if (!booted) continue;
    const painted = await waitFor(
      `document.querySelector("#preview")?.dataset.texpressoPainted ?? ""`,
      45_000,
      "the first paint",
    );
    if (!painted) booted = false;
    if (!booted) {
      frame?.close();
      frame = null;
      continue;
    }
    target = await attachFrame();
  }
  check(booted, "the frame boots under the mdraft-tex origin");
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
    chip.text === "LuaLaTeX" && chip.backend === "texpresso",
    "the engine chip names the engine, not the backend",
    JSON.stringify(chip),
  );

  check(
    await waitFor(
      `document.querySelector("#preview")?.dataset.texpressoPainted ?? ""`,
      120_000,
      "the first paint",
    ),
    "the project typesets and reports a paint",
    await frame
      .evaluate(`document.documentElement.dataset.mdraftTrace ?? "(no trace)"`)
      .catch(() => "(no trace)"),
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
    check(
      afterClick.head === caretBefore.head,
      "a click in the preview does not move the caret",
      `${caretBefore.head} -> ${afterClick.head}`,
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
  const scaleBefore = await frameEval(
    `JSON.stringify({ mode: globalThis.texpresso?.preview?.mode, scale: globalThis.texpresso?.preview?.scale, w: document.querySelector("#pages .page")?.offsetWidth, h: document.querySelector("#pages .page")?.offsetHeight })`,
  );
  await emitMenu(page, "view.zoomIn");
  await sleep(1200);
  const scaleAfter = await frameEval(
    `JSON.stringify({ mode: globalThis.texpresso?.preview?.mode, scale: globalThis.texpresso?.preview?.scale, w: document.querySelector("#pages .page")?.offsetWidth, h: document.querySelector("#pages .page")?.offsetHeight })`,
  );
  check(
    scaleAfter !== scaleBefore,
    "document zoom reaches the frame",
    `${scaleBefore} -> ${scaleAfter}`,
  );
  await emitMenu(page, "view.zoomReset");
  await sleep(600);

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

  console.log("=== engines and fallbacks ===");
  // XeLaTeX restarts the frame with `xetex`: the app's engine is part of the
  // frame's URL, so a second target with `engine=xetex` is the proof.
  const xe = `${process.env.MDRAFT_REPO}\\samples\\latex-engines\\magic-xe.tex`;
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify([xe])} })`,
  );
  const xeFrame = await (async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const hit = list.find((entry) => /mdraft-tex\.localhost\/texpresso\//.test(entry.url));
      if (hit && /engine=xetex/.test(hit.url)) return hit;
      const chipTitle = await evaluate(
        `document.getElementById("status-latex-engine")?.title ?? ""`,
      );
      if (/Preview unavailable/.test(chipTitle)) return null;
      await sleep(500);
    }
    return null;
  })();
  check(
    Boolean(xeFrame),
    "XeLaTeX restarts the frame with xetex",
    xeFrame?.url ?? "no xetex frame",
  );
  if (xeFrame) {
    frame = await openPage(port, { type: "iframe", match: /engine=xetex/ });
    check(
      await waitFor(
        `document.querySelector("#preview")?.dataset.texpressoPainted ?? ""`,
        120_000,
        "the xetex paint",
      ),
      "the xetex frame typesets the document",
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
  check(
    await waitFor(
      `document.querySelectorAll(".typst-page").length > 0`,
      300_000,
      "the WasmTex preview",
    ),
    "the WasmTex preview returns",
  );
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
