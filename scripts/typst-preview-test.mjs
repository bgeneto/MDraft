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
  ws.addEventListener("open", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
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

async function selectWord(word, root) {
  const point = await rectOf(word, root);
  if (!point) return { selected: "", point: null };
  await doubleClickAt(point);
  await sleep(250);
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
const documentReady = await waitFor(
  `Boolean(document.querySelector(".typst-document"))`,
);
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
const documentGenerated = await selectWord("consectetur", ".typst-document");
check(
  "generated Document text can be selected",
  documentGenerated.selected.includes("consectetur"),
  documentGenerated.selected,
);
const generatedDocumentMark = await mark();
check("generated Document text paints nothing", generatedDocumentMark === "", generatedDocumentMark);

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

const pagesWord = await selectWord("gyroscope", ".typst-preview");
check(
  "double-clicking a Pages word selects it",
  pagesWord.selected.includes("gyroscope"),
  pagesWord.selected,
);
const pagesMark = await mark();
check("the Pages word paints the source", pagesMark === "gyroscope", pagesMark);

await clearSelection();
const pagesGenerated = await selectWord("consectetur", ".typst-preview");
check(
  "generated Pages text can be selected",
  pagesGenerated.selected.includes("consectetur"),
  pagesGenerated.selected,
);
const generatedPagesMark = await mark();
check("generated Pages text paints nothing", generatedPagesMark === "", generatedPagesMark);

await clearSelection();
const singlePagePoint = await rectOf("gyroscope", ".typst-preview");
if (singlePagePoint) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: singlePagePoint.x,
    y: singlePagePoint.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: singlePagePoint.x,
    y: singlePagePoint.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(250);
}
const singlePageMark = await mark();
check("a single Pages click does not paint a word", singlePageMark === "", singlePageMark);

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

console.log(`\n${passed}/${passed + failed} checks passed`);
ws.close();
if (failed > 0) process.exit(1);
