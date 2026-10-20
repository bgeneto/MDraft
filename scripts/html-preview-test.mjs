#!/usr/bin/env node
// HTML guest preview checks.
//
//   node scripts/html-preview-test.mjs 9222
//
// Needs the application running with samples/html-tour/index.html loaded and
// WebView2 remote debugging enabled. The port is argv[2], like every other UI
// suite. This is the only suite that also talks to the iframe target: the guest
// is cross-origin by design, so its DOM cannot be reached from the page target.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = process.argv[2] || "9222";
const base = `http://127.0.0.1:${port}`;
let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targets() {
  const response = await fetch(`${base}/json/list`);
  if (!response.ok) throw new Error(`CDP returned ${response.status}`);
  return response.json();
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const client = new Client(ws);
    await client.send("Runtime.enable");
    return client;
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.result.exceptionDetails) {
      throw new Error(JSON.stringify(result.result.exceptionDetails));
    }
    return result.result.result.value;
  }

  close() {
    this.ws.close();
  }
}

async function pageClient() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await targets();
      const page = list.find((target) => target.type === "page");
      if (page) return Client.connect(page.webSocketDebuggerUrl);
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error("No page target appeared.");
}

async function frameClient(expectedSrc) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const list = await targets();
    const frame = list.find(
      (target) =>
        target.type === "iframe" &&
        (!expectedSrc || target.url === expectedSrc || target.url.startsWith(expectedSrc)),
    );
    if (frame) return Client.connect(frame.webSocketDebuggerUrl);
    await sleep(250);
  }
  throw new Error("No matching HTML preview target appeared.");
}

const page = await pageClient();

// The page starts on the fixture. Give the preview time to become ready.
let active = null;
for (let attempt = 0; attempt < 80; attempt += 1) {
  active = await page.evaluate(`(() => {
    const frame = document.querySelector('.html-preview-frame.active');
    return frame ? { src: frame.getAttribute('src') || '', sandbox: frame.getAttribute('sandbox') || '' } : null;
  })()`);
  if (active) break;
  await sleep(250);
}
if (!active) {
  console.log("  FAIL  the HTML preview iframe never became active");
  console.log("\n0/1 checks passed");
  process.exit(1);
}

let frame = await frameClient(active.src);

const parentState = await page.evaluate(`(() => {
  const frame = document.querySelector('.html-preview-frame.active');
  return JSON.stringify({
    sandbox: frame ? frame.getAttribute('sandbox') : '',
    iframes: document.querySelectorAll('.html-preview-frame').length,
    app: document.getElementById('app').className,
    previewDisplay: getComputedStyle(document.getElementById('preview')).display,
    panePadding: getComputedStyle(document.getElementById('preview-pane')).padding,
    paneOverflow: getComputedStyle(document.getElementById('preview-pane')).overflow,
  });
})()`);
const parent = JSON.parse(parentState);
check("one active guest iframe", parent.iframes === 1, String(parent.iframes));
check(
  "sandbox is scripts/forms/modals, no same-origin",
  parent.sandbox === "allow-scripts allow-forms allow-modals",
  parent.sandbox,
);
check("HTML pane is full-bleed", parent.panePadding === "0px" && parent.paneOverflow === "hidden");
check("Markdown article is hidden in HTML mode", parent.previewDisplay === "none");
check("app carries the HTML document class", parent.app.includes("document-html"));

const guest = JSON.parse(
  await frame.evaluate(`JSON.stringify({
    css: getComputedStyle(document.getElementById('css-marker')).color,
    inlineCss: getComputedStyle(document.getElementById('inline-marker')).color,
    image: document.getElementById('local-image').naturalWidth,
    inline: document.body.dataset.inline,
    external: document.body.dataset.external,
    module: document.body.dataset.module,
    fetch: document.body.dataset.fetch,
    inlineText: document.getElementById('inline-script-marker').textContent,
    externalText: document.getElementById('external-marker').textContent,
    moduleText: document.getElementById('module-marker').textContent,
    fetchText: document.getElementById('fetch-marker').textContent,
    money: document.getElementById('money').textContent,
    katex: document.querySelectorAll('.katex').length,
    anchors: document.querySelectorAll('[data-mdraft-line]').length,
    bridge: !!document.querySelector('script[nonce]'),
    scriptString: document.getElementById('script-string').textContent,
    reload: (() => {
      const fire = (init) => {
        const event = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init));
        window.dispatchEvent(event);
        return event.defaultPrevented;
      };
      return {
        f5: fire({ key: 'F5', code: 'F5' }),
        ctrlR: fire({ key: 'r', code: 'KeyR', ctrlKey: true }),
        plain: fire({ key: 'r', code: 'KeyR' }),
      };
    })(),
  })`),
);
check("linked CSS applies", guest.css === "rgb(1, 128, 2)", guest.css);
check("inline CSS applies", guest.inlineCss === "rgb(12, 34, 56)", guest.inlineCss);
check("local image loads", guest.image > 0, String(guest.image));
check("inline script runs", guest.inline === "yes" && guest.inlineText === "inline script ran");
check("classic external script runs", guest.external === "yes" && guest.externalText === "external script ran");
check("ES module runs", guest.module === "yes" && guest.moduleText === "module ran");
check("local fetch is blocked", guest.fetch === "blocked" && guest.fetchText === "local fetch blocked");
check("math is not injected into HTML", guest.katex === 0 && guest.money.includes("$5"));
check("line anchors were spliced in", guest.anchors >= 10, String(guest.anchors));
check("bridge is present", guest.bridge === true);
check(
  "script text survives without reserialisation",
  guest.scriptString === "<div class='kept'> > </div>",
  guest.scriptString,
);
check(
  "the guest swallows the webview reload keys",
  guest.reload.f5 === true && guest.reload.ctrlR === true && guest.reload.plain === false,
  JSON.stringify(guest.reload),
);

const security = JSON.parse(
  await frame.evaluate(`JSON.stringify({
    parent: (() => { try { return parent.document ? 'readable' : 'null'; } catch (error) { return 'throws:' + error.name; } })(),
    internals: typeof window.__TAURI_INTERNALS__,
  })`),
);
check("guest cannot read parent DOM", security.parent === "throws:SecurityError", security.parent);
check("Tauri internals may exist but the origin is not local", security.internals === "object");

const invokeResult = await frame.evaluate(`Promise.race([
  window.__TAURI_INTERNALS__.invoke('path_exists', { path: 'C:/Windows/win.ini', documentPath: null })
    .then(value => 'resolved:' + value)
    .catch(error => 'rejected:' + String(error).slice(0, 120)),
  new Promise(resolve => setTimeout(() => resolve('no response'), 1500)),
])`);
check(
  "guest command does not execute or return a value",
  invokeResult === "no response" || invokeResult.startsWith("rejected:"),
  String(invokeResult),
);

const parentInvoke = await page.evaluate(
  `window.__TAURI_INTERNALS__.invoke('path_exists', { path: 'C:/Windows/win.ini', documentPath: null })`,
);
check("parent IPC still works", parentInvoke === true, String(parentInvoke));

const victim = path.join(os.tmpdir(), `mdraft-html-preview-pwn-${process.pid}.txt`);
try {
  fs.rmSync(victim, { force: true });
} catch {
  /* absent */
}
await frame.evaluate(`(() => {
  try {
    window.__TAURI_INTERNALS__.invoke('write_document', {
      path: ${JSON.stringify(victim)},
      content: 'pwn',
      lineEnding: '\\n',
      hadBom: false
    });
    return 'posted';
  } catch (error) {
    return 'threw:' + String(error);
  }
})()`);
await sleep(1200);
check("guest cannot write a file through IPC", !fs.existsSync(victim), victim);

// Scroll sync, both directions.
await page.evaluate(`document.querySelector('.cm-scroller').scrollTop = 600; 'ok'`);
await sleep(800);
const frameAfterEditorScroll = await frame.evaluate("window.scrollY");
check("editor scroll moves the guest", frameAfterEditorScroll > 50, String(frameAfterEditorScroll));

await frame.evaluate("window.scrollTo(0, 300); 'ok'");
await sleep(800);
const editorAfterFrameScroll = await page.evaluate("document.querySelector('.cm-scroller').scrollTop");
check("guest scroll moves the editor", editorAfterFrameScroll > 400, String(editorAfterFrameScroll));

const scrollBeforeClick = await frame.evaluate("window.scrollY");
const clicked = JSON.parse(
  await frame.evaluate(`(() => {
    const element = [...document.querySelectorAll('[data-mdraft-line]')]
      .find(candidate => candidate.getBoundingClientRect().top > 80 && candidate.getBoundingClientRect().top < 400);
    if (!element) return JSON.stringify({ line: 0 });
    const line = parseInt(element.getAttribute('data-mdraft-line'), 10);
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    return JSON.stringify({ line, scroll: window.scrollY });
  })()`),
);
await sleep(350);
const cursorAfterClick = await page.evaluate("document.getElementById('status-cursor').textContent");
const blinkNow = await frame.evaluate("document.querySelectorAll('.mdraft-blink').length");
const scrollAfterClick = await frame.evaluate("window.scrollY");
check("preview click moves the caret", clicked.line > 0 && cursorAfterClick.includes(`Ln ${clicked.line},`), `${clicked.line} / ${cursorAfterClick}`);
check("preview click blinks the block", blinkNow === 1, String(blinkNow));
check("preview click does not scroll the preview", Math.abs(scrollAfterClick - scrollBeforeClick) < 4);
await sleep(800);
check("blink clears itself", (await frame.evaluate("document.querySelectorAll('.mdraft-blink').length")) === 0);

// Word-level sync. The fixture repeats "Paragraph", so a source search would be
// ambiguous; the parse5 table is what makes the clicked occurrence exact.
await page.evaluate("document.querySelector('.cm-scroller').scrollTop = 0; 'ok'");
// Setting the editor scroll fires the editor -> guest sync, and that message is
// delivered asynchronously. Scrolling the guest before it lands lets the app's
// scrollTo overwrite ours, which is what made this pass alone and fail in the
// full run. Let the sync settle first.
await sleep(500);
await frame.evaluate(`(() => {
  const paragraph = [...document.querySelectorAll('p')].find((node) =>
    node.textContent.startsWith('Paragraph two.')
  );
  if (!paragraph) return 'missing';
  // scrollIntoView is not reliable here and the guest's viewport is shorter
  // than the page; place the paragraph 180 px below the top explicitly.
  const rect = paragraph.getBoundingClientRect();
  window.scrollTo(0, Math.max(0, rect.top + window.scrollY - 180));
  return 'ok';
})()`);
await sleep(700);
const wordTarget = JSON.parse(
  await frame.evaluate(`(() => {
    const paragraph = [...document.querySelectorAll('p')].find((node) =>
      node.textContent.startsWith('Paragraph two.')
    );
    if (!paragraph || !paragraph.firstChild) return JSON.stringify(null);
    const at = paragraph.firstChild.data.indexOf('Paragraph');
    if (at < 0) return JSON.stringify(null);
    const range = document.createRange();
    range.setStart(paragraph.firstChild, at);
    range.setEnd(paragraph.firstChild, at + 'Paragraph'.length);
    const rect = range.getBoundingClientRect();
    return JSON.stringify({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  })()`),
);
const frameOrigin = JSON.parse(
  await page.evaluate(`(() => {
    const element = document.querySelector('.html-preview-frame.active');
    if (!element) return JSON.stringify(null);
    const rect = element.getBoundingClientRect();
    return JSON.stringify({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  })()`),
);
check(
  "the guest word target is on screen",
  wordTarget !== null &&
    frameOrigin !== null &&
    wordTarget.y > 0 &&
    wordTarget.y < frameOrigin.height,
  wordTarget && frameOrigin
    ? JSON.stringify({ wordTarget, frameOrigin })
    : "missing",
);
if (wordTarget && frameOrigin) {
  const x = frameOrigin.x + wordTarget.x;
  const y = frameOrigin.y + wordTarget.y;
  for (const clickCount of [1, 2]) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount,
    });
  }
  await sleep(400);
}
const guestHit =
  wordTarget === null
    ? "missing"
    : await frame.evaluate(`(() => {
        const element = document.elementFromPoint(${wordTarget.x}, ${wordTarget.y});
        return element ? element.tagName + ':' + (element.textContent ?? '').slice(0, 40) : 'none';
      })()`);
const pageHit =
  wordTarget === null || frameOrigin === null
    ? "missing"
    : await page.evaluate(`(() => {
        const element = document.elementFromPoint(${frameOrigin.x + wordTarget.x}, ${frameOrigin.y + wordTarget.y});
        return element ? element.tagName + ':' + (element.className ?? '') : 'none';
      })()`);
check("the guest point is over the paragraph", guestHit.startsWith("P"), guestHit);
check("the page point is over the guest", pageHit.startsWith("IFRAME"), pageHit);
const guestSelection = await frame.evaluate(
  "window.getSelection()?.toString() ?? ''",
);
const guestStamps = await frame.evaluate(
  "document.querySelectorAll('[data-mdraft-n]').length",
);
check("the guest selected the word", guestSelection.includes("Paragraph"), guestSelection);
check("the preview copy carries word ids", guestStamps > 0, String(guestStamps));
const guestMark = await page.evaluate(
  `[...document.querySelectorAll('.cm-sync-word')].map((node) => node.textContent).join('|')`,
);
const guestMarkLine = await page.evaluate(
  `document.querySelector('.cm-sync-word')?.closest('.cm-line')?.textContent ?? ''`,
);
check("a guest double-click paints the clicked word", guestMark === "Paragraph", guestMark);
check(
  "the guest word maps its own paragraph",
  guestMarkLine.includes("Paragraph two."),
  guestMarkLine.slice(0, 80),
);

// Keyboard forwarding: F8 is a menu accelerator with a visible flag.
await frame.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', code: 'F8', bubbles: true, cancelable: true }))");
await sleep(400);
const focusOn = await page.evaluate("document.getElementById('flag-focus').dataset.on");
check("guest forwards a menu shortcut (F8)", focusOn === "true", String(focusOn));
await frame.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', code: 'F8', bubbles: true, cancelable: true }))");
await sleep(400);
const focusOff = await page.evaluate("document.getElementById('flag-focus').dataset.on");
check("the forwarded shortcut can be undone", focusOff === "false", String(focusOff));

const outline = JSON.parse(
  await page.evaluate(
    `JSON.stringify([...document.querySelectorAll('.outline-item')].map(item => item.textContent))`,
  ),
);
check(
  "HTML outline lists source headings",
  outline.includes("HTML Tour") && outline.includes("Second section") && outline.includes("Third section"),
  outline.join(" | "),
);

// Preference: scripts off must block the document, not the bridge.
await page.evaluate(`document.getElementById('btn-prefs').click(); 'ok'`);
await sleep(250);
await page.evaluate(`(() => {
  const section = [...document.querySelectorAll('.prefs-section')].find(node => node.textContent.trim() === 'HTML');
  if (section) section.click();
  return 'ok';
})()`);
await sleep(250);
await page.evaluate(`(() => {
  const row = [...document.querySelectorAll('.prefs-row')].find(node => node.textContent.includes('Run scripts in the HTML preview'));
  const input = row && row.querySelector('input');
  if (input && input.checked) input.click();
  return input ? input.checked : 'missing';
})()`);
let newSrc = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(250);
  const candidate = await page.evaluate(`(() => {
    const frame = document.querySelector('.html-preview-frame.active');
    return frame ? frame.getAttribute('src') : null;
  })()`);
  if (candidate && candidate !== active.src) {
    newSrc = candidate;
    break;
  }
}
if (!newSrc) {
  check("scripts-off preference reloads the guest", false);
} else {
  check("scripts-off preference reloads the guest", true, newSrc);
  frame.close();
  frame = await frameClient(newSrc);
  const off = JSON.parse(
    await frame.evaluate(`JSON.stringify({
      inline: document.body.dataset.inline || '',
      external: document.body.dataset.external || '',
      module: document.body.dataset.module || '',
      inlineText: document.getElementById('inline-script-marker').textContent,
      css: getComputedStyle(document.getElementById('css-marker')).color,
      image: document.getElementById('local-image').naturalWidth,
      anchors: document.querySelectorAll('[data-mdraft-line]').length,
      bridge: !!document.querySelector('script[nonce]'),
    })`),
  );
  check("scripts off blocks inline scripts", off.inline === "" && off.inlineText === "inline script did not run");
  check("scripts off blocks external scripts", off.external === "");
  check("scripts off blocks modules", off.module === "");
  check("scripts off keeps CSS and images", off.css === "rgb(1, 128, 2)" && off.image > 0);
  check("scripts off keeps the bridge and anchors", off.bridge === true && off.anchors >= 10);

  // Let the parent's ready handler finish restoring the visible line before
  // driving a new scroll; otherwise its restore can land after this probe.
  await sleep(700);
  await page.evaluate(`document.querySelector('.cm-scroller').scrollTop = 500; 'ok'`);
  await sleep(800);
  const offScroll = await frame.evaluate("window.scrollY");
  check("scripts off keeps scroll sync", offScroll > 40, String(offScroll));
  await frame.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', code: 'F8', bubbles: true, cancelable: true }))");
  await sleep(400);
  check(
    "scripts off keeps shortcut forwarding",
    (await page.evaluate("document.getElementById('flag-focus').dataset.on")) === "true",
  );
}

// Return to Markdown through the application's own New command.
await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true })); 'ok'`);
await sleep(800);
const back = JSON.parse(
  await page.evaluate(`JSON.stringify({
    iframes: document.querySelectorAll('.html-preview-frame').length,
    app: document.getElementById('app').className,
    previewDisplay: getComputedStyle(document.getElementById('preview')).display,
    title: document.title,
  })`),
);
check("leaving HTML removes the guest iframe", back.iframes === 0, String(back.iframes));
check("leaving HTML restores the Markdown pane", !back.app.includes("document-html") && back.previewDisplay !== "none");

const parked = JSON.parse(
  await page.evaluate(`JSON.stringify([...document.querySelectorAll(".doc-tab-name")].map((el) => el.textContent))`),
);
check(
  "leaving HTML keeps the document tab",
  parked.length === 2 && parked.some((name) => name.includes("index.html")),
  parked.join(", "),
);
await page.evaluate(`
  [...document.querySelectorAll(".doc-tab")].find((tab) => tab.textContent.includes("index.html")).click();
  "ok"
`);
let nextSrc = "";
for (let attempt = 0; attempt < 40; attempt += 1) {
  nextSrc = await page.evaluate(
    `document.querySelector(".html-preview-frame.active")?.getAttribute("src") || ""`,
  );
  if (nextSrc && nextSrc !== active.src) break;
  await sleep(250);
}
if (!nextSrc || nextSrc === active.src) {
  check("returning to the HTML tab rebuilds the guest", false, nextSrc || "no guest");
} else {
  const returned = await frameClient(nextSrc);
  const marker = await returned.evaluate(
    `document.getElementById("css-marker") ? getComputedStyle(document.getElementById("css-marker")).color : ""`,
  );
  check("returning to the HTML tab rebuilds the guest", marker === "rgb(1, 128, 2)", marker);
  returned.close();
}

frame.close();
page.close();

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
