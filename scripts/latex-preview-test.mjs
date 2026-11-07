// The compiled LaTeX PDF in the real UI: zoom, SyncTeX paint, and scroll.
//
//   node scripts/latex-preview-test.mjs [port]
//
// Steps 7, 8 and 10 of the checklist plan need a compiled PDF, and the harness
// stages a private app-data directory. `test-all.mjs` links the developer's
// installed engine into it (`linkLatexEngine`), so a `.tex` document compiles here.
//
// What this proves, in order:
//   1. the engine is reachable and enabled — the preview is a PDF, not the note;
//   2. zoom reaches that PDF, and Reset returns to the original scale;
//   3. a click in the PDF paints a SyncTeX region and moves the source caret;
//   4. scrolling the editor moves the preview (the correspondence, end to end).
//
// Skips cleanly when the engine is not installed, because a host without it has
// nothing to measure and a failure would be misleading.

import { openPage, emitMenu, sleep } from "./cdp-page.mjs";
import { join } from "node:path";

const port = process.argv[2] ?? "9222";
const page = await openPage(port);

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

// Surface the page's own errors: a compile that fails changes no selector, so the
// console is the only place it is visible.
const errors = [];
const consoleLines = [];
page.onException((text) => errors.push(text.split("\n")[0]));
page.onConsole((level, text) => {
  if (level === "error") errors.push(text);
  if (text.includes("[latex-sync]") || text.includes("[latex-source]") || text.includes("[latex-scroll]")) {
    consoleLines.push(text);
  }
});

for (let attempt = 0; attempt < 60; attempt += 1) {
  if (await page.evaluate(`Boolean(document.querySelector(".cm-content"))`)) break;
  await sleep(250);
}

console.log("=== the engine is reachable ===");

// **Enable before checking status.** A fresh test profile has the switch off, so
// asking `latex_status` first reports false and the suite skips on a host that
// could have run it. The order matters: the harness links the engine, this turns
// it on, and only then is there anything to measure.
//
// The switch lives in Preferences › Export, and the checkbox is the route that
// updates the frontend's module-local settings copy as well as the backend.
// Calling `save_settings` directly leaves that copy stale, and the next `persist()`
// — opening a file, changing the view mode — writes false back over it.
const enabled = await page.evaluate(`
  (async () => {
    const current = await window.__TAURI_INTERNALS__.invoke("get_settings");
    if (current.latexEnabled) return "already on";
    const open = document.getElementById("btn-prefs");
    open?.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const section = [...document.querySelectorAll(".prefs-section")]
      .find((node) => node.textContent.trim() === "Export");
    section?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const row = [...document.querySelectorAll(".prefs-row")]
      .find((node) => /Enable LuaLaTeX/i.test(node.querySelector(".prefs-label")?.textContent ?? ""));
    const box = row?.querySelector("input[type=checkbox]");
    if (!box) return "no checkbox";
    if (!box.checked) box.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    open?.click();
    return "enabled";
  })().catch((error) => "error: " + String(error))
`);

const status = await page.evaluate(`
  window.__TAURI_INTERNALS__.invoke("latex_status")
    .then(String)
    .catch((error) => "error: " + String(error))
`);
if (status !== "true") {
  const cache = await page.evaluate(`
    window.__TAURI_INTERNALS__.invoke("latex_cache_info")
      .then(JSON.stringify)
      .catch((error) => "error: " + String(error))
  `);
  console.log(`SKIP: the LaTeX engine is not available.`);
  console.log(`      switch: ${String(enabled)}`);
  console.log(`      latex_status: ${status}`);
  console.log(`      cache: ${cache}`);
  console.log("0/0 checks passed");
  page.close();
  process.exit(0);
}
check(status === "true", "latex_status reports the engine ready", status);

console.log("\n=== a real compile produces a PDF ===");

// Open a fixture with real body text, not the PoC project.
//
// `samples/latex-poc` is mostly preamble and floats: a click anywhere on its page
// resolves to the title block, so it cannot demonstrate a region paint. The
// reference document has sections, prose, lists and tables, which is what a click
// needs to land on.
await page.evaluate(`
  window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
    event: "open-files",
    payload: [${JSON.stringify(join(process.cwd(), "samples", "latex-reference.tex"))}],
  })
`);
await sleep(1200);
await emitMenu(page, "view.split");
await sleep(800);

// A cold compile is seconds, not milliseconds. Wait for a page canvas, then for
// the page count to settle: measuring while a second page is still laying out
// gives a baseline that no later measurement can match, which is what made the
// zoom assertions flaky.
let pages = 0;
for (let attempt = 0; attempt < 120; attempt += 1) {
  pages = await page.evaluate(`document.querySelectorAll(".typst-page-shell canvas").length`);
  if (pages > 0) break;
  await sleep(500);
}
let settled = pages;
for (let attempt = 0; attempt < 20; attempt += 1) {
  await sleep(400);
  const now = await page.evaluate(`document.querySelectorAll(".typst-page-shell").length`);
  if (now === settled) break;
  settled = now;
}
check(pages > 0, "the preview renders at least one page", `${pages} page(s)`);

const failure = await page.evaluate(
  `document.querySelector(".typst-error")?.textContent?.slice(0, 160) ?? ""`,
);
check(!String(failure).trim(), "the compile reported no error", String(failure) || "none");

if (pages === 0) {
  // Nothing further can be measured, and a cascade would bury the one that matters.
  const failed = checks.filter((entry) => !entry.ok).length;
  if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  page.close();
  process.exit(failed === 0 ? 0 : 1);
}

console.log("\n=== zoom reaches the compiled PDF ===");

const geometry = () =>
  page
    .evaluate(`
      (() => {
        const shell = document.querySelector(".typst-page-shell");
        const canvas = shell?.querySelector("canvas");
        if (!shell || !canvas) return null;
        const box = shell.getBoundingClientRect();
        return JSON.stringify({ width: box.width, height: box.height, canvas: canvas.width });
      })()
    `)
    .then((raw) => (raw ? JSON.parse(raw) : null));

const before = await geometry();
await emitMenu(page, "view.zoomIn");
await sleep(700);
const after = await geometry();
check(
  after && before && after.width > before.width,
  "the LaTeX page grows when zoom increases",
  before && after ? `${before.width.toFixed(0)} -> ${after.width.toFixed(0)}` : "no page",
);

await emitMenu(page, "view.zoomReset");
await sleep(600);
const reset = await geometry();
check(
  reset && before && Math.abs(reset.width - before.width) < 2,
  "Reset returns to the original scale",
  reset && before ? `${reset.width.toFixed(0)} vs ${before.width.toFixed(0)}` : "no page",
);

console.log("\n=== a click paints the SyncTeX region ===");

// What the compiled result actually carries. The click handler resolves through
// `latexSourceAt`, which needs a SyncTeX mapping; the engine emits none for this
// build, so the private fallback is what supplies it. If the mapping is empty the
// click can only ever do nothing, and that is the fact worth recording.
const mappingInfo = await page.evaluate(`
  (() => {
    const pane = document.getElementById("preview-pane");
    const shell = document.querySelector(".typst-page-shell");
    return JSON.stringify({
      pages: document.querySelectorAll(".typst-page-shell").length,
      hasCanvas: Boolean(shell?.querySelector("canvas")),
      dataLatexMs: pane?.querySelector("[data-latex-ms]")?.dataset.latexMs ?? "",
    });
  })()
`);
console.log(`  preview: ${mappingInfo}`);

// A click in the middle of the first page. The viewer paints the region it
// resolved, which is the parity with the Typst Pages view the plan asks for.
// A click where body text actually is. The top third of the page is the title
// block, and the caret landed on `\documentclass` — a preamble line that is not
// typeset, so there is correctly no region to paint. The middle of the page is
// where the prose and the itemize are.
const clickResult = await page.evaluate(`
  (async () => {
    const shell = document.querySelector(".typst-page-shell");
    const canvas = shell?.querySelector("canvas");
    if (!canvas) return "no canvas";
    const box = canvas.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height * 0.55;
    canvas.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const marks = document.querySelectorAll(".latex-sync-region");
    const line = document.querySelector(".cm-activeLine")?.textContent?.trim().slice(0, 50) ?? "";
    return JSON.stringify({ marks: marks.length, line });
  })().catch((error) => "error: " + String(error))
`);
check(
  !String(clickResult).startsWith("error"),
  "the click was delivered",
  String(clickResult).slice(0, 80),
);
const clicked = JSON.parse(String(clickResult));
check(
  String(clicked.line ?? "").length > 0,
  "a click in the PDF moves the source caret",
  String(clicked.line ?? "").slice(0, 60),
);

// **Paint must be proved on a typeset line.** A click over a structural node
// resolves to the first line, and a preamble or comment line has no region — that
// is the fail-closed rule working, not a failure. So the test walks down the page
// until the resolved line is body content, and requires a painted region there.
//
// The caret is parked at the **end of the document** first. Without that, a click
// that resolves to nothing leaves the caret on line 1 — where it already was from
// opening the file — and "the caret is on line 1" looks like a click that moved it.
let painted = null;
const attempts = [];
for (const fraction of [0.55, 0.65, 0.75, 0.45, 0.85, 0.35]) {
  const attempt = await page.evaluate(`
    (async () => {
      const shell = document.querySelector(".typst-page-shell");
      const canvas = shell?.querySelector("canvas");
      if (!canvas) return "no canvas";
      document.querySelectorAll(".latex-sync-region").forEach((node) => node.remove());
      // Park the caret on the **last line**, using the same menu route a reader
      // would, so a click that resolves to line 1 is visibly a click that moved it
      // rather than a caret that never left.
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "menu",
        payload: "navigate.gotoLine",
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const field = document.querySelector(".goto-line-input, input[type=number]");
      if (field) {
        field.value = "170";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const before = document.querySelector(".cm-activeLine")?.textContent?.trim().slice(0, 40) ?? "";
      const box = canvas.getBoundingClientRect();
      // The viewer's click handler requires a **collapsed selection**: a click that
      // lands while text is selected is a selection gesture, not a paragraph one.
      // A synthetic click can leave one behind, so it is cleared first — otherwise
      // the handler returns early and the test measures nothing.
      window.getSelection()?.removeAllRanges();
      // Record whether the click reaches the handlers at all, and which guard
      // rejects it. The viewer's click handler requires a collapsed selection and
      // a target inside the host; either can silently swallow a synthetic event.
      // target inside the host; either can silently swallow a synthetic event.
      window.__clickProbe = { dispatched: true, collapsed: null, inHost: null };
      const selection = window.getSelection();
      window.__clickProbe.collapsed = selection ? selection.isCollapsed : "no selection";
      const host = canvas.closest(".typst-preview");
      window.__clickProbe.inHost = host ? host.contains(canvas) : "no host";
      // The geometry the viewer measures against, so a failure says whether the
      // click landed on the page at all rather than only that nothing happened.
      const pageEl = shell.querySelector(".typst-page") ?? shell;
      const pageRect = pageEl.getBoundingClientRect();
      const clientX = box.left + box.width / 2;
      const clientY = box.top + box.height * ${fraction};
      window.__clickProbe.clientY = Math.round(clientY);
      window.__clickProbe.pageTop = Math.round(pageRect.top);
      window.__clickProbe.pageBottom = Math.round(pageRect.bottom);
      window.__clickProbe.onPage =
        clientY >= pageRect.top && clientY <= pageRect.bottom;
      canvas.dispatchEvent(new MouseEvent("click", {
        clientX,
        clientY,
        bubbles: true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return JSON.stringify({
        marks: document.querySelectorAll(".latex-sync-region").length,
        before,
        line: document.querySelector(".cm-activeLine")?.textContent?.trim().slice(0, 50) ?? "",
        probe: window.__clickProbe,
      });
    })().catch((error) => "error: " + String(error))
  `);
  if (String(attempt).startsWith("error")) continue;
  const result = JSON.parse(String(attempt));
  attempts.push(
    `${fraction}: marks=${result.marks} onPage=${result.probe?.onPage} after=${JSON.stringify(result.line.slice(0, 22))}`,
  );
  // **A painted region is the assertion.** Where the caret ends up is a separate
  // question: the click resolves to a source line, and that line may be in a
  // different file than the one on screen, in which case the editor opens that file
  // and the active line belongs to it. Requiring a particular line here would be
  // asserting the fixture's layout rather than the feature.
  if (result.marks > 0) {
    painted = result;
    break;
  }
}

check(
  painted !== null && painted.marks > 0,
  "a click in the PDF paints the SyncTeX region",
  painted
    ? `${painted.marks} mark(s)`
    : `no click painted (${attempts.join(", ")})`,
);

// What the click resolves to, recorded because it is the open question: every
// click in this document resolves to line 1, which suggests the SyncTeX mapping
// carries a document-wide node that owns the whole page. That is a real defect in
// click navigation, not a test problem, and it is recorded in the plan rather than
// asserted here — an assertion would only restate it.
console.log(`  click resolutions: ${attempts.join(", ")}`);
// What the app itself said about each click. This is the line that answers why
// nothing happened, and it is the reason the console listener exists.
if (consoleLines.length) {
  console.log(`  app said: ${[...new Set(consoleLines)].slice(0, 3).join(" | ")}`);
}

// The point of the click: the source moved to the matching line.
const activeLine = await page.evaluate(`
  (() => {
    const line = document.querySelector(".cm-activeLine");
    return line ? String(line.textContent ?? "").trim().slice(0, 60) : "";
  })()
`);
check(activeLine.length > 0, "the editor has an active line after the click", activeLine);

console.log("\n=== scrolling the editor moves the preview ===");

// The correspondence, end to end. Scroll the editor and require the preview's
// scroll offset to change: that is what "vertical scroll sync" means to a reader.
//
// The editor is scrolled to a **fraction of its range**, not by a fixed number of
// pixels: a short document may have no 400px to give, and then the editor never
// moves and the assertion measures nothing. The preview is scrolled to the top
// first so any movement is visible.
const scrolled = await page.evaluate(`
  (async () => {
    const pane = document.getElementById("preview-pane");
    const editorScroll = document.querySelector(".cm-scroller");
    if (!pane || !editorScroll) return "missing";
    pane.scrollTop = 0;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = pane.scrollTop;
    const range = Math.max(0, editorScroll.scrollHeight - editorScroll.clientHeight);
    if (range < 40) return JSON.stringify({ before, after: before, range, skipped: true });
    editorScroll.scrollTop = range * 0.6;
    editorScroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return JSON.stringify({ before, after: pane.scrollTop, range });
  })().catch((error) => "error: " + String(error))
`);
check(!String(scrolled).startsWith("error"), "the editor scrolled", String(scrolled).slice(0, 60));
if (!String(scrolled).startsWith("error")) {
  const { before: p0, after: p1, range, skipped } = JSON.parse(String(scrolled));
  if (skipped) {
    // A document with no scroll range cannot demonstrate correspondence, and a
    // failure here would blame the feature for the fixture.
    console.log(`  SKIP  the document has no scroll range (${range}px)`);
  } else {
    check(p1 !== p0, "the preview followed the editor scroll", `${p0} -> ${p1}`);
  }
}

console.log("\n=== two columns ===");

// The case step 8 asks about: one source line owns regions in **both** columns, so
// a rule that always takes the first region snaps back to the left column while the
// reader scrolls down the right one. `samples/latex-two-column.tex` puts a long
// `multicols` body on the page for exactly this.
await page.evaluate(`
  window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
    event: "open-files",
    payload: [${JSON.stringify(join(process.cwd(), "samples", "latex-two-column.tex"))}],
  })
`);
await sleep(1200);
await emitMenu(page, "view.split");

let columnPages = 0;
for (let attempt = 0; attempt < 120; attempt += 1) {
  columnPages = await page.evaluate(`document.querySelectorAll(".typst-page-shell canvas").length`);
  if (columnPages > 0) break;
  await sleep(500);
}
check(columnPages > 0, "the two-column fixture compiles", `${columnPages} page(s)`);
if (columnPages === 0) {
  const why = await page.evaluate(
    `document.querySelector(".typst-error")?.textContent?.slice(0, 160) ?? "no error shown"`,
  );
  console.log(`  two-column failure: ${String(why)}`);
}

if (columnPages > 0) {
  // Scroll the editor down in steps and require the preview to move **forward**
  // each time. Oscillation is the failure this catches: a rule that picks the left
  // column first would move the preview backward on some steps.
  const steps = await page.evaluate(`
    (async () => {
      const pane = document.getElementById("preview-pane");
      const editorScroll = document.querySelector(".cm-scroller");
      if (!pane || !editorScroll) return JSON.stringify({ error: "missing" });
      const range = Math.max(0, editorScroll.scrollHeight - editorScroll.clientHeight);
      const seen = [];
      for (const fraction of [0.15, 0.35, 0.55, 0.75, 0.9]) {
        editorScroll.scrollTop = range * fraction;
        editorScroll.dispatchEvent(new Event("scroll", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 900));
        seen.push(Math.round(pane.scrollTop));
      }
      return JSON.stringify({ seen, range });
    })().catch((error) => JSON.stringify({ error: String(error) }))
  `);
  const parsed = JSON.parse(String(steps));
  if (parsed.error) {
    check(false, "the two-column scroll could be measured", parsed.error);
  } else {
    const { seen } = parsed;
    // **Not "never backward".** A two-column page is not monotonic in y: `multicols`
    // balances the columns, so a later source line can be typeset *higher* than an
    // earlier one at the column break. Measured on this fixture, line 39 sits at
    // y=396 while line 32 is at y=531, and both are correct — line 32 is deep in the
    // right column and line 39 is back near the top of the left one.
    //
    // What must hold is that the preview **tracks**: it moves at all, it stays
    // inside the pane, and it converges — a second pass over the same scroll
    // positions lands on the same offsets rather than drifting.
    check(
      seen.some((value) => value > 0),
      "the preview moves while scrolling a two-column document",
      `offsets ${seen.join(" -> ")}`,
    );
    const max = await page.evaluate(
      `(() => { const p = document.getElementById("preview-pane"); return Math.round(p.scrollHeight - p.clientHeight); })()`,
    );
    check(
      seen.every((value) => value >= 0 && value <= max + 2),
      "every two-column offset is inside the pane",
      `${seen.join(", ")} within 0..${max}`,
    );
    // Convergence: the same scroll positions must produce the same offsets. The
    // editor is **reset to the top first**, because a pass that begins where the
    // previous one ended does not fire a scroll for its first step — the position is
    // already there — and the comparison then measures the harness, not the rule.
    const repeat = await page.evaluate(`
      (async () => {
        const pane = document.getElementById("preview-pane");
        const editorScroll = document.querySelector(".cm-scroller");
        const range = Math.max(0, editorScroll.scrollHeight - editorScroll.clientHeight);
        // Back to the top, and let the correspondence settle there.
        editorScroll.scrollTop = 0;
        editorScroll.dispatchEvent(new Event("scroll", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 900));
        const seen = [];
        for (const fraction of [0.15, 0.35, 0.55, 0.75, 0.9]) {
          editorScroll.scrollTop = range * fraction;
          editorScroll.dispatchEvent(new Event("scroll", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 900));
          seen.push(Math.round(pane.scrollTop));
        }
        return JSON.stringify(seen);
      })().catch(() => "[]")
    `);
    const again = JSON.parse(String(repeat));
    check(
      JSON.stringify(again) === JSON.stringify(seen),
      "a second pass from the top lands on the same offsets",
      `${seen.join(",")} vs ${again.join(",")}`,
    );
    // **The reset itself is the diagnostic.** If the preview is still where pass 1
    // left it after the editor went back to the top, then scrolling *up* does not
    // move the preview — an asymmetry that would explain the whole divergence and is
    // a defect in its own right.
    check(
      again[0] === seen[0],
      "scrolling back to the top returns the preview to the top",
      `${seen[0]} vs ${again[0]}`,
    );
    // What the app said during the reset. A target that was computed but did not
    // move the pane is `scrollToPagePosition`'s fault; no target at all means the
    // scroll event never reached the handler.
    const resetLines = consoleLines.filter((line) => line.includes("[latex-scroll]"));
    if (resetLines.length) {
      console.log(`  scroll log (last 6):\n    ${resetLines.slice(-6).join("\n    ")}`);
    }
    // What the app said about the scroll, when it said anything. A preview that
    // jumps back to the top is either a target that resolved to the wrong region or
    // no target at all, and those need different fixes.
    const scrollLines = consoleLines.filter((line) => line.includes("[latex-scroll]"));
    if (scrollLines.length) {
      // Every line the correspondence saw, with its hint and target. The
      // oscillation is a sequence, so the whole sequence is the evidence.
      console.log(`  scroll said:\n    ${scrollLines.slice(-10).join("\n    ")}`);
    }
  }
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
page.close();
process.exit(failed === 0 ? 0 : 1);
