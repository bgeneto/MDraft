// Per-project TeX engine in the running application (stage 6.2 of
// docs/architecture.md).
//
//   node scripts/latex-engine-choice-test.mjs <port>
//
// Launched with samples/latex-engines/plain.tex. Proves, through the compiled
// PDF and the compile's own perf record, that:
//   - the chip names the default engine (LuaLaTeX) and why;
//   - the menu offers LuaLaTeX and XeLaTeX and no pdfLaTeX (the bundled preview
//     has no pdfTeX), remembers XeLaTeX for this main document and compiles
//     with XeTeX;
//   - "Use the Preferences default" forgets it and LuaLaTeX compiles again;
//   - a `% !TeX program = xelatex` file compiles with XeTeX and its chip says
//     the magic comment decided, with no engine to choose.
//
// WasmTex is disabled, not deleted: the layer selects the hidden backend
// explicitly because it tests that engine's per-project choice. Network: the
// optional engines come from the pinned origin, like the default engine. Skips
// cleanly without the bundled engine.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPage, sleep, useWasmTex } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";
const engineYear = JSON.parse(readFileSync("src-tauri/latex-engine.json", "utf8")).active;
const page = await openPage(port);
const evaluate = (expression) => page.evaluate(expression);
const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then(JSON.stringify)`,
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
// Each render clears the previous render's perf records (`clearLatexPerf`), so
// a count of compile records never grows: a compile is recognised by starting
// after a moment taken in the page, and by the engine it recorded.
const now = () => evaluate("performance.now()");
const compileSince = (since, engine) =>
  `performance.getEntriesByName("mdraft:latex:compile").find((e) => e.startTime > ${since} && e.detail?.engine === ${JSON.stringify(engine)})`;
const describeCompile = (since, engine) =>
  evaluate(`(() => {
    const e = ${compileSince(since, engine)};
    const all = performance.getEntriesByName("mdraft:latex:compile").map((x) => x.detail?.engine);
    return JSON.stringify(e ? { engine: e.detail.engine, success: e.detail.success, banners: e.detail.banners } : { seen: all });
  })()`).then(JSON.parse);
const pdfHas = (pattern) =>
  `[...document.querySelectorAll(".typst-page .textLayer")].some((t) => ${pattern}.test(t.textContent ?? ""))`;
const chip = () =>
  evaluate(
    `JSON.stringify((() => { const c = document.getElementById("status-latex-engine"); return { hidden: c.hidden, text: c.textContent, title: c.title }; })())`,
  ).then(JSON.parse);
/** Open the chip's menu, return its labels and click the entry matching `pattern`. */
async function pickFromChip(pattern) {
  await evaluate(`document.getElementById("status-latex-engine").click()`);
  const shown = await waitFor(
    `!!document.querySelector(".explorer-menu .favorite-menu-item")`,
    5000,
    "the engine menu",
  );
  if (!shown) return [];
  const labels = await evaluate(
    `JSON.stringify([...document.querySelectorAll(".explorer-menu .favorite-menu-item")].map((b) => b.textContent))`,
  ).then(JSON.parse);
  if (pattern)
    await evaluate(
      `[...document.querySelectorAll(".explorer-menu .favorite-menu-item")].find((b) => ${pattern}.test(b.textContent))?.click()`,
    );
  else
    await evaluate(
      `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
    );
  return labels;
}
/** Wait for a compile with `engine`, started after `since`, whose PDF shows `pattern`. */
async function compiledWith(since, engine, pattern, label) {
  // A failed compile ends the wait at once: waiting the full timeout for a PDF
  // that cannot come only delays the diagnosis.
  await waitFor(
    `(() => { const e = ${compileSince(since, engine)}; return !!e && (e.detail?.success === false || ${pdfHas(pattern)}); })()`,
    180_000,
    label,
  );
  const described = await describeCompile(since, engine);
  // A failed build says why in its compiler output: print the end of it.
  if (described?.success === false) {
    // The SDK reports a failed engine init only as "not available in this
    // build": boot the engine's worker shim directly to see the real error.
    console.log(
      "  worker probe: " +
        (await evaluate(`new Promise((resolve) => {
          const year = ${JSON.stringify(engineYear)};
          const name = { pdflatex: "pdftex", xelatex: "xetex", lualatex: "luatex" }[${JSON.stringify(engine)}];
          const seen = [];
          const worker = new Worker("/wasmtex/" + year + "/wasmtex-" + name + ".worker.js");
          worker.onerror = (e) => { seen.push("error: " + e.message); e.preventDefault(); };
          worker.onmessage = (e) => seen.push("message: " + JSON.stringify(e.data).slice(0, 300));
          setTimeout(() => { worker.terminate(); resolve(seen.join(" | ") || "no error within 8 s"); }, 8000);
        })`)),
    );
    await sleep(500);
    console.log(
      "  compiler output (tail): " +
        (await evaluate(
          `[...document.querySelectorAll("pre, .typst-error, .latex-problems")].map((n) => n.textContent).join(" | ").slice(-3000)`,
        )),
    );
  }
  return described;
}

try {
  await waitFor('!!document.querySelector(".cm-content")', 30_000, "the editor");
  // This layer covers the hidden WasmTex engine's per-project choice. The
  // production default is the incremental preview; pdfLaTeX is not offered
  // there, and the menu below proves it left the bundled choices.
  await useWasmTex(page);
  // Every layer starts from first-run state, where the bundled engine is off:
  // turn it on the way a reader does (as latex-root-test.mjs does).
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
  if ((await evaluate(`document.querySelector("#preview")?.dataset.latexCurrent ?? ""`)) === "")
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"menu",payload:"view.latexCompile"})`,
    );

  // 1. The default engine, and the chip that says so.
  const first = await compiledWith(0, "lualatex", "/Engine marker sentence/", "the LuaLaTeX PDF");
  check(
    "the default engine is LuaLaTeX",
    first?.engine === "lualatex" && first.success === true,
    JSON.stringify(first),
  );
  const shown = await chip();
  check(
    "the chip names the engine and why",
    !shown.hidden && shown.text === "LuaLaTeX" && /\(default\)/.test(shown.title),
    JSON.stringify(shown),
  );

  // 2. Choose XeLaTeX for this project from the chip.
  let since = await now();
  const labels = await pickFromChip("/^XeLaTeX/");
  check(
    "the menu offers LuaLaTeX and XeLaTeX, the current one marked",
    labels.length >= 2 &&
      /^✓ LuaLaTeX/.test(labels[0]) &&
      labels.some((label) => /^XeLaTeX/.test(label)) &&
      !labels.some((label) => /pdfLaTeX/.test(label)),
    JSON.stringify(labels),
  );
  const xeRun = await compiledWith(since, "xelatex", "/Engine marker sentence/", "the XeLaTeX PDF");
  check(
    "the project compiles with XeTeX",
    xeRun?.engine === "xelatex" && xeRun.success === true,
    JSON.stringify(xeRun),
  );
  const settings = await invoke("get_settings");
  const main = join(process.cwd(), "samples", "latex-engines", "plain.tex");
  check(
    "the choice is remembered for this main document",
    settings.latexProjectEngines?.[0]?.engine === "xelatex" &&
      settings.latexProjectEngines[0].main.toLowerCase() === main.toLowerCase(),
    JSON.stringify(settings.latexProjectEngines),
  );
  const after = await chip();
  check(
    "the chip says the project decided",
    after.text === "XeLaTeX" && /\(project\)/.test(after.title),
    JSON.stringify(after),
  );

  // 3. Back to the Preferences default.
  since = await now();
  await pickFromChip("/Preferences default/");
  // The LuaLaTeX PDF of these inputs is still in the preview cache (the engine
  // is part of its key), so it may be drawn without compiling: accept either,
  // from the render's own `compile-call` record.
  const backCall = `performance.getEntriesByName("mdraft:latex:compile-call").find((e) => e.startTime > ${since} && e.detail?.engine === "LuaLaTeX")`;
  await waitFor(
    `!!(${backCall}) && ${pdfHas("/Engine marker sentence/")}`,
    180_000,
    "the LuaLaTeX PDF again",
  );
  const back = await evaluate(`JSON.stringify((${backCall})?.detail ?? null)`).then(JSON.parse);
  check(
    "Use the Preferences default shows LuaLaTeX's PDF again (cached or compiled)",
    back?.engine === "LuaLaTeX",
    JSON.stringify(back),
  );
  const cleared = await invoke("get_settings");
  check(
    "the project's choice is forgotten",
    !(cleared.latexProjectEngines ?? []).length,
    JSON.stringify(cleared.latexProjectEngines),
  );

  // 4. A magic comment wins. The chip offers no choice, only the download of
  // the engine it names when that engine is missing (never a dead entry).
  const magicPath = join(process.cwd(), "samples", "latex-engines", "magic-xe.tex");
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"open-files",payload:${JSON.stringify([magicPath])}})`,
  );
  await waitFor(
    `document.getElementById("status-latex-engine")?.textContent === "XeLaTeX"`,
    60_000,
    "the XeLaTeX chip",
  );
  const magic = await chip();
  check(
    "the chip says the magic comment decided",
    magic.text === "XeLaTeX" && /magic comment/.test(magic.title),
    JSON.stringify(magic),
  );
  const xeInstalled = (await invoke("latex_engine_available", { engine: "xelatex" })) === true;
  since = await now();
  const magicMenu = await pickFromChip(xeInstalled ? null : "/^Download XeLaTeX/");
  check(
    "a magic comment leaves nothing to choose, only a missing engine to download",
    magicMenu.length === 1 &&
      /% !TeX program/.test(magicMenu[0]) &&
      (xeInstalled || /^Download XeLaTeX \(\d+\.\d MB\)/.test(magicMenu[0])),
    JSON.stringify(magicMenu),
  );
  if (xeInstalled)
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"menu",payload:"view.latexCompile"})`,
    );
  const xe = await compiledWith(since, "xelatex", "/XeTeX marker sentence/", "the XeLaTeX PDF");
  check(
    "% !TeX program = xelatex compiles with XeTeX",
    xe?.engine === "xelatex" && xe.success === true,
    JSON.stringify(xe),
  );
} catch (error) {
  failed += 1;
  console.log(`FAIL  ${error.message}`);
} finally {
  page.close();
}
console.log(failed ? `\nsome checks done; ${failed} failed` : "\nall checks done; 0 failed");
process.exit(failed ? 1 : 0);
