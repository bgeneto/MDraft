//! Document zoom across the editor and every preview renderer.
//!
//!     npm test -- --only preview-zoom
//!
//! The window starts on `samples/export-tour.md`, which has a paragraph, a
//! local image and a Mermaid diagram. The suite opens the AsciiDoc, Typst and
//! HTML fixtures itself. Geometry is measured with getBoundingClientRect, which
//! includes CSS zoom; a bare computed font-size would not.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = Number(process.argv[2] ?? 9222);
const repo = process.env.MDRAFT_REPO ?? process.cwd();
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error(`No page target for the preview zoom test on port ${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
ws.addEventListener("message", (event) => {
  const response = JSON.parse(event.data);
  const resolve = pending.get(response.id);
  if (resolve) {
    pending.delete(response.id);
    resolve(response);
  }
});
await new Promise((resolve) => ws.addEventListener("open", resolve));

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await send("Runtime.enable");

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.error || result.result?.exceptionDetails) {
    throw new Error(
      result.result?.exceptionDetails?.exception?.description ?? JSON.stringify(result.error),
    );
  }
  return result.result.result.value;
}
const invoke = (command, args = {}) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(expression, limit = 20000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  throw new Error(`Timed out: ${expression}`);
}
const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
async function menu(id) {
  await sleep(300);
  await invoke("plugin:event|emit", { event: "menu", payload: id });
  await sleep(380);
}
const settings = () => invoke("get_settings");
const tab = (name) =>
  `[...document.querySelectorAll('.doc-tab')].find(t=>t.querySelector('.doc-tab-name')?.textContent===${JSON.stringify(name)})`;

async function openFile(file) {
  await invoke("plugin:event|emit", { event: "open-files", payload: [file] });
  await wait(`${tab(path.basename(file))}?.getAttribute('aria-selected')==='true'`);
  await sleep(500);
}
async function view(mode) {
  await menu(`view.${mode}`);
  await wait(`document.querySelector('.app').classList.contains('mode-${mode}')`);
}
async function zoomTo(level) {
  await menu("view.zoomReset");
  for (let value = 100; value < level; value += 10) await menu("view.zoomIn");
}
const chip = () =>
  evaluate(
    `(() => { const b = document.getElementById('status-zoom'); return { hidden: b.hidden, text: b.textContent }; })()`,
  );
const previewZoom = () =>
  evaluate(`parseFloat(getComputedStyle(document.getElementById('preview')).zoom || '1')`);
const editorFont = () =>
  evaluate(`parseFloat(getComputedStyle(document.querySelector('.cm-content')).fontSize)`);
const contentWidth = () =>
  evaluate(
    `getComputedStyle(document.documentElement).getPropertyValue('--editor-max-width').trim()`,
  );
const paragraphBox = () =>
  evaluate(
    `(() => { const p = document.querySelector('#preview p'); if (!p) return null; const r = p.getBoundingClientRect(); return { width: r.width, height: r.height }; })()`,
  );
const imageBox = () =>
  evaluate(
    `(() => { const i = document.querySelector('#preview img'); if (!i) return null; const r = i.getBoundingClientRect(); return { width: r.width, height: r.height }; })()`,
  );

/** Scroll the word "figure" into view and return a click point after layout. */
async function wordPoint() {
  await evaluate(`(() => {
    const p = [...document.querySelectorAll('#preview p')].find((node) => node.textContent.includes('figure'));
    if (p) p.scrollIntoView({ block: 'center' });
  })()`);
  await sleep(250);
  return evaluate(`(() => {
    const p = [...document.querySelectorAll('#preview p')].find((node) => node.textContent.includes('figure'));
    if (!p) return null;
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.indexOf('figure');
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 6);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    return null;
  })()`);
}
async function doubleClickAt(x, y) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 2,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 2,
  });
}

try {
  if (!(await invoke("typst_status")).found) {
    throw new Error(
      "Document zoom's Typst checks require Typst. Install it through MDraft Tools or put typst on PATH before running preview-zoom.",
    );
  }
  await wait(
    `document.querySelector('.cm-content') && document.title.includes('export-tour.md')`,
    60000,
  );
  await view("split");
  await wait(
    `document.querySelector('#preview img') && document.querySelector('#preview svg')`,
    30000,
  );

  const baseFont = await editorFont();
  const baseParagraph = await paragraphBox();
  const baseImage = await imageBox();
  const baseWidth = await contentWidth();
  const baseChip = await chip();
  check(baseChip.hidden === true, "100% hides the zoom chip at startup");
  check(
    baseParagraph !== null && baseImage !== null,
    "the Markdown fixture has a paragraph and image",
  );

  await zoomTo(150);
  check(Math.abs((await previewZoom()) - 1.5) < 0.01, "Split zoom sets the preview to 150%");
  check((await chip()).text === "150%", "the status chip reads 150%");
  check(
    Math.abs((await editorFont()) - baseFont * 1.5) < 0.6,
    "the editor font follows the same 150%",
  );
  const zoomedParagraph = await paragraphBox();
  const zoomedImage = await imageBox();
  check(
    zoomedParagraph && baseParagraph && zoomedParagraph.height > baseParagraph.height * 1.35,
    "the paragraph reflows and grows with zoom",
    baseParagraph && zoomedParagraph
      ? `${baseParagraph.height} -> ${zoomedParagraph.height}`
      : "missing",
  );
  check(
    zoomedImage && baseImage && Math.abs(zoomedImage.width - baseImage.width * 1.5) < 2,
    "the image scales with the document",
    baseImage && zoomedImage ? `${baseImage.width} -> ${zoomedImage.width}` : "missing",
  );
  check(
    await evaluate(
      `(() => { const p = document.getElementById('preview'); return p.scrollWidth <= p.clientWidth + 1; })()`,
    ),
    "the zoomed DOM article has no horizontal overflow",
  );
  check((await contentWidth()) === baseWidth, "zoom leaves Content Width untouched");

  const point = await wordPoint();
  check(point !== null, "the zoomed word is on screen");
  if (point) {
    await doubleClickAt(point.x, point.y);
    await wait(`!!document.querySelector('.cm-sync-word')`, 5000);
    check(
      await evaluate(
        `(document.querySelector('.cm-sync-word')?.textContent ?? '').includes('figure')`,
      ),
      "a zoomed double-click still paints the source word",
    );
  }

  // Keyboard movement must still reveal the matching zoomed block.
  await evaluate(`document.getElementById('preview-pane').scrollTop = 0`);
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "End",
    code: "End",
    modifiers: 2,
    windowsVirtualKeyCode: 35,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "End",
    code: "End",
    modifiers: 0,
    windowsVirtualKeyCode: 35,
  });
  await sleep(700);
  check(
    (await evaluate(`document.getElementById('preview-pane').scrollTop`)) > 10,
    "Ctrl+End reveals the zoomed preview block",
  );

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(os.tmpdir(), "mdraft-zoom-150.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.result.data, "base64"));
  check(fs.statSync(shotPath).size > 10_000, "a 150% screenshot was captured");

  await menu("view.zoomReset");
  check((await chip()).hidden === true, "reset hides the chip");
  check(Math.abs((await previewZoom()) - 1) < 0.01, "reset returns the preview to 100%");
  check((await contentWidth()) === baseWidth, "reset does not change Content Width");

  // -------------------------------------------------------------------------
  // Preview-only and Source-only policies
  // -------------------------------------------------------------------------
  await view("preview");
  await menu("view.zoomReset");
  const previewBase = await paragraphBox();
  await zoomTo(150);
  const previewOnly = await paragraphBox();
  check(
    Math.abs((await previewZoom()) - 1.5) < 0.01 &&
      previewOnly &&
      previewBase &&
      previewOnly.height > previewBase.height * 1.35,
    "Preview-only zoom affects the rendered document",
    previewBase && previewOnly ? `${previewBase.height} -> ${previewOnly.height}` : "missing",
  );
  await menu("view.zoomReset");

  await view("source");
  const sourceBase = await editorFont();
  await zoomTo(150);
  check(
    Math.abs((await editorFont()) - sourceBase * 1.5) < 0.6,
    "Source-only zoom affects the editor",
  );
  await menu("view.zoomReset");

  // -------------------------------------------------------------------------
  // AsciiDoc
  // -------------------------------------------------------------------------
  await openFile(path.join(repo, "samples/export-tour.adoc"));
  await view("split");
  await wait(`document.querySelector('#preview img')`, 30000);
  const asciidocBase = await paragraphBox();
  await zoomTo(150);
  const asciidocZoomed = await paragraphBox();
  check(
    asciidocBase && asciidocZoomed && asciidocZoomed.height > asciidocBase.height * 1.35,
    "AsciiDoc preview zoom grows the prose",
    asciidocBase && asciidocZoomed
      ? `${asciidocBase.height} -> ${asciidocZoomed.height}`
      : "missing",
  );
  await menu("view.zoomReset");

  // -------------------------------------------------------------------------
  // Typst Document
  // -------------------------------------------------------------------------
  await openFile(path.join(repo, "samples/typst-tour.typ"));
  await view("preview");
  await menu("view.typstDocument");
  await sleep(1200);
  await wait(`document.querySelector('#preview .typst-document, #preview h1, #preview p')`, 30000);
  const typstBase = await paragraphBox();
  await zoomTo(150);
  const typstZoomed = await paragraphBox();
  check(
    typstBase &&
      typstZoomed &&
      typstZoomed.height > typstBase.height * 1.35 &&
      Math.abs((await previewZoom()) - 1.5) < 0.01,
    "Typst Document preview zoom grows the prose",
    typstBase && typstZoomed ? `${typstBase.height} -> ${typstZoomed.height}` : "no paragraph",
  );
  await menu("view.zoomReset");

  // -------------------------------------------------------------------------
  // Typst Pages
  // -------------------------------------------------------------------------
  await openFile(path.join(repo, "samples/typst-pages.typ"));
  await view("preview");
  await menu("view.typstPages");
  await sleep(1500);
  await wait(`document.querySelector('.typst-page-shell canvas')`, 60000);
  const pageBase = await evaluate(
    `(() => { const p = document.querySelector('.typst-page-shell'); const c = p?.querySelector('canvas'); if (!p || !c) return null; const r = p.getBoundingClientRect(); return { width: r.width, height: r.height, canvas: c.width, scrollWidth: document.getElementById('preview-pane').scrollWidth, clientWidth: document.getElementById('preview-pane').clientWidth }; })()`,
  );
  await evaluate(`document.getElementById('preview-pane').scrollTop = 300`);
  await menu("view.zoomIn");
  await sleep(400);
  check(
    (await evaluate(`document.getElementById('preview-pane').scrollTop`)) > 0,
    "Typst Pages keeps the reader's place when the zoom changes",
  );
  await zoomTo(150);
  await sleep(1200);
  const pageZoomed = await evaluate(
    `(() => { const p = document.querySelector('.typst-page-shell'); const c = p?.querySelector('canvas'); if (!p || !c) return null; const r = p.getBoundingClientRect(); const pane = document.getElementById('preview-pane'); return { width: r.width, height: r.height, canvas: c.width, scrollWidth: pane.scrollWidth, clientWidth: pane.clientWidth, zoomed: pane.classList.contains('preview-zoomed') }; })()`,
  );
  check(
    pageBase &&
      pageZoomed &&
      pageZoomed.width > pageBase.width * 1.35 &&
      pageZoomed.canvas > pageBase.canvas,
    "Typst Pages pages and canvases grow at 150%",
    pageBase && pageZoomed ? `${pageBase.width} -> ${pageZoomed.width}` : "no page",
  );
  check(
    Boolean(pageZoomed?.zoomed) && pageZoomed.scrollWidth > pageZoomed.clientWidth,
    "a 150% Typst page can be scrolled horizontally",
  );
  await menu("view.zoomReset");

  // -------------------------------------------------------------------------
  // HTML guest
  // -------------------------------------------------------------------------
  await openFile(path.join(repo, "samples/html-tour/index.html"));
  await view("preview");
  await wait(`document.querySelector('.html-preview-frame')`, 30000);
  const frameBase = await evaluate(
    `(() => { const f = document.querySelector('.html-preview-frame'); const r = f.getBoundingClientRect(); return { zoom: parseFloat(getComputedStyle(f).zoom || '1'), cssWidth: f.clientWidth, rectWidth: r.width }; })()`,
  );
  await zoomTo(150);
  const frameZoomed = await evaluate(
    `(() => { const f = document.querySelector('.html-preview-frame'); const r = f.getBoundingClientRect(); return { zoom: parseFloat(getComputedStyle(f).zoom || '1'), cssWidth: f.clientWidth, rectWidth: r.width }; })()`,
  );
  check(
    frameBase &&
      frameZoomed &&
      Math.abs(frameZoomed.zoom - 1.5) < 0.01 &&
      Math.abs(frameZoomed.rectWidth - frameBase.rectWidth) < 3 &&
      frameZoomed.cssWidth < frameBase.cssWidth,
    "the HTML guest frame scales while its internal viewport narrows",
    frameBase && frameZoomed ? `${frameBase.cssWidth} -> ${frameZoomed.cssWidth}` : "missing",
  );
  await menu("view.zoomReset");
} catch (error) {
  console.error(error.stack ?? error);
  check(false, "the preview zoom suite completed", String(error));
  try {
    console.error(
      "diagnostics",
      await evaluate(
        `JSON.stringify({mode:document.querySelector('.app').className,chip:document.getElementById('status-zoom')?.textContent,settings:window.__TAURI_INTERNALS__ ? 'ipc' : 'no-ipc',title:document.title})`,
      ),
    );
  } catch {}
} finally {
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  ws.close();
  process.exit(passed === checks.length ? 0 : 1);
}
