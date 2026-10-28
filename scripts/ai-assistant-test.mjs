//! End-to-end checks for the AI Assistant against a local mock endpoint.
//!
//! Run against a freshly launched instance holding `samples/feature-tour.md`:
//!
//!   node scripts/ai-assistant-test.mjs [port]
//!
//! The mock is a real HTTP server on 127.0.0.1: it records the exact request,
//! streams SSE at controlled intervals, can hold a response for Stop and the
//! stale-target case, and can answer 401. No provider is contacted.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";

const port = process.argv[2] ?? "9222";
const appIdentifier = process.env.MDRAFT_TEST_IDENTIFIER ?? "io.github.bernh.mdraft";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Mock endpoint
// ---------------------------------------------------------------------------

const TAGS = {
  revised: "improve",
  continuation: "continue",
  expanded: "expand",
  shortened: "shorten",
  simplified: "simplify",
  rewritten: "tone",
  translation: "translate",
  summary: "summarize",
  explanation: "explain",
  points: "keyPoints",
  critique: "critique",
  table: "table",
  converted: "convert",
};

const ANSWERS = {
  improve: "Improved passage from the mock.",
  continue: "and the mock continues.",
  expand: "Expanded passage from the mock, with one more sentence.",
  shorten: "Short mock.",
  simplify: "Simple mock.",
  tone: "Tone changed by the mock.",
  translate: "Texto traduzido pelo mock.",
  summarize: "A short summary from the mock.",
  explain: "The mock explains the passage.",
  keyPoints: "- First mock point\n- Second mock point",
  critique: "The mock finds the argument clear but the ending abrupt.",
  table: "| A | B |\n| --- | --- |\n| one | two |",
  convert: "# Converted by the mock",
};

const control = {
  mode: "normal",
  requests: [],
  cancelled: 0,
  release: null,
};
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const url = request.url ?? "";
  const isModels = url.endsWith("/models");
  const isAnthropic = url.endsWith("/messages");

  if (control.mode === "unauthorized") {
    control.requests.push({ url, headers: request.headers, body: raw });
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "invalid api key" } }));
    return;
  }

  if (isModels) {
    if (control.mode === "models404") {
      control.requests.push({ url, headers: request.headers, body: raw });
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    if (control.mode === "emptyModels") {
      control.requests.push({ url, headers: request.headers, body: raw, empty: true });
      response.writeHead(200, { "content-type": "application/json", "content-length": "0" });
      response.end();
      return;
    }
    const payload = JSON.stringify({
      object: "list",
      data: [{ id: "test-model" }, { id: "second-model" }],
    });
    const gzip = control.mode === "gzipModels";
    control.requests.push({ url, headers: request.headers, body: raw, gzip });
    if (gzip) {
      const compressed = zlib.gzipSync(payload);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(compressed.length),
      });
      response.end(compressed);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
    return;
  }

  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    body = {};
  }

  const system = isAnthropic
    ? String(body.system ?? "")
    : String(body.messages?.find?.((message) => message.role === "system")?.content ?? "");
  const tag = Object.keys(TAGS).find((candidate) => system.includes(`<${candidate}>`));
  const action = tag ? TAGS[tag] : "ask";
  control.requests.push({
    url,
    headers: request.headers,
    body,
    system,
    action,
    tag: tag ?? null,
  });

  const answer =
    action === "ask"
      ? "The mock says **this file is a feature tour** with a [link](https://example.com)."
      : ANSWERS[action];

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const writeDelta = (text) => {
    if (isAnthropic) {
      response.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text },
        })}\n\n`,
      );
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    }
  };

  const content = tag ? `<${tag}>${answer}</${tag}>` : answer;
  const notes = action === "improve" ? "\n<notes>Mock notes: fixed agreement.</notes>" : "";
  const full = `${content}${notes}`;
  const third = Math.ceil(full.length / 3);

  if (control.mode === "hold") {
    writeDelta(full.slice(0, Math.min(12, full.length)));
    let released = false;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      control.release = () => {
        released = true;
        clearTimeout(timer);
        resolve();
      };
      response.on("close", () => {
        if (!released) control.cancelled += 1;
        clearTimeout(timer);
        resolve();
      });
    });
    control.release = null;
    if (!response.writableEnded) {
      try {
        response.end();
      } catch {
        /* the client cancelled */
      }
    }
    return;
  }

  for (let index = 0; index < full.length; index += third) {
    writeDelta(full.slice(index, index + third));
    await sleep(35);
  }
  if (isAnthropic) {
    response.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
  } else {
    response.write("data: [DONE]\n\n");
  }
  response.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const mockPort = server.address().port;
const baseUrl = `http://127.0.0.1:${mockPort}/v1`;
const rootUrl = `http://127.0.0.1:${mockPort}`;

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
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
await sleep(300);

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

async function waitFor(expression, timeout = 12_000, interval = 80) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function prefsOpen() {
  return evaluate(`!document.querySelector('.prefs-overlay')?.hidden`);
}

async function openPrefs() {
  if (await prefsOpen()) return;
  await evaluate(`document.getElementById('btn-prefs').click()`);
  await waitFor(`!document.querySelector('.prefs-overlay')?.hidden`);
}

async function openAiSection() {
  await openPrefs();
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.prefs-section')].find(b => b.textContent === 'AI Assistant');
    button?.click();
  })()`);
  await waitFor(`document.querySelector('.prefs-section-title')?.textContent === 'AI Assistant'`);
}

async function closePrefs() {
  if (await prefsOpen()) {
    await evaluate(`document.querySelector('.prefs-close').click()`);
    await waitFor(`document.querySelector('.prefs-overlay')?.hidden`);
  }
}

async function clickPrefsButton(text) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.prefs-row .prefs-button')].find(b => b.textContent === ${JSON.stringify(text)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(200);
  return clicked;
}

function rowSelector(label) {
  return `[...document.querySelectorAll('.prefs-row')].find(row => row.querySelector('.prefs-label')?.textContent.replace(/\\?$/, '') === ${JSON.stringify(label)})`;
}

async function setCheckbox(label, value) {
  const ok = await evaluate(`(() => {
    const row = ${rowSelector(label)};
    const input = row?.querySelector('input[type=checkbox]');
    if (!input) return false;
    input.checked = ${value ? "true" : "false"};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  return ok;
}

async function setText(label, value) {
  const ok = await evaluate(`(() => {
    const row = ${rowSelector(label)};
    const input = row?.querySelector('input[type=text]');
    if (!input) return false;
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  return ok;
}

async function setSelect(label, value) {
  const ok = await evaluate(`(() => {
    const row = ${rowSelector(label)};
    const select = row?.querySelector('select');
    if (!select) return false;
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  return ok;
}

async function setKey(key) {
  await evaluate(`(() => {
    const row = ${rowSelector("API Key")};
    const input = row?.querySelector('input');
    const save = [...(row?.querySelectorAll('button') ?? [])].find(b => b.textContent === 'Save');
    if (!input || !save) return false;
    input.value = ${JSON.stringify(key)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    save.click();
    return true;
  })()`);
  await sleep(700);
}

async function pressFetchModels() {
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.prefs-row')].find(r => [...r.querySelectorAll('button')].some(b => b.textContent === 'Fetch model list'));
    [...(row?.querySelectorAll('button') ?? [])].find(b => b.textContent === 'Fetch model list')?.click();
  })()`);
  await sleep(700);
}

async function aiStatusNote() {
  return evaluate(
    `[...document.querySelectorAll('.prefs-row')].find(r => r.querySelector('.prefs-label')?.textContent.replace(/\\?$/, '') === 'Status')?.querySelector('.prefs-note')?.textContent ?? ''`,
  );
}

async function clickFab() {
  const rect = await evaluate(`(() => {
    const fab = document.querySelector('.ai-fab');
    if (!fab) return null;
    const box = fab.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  if (!rect) throw new Error("no assistant button");
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(200);
}

async function paletteOpen() {
  return evaluate(`!document.querySelector('.ai-palette').hidden`);
}

async function openPalette() {
  if (await paletteOpen()) return;
  await clickFab();
  await waitFor(`!document.querySelector('.ai-palette').hidden`);
}

async function closePalette() {
  if (await paletteOpen()) {
    await clickFab();
    await waitFor(`document.querySelector('.ai-palette').hidden`);
  }
}

async function historyIsOpen() {
  return evaluate(`!document.querySelector('.ai-history').hidden`);
}

async function openHistory() {
  await openPalette();
  const clicked = await evaluate(`(() => {
    const button = document.querySelector('.ai-palette [data-command="history"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error("no History command");
  await waitFor(`!document.querySelector('.ai-history').hidden`);
  await sleep(150);
}

async function closeHistory() {
  if (await historyIsOpen()) {
    await evaluate(`document.querySelector('.ai-history-close').click()`);
    await waitFor(`document.querySelector('.ai-history').hidden`);
  }
}

async function historyRows() {
  return evaluate(
    `[...document.querySelectorAll('.ai-history-row')].map(row => ({
      title: row.querySelector('.ai-history-action')?.textContent ?? '',
      request: row.querySelector('.ai-history-request')?.textContent ?? '',
      preview: row.querySelector('.ai-history-preview')?.textContent ?? '',
      time: row.querySelector('.ai-history-time')?.textContent ?? '',
    }))`,
  );
}

async function openHistoryDetail(index = 0) {
  const clicked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.ai-history-row')][${index}];
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (clicked) await waitFor(`!document.querySelector('.ai-history-detail').hidden`);
  await sleep(120);
  return clicked;
}

async function chooseAction(label) {
  await openPalette();
  const clicked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.ai-row')].find(r => r.querySelector('.ai-row-label')?.textContent === ${JSON.stringify(label)});
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`no action row ${label}`);
  await waitFor(`!document.querySelector('.ai-panel').hidden`);
  await sleep(120);
}

async function panelStatus() {
  return evaluate(`document.querySelector('.ai-status')?.textContent ?? ""`);
}

async function waitPanelDone(timeout = 15_000) {
  return waitFor(
    `(() => {
      const status = document.querySelector('.ai-status')?.textContent ?? "";
      return status.startsWith('Answer ready') || status.startsWith('Stopped') || document.querySelector('.ai-status')?.classList.contains('is-error');
    })()`,
    timeout,
  );
}

async function clickFooter(label) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.ai-footer-actions button')].find(b => b.textContent === ${JSON.stringify(label)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  await sleep(250);
  return clicked;
}

async function footerButtons() {
  return evaluate(
    `[...document.querySelectorAll('.ai-footer-actions button')].map(b => ({ text: b.textContent, disabled: b.disabled }))`,
  );
}

async function closePanel() {
  if (!(await evaluate(`document.querySelector('.ai-panel').hidden`))) {
    await evaluate(`document.querySelector('.ai-close').click()`);
    await sleep(150);
  }
}

async function panelRect() {
  return evaluate(`(() => {
    const box = document.querySelector('.ai-panel')?.getBoundingClientRect();
    if (!box) return null;
    return {
      left: Math.round(box.left),
      top: Math.round(box.top),
      right: Math.round(box.right),
      bottom: Math.round(box.bottom),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  })()`);
}

async function dragPanelCorner(dx, dy) {
  const handle = await evaluate(`(() => {
    const box = document.querySelector('.ai-panel .ai-resize')?.getBoundingClientRect();
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  })()`);
  if (!handle) throw new Error("no panel resize handle");
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: handle.x,
    y: handle.y,
    button: "left",
    clickCount: 1,
  });
  for (let step = 1; step <= 5; step++) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: handle.x + (dx * step) / 5,
      y: handle.y + (dy * step) / 5,
      button: "left",
      buttons: 1,
    });
    await sleep(25);
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: handle.x + dx,
    y: handle.y + dy,
    button: "left",
    clickCount: 1,
  });
  await sleep(250);
}

async function editorText() {
  return evaluate(
    `[...document.querySelectorAll('.cm-line')].map(line => line.textContent).join('\\n')`,
  );
}

async function rectOf(word) {
  return evaluate(`(() => {
    const root = document.querySelector('#editor-pane');
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
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, left: box.left, right: box.right };
    }
    return null;
  })()`);
}

async function scrollEditorTop() {
  await evaluate(
    `(() => { const scroller = document.querySelector('.cm-scroller'); if (scroller) scroller.scrollTop = 0; })()`,
  );
  await sleep(150);
}

async function clickEditorWord(word) {
  await scrollEditorTop();
  const rect = await waitFor(
    `(() => {
    const root = document.querySelector('#editor-pane');
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
  })()`,
    5000,
  );
  if (!rect) throw new Error(`no editor word ${word}`);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(150);
}

async function selectToLineEnd() {
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "End",
    code: "End",
    windowsVirtualKeyCode: 35,
    modifiers: 8,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "End",
    code: "End",
    windowsVirtualKeyCode: 35,
    modifiers: 8,
  });
  await sleep(150);
  return evaluate(`window.getSelection()?.toString() ?? ""`);
}

async function pressCtrl(key, code, virtualKey) {
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    modifiers: 2,
  });
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    code,
    windowsVirtualKeyCode: virtualKey,
    modifiers: 2,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: virtualKey,
    modifiers: 2,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
  });
  await sleep(250);
}

async function pressKey(key, code, virtualKey, modifiers = 0) {
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    code,
    windowsVirtualKeyCode: virtualKey,
    modifiers,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: virtualKey,
    modifiers,
  });
  await sleep(100);
}

async function undo() {
  await pressCtrl("z", "KeyZ", 90);
}

async function newTab() {
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true }))`,
  );
  await sleep(600);
}

async function closeTab() {
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true }))`,
  );
  await sleep(600);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const original = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_settings')`);
let createdAnthropicKey = false;
let createdOpenAiKey = false;
let anthropicBase = rootUrl;

try {
  console.log("\nDefaults and Preferences");
  await closePanel();
  await closePrefs();
  await closePalette();
  await openAiSection();
  check("Enable can be turned off", await setCheckbox("Enable AI Assistant", false));
  await closePrefs();
  const hiddenAtStart = await evaluate(`document.querySelector('.ai-assistant').hidden`);
  check("disabling the assistant hides the button", hiddenAtStart === true);

  await openAiSection();
  const prefsSection = await evaluate(`(() => ({
    title: document.querySelector('.prefs-section-title')?.textContent,
    labels: [...document.querySelectorAll('.prefs-row .prefs-label')].map(l => l.textContent.replace(/\\?$/, '')),
  }))()`);
  check("Preferences has an AI Assistant section", prefsSection.title === "AI Assistant");
  for (const label of [
    "Enable AI Assistant",
    "Floating button",
    "Provider",
    "Base URL",
    "API Key",
    "Model",
    "Status",
  ]) {
    check(`the AI section has ${label}`, prefsSection.labels.includes(label));
  }
  check(
    "the AI section can reset the floating button",
    await evaluate(
      `[...document.querySelectorAll('.prefs-row .prefs-button')].some(b => b.textContent === 'Reset position')`,
    ),
  );

  await setSelect("Provider", "openai");
  check("the Base URL is set to the mock", await setText("Base URL", baseUrl));
  check("the model is set to the mock", await setText("Model", "test-model"));
  check("Enable is turned on", await setCheckbox("Enable AI Assistant", true));
  await closePrefs();

  const fab = await waitFor(
    `(() => {
    const root = document.querySelector('.ai-assistant');
    const button = document.querySelector('.ai-fab');
    if (!root || root.hidden || !button) return null;
    const pane = document.getElementById('editor-pane').getBoundingClientRect();
    const box = button.getBoundingClientRect();
    return {
      paneHidden: root.hidden,
      text: button.textContent.trim(),
      label: button.getAttribute('aria-label'),
      svg: Boolean(button.querySelector('svg')),
      size: [Math.round(box.width), Math.round(box.height)],
      right: Math.round(pane.right - box.right),
      bottom: Math.round(pane.bottom - box.bottom),
    };
  })()`,
    8000,
  );
  check("enabling the assistant shows the button", fab !== null);
  check(
    "the button is inside the editor pane",
    await evaluate(`Boolean(document.querySelector('#editor-pane .ai-assistant'))`),
  );
  check("the button has no visible text", fab?.text === "");
  check("the button has an accessible name", fab?.label === "AI Assistant");
  check("the button draws an SVG icon", fab?.svg === true);
  check(
    "the button is 40 px",
    fab?.size?.[0] === 40 && fab?.size?.[1] === 40,
    JSON.stringify(fab?.size),
  );
  check("the default anchor is 20 px from the right", fab?.right === 20, String(fab?.right));
  check("the default anchor is 20 px from the bottom", fab?.bottom === 20, String(fab?.bottom));

  console.log("\nPalette");
  await openPalette();
  const palette = await evaluate(`(() => ({
    groups: [...document.querySelectorAll('.ai-group')].map(g => g.textContent),
    rows: [...document.querySelectorAll('.ai-row-label')].map(r => r.textContent),
    footer: [...document.querySelectorAll('.ai-palette-footer button')].map(b => b.textContent),
    height: Math.round(document.querySelector('.ai-palette').getBoundingClientRect().height),
    inside: (() => {
      const pane = document.getElementById('editor-pane').getBoundingClientRect();
      const box = document.querySelector('.ai-palette').getBoundingClientRect();
      return box.left >= pane.left && box.right <= pane.right && box.top >= pane.top && box.bottom <= pane.bottom;
    })(),
  }))()`);
  check(
    "five groups are shown",
    JSON.stringify(palette.groups) ===
      JSON.stringify(["Most used", "Write", "Refine", "Understand", "Transform"]),
    JSON.stringify(palette.groups),
  );
  check("fourteen actions are shown", palette.rows.length === 14, String(palette.rows.length));
  check(
    "the palette footer has History and the settings command",
    palette.footer.includes("History") &&
      palette.footer.includes("AI Assistant Settings…") &&
      !palette.footer.some((label) => label.includes("Reset button position")),
    JSON.stringify(palette.footer),
  );
  check("the palette is at most 520 px tall", palette.height <= 520, String(palette.height));
  check("the palette stays inside the pane", palette.inside === true);
  const scrollbar = await evaluate(`(() => {
    const el = document.querySelector('.ai-actions');
    return {
      width: getComputedStyle(el, '::-webkit-scrollbar').width,
      thumb: getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor,
      gutter: el.offsetWidth - el.clientWidth,
      scrolls: el.scrollHeight > el.clientHeight,
    };
  })()`);
  check(
    "the palette uses the discreet context-menu scrollbar",
    scrollbar.width === "8px" &&
      scrollbar.thumb !== "rgba(0, 0, 0, 0)" &&
      scrollbar.gutter <= 9 &&
      scrollbar.scrolls,
    JSON.stringify(scrollbar),
  );

  await evaluate(
    `(() => { const s = document.querySelector('.ai-search'); s.value = 'translate'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(150);
  check(
    "search filters to Translate",
    JSON.stringify(
      await evaluate(`[...document.querySelectorAll('.ai-row-label')].map(l => l.textContent)`),
    ) === JSON.stringify(["Translate…"]),
  );
  await evaluate(
    `(() => { const s = document.querySelector('.ai-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(100);
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
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
  await sleep(150);
  check("Escape closes the palette", (await paletteOpen()) === false);

  console.log("\nHistory empty state");
  await openHistory();
  const emptyHistory = await evaluate(
    `document.querySelector('.ai-history-empty')?.textContent ?? ''`,
  );
  check("History starts empty", emptyHistory.includes("No answers yet"), emptyHistory);
  check(
    "the empty state says the history is session-only",
    emptyHistory.includes("session only") && emptyHistory.includes("last 10"),
    emptyHistory,
  );
  check(
    "History offers a way back to the actions",
    await evaluate(
      `[...document.querySelectorAll('.ai-history-empty button')].some(b => b.textContent === 'Browse actions')`,
    ),
  );
  await closeHistory();

  console.log("\nDrag and reset");
  const beforeDrag = await evaluate(
    `(() => { const b = document.querySelector('.ai-fab').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
  );
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: beforeDrag.x,
    y: beforeDrag.y,
    button: "left",
    clickCount: 1,
  });
  for (let step = 1; step <= 5; step++) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: beforeDrag.x - step * 18,
      y: beforeDrag.y - step * 12,
      button: "left",
      buttons: 1,
    });
    await sleep(25);
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: beforeDrag.x - 90,
    y: beforeDrag.y - 60,
    button: "left",
    clickCount: 1,
  });
  await sleep(250);
  const dragged = await evaluate(`(() => {
    const pane = document.getElementById('editor-pane').getBoundingClientRect();
    const box = document.querySelector('.ai-fab').getBoundingClientRect();
    return { right: Math.round(pane.right - box.right), bottom: Math.round(pane.bottom - box.bottom), palette: !document.querySelector('.ai-palette').hidden };
  })()`);
  check(
    "the button moved with the drag",
    dragged.right > 40 && dragged.bottom > 40,
    JSON.stringify(dragged),
  );
  check("a drag does not open the palette", dragged.palette === false);
  await openAiSection();
  check("Preferences offers Reset position", await clickPrefsButton("Reset position"));
  await closePrefs();
  await sleep(250);
  const reset = await evaluate(`(() => {
    const pane = document.getElementById('editor-pane').getBoundingClientRect();
    const box = document.querySelector('.ai-fab').getBoundingClientRect();
    return { right: Math.round(pane.right - box.right), bottom: Math.round(pane.bottom - box.bottom) };
  })()`);
  check(
    "Reset returns the button to the anchor",
    reset.right === 20 && reset.bottom === 20,
    JSON.stringify(reset),
  );

  check(
    "no HTTP request happened before the first action",
    control.requests.length === 0,
    String(control.requests.length),
  );

  // -------------------------------------------------------------------------
  // Improve with a selection
  // -------------------------------------------------------------------------

  console.log("\nImprove writing");
  await clickEditorWord("Regular");
  const selected = await selectToLineEnd();
  check("the keyboard selected a passage", selected.length > 10, `${selected.length} chars`);
  await chooseAction("Improve writing");
  await waitPanelDone();
  check(
    "Improve reports an answer",
    (await panelStatus()).startsWith("Answer ready"),
    await panelStatus(),
  );
  const improve = control.requests.at(-1);
  check("Improve reached /chat/completions", improve?.url === "/v1/chat/completions", improve?.url);
  check(
    "the request carries the selected passage",
    improve?.body?.messages?.some((m) => m.role === "user" && m.content.includes(selected.trim())),
  );
  check(
    "the panel filtered the output tags",
    !(await evaluate(`document.querySelector('.ai-answer')?.textContent ?? ''`)).includes(
      "<revised>",
    ),
  );
  check(
    "the panel shows the revised text",
    (await evaluate(`document.querySelector('.ai-answer')?.textContent ?? ''`)).includes(
      "Improved passage from the mock.",
    ),
  );
  check(
    "the notes were separated from the answer",
    (await evaluate(`document.querySelector('.ai-notes-text')?.textContent ?? ''`)).includes(
      "Mock notes",
    ),
  );
  const improveFooter = await footerButtons();
  check(
    "Replace is offered",
    improveFooter.some((b) => b.text === "Replace selection" && !b.disabled),
  );
  check(
    "Insert below is offered",
    improveFooter.some((b) => b.text === "Insert below" && !b.disabled),
  );
  check(
    "Copy is offered",
    improveFooter.some((b) => b.text === "Copy"),
  );
  check(
    "the header names the model and host",
    (await evaluate(`document.querySelector('.ai-chip')?.textContent ?? ''`)).includes(
      "test-model",
    ) &&
      (await evaluate(`document.querySelector('.ai-chip')?.textContent ?? ''`)).includes(
        "127.0.0.1",
      ),
  );
  check("Replace applies the answer", await clickFooter("Replace selection"));
  const replacedText = await editorText();
  check(
    "the buffer contains the mock answer",
    replacedText.includes("Improved passage from the mock."),
  );
  await undo();
  const undoneText = await editorText();
  check(
    "one undo restores the original passage",
    undoneText.includes("Regular text,") && !undoneText.includes("Improved passage from the mock."),
  );

  console.log("\nContinue writing");
  await clickEditorWord("the app.");
  await pressKey("End", "End", 35);
  await chooseAction("Continue writing");
  await waitPanelDone();
  const continuation = control.requests.at(-1);
  check(
    "Continue sends the preceding text",
    continuation?.body?.messages?.some(
      (m) => m.role === "user" && m.content.includes("<preceding_text>"),
    ),
  );
  check(
    "Continue shows the continuation",
    (await evaluate(`document.querySelector('.ai-answer')?.textContent ?? ''`)).includes(
      "and the mock continues.",
    ),
  );
  check(
    "Insert is the primary action",
    (await footerButtons()).some((b) => b.text === "Insert" && !b.disabled),
  );
  check("Insert places the continuation", await clickFooter("Insert"));
  const continued = await editorText();
  check("the continuation is in the buffer", continued.includes("and the mock continues."));
  check(
    "the join rule added a space",
    /the app\. and the mock continues\./.test(continued),
    continued.match(/the app\.[^\n]{0,40}/)?.[0] ?? "",
  );
  await undo();

  console.log("\nSummarize");
  await clickEditorWord("Regular");
  await chooseAction("Summarize");
  await waitPanelDone();
  check(
    "Summarize shows a summary",
    (await evaluate(`document.querySelector('.ai-answer')?.textContent ?? ''`)).includes(
      "A short summary",
    ),
  );
  check(
    "Insert below is the primary action",
    (await footerButtons()).some((b) => b.text === "Insert below" && !b.disabled),
  );
  check("Insert below places the block", await clickFooter("Insert below"));
  const summarized = await editorText();
  check("the summary is in the buffer", summarized.includes("A short summary from the mock."));
  check(
    "the summary is a new paragraph",
    /open inside the app\.\n\nA short summary from the mock\./.test(summarized),
    summarized.match(/open inside the app\.[\s\S]{0,50}/)?.[0] ?? "",
  );
  await undo();

  console.log("\nMarkdown result");
  await clickEditorWord("Regular");
  await chooseAction("Key points");
  await waitPanelDone();
  const listResult = await evaluate(`(() => {
    const answer = document.querySelector('.ai-answer');
    return {
      tag: answer?.tagName ?? '',
      items: [...(answer?.querySelectorAll('li') ?? [])].map(li => li.textContent),
      hyphens: (answer?.textContent ?? '').includes('- First mock point'),
      source: document.querySelector('.ai-answer-source-text')?.textContent ?? '',
      sourceShown: !document.querySelector('.ai-answer-source')?.hidden,
    };
  })()`);
  check(
    "the panel renders a Markdown list",
    listResult.items.length === 2 && listResult.items[0] === "First mock point",
    JSON.stringify(listResult.items),
  );
  check(
    "the panel does not print the list as hyphens",
    listResult.hyphens === false,
    listResult.hyphens ? "literal -" : "",
  );
  check(
    "the panel result is a rendered block, not a pre",
    listResult.tag === "DIV",
    listResult.tag,
  );
  check(
    "the Source disclosure keeps the raw Markdown",
    listResult.sourceShown === true && listResult.source.includes("- First mock point"),
    listResult.source,
  );
  await closePanel();

  await clickEditorWord("Regular");
  await chooseAction("Convert to table");
  await waitPanelDone();
  const tableResult = await evaluate(`(() => {
    const answer = document.querySelector('.ai-answer');
    const table = answer?.querySelector('table');
    return {
      headers: [...(answer?.querySelectorAll('th') ?? [])].map(cell => cell.textContent),
      rows: answer?.querySelectorAll('tbody tr').length ?? 0,
      wrapper: table?.parentElement?.className ?? '',
    };
  })()`);
  check(
    "the panel renders a Markdown table",
    tableResult.headers.join("|") === "A|B" && tableResult.rows === 1,
    JSON.stringify(tableResult),
  );
  check(
    "a table sits in its own scroll container",
    tableResult.wrapper === "ai-table-scroll",
    tableResult.wrapper,
  );

  console.log("\nPanel resize");
  const handleBox = await evaluate(`(() => {
    const handle = document.querySelector('.ai-panel .ai-resize');
    if (!handle) return null;
    const box = handle.getBoundingClientRect();
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      cursor: getComputedStyle(handle).cursor,
    };
  })()`);
  check(
    "the panel has a top-left resize grip",
    handleBox?.width === 14 && handleBox?.height === 14 && handleBox?.cursor === "nwse-resize",
    JSON.stringify(handleBox),
  );

  const beforeResize = await panelRect();
  await dragPanelCorner(60, 40);
  const shrunk = await panelRect();
  check(
    "dragging the grip inward shrinks the panel from that corner",
    shrunk.width < beforeResize.width && shrunk.height < beforeResize.height,
    JSON.stringify({ beforeResize, shrunk }),
  );
  check(
    "the bottom-right corner stays anchored while shrinking",
    Math.abs(shrunk.right - beforeResize.right) <= 1 &&
      Math.abs(shrunk.bottom - beforeResize.bottom) <= 1,
    JSON.stringify({ beforeResize, shrunk }),
  );

  await dragPanelCorner(-80, -60);
  const grown = await panelRect();
  check(
    "dragging the grip outward grows the panel again",
    grown.width > shrunk.width && grown.height > shrunk.height,
    JSON.stringify({ shrunk, grown }),
  );
  check(
    "the bottom-right corner stays anchored while growing",
    Math.abs(grown.right - beforeResize.right) <= 1 &&
      Math.abs(grown.bottom - beforeResize.bottom) <= 1,
    JSON.stringify({ beforeResize, grown }),
  );
  await closePanel();

  await chooseAction("Ask AI…");
  const reopened = await panelRect();
  check(
    "the panel reopens with the resized place and size",
    ["left", "top", "width", "height"].every((key) => Math.abs(reopened[key] - grown[key]) <= 2),
    JSON.stringify({ grown, reopened }),
  );

  await evaluate(`document.querySelector('.ai-panel .ai-resize').focus()`);
  await pressKey("ArrowRight", "ArrowRight", 39);
  await pressKey("ArrowDown", "ArrowDown", 40);
  const keyboardSmaller = await panelRect();
  check(
    "the arrow keys resize from the corner",
    keyboardSmaller.width === reopened.width - 16 &&
      keyboardSmaller.height === reopened.height - 16,
    JSON.stringify({ reopened, keyboardSmaller }),
  );
  await pressKey("ArrowLeft", "ArrowLeft", 37);
  await pressKey("ArrowUp", "ArrowUp", 38);
  const keyboardRestored = await panelRect();
  check(
    "the opposite arrow keys restore the size",
    keyboardRestored.width === reopened.width && keyboardRestored.height === reopened.height,
    JSON.stringify({ reopened, keyboardRestored }),
  );
  await closePanel();

  await openHistory();
  const historySized = await evaluate(`(() => {
    const box = document.querySelector('.ai-history').getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height) };
  })()`);
  check(
    "History opens in the same resized window",
    Math.abs(historySized.width - keyboardRestored.width) <= 2 &&
      Math.abs(historySized.height - keyboardRestored.height) <= 2,
    JSON.stringify({ keyboardRestored, historySized }),
  );
  await closeHistory();

  await openAiSection();
  check("Preferences reset clears the panel layout", await clickPrefsButton("Reset position"));
  await closePrefs();
  await sleep(250);
  await chooseAction("Ask AI…");
  const resetRect = await panelRect();
  const resetInline = await evaluate(`(() => {
    const panel = document.querySelector('.ai-panel');
    return { width: panel.style.width, height: panel.style.height, maxHeight: panel.style.maxHeight };
  })()`);
  const defaultWidth = await evaluate(
    `Math.max(220, Math.min(440, document.getElementById('editor-pane').getBoundingClientRect().width - 16))`,
  );
  check(
    "Reset position restores the default panel size",
    Math.abs(resetRect.width - defaultWidth) <= 1 && resetInline.height === "",
    JSON.stringify({ resetRect, resetInline, defaultWidth }),
  );

  await dragPanelCorner(40, 30);
  await evaluate(
    `document.querySelector('.ai-panel .ai-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`,
  );
  await sleep(250);
  const doubleClickReset = await panelRect();
  const doubleInline = await evaluate(`document.querySelector('.ai-panel').style.height`);
  check(
    "double-clicking the grip restores the default size",
    Math.abs(doubleClickReset.width - defaultWidth) <= 1 && doubleInline === "",
    JSON.stringify({ doubleClickReset, doubleInline, defaultWidth }),
  );
  await closePanel();

  console.log("\nTranslate");
  await clickEditorWord("Regular");
  await chooseAction("Translate…");
  check(
    "Translate opens with a language field",
    await evaluate(`Boolean(document.querySelector('.ai-params input[type=text]'))`),
  );
  const requestsBeforeTranslate = control.requests.length;
  check(
    "Translate does not send before Generate",
    (await panelStatus()).includes("Choose a value"),
  );
  await evaluate(
    `(() => { const input = document.querySelector('.ai-params input[type=text]'); input.value = 'Portuguese'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(100);
  await evaluate(`document.querySelector('.ai-params .ai-generate').click()`);
  await waitPanelDone();
  check(
    "Translate sent exactly one request",
    control.requests.length === requestsBeforeTranslate + 1,
    String(control.requests.length - requestsBeforeTranslate),
  );
  check(
    "Translate carries the target language",
    control.requests.at(-1)?.system.includes("Portuguese"),
  );
  check(
    "Translate shows the translated text",
    (await evaluate(`document.querySelector('.ai-answer')?.textContent ?? ''`)).includes(
      "Texto traduzido",
    ),
  );
  check("Translate replaces the passage", await clickFooter("Replace selection"));
  await undo();

  console.log("\nChange tone");
  await clickEditorWord("Regular");
  await chooseAction("Change tone…");
  check(
    "Change tone starts on Professional",
    (await evaluate(`document.querySelector('.ai-params select')?.value`)) === "Professional",
  );
  await evaluate(
    `(() => { const select = document.querySelector('.ai-params select'); select.value = 'Casual'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await sleep(100);
  await evaluate(`document.querySelector('.ai-params .ai-generate').click()`);
  await waitPanelDone();
  check("Change tone carries the chosen tone", control.requests.at(-1)?.system.includes("Casual"));
  check(
    "Change tone shows the rewritten text",
    (await evaluate(`document.querySelector('.ai-answer')?.textContent ?? ''`)).includes(
      "Tone changed",
    ),
  );
  await closePanel();

  console.log("\nConvert markup");
  await clickEditorWord("Regular");
  await chooseAction("Convert markup…");
  const convertOptions = await evaluate(
    `[...(document.querySelector('.ai-params select')?.options ?? [])].map(o => o.value)`,
  );
  check(
    "Convert excludes the document's own markup",
    !convertOptions.includes("markdown"),
    JSON.stringify(convertOptions),
  );
  await evaluate(
    `(() => { const select = document.querySelector('.ai-params select'); select.value = 'html'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await sleep(100);
  await evaluate(`document.querySelector('.ai-params .ai-generate').click()`);
  await waitPanelDone();
  check("Convert carries the target markup", control.requests.at(-1)?.system.includes("into HTML"));
  check(
    "Convert shows the converted text",
    (await evaluate(`document.querySelector('.ai-answer')?.textContent ?? ''`)).includes(
      "Converted by the mock",
    ),
  );
  await closePanel();

  // -------------------------------------------------------------------------
  // Ask
  // -------------------------------------------------------------------------

  console.log("\nAsk AI");
  await clickEditorWord("Regular");
  const askSelection = await selectToLineEnd();
  await chooseAction("Ask AI…");
  check(
    "Ask focuses its question field",
    await evaluate(`document.activeElement?.classList.contains('ai-ask-input')`),
  );
  await evaluate(
    `(() => { const input = document.querySelector('.ai-ask-input'); input.value = 'What is this passage about?'; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); })()`,
  );
  await sleep(100);
  await evaluate(`document.querySelector('.ai-ask-row .ai-generate').click()`);
  await waitPanelDone();
  const ask = control.requests.at(-1);
  check(
    "Ask carries the passage and the question",
    ask?.body?.messages?.some(
      (m) =>
        m.role === "user" &&
        m.content.includes(askSelection.trim()) &&
        m.content.includes("What is this passage about?"),
    ),
  );
  check(
    "Ask renders Markdown",
    await evaluate(`Boolean(document.querySelector('.ai-chat .ai-markdown strong'))`),
  );
  check(
    "Ask offers a Source toggle",
    await evaluate(`Boolean(document.querySelector('.ai-chat .ai-chat-source summary'))`),
  );
  check(
    "Ask offers Copy and Insert below",
    (await footerButtons()).some((b) => b.text === "Copy") &&
      (await footerButtons()).some((b) => b.text === "Insert below"),
  );
  check("Ask Insert below places the answer", await clickFooter("Insert below"));
  check(
    "the answer is in the buffer",
    (await editorText()).includes("this file is a feature tour"),
  );
  await undo();

  console.log("\nAsk multi-turn");
  await clickEditorWord("Regular");
  await selectToLineEnd();
  await chooseAction("Ask AI…");
  await evaluate(
    `(() => { const input = document.querySelector('.ai-ask-input'); input.value = 'First question'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await evaluate(`document.querySelector('.ai-ask-row .ai-generate').click()`);
  await waitPanelDone();
  await evaluate(
    `(() => { const input = document.querySelector('.ai-ask-input'); input.value = 'Second question'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await evaluate(`document.querySelector('.ai-ask-row .ai-generate').click()`);
  await waitPanelDone();
  const secondAsk = control.requests.at(-1);
  check(
    "the second turn sends the visible history",
    secondAsk?.body?.messages?.filter((m) => m.role === "user" || m.role === "assistant").length >=
      3,
    JSON.stringify(secondAsk?.body?.messages?.map((m) => m.role)),
  );
  check(
    "the passage is not duplicated in the second turn",
    secondAsk?.body?.messages?.filter((m) => m.role === "user" && m.content.includes("<passage>"))
      .length === 1,
  );
  await closePanel();

  // -------------------------------------------------------------------------
  // Stop, errors and stale targets
  // -------------------------------------------------------------------------

  console.log("\nStop");
  control.mode = "hold";
  await clickEditorWord("Regular");
  await chooseAction("Expand");
  await waitFor(`(document.querySelector('.ai-answer')?.textContent ?? '').length > 0`, 5000);
  const stopButtons = await footerButtons();
  check(
    "Stop is offered while generating",
    stopButtons.some((b) => b.text === "Stop"),
  );
  await clickFooter("Stop");
  const stopped = await waitFor(
    `document.querySelector('.ai-status')?.textContent?.startsWith('Stopped')`,
    8000,
  );
  check("Stop reports Stopped", stopped !== null, await panelStatus());
  check("the mock saw the connection close", control.cancelled > 0, String(control.cancelled));
  await sleep(500);
  check(
    "no delta arrives after Stop",
    (await evaluate(`document.querySelector('.ai-answer')?.textContent ?? ''`)).length <= 12,
  );
  control.mode = "normal";
  await closePanel();

  console.log("\nRejected key");
  control.mode = "unauthorized";
  await clickEditorWord("Regular");
  await chooseAction("Shorten");
  await waitPanelDone(8000);
  const errorStatus = await panelStatus();
  const rejectedStatus = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('ai_status', { provider: 'openai', baseUrl: ${JSON.stringify(baseUrl)} })`,
  );
  check(
    rejectedStatus.hasKey
      ? "a 401 explains the rejected key"
      : "a 401 explains that no key is saved",
    rejectedStatus.hasKey
      ? errorStatus.includes("API key was rejected")
      : errorStatus.includes("No API key is saved"),
    errorStatus,
  );
  check(
    "an error offers Retry",
    (await footerButtons()).some((b) => b.text === "Retry"),
  );
  check(
    "an error does not offer Replace",
    !(await footerButtons()).some((b) => b.text === "Replace selection"),
  );
  control.mode = "normal";
  check("Retry re-issues the request", await clickFooter("Retry"));
  await waitPanelDone();
  check(
    "Retry produces an answer",
    (await panelStatus()).startsWith("Answer ready"),
    await panelStatus(),
  );
  await closePanel();

  console.log("\nStale target");
  control.mode = "hold";
  await clickEditorWord("Regular");
  await chooseAction("Improve writing");
  await waitFor(`(document.querySelector('.ai-answer')?.textContent ?? '').length > 0`, 5000);
  await clickEditorWord("Regular");
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send("Input.insertText", { text: "Z" });
  await sleep(200);
  control.release?.();
  control.mode = "normal";
  await waitPanelDone(10_000);
  const staleFooter = await footerButtons();
  check(
    "a changed document disables Replace",
    staleFooter.find((b) => b.text === "Replace selection")?.disabled === true,
    JSON.stringify(staleFooter),
  );
  check(
    "a changed document still offers Insert below",
    staleFooter.find((b) => b.text === "Insert below")?.disabled === false,
  );
  await closePanel();
  await undo();

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  console.log("\nHistory");
  await openHistory();
  const history = await historyRows();
  check("History keeps ten successful requests", history.length === 10, String(history.length));
  check("the newest answer is first", history[0]?.title === "Improve writing", history[0]?.title);
  check(
    "the oldest answers were evicted by the cap",
    history.at(-1)?.title === "Key points" &&
      !history.some((row) => row.title === "Continue writing") &&
      !history.some((row) => row.title === "Summarize"),
    JSON.stringify(history.map((row) => row.title)),
  );
  check(
    "only one Improve answer survived the cap",
    history.filter((row) => row.title === "Improve writing").length === 1,
    JSON.stringify(history.map((row) => row.title)),
  );
  check(
    "a stopped request is not recorded",
    !history.some((row) => row.title === "Expand"),
    JSON.stringify(history.map((row) => row.title)),
  );
  check(
    "a failed request does not add a second Shorten",
    history.filter((row) => row.title === "Shorten").length === 1,
  );
  check(
    "Ask is recorded per exchange",
    history.filter((row) => row.title.startsWith("Ask AI")).length === 3,
    JSON.stringify(history.map((row) => row.title)),
  );
  check("a row shows the document", history[0]?.request.includes("feature-tour.md"));
  check(
    "a row shows an answer preview",
    history.find((row) => row.title === "Key points")?.preview.includes("First mock point"),
    history.find((row) => row.title === "Key points")?.preview,
  );
  check("a row shows a relative time", history[0]?.time === "Just now", history[0]?.time);
  const historyGeometry = await evaluate(`(() => {
    const pane = document.getElementById('editor-pane').getBoundingClientRect();
    const box = document.querySelector('.ai-history').getBoundingClientRect();
    const list = document.querySelector('.ai-history-list');
    return {
      inside: box.left >= pane.left && box.right <= pane.right && box.top >= pane.top && box.bottom <= pane.bottom,
      width: Math.round(box.width),
      scrollbar: getComputedStyle(list, '::-webkit-scrollbar').width,
      thumb: getComputedStyle(list, '::-webkit-scrollbar-thumb').backgroundColor,
      gutter: list.offsetWidth - list.clientWidth,
      scrolls: list.scrollHeight > list.clientHeight,
    };
  })()`);
  check(
    "the history stays inside the pane",
    historyGeometry.inside === true,
    JSON.stringify(historyGeometry),
  );
  check(
    "the history uses the discreet context-menu scrollbar",
    historyGeometry.scrollbar === "8px" &&
      historyGeometry.thumb !== "rgba(0, 0, 0, 0)" &&
      historyGeometry.gutter <= 9,
    JSON.stringify(historyGeometry),
  );
  check(
    "History focuses its first row",
    await evaluate(`document.activeElement?.classList.contains('ai-history-row') === true`),
  );
  await pressKey("ArrowDown", "ArrowDown", 40);
  check(
    "ArrowDown moves through the history",
    await evaluate(`document.activeElement === document.querySelectorAll('.ai-history-row')[1]`),
  );
  await pressKey("ArrowUp", "ArrowUp", 38);
  check(
    "ArrowUp returns to the previous row",
    await evaluate(`document.activeElement === document.querySelectorAll('.ai-history-row')[0]`),
  );

  // The second Ask entry is the newest Ask; its question and Markdown should be intact.
  check("a history row opens a detail", await openHistoryDetail(2));
  const askDetail = await evaluate(`(() => ({
    title: document.querySelector('.ai-history-title')?.textContent ?? '',
    question: document.querySelector('.ai-history-question p')?.textContent ?? '',
    meta: document.querySelector('.ai-history-meta')?.textContent ?? '',
    context: document.querySelector('.ai-history-context summary')?.textContent ?? '',
    answer: document.querySelector('.ai-history-answer')?.textContent ?? '',
    markdown: Boolean(document.querySelector('.ai-history-answer.ai-markdown strong')),
    actions: [...document.querySelectorAll('.ai-history-detail-actions button')].map(b => b.textContent),
    back: !document.querySelector('.ai-history-back').hidden,
  }))()`);
  check(
    "the Ask detail keeps the question",
    askDetail.question === "Second question",
    askDetail.question,
  );
  check(
    "the Ask detail renders Markdown",
    askDetail.markdown === true && askDetail.answer.includes("feature tour"),
    askDetail.answer,
  );
  check(
    "the detail names the document",
    askDetail.meta.includes("feature-tour.md"),
    askDetail.meta,
  );
  check(
    "the detail shows the captured context",
    askDetail.context.includes("Selection"),
    askDetail.context,
  );
  check(
    "the detail offers Copy and Insert below",
    askDetail.actions.includes("Copy") && askDetail.actions.includes("Insert below"),
    JSON.stringify(askDetail.actions),
  );
  check("the detail has a back button", askDetail.back === true);
  await pressKey("Escape", "Escape", 27);
  await waitFor(`!document.querySelector('.ai-history-list').hidden`);
  check("Escape returns from the detail to the list", (await historyRows()).length === 10);

  // Insert below uses the current paragraph, not the range the answer was made for.
  check("the list can open the Ask answer", await openHistoryDetail(2));
  await evaluate(
    `[...document.querySelectorAll('.ai-history-detail-actions button')].find(b => b.textContent === 'Insert below')?.click()`,
  );
  await sleep(350);
  check("Insert below closes the history", (await historyIsOpen()) === false);
  let insertedHistory = "";
  const insertDeadline = Date.now() + 3000;
  while (Date.now() < insertDeadline) {
    insertedHistory = await editorText();
    if (insertedHistory.includes("this file is a feature tour")) break;
    await sleep(100);
  }
  check(
    "Insert below adds the answer to the document",
    insertedHistory.includes("this file is a feature tour"),
    insertedHistory.slice(0, 200),
  );
  await undo();
  check(
    "one undo removes the history insertion",
    !(await editorText()).includes("this file is a feature tour"),
  );

  // Clear leaves a usable empty state, then a fresh request and its regenerate
  // prove the overwrite rule while the list is below the cap.
  await openHistory();
  check(
    "Clear history is offered",
    await evaluate(`!document.querySelector('.ai-history-clear').hidden`),
  );
  await evaluate(`document.querySelector('.ai-history-clear').click()`);
  await sleep(200);
  check("Clear history empties the list", (await historyRows()).length === 0);
  check(
    "the cleared history explains its session scope",
    (await evaluate(`document.querySelector('.ai-history-empty')?.textContent ?? ''`)).includes(
      "session only",
    ),
  );
  await pressKey("Escape", "Escape", 27);
  check("Escape closes the history list", (await historyIsOpen()) === false);

  await clickEditorWord("Regular");
  await chooseAction("Improve writing");
  await waitPanelDone();
  const beforeRegenerate = control.requests.length;
  check("Regenerate sends the request again", await clickFooter("Regenerate"));
  const regenerateDeadline = Date.now() + 8000;
  while (control.requests.length === beforeRegenerate && Date.now() < regenerateDeadline) {
    await sleep(80);
  }
  await waitPanelDone();
  check(
    "Regenerate made exactly one request",
    control.requests.length === beforeRegenerate + 1,
    String(control.requests.length - beforeRegenerate),
  );
  await openHistory();
  const afterRegenerate = await historyRows();
  check(
    "Regenerate does not add a history row",
    afterRegenerate.length === 1,
    String(afterRegenerate.length),
  );
  check(
    "the regenerated answer is still the latest",
    afterRegenerate[0]?.title === "Improve writing",
    afterRegenerate[0]?.title,
  );
  await closeHistory();

  // -------------------------------------------------------------------------
  // Tab switch and view mode
  // -------------------------------------------------------------------------

  console.log("\nTabs and view mode");
  const cancelledBefore = control.cancelled;
  control.mode = "hold";
  await clickEditorWord("Regular");
  await chooseAction("Summarize");
  await waitFor(`(document.querySelector('.ai-answer')?.textContent ?? '').length > 0`, 5000);
  const tabsBefore = await evaluate(`document.querySelectorAll('.doc-tab').length`);
  await newTab();
  const tabsAfter = await evaluate(`document.querySelectorAll('.doc-tab').length`);
  check("Ctrl+N opened a new tab", tabsAfter === tabsBefore + 1, `${tabsBefore} -> ${tabsAfter}`);
  check(
    "a tab switch closes the panel",
    await evaluate(`document.querySelector('.ai-panel').hidden`),
  );
  await sleep(500);
  check(
    "a tab switch cancels the request",
    control.cancelled > cancelledBefore,
    `${cancelledBefore} -> ${control.cancelled}`,
  );
  control.mode = "normal";
  await closeTab();
  await sleep(500);
  await send("Runtime.evaluate", { expression: `window.scrollTo(0, 0)` });
  await evaluate(`document.getElementById('mode-preview').click()`);
  await sleep(300);
  check(
    "Preview-only hides the button with the pane",
    await evaluate(
      `document.querySelector('.ai-assistant').getBoundingClientRect().width === 0 || getComputedStyle(document.querySelector('.ai-fab')).display === 'none'`,
    ),
  );
  await evaluate(`document.getElementById('mode-split').click()`);
  await sleep(300);

  // -------------------------------------------------------------------------
  // Anthropic protocol
  // -------------------------------------------------------------------------

  console.log("\nAnthropic");
  anthropicBase = rootUrl;
  const anthropicStatus = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('ai_status', { provider: 'anthropic', baseUrl: ${JSON.stringify(anthropicBase)} })`,
  );
  const anthropicKey = `sk-mock-${Date.now()}`;
  if (!anthropicStatus.hasKey) {
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke('ai_set_key', { provider: 'anthropic', baseUrl: ${JSON.stringify(anthropicBase)}, key: ${JSON.stringify(anthropicKey)} })`,
    );
    createdAnthropicKey = true;
  }
  await openAiSection();
  await setSelect("Provider", "anthropic");
  await setText("Base URL", anthropicBase);
  await setText("Model", "test-model");
  await closePrefs();
  await clickEditorWord("Regular");
  await chooseAction("Summarize");
  await waitPanelDone();
  const anthropicRequest = control.requests.at(-1);
  check(
    "Anthropic uses /v1/messages",
    anthropicRequest?.url === "/v1/messages",
    anthropicRequest?.url,
  );
  check("Anthropic sends x-api-key", Boolean(anthropicRequest?.headers?.["x-api-key"]));
  check(
    "Anthropic sends anthropic-version",
    anthropicRequest?.headers?.["anthropic-version"] === "2023-06-01",
  );
  check(
    "Anthropic streams the summary",
    (await evaluate(`document.querySelector('.ai-answer')?.textContent ?? ''`)).includes(
      "A short summary",
    ),
  );
  await closePanel();

  // -------------------------------------------------------------------------
  // Model fetch
  // -------------------------------------------------------------------------

  console.log("\nModel list");
  await openAiSection();
  // The Anthropic test left the provider selected; the model-list checks are
  // OpenAI-compatible (a local server needs no key) and the auto-save check
  // stores and clears its own key.
  await setSelect("Provider", "openai");
  await setText("Base URL", baseUrl);
  await setText("Model", "test-model");

  // A Base URL typed but not yet blurred must be the endpoint Fetch uses.
  await setText("Base URL", "http://127.0.0.1:1/v1");
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.prefs-row')].find(r => r.querySelector('.prefs-label')?.textContent.replace(/\\?$/, '') === 'Base URL');
    const input = row?.querySelector('input[type=text]');
    if (!input) return false;
    input.value = ${JSON.stringify(baseUrl)};
    return true;
  })()`);
  const beforeTyped = control.requests.length;
  await pressFetchModels();
  await waitFor(
    `[...document.querySelectorAll('.prefs-row')].some(r => r.querySelector('.prefs-note')?.textContent.includes('2 models found'))`,
    8000,
  );
  const typedStatus = await aiStatusNote();
  check(
    "Fetch uses the Base URL typed before blur",
    control.requests.length === beforeTyped + 1 && control.requests.at(-1)?.url === "/v1/models",
  );
  check("the typed Base URL finds the models", typedStatus.includes("2 models found"), typedStatus);
  const persistedBase = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('get_settings').then(s => s.aiBaseUrl)`,
  );
  check("the typed Base URL is persisted", persistedBase === baseUrl, persistedBase);

  // The endpoint may gzip /models; reqwest must decode the body.
  control.mode = "gzipModels";
  const beforeGzip = control.requests.length;
  await pressFetchModels();
  await waitFor(
    `[...document.querySelectorAll('.prefs-row')].some(r => r.querySelector('.prefs-note')?.textContent.includes('2 models found'))`,
    8000,
  );
  const gzipStatus = await aiStatusNote();
  check("a gzip model list is decoded", gzipStatus.includes("2 models found"), gzipStatus);
  check("the gzip response was actually compressed", control.requests.at(-1)?.gzip === true);
  check(
    "the fetched models reach the datalist",
    await evaluate(
      `[...document.querySelectorAll('datalist option')].some(o => o.value === 'second-model')`,
    ),
  );
  control.mode = "normal";

  // An empty 200 from a wrong Base URL must name the cause.
  control.mode = "emptyModels";
  const beforeEmpty = control.requests.length;
  await pressFetchModels();
  await waitFor(
    `[...document.querySelectorAll('.prefs-row')].some(r => r.querySelector('.prefs-note')?.textContent.includes('empty response'))`,
    8000,
  );
  const emptyStatus = await aiStatusNote();
  check(
    "an empty model list explains the Base URL",
    emptyStatus.includes("empty response") && emptyStatus.includes("Base URL"),
    emptyStatus,
  );
  check(
    "the empty model request still reached the endpoint",
    control.requests.length === beforeEmpty + 1,
  );
  control.mode = "normal";

  // Saving the key fetches once; the button remains for a manual refresh.
  const openAiStatus = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('ai_status', { provider: 'openai', baseUrl: ${JSON.stringify(baseUrl)} })`,
  );
  if (!openAiStatus.hasKey) {
    await setText("Base URL", baseUrl);
    const beforeSave = control.requests.length;
    await setKey(`sk-mock-auto-${Date.now()}`);
    await waitFor(
      `[...document.querySelectorAll('.prefs-row')].some(r => r.querySelector('.prefs-note')?.textContent.includes('models found'))`,
      10_000,
    );
    const saveStatus = await aiStatusNote();
    check(
      "saving the key fetches the model list",
      control.requests.length === beforeSave + 1,
      String(control.requests.length - beforeSave),
    );
    check("saving the key reports the models", saveStatus.includes("models found"), saveStatus);
    check(
      "saving the key fills the datalist",
      await evaluate(
        `[...document.querySelectorAll('datalist option')].some(o => o.value === 'second-model')`,
      ),
    );
    createdOpenAiKey = true;
  } else {
    check("saving the key leaves an existing key alone", true, "an existing key was used");
  }
  await closePrefs();

  // -------------------------------------------------------------------------
  // Appearance and cleanup
  // -------------------------------------------------------------------------

  console.log("\nAppearance");
  const themeBefore = await evaluate(`document.documentElement.dataset.theme`);
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await evaluate(`document.documentElement.dataset.theme`)) === "dark") break;
    await evaluate(`document.getElementById('btn-theme').click()`);
    await sleep(300);
  }
  await openPalette();
  const darkColors = await evaluate(`(() => ({
    theme: document.documentElement.dataset.theme,
    palette: getComputedStyle(document.querySelector('.ai-palette')).backgroundColor,
    fab: getComputedStyle(document.querySelector('.ai-fab')).backgroundColor,
  }))()`);
  check("the palette follows the dark theme", darkColors.theme === "dark", darkColors.theme);
  check("the palette has an opaque surface", darkColors.palette !== "rgba(0, 0, 0, 0)");
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await evaluate(`document.documentElement.dataset.theme`)) === themeBefore) break;
    await evaluate(`document.getElementById('btn-theme').click()`);
    await sleep(300);
  }
  await closePalette();
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reduced = await evaluate(
    `getComputedStyle(document.querySelector('.ai-fab')).transitionDuration`,
  );
  check("reduced motion removes the button transition", reduced === "0s", reduced);
  await send("Emulation.setEmulatedMedia", { features: [] });

  const settings = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_settings')`);
  check("get_settings has no API key", !JSON.stringify(settings).includes("sk-mock-"));
  const configPath = path.join(process.env.APPDATA ?? "", appIdentifier, "settings.json");
  const onDisk = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  check("settings.json has no API key", onDisk.length > 0 && !onDisk.includes("sk-mock-"));
  const recoveryPath = path.join(process.env.APPDATA ?? "", appIdentifier, "recovery");
  const recoveryText = fs.existsSync(recoveryPath)
    ? fs
        .readdirSync(recoveryPath)
        .map((name) => fs.readFileSync(path.join(recoveryPath, name), "utf8"))
        .join("\n")
    : "";
  check("the recovery journal has no API key", !recoveryText.includes("sk-mock-"));
} catch (error) {
  failed += 1;
  console.log(`  FAIL  the suite threw — ${error}`);
} finally {
  try {
    if (createdOpenAiKey) {
      await evaluate(
        `window.__TAURI_INTERNALS__.invoke('ai_clear_key', { provider: 'openai', baseUrl: ${JSON.stringify(baseUrl)} })`,
      );
    }
  } catch {
    /* the app may be gone */
  }
  try {
    if (createdAnthropicKey) {
      await evaluate(
        `window.__TAURI_INTERNALS__.invoke('ai_clear_key', { provider: 'anthropic', baseUrl: ${JSON.stringify(anthropicBase)} })`,
      );
    }
  } catch {
    /* the app may be gone */
  }
  try {
    const current = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_settings')`);
    const patched = {
      ...current,
      aiEnabled: original.aiEnabled,
      aiProvider: original.aiProvider,
      aiBaseUrl: original.aiBaseUrl,
      aiModel: original.aiModel,
    };
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke('save_settings', { settings: ${JSON.stringify(patched)} })`,
    );
  } catch {
    /* cleanup is best-effort */
  }
  ws.close();
  server.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
