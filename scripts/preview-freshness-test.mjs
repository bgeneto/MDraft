// A change that is not an input of a preview must not rebuild it.
//
//   node scripts/preview-freshness-test.mjs [port]
//
// Why this suite exists: the theme toggle, the system theme, the editor's
// syntax palette and the content width were all wired to `scheduleRender`.
// None of them changes any compiled output — PDFs go dark through a CSS filter,
// code colours are a stylesheet, the HTML guest draws its own styles — yet each
// one recompiled a whole LaTeX project and restarted an HTML document's
// scripts. The plan is docs/plans/2026-11-11-preview-freshness-and-cache.md.
//
// Rebuilds are counted at the IPC boundary, where every one has to pass:
// `latex_engine_status` opens every LaTeX render, `render_typst` is the Typst
// compiler, and `set_html_preview` installs a new HTML guest. CDP's Fetch domain
// sees each `http://ipc.localhost/<command>` request and lets it through. The
// page cannot wrap `invoke` itself: `__TAURI_INTERNALS__` is non-writable.
//
//   1. theme toggle on .tex, .typ and .html: no render command;
//   2. syntax palette and content width on .tex: no render command;
//   3. theme toggle on Markdown with a diagram: the preview DOM is kept (a
//      marker survives) and the diagram is redrawn in the new theme;
//   4. the freshness key: an edit undone before the debounce runs leaves the
//      Markdown DOM in place (the marker survives, the diagram stays drawn)
//      and installs no new HTML guest;
//   5. with a LaTeX engine only: an edit undone, and a save of the compiled
//      buffer, start no compile (`#preview[data-compile-count]`); Compile
//      always does. Skipped cleanly when no engine is enabled.
//
// No engine is needed for 1-4: without one, a LaTeX render still asks
// `latex_engine_status` and commits the "not enabled" note, and a Typst render
// still calls `render_typst`. Fixtures live in a temporary directory.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitMenu, openPage, sleep, useWasmTex } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";
const page = await openPage(port);

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const errors = [];
page.onException((text) => errors.push(text.split("\n")[0]));

for (let attempt = 0; attempt < 240; attempt += 1) {
  if (await page.evaluate(`Boolean(document.querySelector(".cm-content"))`)) break;
  await sleep(250);
}
await useWasmTex(page);

const COUNTED = ["latex_engine_status", "render_typst", "render_typst_binary", "set_html_preview"];
const counts = Object.fromEntries(COUNTED.map((command) => [command, 0]));
let lastRequestAt = Date.now();
// Which action a request followed. Printed with every request, so a failure
// says whether the render came from the action under test or from a tab
// activation that had not finished settling.
let step = "start";
const started = Date.now();
page.onEvent((method, params) => {
  if (method !== "Fetch.requestPaused") return;
  const command = decodeURIComponent(new URL(params.request.url).pathname.replace(/^\//, ""));
  if (command in counts) counts[command] += 1;
  lastRequestAt = Date.now();
  console.log(`  ....  ${lastRequestAt - started} ms  ${step}: ${command}`);
  void page
    .send("Fetch.continueRequest", { requestId: params.requestId })
    .catch((error) => console.error(`[freshness] could not release ${command}: ${error}`));
});
await page.send("Fetch.enable", {
  patterns: COUNTED.map((command) => ({
    urlPattern: `http://ipc.localhost/${command}`,
    requestStage: "Request",
  })),
});

const snapshot = () => ({ ...counts });
const delta = (before) =>
  COUNTED.filter((command) => counts[command] !== before[command])
    .map((command) => `${command} +${counts[command] - before[command]}`)
    .join(", ");

const busy = () =>
  page.evaluate(`(() => {
    const status = document.querySelector("#preview-pane > .latex-build-status")?.textContent ?? "";
    return /Preparing|Compiling|Resolving|Downloading|Rendering/.test(status) ||
      Boolean(document.querySelector("#preview-pane > .preview-pending"));
  })()`);

/** Wait until the active tab's render has finished and the IPC line is quiet. */
async function settle(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await busy()) && Date.now() - lastRequestAt > 1200) return true;
    await sleep(150);
  }
  return false;
}

async function activate(name) {
  step = `activate ${name}`;
  const clicked = await page.evaluate(`(() => {
    const tab = [...document.querySelectorAll(".doc-tab")]
      .find((entry) => entry.querySelector(".doc-tab-name")?.textContent === ${JSON.stringify(name)});
    tab?.click();
    return Boolean(tab);
  })()`);
  if (!clicked) throw new Error(`no tab named ${name}`);
  // `displayDoc` awaits the title and status before it schedules the render,
  // so right after the click the IPC line is still quiet from the previous
  // step and `settle` would return at once. The activation's own render then
  // lands inside the next step and is blamed on the theme or the palette.
  await sleep(900);
  await settle();
}

/** Focus the editor at the end of the document. */
async function focusEditorEnd() {
  await page.evaluate(`(() => {
    const content = document.querySelector(".cm-content");
    content?.focus();
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return 1;
  })()`);
  await sleep(100);
}

async function backspace() {
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
  }
}

/**
 * Type a character and delete it within the same debounce window, so the
 * render that follows sees the text it last built — and two revisions later.
 */
async function typeAndUndo(waitMs = 900) {
  await focusEditorEnd();
  await page.send("Input.insertText", { text: "Q" });
  await backspace();
  await sleep(waitMs);
  await settle();
}

/** A real edit that reaches the preview, then the original text again. */
async function typeKeepAndRestore() {
  await focusEditorEnd();
  await page.send("Input.insertText", { text: "Q" });
  await sleep(1200);
  await settle();
  await backspace();
  await sleep(1200);
  await settle();
}

const compiles = () =>
  page.evaluate(`Number(document.getElementById("preview")?.dataset.compileCount ?? 0)`);

/** Wait for a LaTeX build to finish and its PDF to be current. */
async function settleCompile(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      !(await busy()) &&
      (await page.evaluate(`Boolean(document.getElementById("preview")?.dataset.latexCurrent)`))
    )
      return true;
    await sleep(250);
  }
  return false;
}

const isDark = () => page.evaluate(`document.documentElement.dataset.theme === "dark"`);

async function toggleTheme() {
  step = "theme toggle";
  await page.evaluate(`document.getElementById("btn-theme").click(); 1`);
  // Long enough for a queued render (0 ms timer) to reach the IPC line.
  await sleep(900);
  await settle();
}

async function setContentWidth(value) {
  return page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const overlay = document.querySelector(".prefs-overlay");
    if (overlay.hidden) document.getElementById("btn-prefs").click();
    await sleep(150);
    // The row's section is looked up rather than named, so moving it between
    // sections does not break the suite.
    const findRow = () => [...document.querySelectorAll(".prefs-row")].find((r) =>
      (r.querySelector(".prefs-label")?.textContent ?? "").startsWith("Content Width"));
    let row = findRow();
    for (const section of document.querySelectorAll(".prefs-section")) {
      if (row) break;
      section.click();
      await sleep(120);
      row = findRow();
    }
    const select = row?.querySelector("select");
    let before = "missing";
    if (select) {
      before = select.value;
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(300);
    }
    overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
    return before;
  })()`);
}

const workDir = mkdtempSync(join(tmpdir(), "mdraft-preview-freshness-"));
const fixture = (name, text) => {
  const path = join(workDir, name);
  writeFileSync(path, text);
  return path;
};

try {
  const tex = fixture(
    "fresh.tex",
    "\\documentclass{article}\n\\begin{document}\nFreshness probe.\n\\end{document}\n",
  );
  const typ = fixture("fresh.typ", "= Freshness probe\n\nA paragraph.\n");
  const html = fixture(
    "fresh.html",
    "<!doctype html><html><body><h1>Freshness probe</h1><p>Body.</p></body></html>\n",
  );
  const md = fixture(
    "fresh.md",
    "# Freshness probe\n\nA paragraph.\n\n```mermaid\ngraph TD\n  A-->B\n```\n",
  );
  await page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify([tex, typ, html, md])} })`,
  );
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const tabs = await page.evaluate(`document.querySelectorAll(".doc-tab").length`);
    if (tabs >= 4) break;
    await sleep(250);
  }
  const themeBefore = await isDark();

  // 1. Theme toggle on the compiled and guest formats.
  for (const name of ["fresh.tex", "fresh.typ", "fresh.html"]) {
    await activate(name);
    const before = snapshot();
    await toggleTheme();
    await toggleTheme();
    check(delta(before) === "", `${name}: theme toggle starts no render`, delta(before));
  }

  // 2. Palette and width on LaTeX.
  await activate("fresh.tex");
  {
    const before = snapshot();
    step = "palette";
    await emitMenu(page, "view.syntax.nord");
    await sleep(900);
    await settle();
    await emitMenu(page, "view.syntax.auto");
    await sleep(900);
    await settle();
    check(delta(before) === "", "fresh.tex: syntax palette change starts no render", delta(before));
  }
  {
    const before = snapshot();
    step = "width";
    const previous = await setContentWidth("860");
    await sleep(900);
    await settle();
    if (previous !== "missing") await setContentWidth(previous);
    await sleep(900);
    await settle();
    check(previous !== "missing", "the Content Width row is reachable", String(previous));
    check(delta(before) === "", "fresh.tex: content width change starts no render", delta(before));
  }

  // 3. Markdown keeps its DOM and redraws only the diagram.
  await activate("fresh.md");
  const hasDiagram = await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await page.evaluate(`Boolean(document.querySelector("#preview .mermaid svg"))`))
        return true;
      await sleep(200);
    }
    return false;
  })();
  check(hasDiagram, "fresh.md: the diagram is drawn");
  await page.evaluate(
    `document.querySelector("#preview h1")?.setAttribute("data-freshness-marker", "1"); 1`,
  );
  const svgBefore = await page.evaluate(
    `document.querySelector("#preview .mermaid")?.innerHTML ?? ""`,
  );
  await toggleTheme();
  const kept = await page.evaluate(
    `Boolean(document.querySelector('#preview h1[data-freshness-marker="1"]'))`,
  );
  let svgAfter = "";
  {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      svgAfter = await page.evaluate(
        `document.querySelector("#preview .mermaid")?.innerHTML ?? ""`,
      );
      if (svgAfter && svgAfter !== svgBefore) break;
      await sleep(200);
    }
  }
  check(kept, "fresh.md: theme toggle keeps the rendered preview");
  check(
    svgAfter !== "" && svgAfter !== svgBefore,
    "fresh.md: the diagram is redrawn in the new theme",
  );
  await toggleTheme();

  // 4. An edit undone before the debounce: same text, same key, no rebuild.
  {
    step = "edit undone (md)";
    await page.evaluate(
      `document.querySelector("#preview h1")?.setAttribute("data-freshness-marker", "2"); 1`,
    );
    await typeAndUndo();
    const kept = await page.evaluate(
      `Boolean(document.querySelector('#preview h1[data-freshness-marker="2"]'))`,
    );
    const drawn = await page.evaluate(`Boolean(document.querySelector("#preview .mermaid svg"))`);
    check(kept, "fresh.md: an edit undone before the render keeps the preview DOM");
    check(drawn, "fresh.md: the diagram is still drawn after the rebind");
  }
  {
    await activate("fresh.html");
    step = "edit undone (html)";
    const before = snapshot();
    await typeAndUndo();
    check(delta(before) === "", "fresh.html: an edit undone installs no new guest", delta(before));
    step = "real edit (html)";
    const control = snapshot();
    await typeKeepAndRestore();
    check(
      counts.set_html_preview > control.set_html_preview,
      "fresh.html: a real edit does install a new guest (positive control)",
      delta(control),
    );
  }

  // 6. Returning to a tab: the parked preview comes back, nothing is rebuilt.
  {
    await activate("fresh.md");
    await page.evaluate(
      `document.querySelector("#preview h1")?.setAttribute("data-freshness-marker", "3"); 1`,
    );
    await activate("fresh.tex");
    step = "return (md)";
    await activate("fresh.md");
    const kept = await page.evaluate(
      `Boolean(document.querySelector('#preview h1[data-freshness-marker="3"]'))`,
    );
    check(kept, "fresh.md: returning to the tab restores its preview DOM instead of rebuilding");
    const words = await page.evaluate(
      `document.getElementById("app").classList.contains("mode-split") ? Boolean(document.querySelector("#preview [data-f]")) : true`,
    );
    check(words, "fresh.md: the restored preview is still word-mapped for Split");
  }
  {
    await activate("fresh.typ");
    const typstWorks = await page.evaluate(
      `Boolean(document.querySelector("#preview .typst-document, #preview .typst-preview"))`,
    );
    if (!typstWorks) {
      console.log("  SKIP  Typst return — no Typst compiler produced output on this host");
    } else {
      await page.evaluate(
        `document.querySelector("#preview .typst-document, #preview .typst-preview")?.setAttribute("data-freshness-marker", "4"); 1`,
      );
      await activate("fresh.md");
      step = "return (typ)";
      const before = snapshot();
      await activate("fresh.typ");
      check(
        delta(before) === "",
        "fresh.typ: returning to the tab starts no compiler",
        delta(before),
      );
      check(
        await page.evaluate(
          `Boolean(document.querySelector('#preview [data-freshness-marker="4"]'))`,
        ),
        "fresh.typ: the restored preview is the one built before",
      );
      check(
        await page.evaluate(
          `/Compiled with Typst|(Document|PDF) ready/.test(document.querySelector(".compiled-message")?.textContent ?? "")`,
        ),
        "fresh.typ: the restored preview's toolbar says it is compiled",
        await page.evaluate(`document.querySelector(".compiled-message")?.textContent ?? "(none)"`),
      );
    }
  }

  // 5. LaTeX with an engine: undone edits and saves skip; Compile builds.
  // A fresh profile has the bundled engine switched off even when the harness
  // linked it; the Preferences checkbox is the route that updates both copies
  // of the setting (see latex-preview-test.mjs).
  await page.evaluate(`
    (async () => {
      const current = await window.__TAURI_INTERNALS__.invoke("get_settings");
      if (current.latexEnabled) return;
      const open = document.getElementById("btn-prefs");
      open?.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      [...document.querySelectorAll(".prefs-section")]
        .find((node) => node.textContent.trim() === "LaTeX")?.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const row = [...document.querySelectorAll(".prefs-row")]
        .find((node) => /Enable bundled TeX/i.test(node.querySelector(".prefs-label")?.textContent ?? ""));
      const box = row?.querySelector("input[type=checkbox]");
      if (box && !box.checked) box.click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      open?.click();
    })().catch(() => {})
  `);
  // `latex_status` is true only when the enabled engine can actually run; the
  // harness links the developer's installed engine when there is one.
  const usable = await page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("latex_status").then(String).catch(() => "false")`,
  );
  if (usable !== "true") {
    console.log("  SKIP  LaTeX freshness — no LaTeX engine is enabled on this host");
  } else {
    await activate("fresh.tex");
    const compiled = await settleCompile();
    if (!compiled) {
      check(false, "fresh.tex: the first build produces a PDF", "no PDF within 180 s");
    } else {
      step = "edit undone (tex)";
      let before = await compiles();
      await typeAndUndo(1800);
      check((await compiles()) === before, "fresh.tex: an edit undone starts no compile");
      step = "save (tex)";
      before = await compiles();
      await emitMenu(page, "file.save");
      await sleep(1500);
      await settle();
      check(
        (await compiles()) === before,
        "fresh.tex: saving the compiled buffer starts no compile",
      );
      step = "compile (tex)";
      before = await compiles();
      await page.evaluate(`document.querySelector(".compiled-compile")?.click(); 1`);
      await sleep(1500);
      await settleCompile();
      check((await compiles()) > before, "fresh.tex: Compile always builds");

      step = "return (tex)";
      await activate("fresh.md");
      before = await compiles();
      const started = Date.now();
      await activate("fresh.tex");
      const current = await settleCompile(20000);
      check(
        current && (await compiles()) === before,
        "fresh.tex: returning to an unchanged project shows its PDF without compiling",
        `${Date.now() - started} ms including the settle wait`,
      );
      check(
        await page.evaluate(`Boolean(document.querySelector("#preview .typst-page canvas"))`),
        "fresh.tex: the returned PDF is on screen",
      );

      // A disk change while away must rebuild: the key is the content, not the tab.
      step = "return after disk change (tex)";
      await activate("fresh.md");
      writeFileSync(
        tex,
        "\\documentclass{article}\n\\begin{document}\nFreshness probe, changed on disk.\n\\end{document}\n",
      );
      // The disk watcher polls every 2.5 s and reloads an unmodified buffer.
      await sleep(3500);
      before = await compiles();
      await activate("fresh.tex");
      await settleCompile();
      check(
        (await compiles()) > before,
        "fresh.tex: a file changed on disk while away is compiled on return",
      );
    }
  }

  if ((await isDark()) !== themeBefore) await toggleTheme();
  if (errors.length) console.log(`\npage errors:\n  ${errors.join("\n  ")}`);
} finally {
  await page.send("Fetch.disable").catch(() => {});
  rmSync(workDir, { recursive: true, force: true });
  page.close();
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
