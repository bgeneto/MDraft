//! Typst Pages and word sync.
//!
//! Run against a freshly launched instance holding `samples/typst-pages.typ`:
//!
//!   node scripts/typst-preview-test.mjs [port]
//!
//! The fixture is package-free, two columns and two pages. Its prose contains a
//! unique word (`gyroscope`), a repeated word (`pendulum`) and generated
//! `#lorem` text that has no source word to map back to.

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
  await evaluate(`[...document.querySelectorAll(".typst-viewbutton")]
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
const title = await evaluate("document.title");
check("the Typst fixture is open", title.includes("typst-pages.typ"), title);

await switchView("Document");
const documentReady = await waitFor(`Boolean(document.querySelector(".typst-document"))`);
check("Document view is available", documentReady);

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
const pagesReady = await waitFor(`(() => {
  const shells = document.querySelectorAll(".typst-page-shell");
  if (shells.length < 2) return false;
  const canvases = [...document.querySelectorAll(".typst-page canvas")];
  if (canvases.length !== shells.length) return false;
  if (canvases.some((canvas) => canvas.width === 0 || canvas.height === 0)) return false;
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

const viewBarStyle = await evaluate(`(() => {
  const bar = document.querySelector(".typst-viewbar");
  const button = document.querySelector(".typst-viewbutton");
  if (!bar || !button) return null;
  const barStyle = getComputedStyle(bar);
  const buttonStyle = getComputedStyle(button);
  return {
    blur: barStyle.backdropFilter,
    barBackground: barStyle.backgroundColor,
    buttonBackground: buttonStyle.backgroundColor,
  };
})()`);
check(
  "the view bar does not blur the page",
  viewBarStyle?.blur === "none" && viewBarStyle?.barBackground === "rgba(0, 0, 0, 0)",
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
  await sleep(280);
}
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
await sleep(260);
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

console.log(`\n${passed}/${passed + failed} checks passed`);
ws.close();
if (failed > 0) process.exit(1);
