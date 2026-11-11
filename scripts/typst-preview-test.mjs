//! Typst Pages and word sync.
//!
//! Run against a freshly launched instance holding `samples/typst-pages.typ`:
//!
//!   node scripts/typst-preview-test.mjs [port]
//!
//! The fixture is package-free, two columns and two pages. Its prose contains a
//! unique word (`gyroscope`), a repeated word (`pendulum`) and generated
//! `#lorem` text that has no source word to map back to.
//!
//! The last section opens **Help › Typst Reference** and measures the built-in
//! document, so the menu route and the sample are covered by the same suite.

import fs from "node:fs";
import path from "node:path";

const port = process.argv[2] ?? "9222";

// ---------------------------------------------------------------------------
// CDP, the same shape every script here uses.
// ---------------------------------------------------------------------------

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
if (!page) throw new Error(`no page target on ${port}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("CDP socket did not open")), 8000);
  ws.addEventListener(
    "open",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
});
await new Promise((resolve) => setTimeout(resolve, 300));

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Runtime.enable");

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result.exceptionDetails) {
    throw new Error(JSON.stringify(response.result.exceptionDetails));
  }
  return response.result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(expression, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(150);
  }
  return false;
}

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** A word's viewport centre inside one root, or null when it is not there. */
async function rectOf(word, root) {
  return evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(root)});
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(${JSON.stringify(word)});
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + ${word.length});
      let box = range.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const pane = document.getElementById("preview-pane");
      if (pane) {
        const paneBox = pane.getBoundingClientRect();
        if (box.top < paneBox.top + 8 || box.bottom > paneBox.bottom - 8) {
          pane.scrollTop += box.top - paneBox.top - paneBox.height / 2;
          box = range.getBoundingClientRect();
        }
      }
      return {
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        context: node.data.slice(Math.max(0, at - 20), at + ${word.length} + 20),
      };
    }
    return null;
  })()`);
}

/** A word's centre on one specific line of the PDF text layer. */
async function rectOfWordInLine(word, line, root) {
  return evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(root)});
    if (!root) return null;
    const spans = [...root.querySelectorAll('.typst-page .textLayer span[role="presentation"]')]
      .filter((span) => !span.classList.contains("markedContent"));
    for (const span of spans) {
      const text = span.textContent ?? "";
      if (!text.includes(${JSON.stringify(line)}) || !text.includes(${JSON.stringify(word)})) continue;
      const at = text.indexOf(${JSON.stringify(word)});
      const range = document.createRange();
      range.setStart(span.firstChild, at);
      range.setEnd(span.firstChild, at + ${word.length});
      let box = range.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const pane = document.getElementById("preview-pane");
      if (pane) {
        const paneBox = pane.getBoundingClientRect();
        if (box.top < paneBox.top + 8 || box.bottom > paneBox.bottom - 8) {
          pane.scrollTop += box.top - paneBox.top - paneBox.height / 2;
          box = range.getBoundingClientRect();
        }
      }
      return {
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        context: text,
      };
    }
    return null;
  })()`);
}

async function doubleClickAt(point) {
  for (const clickCount of [1, 2]) {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount,
    });
  }
}

async function singleClickAt(point) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  // The click handler waits 240 ms so a double-click can supersede it.
  await sleep(450);
}

async function dragBetween(start, end) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    clickCount: 1,
  });
  for (let step = 1; step <= 5; step += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + ((end.x - start.x) * step) / 5,
      y: start.y + ((end.y - start.y) * step) / 5,
      button: "left",
      buttons: 1,
    });
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(350);
}

async function selectWord(word, root) {
  let point = await rectOf(word, root);
  if (!point) return { selected: "", point: null };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await doubleClickAt(point);
    await sleep(250);
    const selected = await evaluate(`window.getSelection()?.toString() ?? ""`);
    if (selected.includes(word)) return { selected, point };
    // The first launch can still be laying the pane out; re-measure before
    // calling a real selection failure.
    point = await rectOf(word, root);
    if (!point) break;
  }
  return {
    selected: await evaluate(`window.getSelection()?.toString() ?? ""`),
    point,
  };
}

async function selectWordInLine(word, line, root) {
  let point = await rectOfWordInLine(word, line, root);
  if (!point) return { selected: "", point: null };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await doubleClickAt(point);
    await sleep(250);
    const selected = await evaluate(`window.getSelection()?.toString() ?? ""`);
    if (selected.includes(word)) return { selected, point };
    point = await rectOfWordInLine(word, line, root);
    if (!point) break;
  }
  return {
    selected: await evaluate(`window.getSelection()?.toString() ?? ""`),
    point,
  };
}

async function mark() {
  return evaluate(
    `[...document.querySelectorAll(".cm-sync-word")].map((node) => node.textContent).join("|")`,
  );
}

async function markedLine() {
  return evaluate(
    `document.querySelector(".cm-sync-word")?.closest(".cm-line")?.textContent ?? ""`,
  );
}

async function switchView(label) {
  await evaluate(`[...document.querySelectorAll(".compiled-mode")]
    .find((button) => button.textContent === ${JSON.stringify(label)})?.click()`);
  await sleep(200);
}

async function clearSelection() {
  await evaluate(`window.getSelection()?.removeAllRanges()`);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await sleep(100);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

console.log("=== fixture and Document ===");
const compiler = await evaluate(`window.__TAURI_INTERNALS__.invoke('typst_status')`);
if (!compiler.found) {
  console.error(
    "Typst prerequisite missing: install Typst through MDraft Tools or make typst available on PATH before running typst-preview.",
  );
  ws.close();
  process.exit(2);
}
const title = await evaluate("document.title");
check("the Typst fixture is open", title.includes("typst-pages.typ"), title);

await switchView("Document");
const documentReady = await waitFor(`Boolean(document.querySelector(".typst-document"))`);
check("Document view is available", documentReady);

console.log("=== shared compiler controls and Typst messages ===");
let compiledBuildCalls = 0;
ws.addEventListener("message", (event) => {
  const response = JSON.parse(event.data);
  if (response.method !== "Fetch.requestPaused") return;
  const params = response.params;
  void (async () => {
    const bodyResponse = await send("Fetch.getResponseBody", { requestId: params.requestId });
    if (bodyResponse.error) throw new Error(JSON.stringify(bodyResponse.error));
    const body = bodyResponse.result.base64Encoded
      ? Buffer.from(bodyResponse.result.body, "base64").toString("utf8")
      : bodyResponse.result.body;
    const result = JSON.parse(body);
    compiledBuildCalls++;
    const value = {
      ...result,
      warnings: ["warning: shared Typst warning probe"],
      compilerOutput:
        "warning: shared Typst warning probe\nFull diagnostic context beyond the headline.",
      compilerOutputTruncated: false,
    };
    await send("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: params.responseStatusCode,
      responseHeaders: params.responseHeaders.filter(
        (header) => !["content-length", "content-encoding"].includes(header.name.toLowerCase()),
      ),
      body: Buffer.from(JSON.stringify(value)).toString("base64"),
    });
  })().catch((error) => {
    console.error(error);
    void send("Fetch.continueRequest", { requestId: params.requestId });
  });
});
await send("Fetch.enable", {
  patterns: [{ urlPattern: "http://ipc.localhost/render_typst", requestStage: "Response" }],
});
await evaluate(`document.querySelector('.compiled-compile').click()`);
check(
  "successful Typst warnings reach the shared Logs count",
  await waitFor(`document.querySelector('.compiled-issue-count')?.textContent.trim()==='1'`),
);
const warningUi = await evaluate(`(() => {
  document.querySelector('.compiled-logs-toggle').click();
  document.querySelector('#compiler-output-tab').click();
  const result={separate:!document.querySelector('#preview').textContent.includes('warning probe'),raw:document.querySelector('#compiler-output').textContent.includes('Full diagnostic context'),open:document.querySelector('.compiled-logs-toggle').getAttribute('aria-pressed')==='true'};
  document.querySelector('.compiled-logs-toggle').click();
  document.querySelector('.compiled-auto input').click();
  const view=document.querySelector('.cm-content').cmTile.root.view;
  view.dispatch({changes:{from:view.state.doc.length,insert:'\\n// manual compile UI probe\\n'}});
  return result;
})()`);
check(
  "Typst raw output is separate from generated content",
  warningUi.separate && warningUi.raw && warningUi.open,
);
await sleep(900);
check(
  "manual Typst mode does not compile after edits",
  compiledBuildCalls === 1 &&
    (await evaluate(
      `document.querySelector('.compiled-message').textContent.includes('Out of date')`,
    )),
);
await evaluate(`document.querySelector('.compiled-compile').click()`);
check(
  "Compile works in manual Typst mode",
  (await waitFor(`document.querySelector('.compiled-compile').textContent==='Compile'`)) &&
    compiledBuildCalls === 2,
);
await send("Fetch.disable");
await evaluate(`(() => {

  document.querySelector('.compiled-auto input').click();
  const view=document.querySelector('.cm-content').cmTile.root.view;
  const marker='\\n// manual compile UI probe\\n',at=view.state.doc.toString().indexOf(marker);
  if(at>=0)view.dispatch({changes:{from:at,to:at+marker.length}});
})()`);
await waitFor(
  `!document.querySelector('#compiler-output')?.textContent.includes('Full diagnostic context')`,
);

// A theme change requests a fresh paint of the same revision. The cached Typst
// result must keep its view controls and word mapping instead of clearing them.
await evaluate(`document.getElementById("btn-theme")?.click()`);
await sleep(1000);
check(
  "a theme change keeps the Typst view controls",
  (await evaluate(`document.querySelectorAll(".compiled-mode").length`)) === 2,
);

// Hold the map's idle callback across a Source -> Split round trip. The cached
// Document DOM must schedule a new map without compiling or reviving the old one.
await evaluate(`(() => {
  window.__typstIdleOriginal=window.requestIdleCallback;
  window.__typstIdleHeld=[];
  window.requestIdleCallback=(callback)=>{window.__typstIdleHeld.push(callback);return 0;};
  window.__typstBarBefore=document.querySelector('.typst-document');
  const view=document.querySelector('.cm-content').cmTile.root.view;
  view.dispatch({changes:{from:view.state.doc.length,insert:'\\n// deferred map test\\n'}});
})()`);
const newDocumentRender = await waitFor(
  `document.querySelector('.typst-document') !== window.__typstBarBefore`,
  20000,
);
const oldMapHeld = await waitFor(`window.__typstIdleHeld.length > 0`, 6000);
await evaluate(
  `window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'menu',payload:'view.source'})`,
);
await evaluate(
  `window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'menu',payload:'view.split'})`,
);
await evaluate(`(() => {
  const original=window.__typstIdleOriginal,held=window.__typstIdleHeld;
  window.requestIdleCallback=original;
  for(const callback of held)original.call(window,callback,{timeout:800});
})()`);
await sleep(1400);
await clearSelection();
const restoredDocumentWord = await selectWord("gyroscope", ".typst-document");
const restoredDocumentMark = await mark();
check(
  "Document word sync returns after a pending map is invalidated by a mode switch",
  newDocumentRender &&
    oldMapHeld &&
    restoredDocumentWord.selected.includes("gyroscope") &&
    restoredDocumentMark === "gyroscope",
  JSON.stringify({
    newDocumentRender,
    oldMapHeld,
    selected: restoredDocumentWord.selected,
    mark: restoredDocumentMark,
  }),
);

const documentShape = await evaluate(`(() => {
  const host = document.querySelector(".typst-document");
  if (!host) return null;
  return {
    blocks: host.children.length,
    anchors: host.querySelectorAll("[data-line]").length,
    ranges: host.querySelectorAll("[data-b]").length,
    abstractLine: host.querySelector("p[data-line]")?.getAttribute("data-line") ?? "",
  };
})()`);
check(
  "Document maps its prose blocks",
  documentShape !== null && documentShape.anchors >= 8 && documentShape.ranges >= 8,
  documentShape ? `${documentShape.anchors} anchors/${documentShape.ranges} ranges` : "missing",
);
check(
  "Document maps the opening abstract",
  documentShape?.abstractLine === "19",
  documentShape?.abstractLine ?? "",
);

const documentWord = await selectWord("gyroscope", ".typst-document");
check(
  "double-clicking a Document word selects it",
  documentWord.selected.includes("gyroscope"),
  documentWord.selected,
);
const documentMark = await mark();
check("the Document word paints the source", documentMark === "gyroscope", documentMark);

await clearSelection();
const wrappedAfterMath = await evaluate(`(() => {
  const host = document.querySelector(".typst-document");
  if (!host) return null;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const match = node.data.match(/measuring the\\s+length carefully/);
    if (!match || match.index === undefined) continue;
    const range = document.createRange();
    range.setStart(node, match.index);
    range.setEnd(node, match.index + match[0].length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  }
  return null;
})()`);
await evaluate(`document.querySelector(".cm-scroller").scrollTop = 999999`);
await sleep(220);
const wrappedAfterMathMark = await mark();
check(
  "a hard-wrapped phrase after inline math in Document view paints the exact source phrase",
  wrappedAfterMath !== null && wrappedAfterMathMark === "measuring the|length carefully",
  `${JSON.stringify(wrappedAfterMath)} -> ${wrappedAfterMathMark}`,
);

await clearSelection();
const mathSelected = await evaluate(`(() => {
  const math = document.querySelector(".typst-document p math");
  if (!math) return null;
  const range = document.createRange();
  range.selectNodeContents(math);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return selection.toString();
})()`);
await sleep(220);
const mathFallbackMark = await mark();
const mathFallbackPlain = mathFallbackMark.replace(/\|/g, "");
check(
  "selecting inside inline math in Document view falls back to its paragraph",
  mathSelected !== null &&
    mathFallbackPlain.includes("The agreement with $T = 2 pi sqrt(L / g)$") &&
    mathFallbackPlain.includes("measuring the") &&
    mathFallbackPlain.includes("model predicts"),
  mathFallbackPlain.slice(0, 90),
);
await evaluate(`document.querySelector(".cm-scroller").scrollTop = 0`);
await sleep(150);

await clearSelection();
const documentGenerated = await selectWord("consectetur", ".typst-document");
check(
  "generated Document text can be selected",
  documentGenerated.selected.includes("consectetur"),
  documentGenerated.selected,
);
const generatedDocumentMark = await mark();
check(
  "generated Document text paints nothing",
  generatedDocumentMark === "",
  generatedDocumentMark,
);

await clearSelection();
const singlePoint = await rectOf("gyroscope", ".typst-document");
if (singlePoint) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: singlePoint.x,
    y: singlePoint.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: singlePoint.x,
    y: singlePoint.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(250);
}
const singleClickMark = await mark();
check("a single click does not paint a word", singleClickMark === "", singleClickMark);

console.log("\n=== Pages ===");
await switchView("Pages");
await evaluate(`document.getElementById('preview-pane').scrollTop = 0`);
const pagesReady = await waitFor(`(() => {
  const shells = document.querySelectorAll(".typst-page-shell");
  if (shells.length < 2) return false;
  const canvases = [...document.querySelectorAll(".typst-page canvas")];
  if (canvases.length !== shells.length) return false;
  if (canvases.some((canvas) => canvas.width === 0 || canvas.height === 0)) return false;
  if (canvases.some((canvas) => Math.abs(canvas.width/canvas.height-210/297)>0.01)) return false;
  const text = [...document.querySelectorAll(".typst-page .textLayer")]
    .map((layer) => layer.textContent).join(" ");
  return text.includes("gyroscope") && text.includes("Discussion");
})()`);
check("Pages renders two pages with text layers", pagesReady);

const pagesShape = await evaluate(`(() => {
  const shells = [...document.querySelectorAll(".typst-page-shell")];
  const canvases = [...document.querySelectorAll(".typst-page canvas")];
  const text = [...document.querySelectorAll(".typst-page .textLayer")]
    .map((layer) => layer.textContent).join(" ");
  const first = canvases[0];
  return {
    shells: shells.length,
    canvases: canvases.length,
    text,
    ratio: first ? first.height && first.width / first.height : 0,
    errors: document.querySelectorAll(".typst-error").length,
  };
})()`);
check("two page shells exist", pagesShape.shells === 2, String(pagesShape.shells));
check(
  "each page has a rendered canvas",
  pagesShape.canvases === pagesShape.shells,
  `${pagesShape.canvases}/${pagesShape.shells}`,
);
check(
  "the text layer carries both columns",
  pagesShape.text.includes("Introduction") && pagesShape.text.includes("Results"),
);
check(
  "the page keeps the A4 aspect ratio",
  Math.abs(pagesShape.ratio - 210 / 297) < 0.01,
  pagesShape.ratio.toFixed(4),
);
check("Pages shows no error box", pagesShape.errors === 0);
const compiledChrome = await evaluate(`(() => {
  const toolbar=document.querySelector('.compiled-toolbar'), compile=document.querySelector('.compiled-compile');
  return {
    icons:['.compiled-compile','.compiled-logs-toggle','.compiled-save-pdf'].every(selector=>document.querySelector(selector+' svg[aria-hidden="true"]')),
    primary:getComputedStyle(compile).backgroundColor!==getComputedStyle(toolbar).backgroundColor,
    label:document.querySelector('.compiled-state-label').textContent,
    engine:document.querySelector('.compiled-engine').textContent,
  };
})()`);
check(
  "Typst shares the prototype's primary action, outline icons and structured status",
  compiledChrome.icons &&
    compiledChrome.primary &&
    compiledChrome.label === "PDF ready" &&
    /Typst.*s/.test(compiledChrome.engine),
  JSON.stringify(compiledChrome),
);

// The pages are flush: the second shell starts exactly where the first ends, and
// neither draws a rule or a shadow. A gap here is the band of pane background the
// reader sees between two pages, which reads as a divider rather than a document.
const pageGap = await evaluate(`(() => {
  const shells = [...document.querySelectorAll(".typst-page-shell")];
  if (shells.length < 2) return null;
  const first = shells[0].getBoundingClientRect();
  const second = shells[1].getBoundingClientRect();
  const style = getComputedStyle(shells[0]);
  const host = getComputedStyle(document.querySelector(".typst-preview"));
  return {
    gap: second.top - first.bottom,
    rowGap: host.rowGap,
    shadow: style.boxShadow,
  };
})()`);
check(
  "consecutive pages sit flush with no gap",
  pageGap !== null && Math.abs(pageGap.gap) < 1 && pageGap.rowGap === "normal",
  pageGap ? `gap ${pageGap.gap.toFixed(1)}px, row-gap ${pageGap.rowGap}` : "no second page",
);
check(
  "a page draws no rule or shadow at its edge",
  pageGap !== null && pageGap.shadow === "none",
  pageGap ? pageGap.shadow : "no page",
);

const logsToggleProbe = await evaluate(`(() => {
 const pane=document.getElementById('preview-pane'), button=document.querySelector('.compiled-logs-toggle');
 const canvas=document.querySelector('#preview canvas'), before=pane.scrollTop;
 button.click();
 const opened=button.getAttribute('aria-pressed')==='true' && pane.inert && getComputedStyle(pane).visibility==='hidden';
 button.click();
 return opened && !pane.inert && Math.abs(pane.scrollTop-before)<1 && document.querySelector('#preview canvas')===canvas;
})()`);
check("Typst uses the same reversible Logs toggle without rerendering its PDF", logsToggleProbe);

await evaluate(`(() => {
  const pane=document.getElementById('preview-pane'), source=document.querySelector('.cm-content').cmTile.root.view.scrollDOM;
  window.__compiledLogsScroll={pdf:pane.scrollTop,source:source.scrollTop};
  document.querySelector('.compiled-logs-toggle').click();
  source.scrollTop += 120;
})()`);
await sleep(350);
const hiddenPdfStayed = await evaluate(`(() => {
  const stayed=Math.abs(document.getElementById('preview-pane').scrollTop-window.__compiledLogsScroll.pdf)<1;
  document.querySelector('.cm-content').cmTile.root.view.scrollDOM.scrollTop=window.__compiledLogsScroll.source;
  return stayed;
})()`);
await sleep(150);
await evaluate(`document.querySelector('.compiled-logs-toggle').click()`);
check("source scrolling while reading Logs leaves the hidden PDF position intact", hiddenPdfStayed);

// Toolbar geometry is a user-visible contract at each supported pane width.
const originalPreviewFlex = await evaluate(`document.getElementById('preview-shell').style.flex`);
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
for (const width of [320, 480, 900]) {
  await evaluate(`document.getElementById('preview-shell').style.flex='0 0 ${width}px'`);
  await sleep(500);
  const geometry = await evaluate(`(() => {
    const bar=document.querySelector('.compiled-toolbar'), pane=document.getElementById('preview-pane');
    const toolbar=bar.getBoundingClientRect(), viewport=pane.getBoundingClientRect();
    const controls=[...bar.querySelectorAll('button,label')].filter(node=>node.getClientRects().length);
    return {reserved:viewport.top>=toolbar.bottom-1,reachable:controls.every(node=>{const box=node.getBoundingClientRect();return box.left>=toolbar.left-1 && box.right<=toolbar.right+1 && box.bottom<=toolbar.bottom+1;}),width:viewport.width};
  })()`);
  check(
    `shared toolbar reserves content space at ${width}px`,
    geometry.reserved && geometry.reachable,
    JSON.stringify(geometry),
  );
  if (process.env.MDRAFT_COMPILED_UI_SCREENSHOTS) {
    fs.mkdirSync(process.env.MDRAFT_COMPILED_UI_SCREENSHOTS, { recursive: true });
    const clip = await evaluate(
      `(() => { const r=document.getElementById('preview-shell').getBoundingClientRect(); return {x:r.left,y:r.top,width:r.width,height:Math.min(r.height,innerHeight-r.top),scale:1}; })()`,
    );
    const shot = await send("Page.captureScreenshot", { format: "png", clip });
    fs.writeFileSync(
      path.join(process.env.MDRAFT_COMPILED_UI_SCREENSHOTS, `typst-pdf-${width}.png`),
      Buffer.from(shot.result.data, "base64"),
    );
    await evaluate(`document.querySelector('.compiled-logs-toggle').click()`);
    const logsShot = await send("Page.captureScreenshot", { format: "png", clip });
    fs.writeFileSync(
      path.join(process.env.MDRAFT_COMPILED_UI_SCREENSHOTS, `typst-logs-${width}.png`),
      Buffer.from(logsShot.result.data, "base64"),
    );
    await evaluate(`document.querySelector('.compiled-logs-toggle').click()`);
  }
}
await evaluate(
  `document.getElementById('preview-shell').style.flex=${JSON.stringify(originalPreviewFlex)}`,
);
await send("Emulation.clearDeviceMetricsOverride");
await sleep(700);

const viewBarStyle = await evaluate(`(() => {
  const bar = document.querySelector(".compiled-toolbar");
  const button = document.querySelector(".compiled-mode");
  if (!bar || !button) return null;
  const barStyle = getComputedStyle(bar);
  const buttonStyle = getComputedStyle(button);
  return {
    reserved: bar.getBoundingClientRect().bottom <= document.getElementById("preview-pane").getBoundingClientRect().top + 1,
    blur: barStyle.backdropFilter,
    barBackground: barStyle.backgroundColor,
    buttonBackground: buttonStyle.backgroundColor,
  };
})()`);
check(
  "the shared toolbar reserves space above the page",
  viewBarStyle?.blur === "none" && viewBarStyle?.reserved === true,
  viewBarStyle ? `${viewBarStyle.blur}/${viewBarStyle.barBackground}` : "missing",
);
check(
  "the view buttons keep their own background",
  viewBarStyle !== null && viewBarStyle.buttonBackground !== "rgba(0, 0, 0, 0)",
  viewBarStyle?.buttonBackground ?? "",
);

const paragraphPoint = await rectOfWordInLine(
  "simple",
  "The simple pendulum is a useful model",
  ".typst-preview",
);
check("the two-column paragraph line is there", paragraphPoint !== null);
await clearSelection();
if (paragraphPoint) await singleClickAt(paragraphPoint);
const paragraphMark = await mark();
check(
  "a single Pages click paints the source paragraph",
  paragraphMark.includes("The simple pendulum is a useful model"),
  paragraphMark.slice(0, 80),
);

await clearSelection();
const pagesWord = await selectWord("gyroscope", ".typst-preview");
check(
  "double-clicking a Pages word selects it",
  pagesWord.selected.includes("gyroscope"),
  pagesWord.selected,
);
const pagesMark = await mark();
check("the Pages word paints the source", pagesMark === "gyroscope", pagesMark);

await evaluate(`document.getElementById('btn-theme').click()`);
await sleep(1000);
await clearSelection();
const pagesThemeWord = await selectWord("gyroscope", ".typst-preview");
const pagesThemeMark = await mark();
check(
  "a theme cache hit keeps Pages word sync owned by the current render",
  pagesThemeWord.selected.includes("gyroscope") && pagesThemeMark === "gyroscope",
  JSON.stringify({ selected: pagesThemeWord.selected, mark: pagesThemeMark }),
);

await clearSelection();
const latePendulum = await selectWordInLine(
  "pendulum",
  "celeration. The word pendulum appears again",
  ".typst-preview",
);
check(
  "a repeated Pages word can be selected",
  latePendulum.selected.includes("pendulum"),
  latePendulum.selected,
);
const latePendulumLine = await markedLine();
check(
  "a repeated Pages word maps the clicked occurrence",
  latePendulumLine.includes("The word pendulum appears again"),
  latePendulumLine,
);

await clearSelection();
const oneWordHeading = await selectWordInLine("Method", "Method", ".typst-preview");
check(
  "a one-word Pages heading can be selected",
  oneWordHeading.selected.includes("Method"),
  oneWordHeading.selected,
);
const oneWordHeadingLine = await markedLine();
check(
  "a one-word Pages heading maps its source line",
  oneWordHeadingLine.includes("= Method"),
  oneWordHeadingLine,
);

await clearSelection();
const rightColumnThe = await selectWordInLine(
  "the",
  "Substituting the illustrative values gives an estimate",
  ".typst-preview",
);
check(
  "a right-column Pages word can be selected",
  rightColumnThe.selected.includes("the"),
  rightColumnThe.selected,
);
const rightColumnLine = await markedLine();
check(
  "a right-column Pages word maps its own line",
  rightColumnLine.includes("Substituting the illustrative values"),
  rightColumnLine,
);

await clearSelection();
const dragStart = await rectOfWordInLine(
  "simple",
  "The simple pendulum is a useful model",
  ".typst-preview",
);
const dragEnd = await rectOfWordInLine(
  "model",
  "The simple pendulum is a useful model",
  ".typst-preview",
);
if (dragStart && dragEnd) await dragBetween(dragStart, dragEnd);
const dragMark = await mark();
check(
  "dragging across a Pages line paints the selected range",
  dragMark.includes("simple") && dragMark.includes("model"),
  dragMark,
);

await clearSelection();
const pagesGenerated = await selectWord("consectetur", ".typst-preview");
check(
  "generated Pages text can be selected",
  pagesGenerated.selected.includes("consectetur"),
  pagesGenerated.selected,
);
const generatedPagesMark = await mark();
check("generated Pages text paints nothing", generatedPagesMark === "", generatedPagesMark);

console.log("\n=== switching back ===");
await clearSelection();
await switchView("Document");
const backReady = await waitFor(`Boolean(document.querySelector(".typst-document"))`);
check("Document returns after Pages", backReady);
const pagesGone = await evaluate(`document.querySelectorAll(".typst-page-shell").length`);
check("the PDF page view is disposed", pagesGone === 0, String(pagesGone));
check(
  "Document still maps its blocks after the switch",
  (await evaluate(`document.querySelectorAll(".typst-document [data-b]").length`)) >= 8,
);

await evaluate(`document.querySelector(".cm-scroller").scrollTop = 260`);
await sleep(200);
const srcWordPoint = await evaluate(`(() => {
  const walker = document.createTreeWalker(document.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf("illustrative");
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + "illustrative".length);
    const box = range.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }
  return null;
})()`);
if (srcWordPoint) {
  await doubleClickAt(srcWordPoint);
}
await waitFor(
  `(() => {
  const h = CSS.highlights?.get("mdraft-sync") ?? CSS.highlights?.get("mdraft-sync-peak");
  return h && [...h].some((range) => range.toString().includes("illustrative"));
})()`,
  4000,
);
const highlightBeforeSwitch = await evaluate(`(() => {
  const highlight =
    CSS.highlights?.get("mdraft-sync") ??
    CSS.highlights?.get("mdraft-sync-peak");
  return highlight ? [...highlight].map((range) => range.toString()) : null;
})()`);
await switchView("Pages");
await waitFor(`document.querySelectorAll(".typst-page-shell").length >= 2`);
await switchView("Document");
await waitFor(`Boolean(document.querySelector(".typst-document"))`);
await waitFor(
  `(() => {
  const h = CSS.highlights?.get("mdraft-sync") ?? CSS.highlights?.get("mdraft-sync-peak");
  return h && [...h].some((range) => range.toString().includes("illustrative"));
})()`,
  4000,
);
const previewHighlightAfterRender = await evaluate(`(() => {
  const highlight =
    CSS.highlights?.get("mdraft-sync") ??
    CSS.highlights?.get("mdraft-sync-peak");
  return highlight ? [...highlight].map((range) => range.toString()) : null;
})()`);
check(
  "a source selection still paints the Document preview after a re-render",
  Array.isArray(previewHighlightAfterRender) &&
    previewHighlightAfterRender.join(" ").includes("illustrative"),
  JSON.stringify({ srcWordPoint, highlightBeforeSwitch, previewHighlightAfterRender }),
);

console.log("\n=== Pages correspondence regressions ===");
await switchView("Pages");
await waitFor(`document.querySelector('.textLayer')?.textContent`);
await sleep(500);

async function previewPaint() {
  return evaluate(`(() => {
    const h = CSS.highlights?.get('mdraft-sync') ?? CSS.highlights?.get('mdraft-sync-peak');
    return h ? [...h].map(r => r.toString()).join('') : '';
  })()`);
}

// A real preview gesture reveals the exact source occurrence. Clicking that
// decoration then checks the inverse, without relying on a first text match.
async function roundTrip(word, root = ".typst-preview") {
  await clearSelection();
  const hit = await selectWord(word, root);
  // The source decoration is painted after the reveal's measure; wait for it
  // before reading .cm-sync-word, or a word that had to scroll reads as empty.
  await sleep(200);
  const forward = await mark();
  const sourcePoint = await evaluate(`(() => {
    const el = document.querySelector('.cm-sync-word');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {x:b.left+b.width/2,y:b.top+b.height/2};
  })()`);
  if (sourcePoint) await doubleClickAt(sourcePoint);
  await sleep(250);
  const reverse = await previewPaint();
  const diagnostics = await evaluate(`(() => ({
    scroll: document.querySelector('.cm-scroller')?.scrollTop,
    active: document.activeElement?.className ?? "",
    markNodes: [...document.querySelectorAll('.cm-sync-word')].length,
  }))()`);
  return {
    word,
    selected: hit.selected.trim(),
    forward,
    reverse,
    diagnostics,
    ok: hit.selected.trim() === word && forward === word && reverse === word,
  };
}

const formulaTrip = await roundTrip("velocidade");
check(
  "prose beside Portuguese inline math maps in both directions",
  formulaTrip.ok,
  JSON.stringify(formulaTrip),
);
const cycles = [];
for (let n = 0; n < 20; n += 1)
  cycles.push(await roundTrip(["gyroscope", "illustrative", "velocidade", "centrípeta"][n % 4]));
check(
  "twenty Pages/editor pairs retain exact words across both columns",
  cycles.every((r) => r.ok),
  JSON.stringify(cycles.filter((r) => !r.ok)),
);

// Browser endpoint at the next node's leading space must not turn a phrase
// into a paragraph selection. The DOM Range is deliberate boundary coverage.
await clearSelection();
await evaluate(`document.activeElement?.blur()`);
await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('.textLayer span[role="presentation"]')];
  const span = nodes.find(el => el.textContent.includes('com velocidade'));
  if (!span?.firstChild) return;
  const at=span.textContent.indexOf('com velocidade'), r=document.createRange();
  r.setStart(span.firstChild,at); r.setEnd(span.firstChild,at+14);
  const s=getSelection();s.removeAllRanges();s.addRange(r);
})()`);
await sleep(180);
await evaluate(`(() => {
  const scroller = document.querySelector('.cm-scroller');
  for (let i = 0; i < 40; i += 1) {
    if ((document.querySelector('.cm-content')?.innerText ?? '').includes('com velocidade')) return;
    scroller.scrollTop += 120;
  }
})()`);
await sleep(100);
const phraseMark = await mark();
const phraseDebug = await evaluate(`(() => ({
  scroll: document.querySelector('.cm-scroller')?.scrollTop,
  content: (document.querySelector('.cm-content')?.innerText ?? '').includes('com velocidade'),
}))()`);
check(
  "a Pages phrase after math paints only its two source words",
  phraseMark.replaceAll("|", "") === "com velocidade",
  JSON.stringify({ mark: phraseMark, ...phraseDebug }),
);

await send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
const reduced = await roundTrip("velocidade");
await sleep(280);
check(
  "Pages reduced motion keeps a stable resting highlight",
  reduced.ok &&
    (await evaluate(
      `CSS.highlights.has('mdraft-sync') && !CSS.highlights.has('mdraft-sync-peak')`,
    )),
);
await send("Emulation.setEmulatedMedia", { features: [] });

const beforeEscape = await evaluate(`getSelection().toString()`);
await send("Input.dispatchKeyEvent", {
  type: "keyDown",
  key: "Escape",
  code: "Escape",
  windowsVirtualKeyCode: 27,
});
await sleep(350);
check(
  "Pages Escape clears paint and pending pulses while preserving selection",
  (await previewPaint()) === "" &&
    (await mark()) === "" &&
    (await evaluate(`getSelection().toString()`)) === beforeEscape,
);

await send("Emulation.setDeviceMetricsOverride", {
  width: 1000,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
const narrow = await roundTrip("velocidade");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
const wide = await roundTrip("illustrative");
check(
  "Pages correspondence survives narrow and wide pane fits",
  narrow.ok && wide.ok,
  JSON.stringify({ narrow, wide }),
);
await evaluate(`document.getElementById('preview-pane').scrollTop=99999`);
await sleep(300);
const lazy = await roundTrip("gyroscope");
check("Pages correspondence survives canvas disposal and repaint", lazy.ok, JSON.stringify(lazy));

await evaluate(
  `window.__oldPageRange=(()=>{const e=[...document.querySelectorAll('.textLayer span[role="presentation"]')].find(e=>!e.classList.contains('markedContent') && e.textContent.includes('com velocidade'));const r=document.createRange(),at=e.textContent.indexOf('velocidade');r.setStart(e.firstChild,at);r.setEnd(e.firstChild,at+10);return r})()`,
);
await evaluate(`document.querySelector(".cm-content").focus()`);
await send("Input.dispatchKeyEvent", {
  type: "keyDown",
  key: "Home",
  code: "Home",
  modifiers: 2,
  windowsVirtualKeyCode: 36,
});
await send("Input.dispatchKeyEvent", {
  type: "keyUp",
  key: "Home",
  code: "Home",
  modifiers: 2,
  windowsVirtualKeyCode: 36,
});
await send("Input.insertText", { text: "// audit prefix\n" });
await sleep(120);
await evaluate(
  `(()=>{const s=getSelection();s.removeAllRanges();s.addRange(window.__oldPageRange);document.querySelector('.typst-preview').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))})()`,
);
check(
  "Pages refuses a stale PDF selection during render debounce",
  (await mark()) === "",
  await mark(),
);
await sleep(1300);
const edited = await roundTrip("velocidade");
check("Pages binds a fresh bidirectional map after editing", edited.ok, JSON.stringify(edited));

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
  modifiers: 2,
  windowsVirtualKeyCode: 35,
});
await send("Input.insertText", { text: "\n// audit suffix\n" });
await sleep(1300);
const sameWord = await roundTrip("velocidade");
check(
  "Pages reselects the same source offsets after another render",
  sameWord.ok,
  JSON.stringify(sameWord),
);
await evaluate(
  `window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',code:'KeyN',ctrlKey:true,bubbles:true,cancelable:true}))`,
);
await sleep(300);
check(
  "leaving a Pages tab clears correspondence",
  (await previewPaint()) === "" && (await mark()) === "",
);
await evaluate(
  `[...document.querySelectorAll('.doc-tab')].find(e=>e.textContent.includes('typst-pages.typ')).click()`,
);
await waitFor(`document.querySelector('.textLayer')?.textContent.includes('gyroscope')`);
await sleep(500);
const returnedTrip = await roundTrip("velocidade");
check(
  "returning to a Pages tab restores current correspondence",
  returnedTrip.ok,
  JSON.stringify(returnedTrip),
);
await send("Emulation.clearDeviceMetricsOverride");
await sleep(350);

if (process.env.MDRAFT_TEST_SCREENSHOT) {
  await roundTrip("velocidade");
  await sleep(150);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(process.env.MDRAFT_TEST_SCREENSHOT, Buffer.from(shot.result.data, "base64"));
}

// The ignored local exam is optional; the tracked fixture above always runs.
const exam = path.resolve("docs/samples/prova-fisica.typ");
if (fs.existsSync(exam)) {
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'open-files',payload:[${JSON.stringify(exam)}]})`,
  );
  await waitFor(`document.title.includes('prova-fisica.typ')`);
  await switchView("Pages");
  await waitFor(`document.querySelector('.textLayer')?.textContent.includes('instante')`, 30000);
  await sleep(1200);
  const examCycles = [];
  for (let n = 0; n < 25; n += 1)
    examCycles.push(
      await roundTrip(["instante", "velocidade", "partícula", "coordenadas", "centrípeta"][n % 5]),
    );
  check(
    "physics exam survives fifty alternating gestures with exact words",
    examCycles.every((r) => r.ok),
    JSON.stringify(examCycles.filter((r) => !r.ok)),
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== Help opens the built-in Typst reference ===");
await evaluate(
  `window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'menu',payload:'help.typstReference'})`,
);
const referenceOpened = await waitFor(
  `document.querySelector('.doc-tab[aria-selected="true"]')?.textContent?.includes('Untitled') === true`,
  15000,
);
check("Help › Typst Reference opens a Typst document", referenceOpened);
// The suite left the shared preference on Pages; the reference documents the
// Document view. Use the menu rather than the in-pane switch: the bar is now a
// sibling of the zoomed preview, and a stale bar from the previous document must
// not be clicked while the reference is still rendering.
await evaluate(
  `window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'menu',payload:'view.typstDocument'})`,
);
await waitFor(
  `document.querySelector('.typst-document')?.textContent?.includes('Typst Reference') === true`,
  20000,
);
const reference = JSON.parse(
  await evaluate(`(() => {
    const host = document.querySelector('.typst-document');
    return JSON.stringify({
      heading: host?.querySelector('h2')?.textContent?.trim() ?? '',
      sections: host?.querySelectorAll('h3').length ?? 0,
      table: host?.querySelector('table') !== null,
      contents: host?.querySelector('nav[role="doc-toc"]') !== null,
      error: document.querySelector('.typst-error')?.textContent ?? null,
      viewbar: document.querySelectorAll('.compiled-mode').length,
    });
  })()`),
);
check(
  "the reference renders its live document",
  reference.error === null && /Typst Reference/.test(reference.heading) && reference.sections >= 10,
  JSON.stringify(reference),
);
check(
  "the reference shows its generated contents, table and view switch",
  reference.contents && reference.table && reference.viewbar === 2,
  JSON.stringify(reference),
);

// ---------------------------------------------------------------------------
// A wrapped list item maps from its own line, in both directions
// ---------------------------------------------------------------------------
console.log("\n=== Typst list word sync ===");

/** A point on the first occurrence of a word inside a descendant that matches. */
const wordPoint = (word, selector, contains) =>
  evaluate(`(async () => {
    const host = document.querySelector("${selector}");
    if (!host) return null;
    const target = [...host.querySelectorAll("li, p, h2, h3")]
      .find((element) => element.textContent.includes(${JSON.stringify(contains)}));
    if (!target) return null;
    target.scrollIntoView({ block: "center" });
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(${JSON.stringify(word)});
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + ${JSON.stringify(word)}.length);
      const box = range.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return null;
  })()`);

for (const [word, item, line] of [
  ["selectable", "selectable prose styled like the", "flowing, selectable prose"],
  ["application", "rest of the application", "rest of the application"],
]) {
  // The word map is built after paint, so the first click of the suite can land
  // before it exists; a person would simply click again.
  let painted = "";
  for (let attempt = 0; attempt < 3 && painted !== word; attempt += 1) {
    const point = await wordPoint(word, ".typst-document", item);
    if (!point) break;
    await doubleClickAt(point);
    await sleep(320);
    painted = await mark();
  }
  check(
    `a Typst list word maps back to the source (${word})`,
    painted === word,
    JSON.stringify(painted),
  );
  check(
    `a Typst list word paints its own line (${word})`,
    (await markedLine()).includes(line),
    JSON.stringify(await markedLine()),
  );
}

{
  // Source -> Document, from a word that only exists on the wrapped line.
  await clearSelection();
  const point = await evaluate(`(async () => {
    const walker = document.createTreeWalker(document.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf("application");
      if (at < 0) continue;
      const line = node.parentElement?.closest(".cm-line");
      if (!line || !line.textContent.includes("rest of the application")) continue;
      line.scrollIntoView({ block: "center" });
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 11);
      const box = range.getBoundingClientRect();
      if (box.width === 0) continue;
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return null;
  })()`);
  if (point) await doubleClickAt(point);
  await sleep(350);
  const painted = await evaluate(`(() => {
    const highlight = CSS.highlights?.get("mdraft-sync") ?? CSS.highlights?.get("mdraft-sync-peak");
    return highlight ? [...highlight].map((range) => range.toString()).join(" ") : null;
  })()`);
  check(
    "a source word on a Typst list continuation paints the preview",
    painted === "application",
    JSON.stringify(painted),
  );
  await clearSelection();
}

// ---------------------------------------------------------------------------
// Typst Pages: a list item still maps through the PDF text layer
// ---------------------------------------------------------------------------
console.log("\n=== Typst Pages list word sync ===");
{
  const source = [
    "= List pages",
    "",
    "- alpha first item",
    "  beta continuation line",
    "- gamma second item",
    "  delta continuation line",
    "",
  ].join("\n");
  const directory = fs.mkdtempSync(path.join(process.cwd(), ".tmp-typst-list-"));
  const file = path.join(directory, "pages-list.typ");
  fs.writeFileSync(file, source);
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'open-files',payload:[${JSON.stringify(file)}]})`,
  );
  await waitFor(`document.title.includes("pages-list.typ")`, 15000);
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'menu',payload:'view.typstPages'})`,
  );
  const ready = await waitFor(
    `(() => {
      const canvases = [...document.querySelectorAll(".typst-page canvas")];
      if (canvases.length === 0) return false;
      if (canvases.some((canvas) => canvas.width === 0 || canvas.height === 0)) return false;
      const text = [...document.querySelectorAll(".typst-page .textLayer")].map((layer) => layer.textContent).join(" ");
      return text.includes("alpha first item") && text.includes("delta continuation line");
    })()`,
    40000,
  );
  check("a small Typst document renders its list in Pages", ready);
  const point = await evaluate(`(async () => {
    const layer = document.querySelector(".typst-page .textLayer");
    if (!layer) return null;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf("delta");
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 5);
      const box = range.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return null;
  })()`);
  if (point) {
    // The page map is built after the PDF paints, so the first gesture can
    // arrive before it exists. A reader would simply click again.
    let painted = "";
    for (let attempt = 0; attempt < 3 && painted !== "delta"; attempt += 1) {
      await doubleClickAt(point);
      await sleep(400);
      painted = await mark();
    }
    check(
      "a Pages list word maps back to its source line",
      painted === "delta" && (await markedLine()).includes("delta continuation line"),
      JSON.stringify({ painted, line: await markedLine() }),
    );
    await clearSelection();
    // Source -> Pages, from the word that only exists on the wrapped line.
    const sourcePoint = await evaluate(`(async () => {
      const walker = document.createTreeWalker(document.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf("delta");
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 5);
        const box = range.getBoundingClientRect();
        if (box.width === 0) continue;
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
      return null;
    })()`);
    if (sourcePoint) await doubleClickAt(sourcePoint);
    await sleep(350);
    const reverse = await evaluate(`(() => {
      const highlight = CSS.highlights?.get("mdraft-sync") ?? CSS.highlights?.get("mdraft-sync-peak");
      return highlight ? [...highlight].map((range) => range.toString()).join(" ") : null;
    })()`);
    check(
      "a source word in a list paints its Pages text",
      reverse === "delta",
      JSON.stringify(reverse),
    );
    await clearSelection();
  } else {
    check("the Pages list word is reachable", false);
  }

  console.log("\n=== Typst rebuilding at the end ===");
  await evaluate(`(() => {
    const v=document.querySelector(".cm-content").cmTile.root.view;
    v.dispatch({selection:{anchor:v.state.doc.length},scrollIntoView:true});
    v.contentDOM.focus();
  })()`);
  const seed =
    "\n\n= Tail fixture\n\n" +
    "A typeset paragraph keeps the text flowing across the page.\n\n".repeat(100);
  await send("Input.insertText", { text: seed });
  const seeded = await waitFor(
    `(() => {
    const host=document.querySelector('.typst-preview:not([style*="hidden"])');
    return host && host.querySelectorAll('.typst-page-shell').length >= 3 && host.textContent.includes('Tail fixture');
  })()`,
    40000,
  );
  check("the Typst tail fixture spans several pages", seeded);
  const start = await evaluate(`(async () => {
    const v=document.querySelector(".cm-content").cmTile.root.view, pane=document.getElementById("preview-pane");
    v.dispatch({selection:{anchor:v.state.doc.length},scrollIntoView:true});
    await new Promise(r=>setTimeout(r,300)); pane.scrollTop=pane.scrollHeight;
    await new Promise(r=>setTimeout(r,150));
    window.__typstViewport={min:pane.scrollTop,frames:0,active:true};
    const frame=()=>{const p=window.__typstViewport;if(!p.active)return;p.min=Math.min(p.min,pane.scrollTop);p.frames++;requestAnimationFrame(frame)};
    requestAnimationFrame(frame);v.contentDOM.focus();
    return {top:pane.scrollTop,pages:document.querySelectorAll('.typst-page-shell').length};
  })()`);
  const growth =
    "\n\n= Typst growth marker\n\n" +
    "More text follows the reader onto another page.\n\n".repeat(100);
  await send("Input.insertText", { text: growth });
  const rebuilt = await waitFor(
    `(() => {
    const host=document.querySelector('.typst-preview:not([style*="hidden"])');
    return host && host.textContent.includes('Typst growth marker');
  })()`,
    40000,
  );
  const after = await evaluate(`(() => {
    const pane=document.getElementById("preview-pane"), p=window.__typstViewport;p.active=false;
    return {top:pane.scrollTop,min:p.min,frames:p.frames,max:pane.scrollHeight-pane.clientHeight,pages:document.querySelectorAll('.typst-page-shell').length};
  })()`);
  check("typing rebuilds the Typst PDF", rebuilt);
  check(
    "Typst keeps the previous pages visible throughout rebuilding",
    start.top > 50 && after.frames > 0 && after.min > 50,
    JSON.stringify({ start, after }),
  );
  check(
    "Typst grows onto new pages",
    after.pages > start.pages,
    `${start.pages} -> ${after.pages}`,
  );
  check(
    "Typst follows the new last page",
    after.max - after.top < 100,
    `${after.top}/${after.max}`,
  );
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} checks passed`);
ws.close();
if (failed > 0) process.exit(1);
