//! Word-level sync between the source and the Markdown preview.
//!
//! Run against a freshly launched instance holding `samples/word-sync.md`:
//!
//!   node scripts/word-sync-test.mjs [port]
//!
//! The fixture is deliberately hostile: accent + repeated word, hard-wrapped
//! paragraph, escaped asterisks, an entity, inline code, a formula, a link, a
//! table, a task list, an alert and a fence. A "word" that maps correctly here
//! maps correctly anywhere.

import fs from "node:fs";
import os from "node:os";
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
  // `id: 0` is a valid response: a truthiness check here swallowed the first
  // response and made every script look like it had hung.
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

/** A word's viewport centre, by text search inside one container. */
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
      range.setEnd(node, at + ${JSON.stringify(word)}.length);
      const box = range.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return null;
  })()`);
}

async function doubleClickAt(x, y) {
  for (const clickCount of [1, 2]) {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount,
    });
  }
}

async function drag(x1, y1, x2, y2) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: x1,
    y: y1,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: (x1 + x2) / 2,
    y: y1,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: x2,
    y: y2,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: x2,
    y: y2,
    button: "left",
    clickCount: 1,
  });
}

/** Select a word in the preview the way a browser double-click would. */
async function selectPreviewWord(word) {
  return evaluate(`(() => {
    const walker = document.createTreeWalker(document.getElementById("preview"), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(${JSON.stringify(word)});
      if (at < 0) continue;
      if (!node.parentElement?.closest("[data-f], [data-b]")) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + ${JSON.stringify(word)}.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    }
    return null;
  })()`);
}

// A mark that crosses lines is rendered as one element per line.
const paintedWord = () =>
  evaluate(`(() => {
    const marks = [...document.querySelectorAll(".cm-sync-word")];
    return marks.length === 0 ? null : marks.map((mark) => mark.textContent).join("\\n");
  })()`);

const highlightText = () =>
  evaluate(`(() => {
    // The pulse swaps the registered name, so either one is the painted word.
    const highlight =
      CSS.highlights?.get("mdraft-sync") ??
      CSS.highlights?.get("mdraft-sync-peak");
    return highlight ? [...highlight].map((range) => range.toString()) : null;
  })()`);

const markStyle = () =>
  evaluate(`(() => {
    const mark = document.querySelector(".cm-sync-word");
    if (!mark) return null;
    const style = getComputedStyle(mark);
    return {
      animation: style.animationName,
      duration: style.animationDuration,
      count: style.animationIterationCount,
      background: style.backgroundColor,
    };
  })()`);

const scrollState = () =>
  evaluate(`({
    preview: document.getElementById("preview-pane").scrollTop,
    source: document.querySelector(".cm-scroller")?.scrollTop ?? null,
  })`);

async function clearSelection() {
  await evaluate(`window.getSelection()?.removeAllRanges()`);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await sleep(80);
}

async function resetView() {
  await clearSelection();
  await evaluate(`document.getElementById("preview-pane").scrollTop = 0`);
  await evaluate(`document.querySelector(".cm-scroller").scrollTop = 0`);
  await sleep(120);
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

console.log("\n=== the map ===");
{
  const fragments = await evaluate(`document.querySelectorAll("#preview [data-f]").length`);
  check("the render emitted source fragments", fragments >= 20, `${fragments} fragments`);

  const blocks = await evaluate(`document.querySelectorAll("#preview [data-line]").length`);
  check("block anchors are untouched", blocks >= 8, `${blocks} blocks`);

  const bold = await evaluate(`[...document.querySelectorAll("#preview strong [data-f]")].some(
    (element) => element.textContent === "efetivos"
  )`);
  check("the bold word is its own fragment", bold);

  const fence = await evaluate(`document.querySelectorAll("#preview pre[data-f]").length`);
  check("a fence is an atomic fragment", fence >= 1, `${fence} fences`);

  const image = await evaluate(`document.querySelectorAll("#preview img[data-f]").length`);
  check("an image is an atomic fragment", image >= 1, `${image} images`);

  const line = await evaluate(
    `document.querySelector("#preview [data-f]")?.closest("[data-line]") !== null`,
  );
  check("fragments live inside anchored blocks", line);
}

// ---------------------------------------------------------------------------
// Preview -> source, plain and awkward text
// ---------------------------------------------------------------------------

console.log("\n=== preview to source ===");
{
  await resetView();
  const cases = [
    ["efetivos", "bold, repeated word"],
    ["frase", "after inline code"],
    ["parágrafo", "after a formula"],
    ["literal", "after a backslash escape"],
    ["Analista", "inside a table cell"],
    ["concluída", "inside a task list"],
  ];
  for (const [word, note] of cases) {
    const selected = await selectPreviewWord(word);
    await sleep(120);
    const painted = await paintedWord();
    check(
      `"${word}" paints the same word in the source`,
      selected === word && painted === word,
      `${note}: ${painted}`,
    );
  }
}

console.log("\n=== atomic spans ===");
{
  const code = await selectPreviewWord("código");
  await sleep(120);
  const painted = await paintedWord();
  check(
    "a word inside inline code paints the whole span",
    code === "código" && painted === "`código embutido`",
    painted,
  );

  const formula = await evaluate(`(() => {
    const node = document.querySelector("#preview [data-f] .math-inline");
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  })()`);
  await sleep(120);
  const formulaPainted = await paintedWord();
  check(
    "a selection inside a formula paints the formula",
    formula !== null && formulaPainted === "$E = mc^2$",
    formulaPainted,
  );

  const alertSpans = await evaluate(
    `document.querySelectorAll("#preview .md-alert [data-f]").length`,
  );
  check(
    "the alert paragraph has no fragments (documented fallback)",
    alertSpans === 0,
    `${alertSpans}`,
  );
}

console.log("\n=== across blocks ===");
{
  const selected = await evaluate(`(() => {
    const walker = document.createTreeWalker(document.getElementById("preview"), NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    const first = nodes.find((node) => node.data.includes("Presidente"));
    const last = nodes.find((node) => node.data.includes("efetivos"));
    if (!first || !last || first === last) return null;
    const range = document.createRange();
    range.setStart(first, first.data.indexOf("Presidente"));
    range.setEnd(last, last.data.indexOf("efetivos") + 8);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  })()`);
  await sleep(150);
  const painted = await paintedWord();
  check(
    "a selection spanning paragraphs maps both ends to words",
    selected !== null &&
      painted !== null &&
      painted.trimStart().startsWith("Presidente") &&
      painted.trimEnd().endsWith("efetivos"),
    JSON.stringify(painted),
  );
}

// ---------------------------------------------------------------------------
// No side effects
// ---------------------------------------------------------------------------

console.log("\n=== side effects ===");
{
  await resetView();
  const before = await scrollState();
  await selectPreviewWord("Presidente");
  await sleep(150);
  const after = await scrollState();
  const selected = await evaluate(`window.getSelection().toString()`);
  check(
    "a preview selection never scrolls the panes",
    before.preview === after.preview && before.source === after.source,
    `preview ${before.preview}->${after.preview}, source ${before.source}->${after.source}`,
  );
  check(
    "a preview selection never takes the preview's own selection",
    selected === "Presidente",
    selected,
  );
}

// ---------------------------------------------------------------------------
// Real input: double-click and drag
// ---------------------------------------------------------------------------

console.log("\n=== real input ===");
{
  await resetView();
  const word = await rectOf("sanciona", "#preview");
  check("the double-click target is on screen", word !== null);
  if (word) {
    const before = await scrollState();
    const started = Date.now();
    await doubleClickAt(word.x, word.y);
    let painted = null;
    for (let i = 0; i < 40 && painted === null; i += 1) {
      await sleep(10);
      painted = await paintedWord();
    }
    const elapsed = Date.now() - started;
    const after = await scrollState();
    check(
      "a real double-click paints exactly the word",
      painted === "sanciona",
      `${painted} in ${elapsed} ms`,
    );
    check(
      "a double-click does not scroll when the word is visible",
      before.source === after.source,
    );
    check("the highlight arrives within a frame budget", elapsed < 250, `${elapsed} ms`);

    const style = await markStyle();
    check(
      "the mark pulses four times of 500 ms",
      style?.duration === "0.5s" && style?.count === "4",
      style ? `${style.duration} x ${style.count}` : "missing",
    );
    await sleep(2300);
    const lingering = await markStyle();
    check(
      "the mark remains after the pulse",
      lingering !== null && lingering.background !== "rgba(0, 0, 0, 0)",
      lingering?.background ?? "missing",
    );

    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await clearSelection();
    await selectPreviewWord("sanciona");
    await sleep(150);
    const reduced = await markStyle();
    check(
      "reduced motion keeps the mark and skips the pulse",
      reduced?.animation === "none" && reduced?.background !== "rgba(0, 0, 0, 0)",
      reduced ? `${reduced.animation} / ${reduced.background}` : "missing",
    );
    await send("Emulation.setEmulatedMedia", { features: [] });
  }

  await clearSelection();
  const start = await rectOf("Presidente", "#preview");
  const end = await rectOf("República", "#preview");
  check("the drag targets are on screen", start !== null && end !== null);
  if (start && end) {
    await drag(start.x - 10, start.y, end.x + 10, end.y);
    await sleep(200);
    const painted = await paintedWord();
    check(
      "a drag paints a word-aligned range",
      painted !== null &&
        painted.trim().startsWith("Presidente") &&
        painted.trim().endsWith("República"),
      JSON.stringify(painted),
    );
    const selection = await evaluate(`window.getSelection().toString()`);
    check("the drag keeps the user's selection", selection.length > 0, JSON.stringify(selection));
  }
}

// ---------------------------------------------------------------------------
// Source -> preview
// ---------------------------------------------------------------------------

console.log("\n=== source to preview ===");
{
  await resetView();
  const word = await rectOf("sanciona", ".cm-content");
  check("the source word is on screen", word !== null);
  if (word) {
    const before = await scrollState();
    await doubleClickAt(word.x, word.y);
    await sleep(250);
    const ranges = await highlightText();
    const after = await scrollState();
    check(
      "a source word paints the preview",
      Array.isArray(ranges) && ranges.length > 0 && ranges.join(" ").includes("sanciona"),
      JSON.stringify(ranges),
    );
    check("painting the preview does not scroll it", before.preview === after.preview);

    await send("Input.insertText", { text: "X" });
    await sleep(300);
    const cleared = await highlightText();
    check("typing clears the preview highlight", cleared === null, JSON.stringify(cleared));
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "z",
      code: "KeyZ",
      modifiers: 2,
      windowsVirtualKeyCode: 90,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "z",
      code: "KeyZ",
      modifiers: 2,
      windowsVirtualKeyCode: 90,
    });
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// Escape and reveal
// ---------------------------------------------------------------------------

console.log("\n=== escape ===");
{
  await resetView();
  const word = await rectOf("sanciona", "#preview");
  if (word) {
    await doubleClickAt(word.x, word.y);
    await sleep(150);
    const beforeEscape = await paintedWord();
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await sleep(120);
    const afterEscape = await paintedWord();
    check(
      "escape clears the source decoration",
      beforeEscape === "sanciona" && afterEscape === null,
      `${beforeEscape} -> ${afterEscape}`,
    );
  }
}

// Exact occurrences after currency escapes, Unicode, code and math substitutions.
await evaluate(
  `document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown',{key:'n',code:'KeyN',ctrlKey:true,bubbles:true}))`,
);
const currencySource =
  "😀 Café R\\$50 `R$7` $a*b*c$ posterior R\\$50 final\n\n$$x^2$$\n\nacréscimo";
await sleep(450);
await evaluate("document.querySelector('.cm-content').focus()");
await send("Input.insertText", { text: currencySource });
await sleep(700);
await resetView();
for (const word of ["posterior", "final", "acréscimo"]) {
  const position = await rectOf(word, "#preview");
  if (position) await doubleClickAt(position.x, position.y);
  await sleep(150);
  check("preview maps exact following source word: " + word, (await paintedWord()) === word);
}
const repeatedCurrency = await evaluate(
  `(() => {const walker=document.createTreeWalker(document.querySelector('#preview'),NodeFilter.SHOW_TEXT);let seen=0;for(let node=walker.nextNode();node;node=walker.nextNode()){const at=node.data.indexOf('50');if(at<0||++seen!==2)continue;const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+2);const box=range.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2};}return null;})()`,
);
if (repeatedCurrency) await doubleClickAt(repeatedCurrency.x, repeatedCurrency.y);
await sleep(150);
const markedOffset = await evaluate(
  `(() => {const mark=document.querySelector('.cm-sync-word');if(!mark)return null;const line=mark.closest('.cm-line');const lines=[...document.querySelectorAll('.cm-line')];const before=document.createRange();before.setStart(line,0);before.setEndBefore(mark);return lines.slice(0,lines.indexOf(line)).reduce((n,node)=>n+node.textContent.length+1,0)+before.toString().length;})()`,
);
check(
  "second repeated monetary value maps to its original occurrence",
  markedOffset === currencySource.lastIndexOf("50"),
  String(markedOffset),
);
await clearSelection();
const sourceWord = await rectOf("posterior", ".cm-content");
if (sourceWord) await doubleClickAt(sourceWord.x, sourceWord.y);
await sleep(180);
check(
  "source maps following word back to preview after substitutions",
  (await highlightText())?.join("") === "posterior",
);
const atomic = await evaluate(
  `(() => {const node=document.querySelector('#preview .math-inline');const r=node.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
);
await doubleClickAt(atomic.x, atomic.y);
await sleep(180);
check(
  "emphasis-shaped formula remains an atomic source fragment",
  (await paintedWord()) === "$a*b*c$",
);
console.log("\n=== shared selection regression matrix ===");
const matrixDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-sync-matrix-"));
for (const [extension, source] of [
  ["md", "# Audit\n\nalpha **bravo** charlie.\n\ndelta echo foxtrot.\n"],
  ["adoc", "= Audit\n\nalpha *bravo* charlie.\n\ndelta echo foxtrot.\n"],
  ["typ", "= Audit\n\nalpha *bravo* charlie.\n\ndelta echo foxtrot.\n"],
]) {
  const file = path.join(matrixDir, `audit.${extension}`);
  fs.writeFileSync(file, source);
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'open-files',payload:[${JSON.stringify(file)}]})`,
  );
  for (let attempt = 0; attempt < 120; attempt++) {
    if (
      await evaluate(
        `document.title.includes('audit.${extension}') && [...document.querySelectorAll('#preview strong')].some(e=>e.textContent==='bravo')`,
      )
    )
      break;
    await sleep(100);
  }
  await resetView();
  const boundary = await evaluate(
    `(()=>{const p=[...document.querySelectorAll('#preview p')].find(e=>e.textContent.includes('alpha'));if(!p)return null;const strong=p.querySelector('strong'),at=[...p.childNodes].indexOf(strong);const r=document.createRange();r.setStart(p,at);r.setEnd(p,at+1);const s=window.getSelection();s.removeAllRanges();s.addRange(r);document.querySelector('#preview').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return s.toString();})()`,
  );
  await sleep(150);
  check(
    `${extension}: element endpoints select only the bold word`,
    boundary === "bravo" && (await paintedWord()) === "bravo",
    JSON.stringify(await paintedWord()),
  );
  await clearSelection();
  const a = await rectOf("alpha", ".cm-content"),
    b = await rectOf("echo", ".cm-content");
  if (a && b) await drag(a.x, a.y, b.x, b.y);
  await sleep(180);
  const multi = (await highlightText())?.join(" ") ?? "";
  check(
    `${extension}: reverse selection paints both paragraphs`,
    ["alpha", "bravo", "charlie", "delta", "echo"].every((word) => multi.includes(word)),
    JSON.stringify(multi),
  );
  let alternations = true;
  for (let pair = 0; pair < 20; pair++) {
    const point = await rectOf("bravo", ".cm-content");
    if (!point) {
      alternations = false;
      break;
    }
    await doubleClickAt(point.x, point.y);
    await sleep(25);
    if (!(await highlightText())?.join("").includes("bravo")) {
      alternations = false;
      break;
    }
    await selectPreviewWord("bravo");
    await evaluate(
      `document.querySelector('#preview').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`,
    );
    await sleep(25);
    if ((await paintedWord()) !== "bravo") {
      alternations = false;
      break;
    }
  }
  check(`${extension}: twenty alternating source/preview pairs keep the exact word`, alternations);
  const escapePoint = await rectOf("bravo", ".cm-content");
  if (escapePoint) await doubleClickAt(escapePoint.x, escapePoint.y);
  const sourceSelection = await evaluate(`getSelection().toString()`);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await sleep(180);
  check(
    `${extension}: Escape dismisses source correspondence without collapsing selection`,
    sourceSelection === "bravo" &&
      (await evaluate(`getSelection().toString()`)) === sourceSelection &&
      (await paintedWord()) === null &&
      !(await highlightText())?.length,
  );
  if (extension === "md") {
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await clearSelection();
    const point = await rectOf("alpha", ".cm-content");
    if (point) await doubleClickAt(point.x, point.y);
    await sleep(350);
    check(
      "reduced motion keeps the preview resting highlight",
      await evaluate(`CSS.highlights.has('mdraft-sync')&&!CSS.highlights.has('mdraft-sync-peak')`),
    );
    await send("Emulation.setEmulatedMedia", { features: [] });
  }
  // Save a Range on the old DOM, edit before it, and select it during debounce.
  await evaluate(
    `(()=>{const w=document.createTreeWalker(document.querySelector('#preview'),NodeFilter.SHOW_TEXT);for(let n=w.nextNode();n;n=w.nextNode()){const at=n.data.indexOf('alpha');if(at<0)continue;const r=document.createRange();r.setStart(n,at);r.setEnd(n,at+5);window.__oldSyncRange=r;break;}document.querySelector('.cm-content').focus();})()`,
  );
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
  await send("Input.insertText", { text: "PREFIX " });
  await evaluate(
    `(()=>{const s=window.getSelection();s.removeAllRanges();s.addRange(window.__oldSyncRange);document.querySelector('#preview').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));})()`,
  );
  check(
    `${extension}: stale visible text cannot paint shifted source`,
    (await paintedWord()) === null,
    JSON.stringify(await paintedWord()),
  );
  await sleep(900);
  await selectPreviewWord("alpha");
  await evaluate(
    `document.querySelector('#preview').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`,
  );
  await sleep(150);
  check(
    `${extension}: the new map paints the current word after editing`,
    (await paintedWord()) === "alpha",
    JSON.stringify(await paintedWord()),
  );
}

ws.close();
await new Promise((resolve) => setTimeout(resolve, 200));
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
