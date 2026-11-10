// The compiled LaTeX PDF in the real UI: zoom, word correspondence, and scroll.
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
//   3. exact prose and verbatim word correspondence works in both directions;
//   4. inline and displayed equations map atomically in both directions;
//   5. scroll sync and rebuild-at-tail viewport retention work in the real app;
//   6. export and print hand off the compiled bytes without a second compile.
//
// Skips cleanly when the engine is not installed, because a host without it has
// nothing to measure and a failure would be misleading.

import { openPage, emitMenu, sleep } from "./cdp-page.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  if (
    text.includes("[latex-sync]") ||
    text.includes("[latex-source]") ||
    text.includes("[latex-scroll]")
  ) {
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
// The switch lives in Preferences › LaTeX, and the checkbox is the route that
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
      .find((node) => node.textContent.trim() === "LaTeX");
    section?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const row = [...document.querySelectorAll(".prefs-row")]
      .find((node) => /Enable bundled LuaLaTeX/i.test(node.querySelector(".prefs-label")?.textContent ?? ""));
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

if (process.env.MDRAFT_LATEX_SAMPLE_ONLY === "1") {
  const sampleDir = join(tmpdir(), "mdraft-latex-reported-sample");
  mkdirSync(sampleDir, { recursive: true });
  const sample = readFileSync(
    join(process.cwd(), "docs", "samples", "Resumo-executivo.tex"),
    "utf8",
  );
  const imageCommand = sample.match(/\\includegraphics[^\r\n]*/)?.[0];
  if (!imageCommand) throw new Error("The reported sample has no image command");
  const samplePath = join(sampleDir, "reported.tex");
  writeFileSync(samplePath, sample);
  await page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {event: "open-files", payload: [${JSON.stringify(samplePath)}]})`,
  );
  let missing = false;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    missing = await page.evaluate(
      `document.querySelector(".latex-problems")?.textContent.includes("Missing project file") ?? false`,
    );
    if (missing) break;
    await sleep(250);
  }
  check(missing, "the reported sample identifies its missing image");
  await page.evaluate(`(() => {
    const view = document.querySelector(".cm-content").cmTile.root.view;
    const command = ${JSON.stringify(imageCommand)};
    const from = view.state.doc.toString().indexOf(command);
    if (from < 0) throw new Error("The reported image command is not in the active buffer");
    view.dispatch({changes: {from, to: from + command.length}});
  })()`);
  let state = null;
  for (let attempt = 0; attempt < 480; attempt += 1) {
    state = JSON.parse(
      String(
        await page.evaluate(
          `JSON.stringify({current: document.querySelector("#preview")?.dataset.latexCurrent ?? null, pages: document.querySelectorAll(".typst-page-shell").length, status: document.querySelector(".latex-build-message")?.textContent ?? ""})`,
        ),
      ),
    );
    if (state.current || state.status.includes("failed")) break;
    await sleep(500);
  }
  check(
    Boolean(state.current && state.pages),
    "removing the image command builds the sample",
    JSON.stringify(state),
  );
  if (state.current && process.env.MDRAFT_LATEX_SCREENSHOT) {
    const capture = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.MDRAFT_LATEX_SCREENSHOT, Buffer.from(capture.result.data, "base64"));
  }
  rmSync(sampleDir, { recursive: true, force: true });
  const failed = checks.filter((entry) => !entry.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  page.close();
  process.exit(failed ? 1 : 0);
}

console.log("\n=== a real compile produces a PDF ===");

// Open a fixture with real body text, rather than the multi-file project.
//
// `samples/latex-project` is mostly preamble and floats: a click anywhere on its page
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

console.log("\n=== the export row names its engine; Auto-compile has visible switches ===");
{
  const invoke = (command) =>
    page.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)})`);
  let pdfRow = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    pdfRow = (await invoke("menu_items")).find((item) => item.id === "export.pdf");
    if (pdfRow?.text?.includes("compiled by")) break;
    await sleep(250);
  }
  check(
    pdfRow?.text === "PDF… (compiled by LuaLaTeX)",
    "Export › PDF names the engine that compiled the preview",
    pdfRow?.text,
  );

  const toggleState = () =>
    page.evaluate(`(() => {
      const input = document.querySelector("#preview-pane > .latex-build-status .latex-auto input");
      return input ? String(input.checked) : "missing";
    })()`);
  const storedAuto = async (want) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const settings = await invoke("get_settings");
      if (settings.latexAutoCompile === want) return true;
      await sleep(150);
    }
    return false;
  };
  const menuCheck = async () =>
    (await invoke("menu_state")).find((item) => item.id === "view.latexAutoCompile");
  const prefsAuto = () =>
    page.evaluate(`
      (async () => {
        document.getElementById("btn-prefs")?.click();
        await new Promise(r => setTimeout(r, 300));
        [...document.querySelectorAll(".prefs-section")]
          .find(n => n.textContent.trim() === "LaTeX")?.click();
        await new Promise(r => setTimeout(r, 300));
        const row = [...document.querySelectorAll(".prefs-row")]
          .find(n => /Auto-compile/.test(n.querySelector(".prefs-label")?.textContent ?? ""));
        const value = String(row?.querySelector("input[type=checkbox]")?.checked ?? "missing");
        document.getElementById("btn-prefs")?.click();
        await new Promise(r => setTimeout(r, 200));
        return value;
      })()
    `);

  check((await toggleState()) === "true", "the preview offers an Auto-compile switch, on");
  const onCheck = await menuCheck();
  check(
    onCheck?.checked === true && onCheck?.enabled === true,
    "View › Compile LaTeX Automatically is checked and enabled for a .tex document",
    JSON.stringify(onCheck),
  );

  await page.evaluate(
    `document.querySelector("#preview-pane > .latex-build-status .latex-auto input").click()`,
  );
  check(await storedAuto(false), "the preview switch turns Auto-compile off in settings");
  await sleep(300);
  check((await menuCheck())?.checked === false, "the View menu check follows the preview switch");
  check((await prefsAuto()) === "false", "Preferences › LaTeX follows the preview switch");

  await emitMenu(page, "view.latexAutoCompile");
  check(await storedAuto(true), "the View menu item turns Auto-compile back on");
  await sleep(300);
  check((await toggleState()) === "true", "the preview switch follows the View menu");
  check((await prefsAuto()) === "true", "Preferences › LaTeX follows the View menu");
}

console.log("\n=== zoom reaches the compiled PDF ===");

const geometry = () =>
  page
    .evaluate(
      `
      (() => {
        const shell = document.querySelector(".typst-page-shell");
        const canvas = shell?.querySelector("canvas");
        if (!shell || !canvas) return null;
        const box = shell.getBoundingClientRect();
        return JSON.stringify({ width: box.width, height: box.height, canvas: canvas.width });
      })()
    `,
    )
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

console.log("\n=== precise PDF word correspondence ===");
let mapState = "";
for (let attempt = 0; attempt < 100; attempt += 1) {
  mapState = await page.evaluate(
    'document.querySelector(".typst-preview:not([style*=hidden])")?.dataset.wordMap ?? ""',
  );
  if (mapState === "ready" || mapState === "unavailable") break;
  await sleep(200);
}
check(mapState === "ready", "the PDF correspondence map finishes", mapState);
console.log(
  `  PDF map: ${await page.evaluate('JSON.stringify(document.querySelector(".typst-preview")?.dataset ?? {})')}`,
);
await page.evaluate(`(() => {
 const v=document.querySelector(".cm-content").cmTile.root.view;
 const at=v.state.doc.toString().indexOf("draws");
 v.dispatch({selection:{anchor:at,head:at+5}});
})()`);
await sleep(500);
const forward = await page.evaluate(`(() => {
 const h=CSS.highlights.get("mdraft-sync") ?? CSS.highlights.get("mdraft-sync-peak");
 return h ? [...h].map(r=>r.toString()).join("") : "";
})()`);
check(forward === "draws", "source selection paints only draws in the PDF", forward);
// Use a real PDF drag. A synthetic Range while CodeMirror retains focus can be
// replaced by its prior editor selection when the source decoration updates.
const phrasePoint = await page.evaluate(`(async () => {
 const phrase="A heading is a command";
 const find=()=>[...document.querySelectorAll(".typst-page .textLayer span")].find(e=>e.firstChild?.nodeType===3 && e.textContent.includes(phrase));
 let span=find(); if(!span) return "";
 span.scrollIntoView({block:"center"}); await new Promise(r=>setTimeout(r,250));
 span=find(); if(!span) return "";
 const at=span.textContent.indexOf(phrase), first=document.createRange(), last=document.createRange();
 first.setStart(span.firstChild,at); first.setEnd(span.firstChild,at+1);
 last.setStart(span.firstChild,at+phrase.length-1); last.setEnd(span.firstChild,at+phrase.length);
 const a=first.getBoundingClientRect(), b=last.getBoundingClientRect();
 return JSON.stringify({start:{x:a.left+a.width*0.15,y:(a.top+a.bottom)/2},end:{x:b.right-b.width*0.15,y:(b.top+b.bottom)/2}});
})()`);
if (phrasePoint) {
  const { start, end } = JSON.parse(phrasePoint);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...start,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 8; step += 1)
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + ((end.x - start.x) * step) / 8,
      y: start.y + ((end.y - start.y) * step) / 8,
      button: "left",
      buttons: 1,
    });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...end,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}
await sleep(700);
const reverse = await page.evaluate('window.getSelection()?.toString() ?? ""');
const sourceMark = await page.evaluate(
  '[...document.querySelectorAll(".cm-sync-word")].map(e=>e.textContent).join("")',
);
check(reverse === "A heading is a command", "the PDF phrase is selected", reverse);
check(
  sourceMark === "A heading is a command",
  "PDF selection paints the same phrase in the source",
  sourceMark,
);
check(
  (await page.evaluate('document.querySelectorAll(".latex-sync-region").length')) === 0,
  "no whole-line SyncTeX region is painted",
);

async function doubleClickPoint(point) {
  for (const clickCount of [1, 2]) {
    for (const type of ["mousePressed", "mouseReleased"])
      await page.send("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        clickCount,
      });
  }
  await sleep(500);
}
const sourcePoint = await page.evaluate(`(async () => {
  const v=document.querySelector(".cm-content").cmTile.root.view;
  const at=v.state.doc.toString().indexOf("draws");
  v.dispatch({selection:{anchor:at},scrollIntoView:true});
  await new Promise(resolve=>setTimeout(resolve,250));
  const r=v.coordsAtPos(at+2); return r ? JSON.stringify({x:r.left,y:(r.top+r.bottom)/2}) : "";
})()`);
if (sourcePoint) await doubleClickPoint(JSON.parse(sourcePoint));
const pointerForward = await page.evaluate(`(() => {
  const h=CSS.highlights.get("mdraft-sync") ?? CSS.highlights.get("mdraft-sync-peak");
  return h ? [...h].map(r=>r.toString()).join("") : "";
})()`);
check(pointerForward === "draws", "a real source double-click paints only draws", pointerForward);
const pdfPoint = await page.evaluate(`(() => {
  const span=[...document.querySelectorAll(".typst-page .textLayer span")].find(e=>e.firstChild?.nodeType===3 && e.textContent.includes("draws"));
  if(!span)return ""; span.scrollIntoView({block:"center"});
  const at=span.textContent.indexOf("draws"), r=document.createRange();
  r.setStart(span.firstChild,at); r.setEnd(span.firstChild,at+5);
  const box=r.getBoundingClientRect(); return JSON.stringify({x:box.left+box.width/2,y:box.top+box.height/2});
})()`);
if (pdfPoint) await doubleClickPoint(JSON.parse(pdfPoint));
const pointerReverse = await page.evaluate(
  '[...document.querySelectorAll(".cm-sync-word")].map(e=>e.textContent).join("")',
);
check(
  pointerReverse === "draws",
  "a real PDF double-click paints only draws in the source",
  pointerReverse,
);

// The reported defect was a **collapsed** click painting a whole line. A single
// click with no selection must either paint nothing or paint a paragraph-sized
// region — never a line-shaped rectangle, which is what the SyncTeX path did and
// what made the reader think a word had been identified.
{
  await page.evaluate(
    'window.getSelection()?.removeAllRanges(); document.querySelector(".cm-content")?.focus()',
  );
  await sleep(300);
  const collapsed = await page.evaluate(`(async () => {
    const span=[...document.querySelectorAll(".typst-page .textLayer span")]
      .find(e=>e.firstChild?.nodeType===3 && e.textContent.includes("command"));
    if(!span) return JSON.stringify({error:"no span"});
    span.scrollIntoView({block:"center"});
    const at=span.textContent.indexOf("command"), r=document.createRange();
    r.setStart(span.firstChild,at); r.setEnd(span.firstChild,at+1);
    const box=r.getBoundingClientRect();
    return JSON.stringify({x:box.left+box.width/2,y:box.top+box.height/2});
  })()`);
  const point = JSON.parse(String(collapsed));
  if (point.error) {
    check(false, "a collapsed PDF click paints no line-shaped region", point.error);
  } else {
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await sleep(600);
    const collapsedState = JSON.parse(
      String(
        await page.evaluate(`(() => {
          const marks=[...document.querySelectorAll(".cm-sync-word")].map(e=>e.textContent).join("");
          const regions=document.querySelectorAll(".latex-sync-region").length;
          const lines=marks ? marks.split(String.fromCharCode(10)).length : 0;
          return JSON.stringify({marks,regions,length:marks.length,lines});
        })()`),
      ),
    );
    // A single click may reveal the paragraph, which is legitimate feedback. What
    // it must never do is paint a whole typeset *line* as if a word were found.
    check(
      collapsedState.regions === 0,
      "a collapsed PDF click paints no line-shaped region",
      `regions=${collapsedState.regions} marks=${JSON.stringify(collapsedState.marks.slice(0, 40))}`,
    );
    check(
      collapsedState.length === 0 || collapsedState.length > 20,
      "a collapsed PDF click never paints a single word as if selected",
      `${collapsedState.length} characters`,
    );
  }
}

console.log("\n=== verbatim and equation correspondence ===");
const structureFixture =
  "\n\\section*{PDF correspondence fixtures}\n" +
  "\\begin{verbatim}\n" +
  "\\section{name} is a command used in verbatim.\n" +
  "\\end{verbatim}\n" +
  "Inline equation: $Q=7r^3$.\n" +
  "\\[\\lambda+\\mu=\\nu\\]\n";
await page.evaluate(`(() => {
  const view=document.querySelector(".cm-content")?.cmTile?.root?.view;
  if(!view) return "missing editor";
  const source=view.state.doc.toString();
  const at=source.lastIndexOf(String.fromCharCode(92)+"end{document}");
  if(at<0) return "missing document end";
  view.dispatch({changes:{from:at,insert:${JSON.stringify(structureFixture)}}});
  return "inserted";
})()`);
let structureState = "";
for (let attempt = 0; attempt < 120; attempt += 1) {
  structureState = await page.evaluate(`(() => {
    const hosts=[...document.querySelectorAll(".typst-preview")];
    for(const host of hosts){
      const spans=[...host.querySelectorAll(".textLayer span")];
      const text=spans.map(e=>e.textContent??"").join(" ");
      if(text.includes("command used in verbatim.")){
        return JSON.stringify({map:host.dataset.wordMap??"",atomic:host.dataset.wordMapAtomicAnchors??"",text:text.slice(text.indexOf("PDF correspondence"),text.indexOf("PDF correspondence")+500)});
      }
    }
    return "";
  })()`);
  if (structureState) {
    const current = JSON.parse(structureState);
    if (current.map === "ready") break;
  }
  await sleep(400);
}
const structureReady = structureState ? JSON.parse(structureState) : null;
check(
  structureReady?.map === "ready",
  "the rebuilt PDF map includes verbatim and math text",
  structureReady
    ? `${structureReady.map}, ${structureReady.atomic} equation anchors; ${structureReady.text}`
    : "fixture not compiled",
);
check(
  Number(structureReady?.atomic ?? 0) >= 2,
  "the equation map contains atomic PDF ranges",
  structureReady?.atomic ?? "missing map",
);
if (structureReady?.map === "ready") {
  async function sourceSelectText(target, after = "\\begin{verbatim}") {
    return page.evaluate(`(() => {
      const view=document.querySelector(".cm-content").cmTile.root.view;
      const source=view.state.doc.toString(), base=source.indexOf(${JSON.stringify(after)});
      const from=source.indexOf(${JSON.stringify(target)},Math.max(0,base));
      if(from<0) return "missing source text";
      view.dispatch({selection:{anchor:from,head:from+${target.length}}});
      return source.slice(from,from+${target.length});
    })()`);
  }
  async function paintedPdfText() {
    return page.evaluate(`(() => {
      const h=CSS.highlights.get("mdraft-sync")??CSS.highlights.get("mdraft-sync-peak");
      return h?[...h].map(r=>r.toString()).join(""):"";
    })()`);
  }
  for (const word of ["command", "used"]) {
    await sourceSelectText(word);
    await sleep(350);
    const paint = await paintedPdfText();
    check(paint === word, `verbatim source selection paints only ${word}`, paint);
  }
  for (const word of ["command", "used"]) {
    await page.evaluate(`(() => {
      const view=document.querySelector(".cm-content").cmTile.root.view;
      view.dispatch({selection:{anchor:0}});
      window.getSelection()?.removeAllRanges();
      document.getElementById("preview-pane")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    })()`);
    await sleep(250);
    const beforePdfGesture = await page.evaluate(
      '[...document.querySelectorAll(".cm-sync-word")].map(e=>e.textContent).join("")',
    );
    check(
      beforePdfGesture === "",
      `verbatim ${word} reverse test starts without a source mark`,
      beforePdfGesture,
    );
    await page.evaluate(`(() => {
      window.getSelection()?.removeAllRanges();
      document.getElementById("preview-pane")?.dispatchEvent(
        new KeyboardEvent("keydown",{key:"Escape",bubbles:true}),
      );
    })()`);
    const point = await page.evaluate(`(() => {
      const layer=[...document.querySelectorAll(".typst-preview .textLayer")]
        .find(e=>e.textContent.includes("command used in verbatim."));
      const span=[...(layer?.querySelectorAll("span")??[])]
        .find(e=>e.firstChild?.nodeType===3&&e.textContent.includes(${JSON.stringify(word)}));
      if(!span) return "";
      span.scrollIntoView({block:"center"});
      const at=span.textContent.indexOf(${JSON.stringify(word)}),r=document.createRange();
      r.setStart(span.firstChild,at);r.setEnd(span.firstChild,at+${word.length});
      const box=r.getBoundingClientRect();
      return JSON.stringify({x:box.left+box.width/2,y:box.top+box.height/2});
    })()`);
    if (point) await doubleClickPoint(JSON.parse(point));
    const selectedPdfText = await page.evaluate('window.getSelection()?.toString().trim() ?? ""');
    const sourcePaint = await page.evaluate(
      '[...document.querySelectorAll(".cm-sync-word")].map(e=>e.textContent).join("")',
    );
    check(selectedPdfText === word, `verbatim PDF double-click selects ${word}`, selectedPdfText);
    check(sourcePaint === word, `verbatim PDF double-click paints only ${word}`, sourcePaint);
  }

  async function selectMathOnSource(latex) {
    return page.evaluate(`(() => {
      const view=document.querySelector(".cm-content").cmTile.root.view;
      const source=view.state.doc.toString(),from=source.lastIndexOf(${JSON.stringify(latex)});
      if(from<0) return "missing equation";
      view.dispatch({selection:{anchor:from,head:from+${latex.length}}});
      return "selected";
    })()`);
  }
  const normalized = (value) => value.replace(/\s+/g, "").replace(/\u00b5/g, "μ");
  for (const [latex, expected] of [
    ["$Q=7r^3$", "Q=7r3"],
    ["\\[\\lambda+\\mu=\\nu\\]", "λ+μ=ν"],
  ]) {
    await selectMathOnSource(latex);
    await sleep(350);
    const paint = await paintedPdfText();
    check(
      normalized(paint).includes(expected),
      `selecting ${latex} highlights its whole PDF equation`,
      paint,
    );
    check(
      !paint.includes("equation"),
      `equation highlighting for ${latex} excludes neighbouring prose`,
      paint,
    );
  }
  for (const [regexSource, target, expected] of [
    ["Q", "r", "$Q=7r^3$"],
    ["λ", "µ", "\\[\\lambda+\\mu=\\nu\\]"],
  ]) {
    const selectedText = await page.evaluate(`(() => {
      const view=document.querySelector(".cm-content").cmTile.root.view;
      view.dispatch({selection:{anchor:0}});
      const layer=[...document.querySelectorAll(".typst-preview .textLayer")]
        .find(e=>/command used in verbatim\\./.test(e.textContent??""));
      if(!layer) return "";
      const spans=[...layer.querySelectorAll("span")];
      const marker=${JSON.stringify(regexSource)};
      const equationAt=spans.findIndex(e=>e.textContent.includes(marker));
      if(equationAt<0) return "";
      const span=spans.slice(equationAt,equationAt+12).find(e=>e.firstChild?.nodeType===3&&e.textContent.includes(${JSON.stringify(target)}));
      if(!span) return "";
      span.scrollIntoView({block:"center"});
      const at=span.textContent.indexOf(${JSON.stringify(target)}),r=document.createRange();
      r.setStart(span.firstChild,at);r.setEnd(span.firstChild,at+${target.length});
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(r);
      span.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));
      return selection.toString();
    })()`);
    await sleep(500);
    const sourcePaint = await page.evaluate(
      '[...document.querySelectorAll(".cm-sync-word")].map(e=>e.textContent).join("")',
    );
    check(selectedText === target, `PDF selection targets ${target}`, selectedText);
    check(sourcePaint === expected, `PDF equation selection maps to ${expected}`, sourcePaint);
  }
}

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

console.log("\n=== rebuilding at the end retains the PDF viewport ===");
const viewportStart = await page.evaluate(`(async () => {
 const content=document.querySelector(".cm-content"), v=content.cmTile.root.view;
 const pane=document.getElementById("preview-pane"), text=v.state.doc.toString();
 const at=text.lastIndexOf(String.fromCharCode(92)+"end{document}");
 v.dispatch({selection:{anchor:at},scrollIntoView:true});
 await new Promise(r=>setTimeout(r,400));
 pane.scrollTop=pane.scrollHeight;
 await new Promise(r=>setTimeout(r,200));
 window.__pdfViewportProbe={min:pane.scrollTop,frames:0,active:true};
 const frame=()=>{const p=window.__pdfViewportProbe;if(!p.active)return;p.min=Math.min(p.min,pane.scrollTop);p.frames++;requestAnimationFrame(frame);};
 requestAnimationFrame(frame);content.focus();
 return JSON.stringify({top:pane.scrollTop,pages:document.querySelectorAll(".typst-page-shell").length});
})()`);
const viewportBefore = JSON.parse(viewportStart);
const added =
  "\nViewport growth marker.\n\n" +
  Array.from(
    { length: 90 },
    (_, index) =>
      `Paragraph ${index}: A carefully typeset passage follows the end of the document.\n\n`,
  ).join("");
await page.send("Input.insertText", { text: added });
let rebuilt = false;
let rebuildError = "";
for (let attempt = 0; attempt < 180; attempt++) {
  rebuilt = await page.evaluate(
    `Boolean(document.querySelector("#preview[data-latex-current]") && [...document.querySelectorAll(".typst-page .textLayer")].some(e=>e.textContent.includes("Viewport growth marker")))`,
  );
  rebuildError = await page.evaluate('document.querySelector(".typst-error")?.textContent ?? ""');
  if (rebuildError) break;
  if (rebuilt) break;
  await sleep(500);
}
const viewportAfter = JSON.parse(
  await page.evaluate(`(() => {
 const pane=document.getElementById("preview-pane"), p=window.__pdfViewportProbe;p.active=false;
 return JSON.stringify({top:pane.scrollTop,min:p.min,frames:p.frames,pages:document.querySelectorAll(".typst-page-shell").length,max:pane.scrollHeight-pane.clientHeight});
})()`),
);
check(rebuilt, "typing produces a new current PDF", rebuildError.slice(-1500));
check(
  viewportBefore.top > 50 && viewportAfter.frames > 0 && viewportAfter.min > 50,
  "the old PDF never flashes page one during rebuilding",
  JSON.stringify({ before: viewportBefore.top, ...viewportAfter }),
);
check(
  viewportAfter.pages > viewportBefore.pages,
  "the inserted text grows the PDF onto new pages",
  `${viewportBefore.pages} -> ${viewportAfter.pages}`,
);
check(
  viewportAfter.max - viewportAfter.top < 100,
  "the last page remains visible while following the end",
  `${viewportAfter.top}/${viewportAfter.max} — commit ${await page.evaluate(
    `document.getElementById("preview")?.dataset.pdfCommit ?? "none"`,
  )}`,
);

console.log("\n=== an invalid edit preserves the last PDF ===");
await page.evaluate(`(() => {
  const v=document.querySelector(".cm-content").cmTile.root.view, text=v.state.doc.toString();
  const at=text.indexOf("Viewport growth marker.");
  v.dispatch({changes:{from:at,insert:String.fromCharCode(92)+"mdraftUndefinedCommand "}});
})()`);
let shownError = false;
for (let attempt = 0; attempt < 80; attempt++) {
  shownError = await page.evaluate(
    'Boolean(document.querySelector("#preview .pdf-rebuild-error .typst-error"))',
  );
  if (shownError) break;
  await sleep(250);
}
const failedView = JSON.parse(
  await page.evaluate(`(() => {
  const pane=document.getElementById("preview-pane");
  return JSON.stringify({top:pane.scrollTop,pages:document.querySelectorAll(".typst-page-shell").length});
})()`),
);
check(shownError, "a failed compile reports an error");
check(
  failedView.pages === viewportAfter.pages && failedView.top > 50,
  "a failed compile keeps the previous PDF and viewport",
  JSON.stringify(failedView),
);

const partialOffered = await page.evaluate(
  `Boolean([...document.querySelectorAll(".latex-problems button")].find(button => button.textContent === "View partial PDF"))`,
);
if (partialOffered) {
  await page.evaluate(
    `[...document.querySelectorAll(".latex-problems button")].find(button => button.textContent === "View partial PDF").click()`,
  );
  let partialShown = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    partialShown = await page.evaluate(
      `document.querySelector(".latex-build-message")?.textContent.includes("Partial PDF") && Boolean(document.querySelector(".typst-page-shell")) && Boolean(document.querySelector(".latex-problems"))`,
    );
    if (partialShown) break;
    await sleep(250);
  }
  check(partialShown, "an available partial PDF is labelled and retains the errors");
} else {
  console.log("  note: this compiler failure returned no partial PDF");
}

// **Undo the deliberate break.** Leaving `\mdraftUndefinedCommand` in the buffer
// poisons every later section: the two-column fixture opens as a new tab, but the
// Reference tab still holds the bad command, so the next compile that touches it
// reports `Undefined control sequence` and the export/print checks find no
// current PDF. The probe is about a *transient* failure, so it is reverted.
await page.evaluate(`(() => {
  const v=document.querySelector(".cm-content").cmTile.root.view, text=v.state.doc.toString();
  const at=text.indexOf(String.fromCharCode(92)+"mdraftUndefinedCommand ");
  if (at >= 0) v.dispatch({changes:{from:at,to:at+String.fromCharCode(92).length+"mdraftUndefinedCommand ".length}});
})()`);
let recovered = false;
for (let attempt = 0; attempt < 80; attempt++) {
  recovered = await page.evaluate(
    `Boolean(document.querySelector("#preview[data-latex-current]") && !document.querySelector("#preview .pdf-rebuild-error"))`,
  );
  if (recovered) break;
  await sleep(250);
}
check(recovered, "undoing the break restores a current PDF");

console.log("\n=== two columns ===");

// The Reference buffer is dirty from the viewport and invalid-edit probes above.
// Opening another document therefore raises the unsaved-changes dialog and the
// open does not happen — which made this section compile the *previous* document
// and report a failure citing lines that do not exist in the fixture. The dialog
// only appears *after* the open is requested, so it is dismissed after the emit.
//
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
await sleep(900);
for (let attempt = 0; attempt < 10; attempt += 1) {
  const open = await page.evaluate(`Boolean(document.querySelector(".unsaved-dialog[open]"))`);
  if (!open) break;
  await page.evaluate(
    `document.querySelector('.unsaved-dialog [data-decision="discard"]')?.click()`,
  );
  await sleep(700);
}
await sleep(1200);
await emitMenu(page, "view.split");

let columnPages = 0;
for (let attempt = 0; attempt < 120; attempt += 1) {
  columnPages = await page.evaluate(
    `document.querySelector("#preview[data-latex-current]") && document.querySelector(".typst-page .textLayer")?.textContent.includes("first paragraph begins") ? document.querySelectorAll(".typst-page-shell canvas").length : 0`,
  );
  if (columnPages > 0) break;
  await sleep(500);
}
check(columnPages > 0, "the two-column fixture compiles", `${columnPages} page(s)`);
if (columnPages === 0) {
  const why = await page.evaluate(
    `document.querySelector(".typst-error")?.textContent?.slice(0, 160) ?? "no error shown"`,
  );
  const tabs = await page.evaluate(
    `[...document.querySelectorAll(".doc-tab")].map(t=>t.textContent.trim()).join(" | ")`,
  );
  const dialog = await page.evaluate(
    `document.querySelector(".unsaved-dialog[open]") ? "unsaved dialog open" : "no dialog"`,
  );
  console.log(`  two-column failure: ${String(why)}`);
  console.log(`  tabs: ${String(tabs)}  (${dialog})`);
}

if (columnPages > 0) {
  /**
   * Scroll the editor with a **real wheel event**, not a `scrollTop` write.
   *
   * CodeMirror's `onScroll` does not emit for a programmatic `scrollTop`
   * assignment — measured: setting it to 0 and dispatching a `scroll` event
   * produced no `[latex-scroll]` line at all, so the correspondence never ran and
   * the preview appeared not to follow. `Input.dispatchMouseEvent` with
   * `type: "mouseWheel"` is what a reader actually does, and CodeMirror observes it.
   */
  async function wheelEditor(deltaY) {
    const point = await page.evaluate(`
      (() => {
        const box = document.querySelector(".cm-scroller")?.getBoundingClientRect();
        if (!box) return null;
        return JSON.stringify({
          x: Math.round(box.left + box.width / 2),
          y: Math.round(box.top + box.height / 2),
        });
      })()
    `);
    if (!point) return;
    const { x, y } = JSON.parse(point);
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
      pointerType: "mouse",
    });
    await sleep(700);
  }

  const paneOffset = () =>
    page.evaluate(`Math.round(document.getElementById("preview-pane").scrollTop)`);
  const editorOffset = () =>
    page.evaluate(`Math.round(document.querySelector(".cm-scroller").scrollTop)`);

  /** Wheel up until the **editor** reaches the top, or give up. */
  async function wheelToTop() {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if ((await editorOffset()) === 0) return true;
      await wheelEditor(-1200);
    }
    return (await editorOffset()) === 0;
  }

  // The reset is asserted on the **editor**, because that is the input the
  // correspondence consumes. Checking the preview instead was what made the second
  // pass start at 217: the preview had reached 0 while the editor had not.
  check(
    await wheelToTop(),
    "the wheel returns the editor to the top",
    `editor ${await editorOffset()}, preview ${await paneOffset()}`,
  );

  const seen = [];
  for (let step = 0; step < 5; step += 1) {
    await wheelEditor(400);
    seen.push(await paneOffset());
  }

  check(
    seen.some((value) => value > 0),
    "the preview moves while wheeling through a two-column document",
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

  // Convergence: wheel back to the top and repeat. This is the assertion that
  // caught the non-determinism, and it only means anything if the reset is observed
  // — which is why the wheel is used for it too.
  await wheelToTop();
  const again = [];
  for (let step = 0; step < 5; step += 1) {
    await wheelEditor(400);
    again.push(await paneOffset());
  }
  // **The destination is deterministic; the trajectory is not, and should not be.**
  //
  // Both passes end at 318 and both pass through 243 — the mapping from a source
  // line to a preview position is a function of the document. But the *path* differs
  // because the top of this document is the comment header and the preamble, neither
  // of which is typeset: the correspondence correctly produces no target there, so
  // the preview stays wherever it was until the editor reaches a line that is on the
  // page. Pass 1 began at 0 and pass 2 began at 318 for exactly that reason.
  //
  // Asserting identical trajectories would demand that a comment line move the
  // preview, which is the opposite of the fail-closed rule the correspondence is
  // built on.
  // **The destination is deterministic; the trajectory is not, and should not be.**
  //
  // Both passes end at 318 — the mapping from a source line to a preview position is a
  // function of the document, which is the guarantee that matters and the one the
  // earlier non-determinism violated (it produced 277 on one pass and 318 on another).
  //
  // The *paths* differ, and legitimately: the top of this document is a comment header
  // and a preamble, neither of which is typeset, so the correspondence correctly
  // produces no target there and leaves the preview where it was. Pass 1 began at 0 and
  // pass 2 at 318 for exactly that reason, and a wheel near the end of the pane clamps.
  // Asserting identical trajectories would demand that a comment line move the preview,
  // which is the opposite of the fail-closed rule the correspondence is built on.
  check(
    again[again.length - 1] === seen[seen.length - 1],
    "both wheel passes end at the same preview position",
    `${seen[seen.length - 1]} vs ${again[again.length - 1]}`,
  );
  check(
    seen.every(
      (value, index) => index === 0 || value >= seen[index - 1] || value === seen[seen.length - 1],
    ),
    "wheeling down never moves the preview up except at the clamp",
    seen.join(","),
  );

  const scrollLines = consoleLines.filter((line) => line.includes("[latex-scroll]"));
  if (scrollLines.length) {
    console.log(`  scroll log (last 6):\n    ${scrollLines.slice(-6).join("\n    ")}`);
  }
}

console.log("\n=== File › Export for a .tex document ===");

// The reported defect: a `.tex` document answered every export row with
// "LaTeX exports its own PDF through the preview; export formats arrive with it".
// The gate is gone, and this drives the real menu event with only the native save
// dialog stubbed — everything after the dialog runs for real.
{
  const exportDir = join(tmpdir(), "mdraft-latex-export");
  rmSync(exportDir, { recursive: true, force: true });
  mkdirSync(exportDir, { recursive: true });
  const pdfTarget = join(exportDir, "compiled.pdf");
  const mdTarget = join(exportDir, "converted.md");

  // Only `plugin:dialog|save` is stubbed; `save_compiled_pdf` and the pandoc
  // command run for real. `saveCompiledPdf`'s data is captured so the written
  // file can be compared with the bytes the frontend handed over.
  await page.evaluate(`(() => {
    const state = window.__latexExportTest = {
      original: window.fetch,
      next: null,
      compiled: [],
      messages: [],
    };
    window.fetch = async function (input, options) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.hostname !== 'ipc.localhost') return state.original.call(window, input, options);
      const command = decodeURIComponent(url.pathname.slice(1));
      const args = typeof options?.body === 'string' ? JSON.parse(options.body) : {};
      const respond = (value, ok = true) =>
        new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json', 'Tauri-Response': ok ? 'ok' : 'error' },
        });
      if (command === 'plugin:dialog|save') {
        const chosen = state.next;
        state.next = null;
        return respond(chosen);
      }
      if (command === 'save_compiled_pdf') {
        state.compiled.push({ path: args.outputPath, length: args.data.length, head: atob(args.data.slice(0, 8)) });
      }
      if (command === 'plugin:dialog|message') {
        state.messages.push(args.message);
        return respond('Ok');
      }
      return state.original.call(window, input, options);
    };
  })()`);

  const before = await page.evaluate(
    `JSON.stringify({ token: document.querySelector('[data-latex-current]')?.dataset.latexCurrent ?? null, ms: document.querySelector('[data-latex-ms]')?.dataset.latexMs ?? null })`,
  );

  // File › Export › PDF writes the compiled bytes. The row is enabled because a
  // current compile exists.
  await page.evaluate(`window.__latexExportTest.next = ${JSON.stringify(pdfTarget)}`);
  await emitMenu(page, "export.pdf");
  await sleep(2500);

  const compiled = await page.evaluate(`JSON.stringify(window.__latexExportTest.compiled)`);
  const captured = JSON.parse(String(compiled));
  check(
    captured.length === 1,
    "File › Export › PDF writes the compiled PDF",
    captured.length === 0 ? "save_compiled_pdf was never called" : captured[0].path,
  );
  if (captured.length > 0) {
    check(
      captured[0].head.startsWith("%PDF-"),
      "the bytes handed to the writer are a PDF",
      captured[0].head,
    );
    check(
      captured[0].path === pdfTarget,
      "the compiled PDF goes to the chosen path",
      captured[0].path,
    );
  }
  const written = existsSync(pdfTarget) ? readFileSync(pdfTarget) : null;
  check(
    written !== null && written.subarray(0, 5).toString() === "%PDF-",
    "the exported PDF is on disk and starts with %PDF-",
    written ? `${written.length} bytes` : "no file",
  );
  if (written && captured.length > 0) {
    // The command writes exactly the bytes it was given, so this is the proof the
    // file is the preview's PDF rather than a re-render.
    check(
      Math.ceil(captured[0].length / 4) * 3 - written.length < 4,
      "the file holds the bytes the preview handed over",
      `base64 ${captured[0].length} chars, file ${written.length} bytes`,
    );
  }
  const after = await page.evaluate(
    `JSON.stringify({ token: document.querySelector('[data-latex-current]')?.dataset.latexCurrent ?? null, ms: document.querySelector('[data-latex-ms]')?.dataset.latexMs ?? null })`,
  );
  check(
    String(before) === String(after),
    "exporting the PDF does not start another compile",
    `${before} -> ${after}`,
  );
  check(
    !(await page.evaluate(`document.getElementById('toast').textContent`)).includes(
      "export formats arrive with it",
    ),
    "the stale LaTeX export toast is gone",
  );

  // Export › Markdown is a real conversion through pandoc's LaTeX reader, and it
  // reads the project snapshot rather than the file on disk.
  await page.evaluate(`window.__latexExportTest.next = ${JSON.stringify(mdTarget)}`);
  await emitMenu(page, "export.markdown");
  await sleep(6000);
  check(
    existsSync(mdTarget),
    "LaTeX exports Markdown through pandoc",
    existsSync(mdTarget) ? `${readFileSync(mdTarget).length} bytes` : "no file",
  );
  if (existsSync(mdTarget)) {
    const text = readFileSync(mdTarget, "utf8");
    check(
      /^#{1,3} /m.test(text),
      "the Markdown carries the document's headings",
      text.split("\n").find((line) => line.startsWith("#")) ?? "no heading",
    );
    check(
      !text.includes("\\documentclass") && !text.includes("\\section"),
      "the LaTeX commands are converted, not copied",
      text.includes("\\section") ? "a raw command survived" : "clean",
    );
  }

  await page.evaluate(
    `window.fetch = window.__latexExportTest.original; delete window.__latexExportTest`,
  );
  rmSync(exportDir, { recursive: true, force: true });
}

// File › Print for a `.tex` document hands the compiled bytes to the PDF viewer,
// never a re-render. The viewer handoff is stubbed; the bytes are checked.
{
  await page.evaluate(`(() => {
    const state = window.__latexPrintTest = { original: window.fetch, printed: [] };
    window.fetch = async function (input, options) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.hostname !== 'ipc.localhost') return state.original.call(window, input, options);
      const command = decodeURIComponent(url.pathname.slice(1));
      if (command === 'print_compiled_pdf') {
        const args = typeof options?.body === 'string' ? JSON.parse(options.body) : {};
        state.printed.push({ name: args.name, head: atob(args.data.slice(0, 8)), length: args.data.length });
        return new Response(JSON.stringify('stub.pdf'), {
          headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
        });
      }
      return state.original.call(window, input, options);
    };
  })()`);
  await emitMenu(page, "file.print");
  await sleep(2500);
  const printed = JSON.parse(
    String(await page.evaluate(`JSON.stringify(window.__latexPrintTest.printed)`)),
  );
  check(
    printed.length === 1,
    "File › Print hands the compiled PDF to the viewer",
    printed.length === 0 ? "print_compiled_pdf was never called" : printed[0].name,
  );
  if (printed.length > 0) {
    check(
      printed[0].head.startsWith("%PDF-"),
      "Print receives compiled PDF bytes, not a re-render",
      printed[0].head,
    );
  }
  await page.evaluate(
    `window.fetch = window.__latexPrintTest.original; delete window.__latexPrintTest`,
  );
}

console.log("\n=== measurement ===");

// Step 13 of the product plan and step 10 of the checklist both ask for real
// numbers, and the only honest source is a real compile in the real application.
// The preview carries `data-latex-ms` on each render, so the timings come from the
// app rather than from a stopwatch around an IPC call.
const timings = await page.evaluate(`
  (async () => {
    const pane = document.getElementById("preview-pane");
    const read = () => {
      const node = pane?.querySelector("[data-latex-ms]");
      return node ? Number(node.dataset.latexMs) : null;
    };
    const samples = [];
    const first = read();
    if (first !== null) samples.push(first);
    // Recompile by touching the document: a warm compile reuses the engine and the
    // package cache, which is the number a reader actually feels.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = read();
      const editor = document.querySelector(".cm-content");
      editor?.focus();
      document.execCommand("insertText", false, " ");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const after = read();
      if (after !== null && after !== before) samples.push(after);
    }
    return JSON.stringify({ first, samples });
  })().catch((error) => JSON.stringify({ error: String(error) }))
`);
const measured = JSON.parse(String(timings));
if (measured.error) {
  console.log(`  timing probe failed: ${measured.error}`);
} else if (measured.samples.length === 0) {
  console.log("  SKIP  no compile timing was reported by the preview");
} else {
  const warm = measured.samples.slice(1);
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
  };
  console.log(`  first compile: ${measured.first} ms`);
  console.log(`  warm compiles: ${warm.join(", ")} ms (median ${median(warm)} ms)`);
  check(
    measured.first !== null && measured.first > 0,
    "the preview reports a compile time",
    `${measured.first} ms`,
  );
}

// The cache the engine downloads into, which step 13 asks about and which a reader
// indirectly pays for on disk.
const cache = await page.evaluate(`
  window.__TAURI_INTERNALS__.invoke("latex_cache_info")
    .then(JSON.stringify)
    .catch((error) => "error: " + String(error))
`);
if (!String(cache).startsWith("error")) {
  const info = JSON.parse(String(cache));
  console.log(
    `  engine cache: ${(info.bytes / 1024 / 1024).toFixed(1)} MiB of ${info.limitMb} MiB` +
      ` (installed: ${info.installed}, enabled: ${info.enabled})`,
  );
  check(
    info.bytes > 0 && info.bytes <= info.limitMb * 1024 * 1024,
    "the engine cache is populated and inside its ceiling",
    `${(info.bytes / 1024 / 1024).toFixed(1)} MiB`,
  );
}

// Typing latency with the LaTeX preview live. Step 13 asks for p95, and the honest
// way to get it is to type into the real editor while the preview is compiled and
// measure the round trip from keydown to the next animation frame.
const typing = await page.evaluate(`
  (async () => {
    const editor = document.querySelector(".cm-content");
    if (!editor) return JSON.stringify({ error: "no editor" });
    editor.focus();
    const samples = [];
    for (let index = 0; index < 24; index += 1) {
      const start = performance.now();
      document.execCommand("insertText", false, "x");
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const at = (fraction) => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
    return JSON.stringify({
      p50: at(0.5),
      p95: at(0.95),
      max: samples[samples.length - 1],
    });
  })().catch((error) => JSON.stringify({ error: String(error) }))
`);
if (!String(typing).startsWith("error")) {
  const latency = JSON.parse(String(typing));
  if (latency.error) {
    console.log(`  typing probe failed: ${latency.error}`);
  } else {
    console.log(
      `  typing latency: p50 ${latency.p50.toFixed(1)} ms, p95 ${latency.p95.toFixed(1)} ms,` +
        ` max ${latency.max.toFixed(1)} ms`,
    );
    // The editor's own budget. A keypress that takes longer than a frame is felt.
    check(
      latency.p95 < 50,
      "typing stays responsive with the LaTeX preview live",
      `p95 ${latency.p95.toFixed(1)} ms`,
    );
  }
}

console.log("\n=== a missing figure points at the included file ===");

// The reported shape: a main document `\input`s a chapter that references an
// image which does not exist, with the same image also commented out. The panel
// must name only the live line, the editor must mark that command, and a failing
// build must open the included file rather than silently compiling it as the
// main document.
{
  const problemsDir = join(tmpdir(), "mdraft-latex-problems");
  rmSync(problemsDir, { recursive: true, force: true });
  mkdirSync(problemsDir, { recursive: true });
  writeFileSync(
    join(problemsDir, "main.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{Resumo executivo}",
      "\\end{document}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(problemsDir, "Resumo executivo.tex"),
    [
      "\\section{Resumo}",
      "\\begin{figure}",
      "\\centering",
      // The reported form: `%` immediately followed by the command, no space.
      "%\\includegraphics{arquitetura_tecnológica_biocomp_perenes(1).png}",
      "\\includegraphics{arquitetura_tecnológica_biocomp_perenes(1).png}",
      "\\caption{Arquitetura}",
      "\\end{figure}",
      "",
    ].join("\n"),
  );

  await page.evaluate(`
    window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "open-files",
      payload: [${JSON.stringify(join(problemsDir, "main.tex"))}],
    })
  `);

  let panel = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    panel = await page.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll(".latex-problem")];
        if (!rows.length) return null;
        return JSON.stringify(rows.map((row) => ({
          place: row.querySelector(".latex-problem-place")?.textContent ?? "",
          source: row.querySelector(".latex-problem-source")?.textContent ?? "",
        })));
      })()
    `);
    if (panel) break;
    await sleep(500);
  }
  const rows = panel ? JSON.parse(String(panel)) : [];
  check(rows.length === 1, "one live occurrence is one row", `${rows.length} row(s)`);
  check(
    rows[0]?.place === "Resumo executivo.tex:5",
    "the row names the included file and the live line",
    rows[0]?.place ?? "none",
  );
  check(
    (rows[0]?.source ?? "").includes(
      "\\includegraphics{arquitetura_tecnológica_biocomp_perenes(1).png}",
    ),
    "the row shows the line the compiler read",
    rows[0]?.source ?? "none",
  );

  await sleep(600);
  const jumped = await page.evaluate(`
    (() => {
      // This build marks the active tab with \`aria-selected\`, not an \`.active\`
      // class; querying the class found nothing and made a working jump look like
      // a missing one.
      const active = document.querySelector('.doc-tab[aria-selected="true"]');
      return JSON.stringify({
        tab: active?.textContent?.trim() ?? "",
        // A wrapped range is one element per visual row, so join the segments.
        marks: [...document.querySelectorAll(".cm-latex-error")]
          .map((node) => node.textContent)
          .join(""),
      });
    })()
  `);
  const jump = JSON.parse(String(jumped));
  check(
    jump.tab.includes("Resumo executivo.tex"),
    "a new failure opens the included file",
    jump.tab || "none",
  );
  check(
    jump.marks.includes("\\includegraphics{arquitetura_tecnológica_biocomp_perenes(1).png}"),
    "the editor marks the offending command",
    JSON.stringify(jump.marks),
  );

  // Comment the live line through the real editor and wait for the next compile
  // to succeed. The main document is a valid `article`, so the panel must clear.
  await page.evaluate(`
    (() => {
      const view = document.querySelector(".cm-content").cmTile.root.view;
      const lines = view.state.doc.toString().split("\\n");
      // The live line, not the already-commented one above it.
      const index = lines.findIndex((line) =>
        line.trimStart().startsWith("\\\\includegraphics{arquitetura"),
      );
      if (index < 0) throw new Error("the live figure line is gone");
      const from = lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0);
      view.dispatch({ changes: { from, insert: "%" } });
    })()
  `);
  let cleared = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    cleared = await page.evaluate(`
      Boolean(
        !document.querySelector(".latex-problems") &&
        document.querySelector("#preview .typst-page-shell")
      )
    `);
    if (cleared) break;
    await sleep(500);
  }
  const after = await page.evaluate(`
    JSON.stringify({
      problems: document.querySelectorAll(".latex-problem").length,
      marks: document.querySelectorAll(".cm-latex-error").length,
    })
  `);
  check(
    cleared,
    "commenting the live line clears the panel after a successful compile",
    String(after),
  );
  check(
    JSON.parse(String(after)).marks === 0,
    "a successful compile removes the marks",
    String(after),
  );

  const manual = await page.evaluate(`
    (async () => {
      document.getElementById("btn-prefs")?.click();
      await new Promise(r => setTimeout(r, 300));
      [...document.querySelectorAll(".prefs-section")]
        .find(n => n.textContent.trim() === "LaTeX")?.click();
      await new Promise(r => setTimeout(r, 300));
      const row = [...document.querySelectorAll(".prefs-row")]
        .find(n => /Auto-compile/.test(n.querySelector(".prefs-label")?.textContent ?? ""));
      const box = row?.querySelector("input[type=checkbox]");
      if (!box) throw new Error("Auto-compile control is missing");
      if (box.checked) box.click();
      document.getElementById("btn-prefs")?.click();
      const view = document.querySelector(".cm-content").cmTile.root.view;
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\\n% manual compile test" } });
      await new Promise(r => setTimeout(r, 1400));
      return JSON.stringify({ status: document.querySelector(".latex-build-message")?.textContent, current: document.querySelector("#preview")?.dataset.latexCurrent ?? null });
    })()
  `);
  const manualState = JSON.parse(String(manual));
  check(
    manualState.status?.includes("Select Compile") && manualState.current === null,
    "manual mode marks an edit stale without compiling",
    String(manual),
  );
  await page.evaluate(`
    [...document.querySelectorAll(".latex-build-status button")]
      .find(button => button.textContent === "Compile")?.click()
  `);
  let manualCompiled = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    manualCompiled = await page.evaluate(
      `Boolean(document.querySelector("#preview")?.dataset.latexCurrent)`,
    );
    if (manualCompiled) break;
    await sleep(500);
  }
  check(manualCompiled, "Compile builds the current unsaved manual-mode revision");

  const shortcutHandled = await page.evaluate(`
    (() => {
      const view = document.querySelector(".cm-content").cmTile.root.view;
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\\nA reference: \\\\ref{mdraft-missing-label}." } });
      const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      document.querySelector(".cm-content").dispatchEvent(event);
      return event.defaultPrevented;
    })()
  `);
  check(shortcutHandled, "Ctrl+Shift+Enter reaches Compile while the editor has focus");
  let warningPdf = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    warningPdf = await page.evaluate(
      `Boolean(document.querySelector("#preview")?.dataset.latexCurrent && document.querySelector(".latex-warnings > summary")?.textContent.includes("warning"))`,
    );
    if (warningPdf) break;
    await sleep(500);
  }
  check(warningPdf, "an undefined-reference warning remains visible beside the current PDF");

  const cancelled = await page.evaluate(`(async () => {
    const view = document.querySelector(".cm-content").cmTile.root.view;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\\n% cancelled compile" } });
    [...document.querySelectorAll(".latex-build-status button")].find(b => b.textContent === "Compile")?.click();
    const cancel = document.querySelector(".latex-cancel");
    if (!cancel || cancel.hidden) throw new Error("Cancel was not offered during compilation");
    cancel.click();
    await new Promise(r => setTimeout(r, 1400));
    return JSON.stringify({status: document.querySelector(".latex-build-message")?.textContent, current: document.querySelector("#preview")?.dataset.latexCurrent ?? null});
  })()`);
  const cancelledState = JSON.parse(String(cancelled));
  check(
    cancelledState.status?.includes("cancelled") && !cancelledState.current,
    "Cancel invalidates the active build",
    String(cancelled),
  );

  if (process.env.MDRAFT_LATEX_REPORTED_SAMPLE === "1") {
    const sample = readFileSync(
      join(process.cwd(), "docs", "samples", "Resumo-executivo.tex"),
      "utf8",
    );
    const imageCommand = sample.match(/\\includegraphics[^\r\n]*/)?.[0];
    if (!imageCommand) throw new Error("The reported sample no longer contains an image command");
    const samplePath = join(problemsDir, "reported.tex");
    writeFileSync(samplePath, sample);
    await page.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "open-files", payload: [${JSON.stringify(samplePath)}]
    })`);
    await sleep(700);
    await page.evaluate(
      `[...document.querySelectorAll(".latex-build-status button")].find(b => b.textContent === "Compile")?.click()`,
    );
    let missing = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      missing = await page.evaluate(
        `document.querySelector(".latex-problems")?.textContent.includes("Missing project file") ?? false`,
      );
      if (missing) break;
      await sleep(250);
    }
    check(missing, "the reported sample identifies its missing image");
    await page.evaluate(`(() => {
      const view = document.querySelector(".cm-content").cmTile.root.view;
      const command = ${JSON.stringify(imageCommand)};
      const from = view.state.doc.toString().indexOf(command);
      if (from < 0) throw new Error("The reported image command is not in the active buffer");
      view.dispatch({ changes: { from, to: from + command.length } });
      [...document.querySelectorAll(".latex-build-status button")].find(b => b.textContent === "Compile")?.click();
    })()`);
    let outcome = null;
    for (let attempt = 0; attempt < 480; attempt += 1) {
      outcome = await page.evaluate(
        `JSON.stringify({current: document.querySelector("#preview")?.dataset.latexCurrent ?? null, pages: document.querySelectorAll(".typst-page-shell").length, status: document.querySelector(".latex-build-message")?.textContent ?? "", details: document.querySelector(".latex-problems")?.textContent?.slice(0, 600) ?? ""})`,
      );
      const state = JSON.parse(String(outcome));
      if (state.current || state.status.includes("failed")) break;
      await sleep(500);
    }
    const state = JSON.parse(String(outcome));
    check(
      Boolean(state.current && state.pages),
      "the reported sample builds after removing the image command in the unsaved buffer",
      String(outcome),
    );
    if (state.current && process.env.MDRAFT_LATEX_SCREENSHOT) {
      const capture = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(
        process.env.MDRAFT_LATEX_SCREENSHOT,
        Buffer.from(capture.result.data, "base64"),
      );
    }
  }

  rmSync(problemsDir, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
page.close();
process.exit(failed === 0 ? 0 : 1);
