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
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// The palette's *Most used* section is computed by the application from the
// recorded usage. The check below compares the rendered rows with the same
// module, so it holds on a profile that already has a history instead of
// assuming a fresh one.
import { rankMostUsed } from "../src/ai/usage.ts";

const port = process.argv[2] ?? "9222";
const appIdentifier = process.env.MDRAFT_TEST_IDENTIFIER ?? "io.github.bernh.mdraft";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Mock endpoint
// ---------------------------------------------------------------------------

const TAGS = {
  "mdraft-revised": "improve",
  "mdraft-continuation": "continue",
  "mdraft-expanded": "expand",
  "mdraft-shortened": "shorten",
  "mdraft-simplified": "simplify",
  "mdraft-rewritten": "tone",
  "mdraft-translation": "translate",
  "mdraft-summary": "summarize",
  "mdraft-explanation": "explain",
  "mdraft-points": "keyPoints",
  "mdraft-critique": "critique",
  "mdraft-table": "table",
  "mdraft-converted": "convert",
};

// A model that ignores the wrapper protocol: the preamble and the change
// summary reach `done` together, and the Rust guard must leave only the
// translation.
const NOISY_TRANSLATION =
  "Here is the translation:\n\nTexto traduzido pelo mock.\n\n**Summary of changes:**\n- Kept the greeting\n- Fixed the comma";

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
  const isName = system.includes("You name text documents");
  const tag = Object.keys(TAGS).find((candidate) => system.includes(`<${candidate}>`));
  const action = isName ? "filename" : tag ? TAGS[tag] : "ask";
  control.requests.push({
    url,
    headers: request.headers,
    body,
    system,
    action,
    tag: tag ?? null,
  });

  // A model that refuses the reasoning-off field. `rejectReasoning` refuses the
  // first Anthropic spelling only, which is what exercises the client's
  // `between_tools` translation; `rejectAllReasoning` stands for a model whose
  // thinking cannot be turned off at all.
  const reasoningOff = isAnthropic
    ? body.thinking?.type === "disabled" || body.thinking?.type === "between_tools"
    : body.reasoning_effort === "none";
  const refusesReasoning =
    control.mode === "rejectAllReasoning" ||
    (control.mode === "rejectReasoning" &&
      (isAnthropic ? body.thinking?.type === "disabled" : body.reasoning_effort === "none"));
  if (reasoningOff && refusesReasoning) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        isAnthropic
          ? {
              type: "error",
              error: {
                message:
                  '"thinking.type.disabled" is not supported for this model. Use "thinking.type.between_tools" instead.',
              },
            }
          : { error: { message: "Unrecognized request argument supplied: reasoning_effort" } },
      ),
    );
    return;
  }

  // The Preferences test is a plain completion, not a stream.
  if (body.stream === false) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        isAnthropic
          ? { type: "message", content: [{ type: "text", text: "OK" }] }
          : { choices: [{ message: { role: "assistant", content: "OK" } }] },
      ),
    );
    return;
  }

  // A provider that accepted the connection and never sends headers. Only the
  // client closing the socket (Stop) or `release` ends it.
  if (control.mode === "stallHeaders") {
    let released = false;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 20_000);
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
        response.writeHead(500, { "content-type": "application/json" });
        response.end("{}");
      } catch {
        /* the client cancelled */
      }
    }
    return;
  }

  const noisy = control.mode === "noisy" && action === "translate";
  const answer =
    action === "ask"
      ? "The mock says **this file is a feature tour** with a [link](https://example.com)."
      : noisy
        ? NOISY_TRANSLATION
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

  if (isName) {
    // Deliberately labelled and containing a slash: the backend removes the
    // label and the frontend's sanitiser replaces the slash, which is what the
    // end-to-end check measures.
    writeDelta("Nome: Relações EUA/China na Era da IA");
    response.end(
      isAnthropic ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : "data: [DONE]\n\n",
    );
    return;
  }

  const content = tag && !noisy ? `<${tag}>${answer}</${tag}>` : answer;
  const notes =
    action === "improve" ? "\n<mdraft-notes>Mock notes: fixed agreement.</mdraft-notes>" : "";
  const full = `${content}${notes}`;
  const third = Math.ceil(full.length / 3);

  if (control.mode === "hold") {
    const head = full.slice(0, Math.min(12, full.length));
    writeDelta(head);
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
        // A stale-target test releases the hold and expects a completed answer;
        // a Stop test closes the connection first, and the partial wrapper is
        // discarded by the backend.
        if (released) {
          for (let index = head.length; index < full.length; index += third) {
            writeDelta(full.slice(index, index + third));
            await sleep(20);
          }
        }
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

async function setNumber(label, value) {
  const ok = await evaluate(`(() => {
    const row = ${rowSelector(label)};
    const input = row?.querySelector('input[type=number]');
    if (!input) return false;
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
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

async function openModelPicker() {
  const opened = await evaluate(`(() => {
    const row = ${rowSelector("Model")};
    const toggle = row?.querySelector('.combo-toggle');
    if (!toggle) return false;
    toggle.click();
    return true;
  })()`);
  await sleep(120);
  return opened;
}

async function modelOptionIds() {
  return evaluate(
    `[...document.querySelectorAll('.combo-popup .combo-option')].map(o => o.textContent)`,
  );
}

async function modelInputValue() {
  return evaluate(`(${rowSelector("Model")})?.querySelector('input[type=text]')?.value ?? null`);
}

async function modelFieldNote() {
  return evaluate(
    `(${rowSelector("Model")})?.querySelector('.prefs-field-note')?.textContent ?? ''`,
  );
}

async function filterModelPicker(query) {
  const ok = await evaluate(`(() => {
    const input = (${rowSelector("Model")})?.querySelector('input[type=text]');
    if (!input) return false;
    input.focus();
    input.value = ${JSON.stringify(query)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(120);
  return ok;
}

async function chooseModelFromPicker(model) {
  const chosen = await evaluate(`(() => {
    const option = [...document.querySelectorAll('.combo-popup .combo-option')].find(o => o.textContent === ${JSON.stringify(model)});
    if (!option) return false;
    option.click();
    return true;
  })()`);
  await sleep(150);
  return chosen;
}

async function closeModelPicker() {
  await evaluate(`(() => {
    const input = (${rowSelector("Model")})?.querySelector('input[type=text]');
    if (!input) return false;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(80);
}

// The answer to Fetch is a "Models" note under the button that asked for it;
// the key's own state is on the API Key row.
async function aiStatusNote() {
  return evaluate(
    `[...document.querySelectorAll('.prefs-row')].find(r => r.querySelector('.prefs-label')?.textContent.replace(/\\?$/, '') === 'Models')?.querySelector('.prefs-note')?.textContent ?? ''`,
  );
}

// The reasoning test's answer, under the button that asked for it.
async function reasoningNote() {
  return evaluate(
    `[...document.querySelectorAll('.prefs-row')].find(r => r.querySelector('.prefs-label')?.textContent.replace(/\\?$/, '') === 'Reasoning')?.querySelector('.prefs-note')?.textContent ?? ''`,
  );
}

async function waitReasoningNote(fragment, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const note = await reasoningNote();
    if (note.includes(fragment)) return note;
    await sleep(120);
  }
  return "";
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

/**
 * Open the button's own menu with a synthetic contextmenu.
 *
 * The event is cancelable, and `preventDefault()` on it is exactly what stops
 * WebView2 from drawing its native Back/Refresh menu; the assertion therefore
 * measures the suppression rather than only the popup.
 */
async function openAssistantMenu() {
  const opened = await evaluate(`(() => {
    const fab = document.querySelector('.ai-fab');
    if (!fab) return null;
    const box = fab.getBoundingClientRect();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      button: 2,
      buttons: 2,
    });
    fab.dispatchEvent(event);
    const menu = document.querySelector('.ai-menu');
    return {
      prevented: event.defaultPrevented,
      labels: menu ? [...menu.querySelectorAll('.ai-menu-item')].map((b) => b.textContent) : [],
      separators: menu ? menu.querySelectorAll('.ai-menu-sep').length : 0,
    };
  })()`);
  await sleep(120);
  return opened;
}

async function chooseAssistantMenuItem(action) {
  const clicked = await evaluate(`(() => {
    const button = document.querySelector('.ai-menu-item[data-action="${action}"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(250);
  return clicked;
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
  const rowExpression = `[...document.querySelectorAll('.ai-row')].find(r => r.querySelector('.ai-row-label')?.textContent === ${JSON.stringify(label)})`;
  // A palette row is briefly disabled while its passage is measured
  // ("Measuring the passage…"), and the palette re-renders once the count
  // arrives. A single click in that window only raises a toast, so retry the
  // gesture the way a person would instead of waiting for a panel that never
  // opens.
  const deadline = Date.now() + 5000;
  let lastReason = "";
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => {
      const row = ${rowExpression};
      if (!row) return { state: 'missing' };
      return {
        state: row.classList.contains('is-disabled') ? 'disabled' : 'ready',
        reason: row.querySelector('.ai-row-description')?.textContent ?? '',
      };
    })()`);
    if (state.state === "missing") throw new Error(`no action row ${label}`);
    lastReason = state.reason;
    if (state.state === "ready") {
      await evaluate(`(() => {
        const row = ${rowExpression};
        if (!row) return false;
        row.click();
        return true;
      })()`);
      if (await waitFor(`!document.querySelector('.ai-panel').hidden`, 2000)) {
        await sleep(120);
        return;
      }
      const toast = await evaluate(
        `document.getElementById('toast')?.hidden ? '' : (document.getElementById('toast')?.textContent ?? '')`,
      );
      if (toast) throw new Error(`${label} did not open: ${toast}`);
    }
    await sleep(120);
    if (!(await evaluate(`!document.querySelector('.ai-palette').hidden`))) await openPalette();
  }
  throw new Error(`${label} never opened its panel (last row state: ${lastReason || "unknown"})`);
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

/** The persisted palette usage, as the palette itself reads it. */
async function storedUsage() {
  return evaluate(
    `window.__TAURI_INTERNALS__.invoke('get_settings').then((s) => s.aiActionUsage ?? [])`,
  );
}

/**
 * Wait until `id` has a stored entry, then return the whole list.
 *
 * The settings write is queued, so reading immediately after an answer can see
 * the copy from before it; polling is the honest wait rather than a sleep.
 */
async function waitForStoredUsage(id, timeout = 6_000) {
  await waitFor(
    `window.__TAURI_INTERNALS__.invoke('get_settings').then((s) => (s.aiActionUsage ?? []).some((e) => e.id === ${JSON.stringify(id)}))`,
    timeout,
  );
  return storedUsage();
}

async function clickFooter(label) {
  // Scope to the panel: a history detail owns the same `.ai-footer-actions`
  // class, and it sits earlier in the DOM, so an unscoped query would click a
  // remembered answer instead of the one on screen.
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.ai-panel .ai-footer-actions button')].find(b => b.textContent === ${JSON.stringify(label)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  await sleep(250);
  return clicked;
}

async function footerButtons() {
  return evaluate(
    `[...document.querySelectorAll('.ai-panel .ai-footer-actions button')].map(b => ({ text: b.textContent, disabled: b.disabled }))`,
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

/** The visible tab strip: how many, which one is active, which are unsaved. */
async function tabState() {
  return evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.doc-tab')];
    return {
      count: tabs.length,
      active: tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true'),
      dirty: tabs.map((tab) => tab.classList.contains('is-dirty')),
      names: tabs.map((tab) => tab.querySelector('.doc-tab-name')?.textContent ?? ''),
    };
  })()`);
}

/**
 * Close the rightmost tab and discard it when the app asks to save it.
 *
 * A generated tab is dirty by design, so Ctrl+W (and the harness afterwards)
 * meets the unsaved dialog instead of a silent close. Returns whether the
 * dialog appeared, which is itself the assertion that the tab was marked dirty.
 */
async function discardGeneratedTab() {
  const clicked = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.doc-tab')];
    const last = tabs.at(-1);
    if (!last) return false;
    last.querySelector('.doc-tab-close')?.click();
    return true;
  })()`);
  if (!clicked) return false;
  const asked = await waitFor(`Boolean(document.querySelector('.unsaved-dialog'))`, 4000);
  if (asked) {
    await evaluate(
      `document.querySelector('.unsaved-dialog button[data-decision="discard"]')?.click()`,
    );
    await sleep(400);
  }
  return Boolean(asked);
}

/** Press the answer head's Regenerate icon, which replaced the footer button. */
async function clickRegenerate() {
  const clicked = await evaluate(`(() => {
    const button = document.querySelector('.ai-regenerate');
    if (!button || button.hidden) return false;
    button.click();
    return true;
  })()`);
  await sleep(250);
  return clicked;
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
  const filenameOptionOff = await evaluate(`(() => {
    const row = ${rowSelector("Suggest file names when saving")};
    const input = row?.querySelector('input[type=checkbox]');
    return input ? { found: true, disabled: input.disabled } : { found: false, disabled: false };
  })()`);
  check(
    "the filename option is disabled while the assistant is off",
    filenameOptionOff.found && filenameOptionOff.disabled,
    JSON.stringify(filenameOptionOff),
  );
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
    "Suggest file names when saving",
    "Floating button",
    "Provider",
    "Base URL",
    "API Key",
    "Model",
    "Context limit",
    "Prompts file",
  ]) {
    check(`the AI section has ${label}`, prefsSection.labels.includes(label));
  }
  // The section used to end in one catch-all "Status" row that spoke about the
  // API key far from the key field; each control answers for itself now.
  check(
    "the AI section has no catch-all Status row",
    !prefsSection.labels.includes("Status"),
    prefsSection.labels.join(", "),
  );
  // The Privacy paragraph explained the endpoint, the credential store and what
  // leaves the machine. That is documentation, and it lives in the guide; the
  // panel is a list of controls.
  check(
    "the AI section has no Privacy paragraph",
    !prefsSection.labels.includes("Privacy"),
    prefsSection.labels.join(", "),
  );
  const contextLimit = await evaluate(`(() => {
    const input = (${rowSelector("Context limit")})?.querySelector('input[type=number]');
    if (!input) return null;
    return { value: input.value, min: input.min, max: input.max, step: input.step };
  })()`);
  check(
    "the context limit starts at 8192 tokens",
    contextLimit?.value === "8192",
    JSON.stringify(contextLimit),
  );
  check(
    "the context limit carries the hard bounds",
    contextLimit?.min === "1024" && contextLimit?.max === "32768",
    JSON.stringify(contextLimit),
  );
  check("the context limit can be lowered", await setNumber("Context limit", 1024));
  const loweredLimit = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('get_settings').then(s => s.aiContextTokens)`,
  );
  check("the lowered context limit is persisted", loweredLimit === 1024, String(loweredLimit));
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
  const filenameOptionOn = await evaluate(`(() => {
    const row = ${rowSelector("Suggest file names when saving")};
    const input = row?.querySelector('input[type=checkbox]');
    return input ? { found: true, disabled: input.disabled } : { found: false, disabled: false };
  })()`);
  check(
    "the filename option enables with the assistant",
    filenameOptionOn.found && !filenameOptionOn.disabled,
    JSON.stringify(filenameOptionOn),
  );
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
  check("the default anchor is at the bottom limit", fab?.bottom === 8, String(fab?.bottom));

  console.log("\nPalette");
  await openPalette();
  const palette = await evaluate(`(() => {
    const sections = [];
    let current = null;
    for (const child of document.querySelector('.ai-actions').children) {
      if (child.classList.contains('ai-group')) {
        current = { label: child.textContent, labels: [] };
        sections.push(current);
      } else if (child.classList.contains('ai-row') && current) {
        current.labels.push(child.querySelector('.ai-row-label')?.textContent ?? '');
      }
    }
    return {
      groups: [...document.querySelectorAll('.ai-group')].map(g => g.textContent),
      sections,
      rows: [...document.querySelectorAll('.ai-row-label')].map(r => r.textContent),
      ids: [...document.querySelectorAll('.ai-row')].map(r => r.id),
      footer: [...document.querySelectorAll('.ai-palette-footer button')].map((b) => b.textContent.trim()),
      height: Math.round(document.querySelector('.ai-palette').getBoundingClientRect().height),
      inside: (() => {
        const pane = document.getElementById('editor-pane').getBoundingClientRect();
        const box = document.querySelector('.ai-palette').getBoundingClientRect();
        return box.left >= pane.left && box.right <= pane.right && box.top >= pane.top && box.bottom <= pane.bottom;
      })(),
    };
  })()`);
  check(
    "five groups are shown",
    JSON.stringify(palette.groups) ===
      JSON.stringify(["Most used", "Write", "Refine", "Understand", "Transform"]),
    JSON.stringify(palette.groups),
  );
  check(
    "the shortcut section shows three rows",
    palette.sections[0]?.labels.length === 3,
    JSON.stringify(palette.sections[0]?.labels),
  );
  check(
    "the catalog renders fourteen actions plus three shortcuts",
    palette.rows.length === 17,
    String(palette.rows.length),
  );
  check(
    "every palette row has a unique id",
    new Set(palette.ids).size === palette.ids.length,
    `${new Set(palette.ids).size}/${palette.ids.length}`,
  );
  const usageNow = await storedUsage();
  const expectedShortcuts = rankMostUsed(usageNow).map((action) => action.label);
  check(
    "the section is the ranking of the recorded use",
    JSON.stringify(palette.sections[0]?.labels) === JSON.stringify(expectedShortcuts),
    `${JSON.stringify(palette.sections[0]?.labels)} vs ${JSON.stringify(expectedShortcuts)}`,
  );
  const categoryOf = (label) =>
    palette.sections.slice(1).find((section) => section.labels.includes(label))?.label ?? "";
  check(
    "Continue writing is listed under Write",
    categoryOf("Continue writing") === "Write",
    categoryOf("Continue writing"),
  );
  check(
    "Improve writing is listed under Refine",
    categoryOf("Improve writing") === "Refine",
    categoryOf("Improve writing"),
  );
  check(
    "Ask AI is listed under Understand",
    categoryOf("Ask AI…") === "Understand",
    categoryOf("Ask AI…"),
  );
  check(
    "a shortcut also appears in its own category",
    palette.sections[0].labels.every(
      (label) => palette.rows.filter((row) => row === label).length === 2,
    ),
    JSON.stringify(palette.rows),
  );
  check(
    "the palette footer has History and the settings command",
    palette.footer.includes("History") &&
      palette.footer.includes("AI Settings…") &&
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

  console.log("\nContext limit");
  await closePalette();
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await pressCtrl("End", "End", 35);
  await send("Input.insertText", { text: "\n\n" + "word ".repeat(1500) });
  await sleep(300);
  await pressCtrl("a", "KeyA", 65);
  await openPalette();
  const overLimit = await waitFor(
    `(() => {
      const row = document.querySelector('#ai-row-refine-improve');
      return row?.classList.contains('is-disabled')
        ? row.querySelector('.ai-row-description')?.textContent ?? ''
        : null;
    })()`,
    8000,
  );
  check(
    "the palette names the configured token limit",
    overLimit?.includes("up to 1,024 tokens") === true,
    String(overLimit),
  );
  await evaluate(`document.querySelector('#ai-row-refine-improve').click()`);
  await sleep(200);
  const limitToast = await evaluate(
    `document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent`,
  );
  check("a refused action explains the budget", limitToast.includes("shorter passage"), limitToast);
  await closePalette();
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await undo();
  await sleep(300);
  await openAiSection();
  check("the context limit can be raised", await setNumber("Context limit", 8192));
  await closePrefs();
  await openPalette();
  const raisedRow = await waitFor(
    `(() => {
      const row = document.querySelector('#ai-row-refine-improve');
      return row && !row.classList.contains('is-disabled') ? true : null;
    })()`,
    8000,
  );
  check("raising the limit re-enables the row", raisedRow === true);
  await closePalette();
  await clickEditorWord("Regular");
  await openPalette();

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
  check(
    "a search hides the shortcut section",
    (await evaluate(
      `[...document.querySelectorAll('.ai-group')].every((g) => g.textContent !== 'Most used')`,
    )) === true,
  );
  check(
    "a searched action appears once",
    (await evaluate(
      `[...document.querySelectorAll('.ai-row-label')].filter((l) => l.textContent === 'Translate…').length`,
    )) === 1,
  );
  await evaluate(
    `(() => { const s = document.querySelector('.ai-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(100);
  check(
    "clearing the search restores the shortcut section",
    (await evaluate(
      `[...document.querySelectorAll('.ai-group')].some((g) => g.textContent === 'Most used')`,
    )) === true,
  );
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

  // The reported bug: a dragged button kept its old pixel offset when the
  // window grew, so it ended up stranded in the middle of a taller editor.
  console.log("\nResize resilience");
  const buttonFractions = async () =>
    evaluate(`(() => {
      const pane = document.getElementById('editor-pane').getBoundingClientRect();
      const box = document.querySelector('.ai-fab').getBoundingClientRect();
      return {
        x: (box.left - pane.left - 8) / (pane.width - 56),
        y: (box.top - pane.top - 8) / (pane.height - 56),
        top: box.top,
        right: pane.right - box.right,
        bottom: pane.bottom - box.bottom,
      };
    })()`);
  const beforeGrow = await buttonFractions();
  const viewport = await evaluate(`({ width: window.innerWidth, height: window.innerHeight })`);
  await send("Emulation.setDeviceMetricsOverride", {
    width: Math.round(viewport.width),
    height: Math.round(viewport.height + 320),
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(450);
  const afterGrow = await buttonFractions();
  check(
    "a taller window keeps the dragged button's relative place",
    Math.abs(afterGrow.x - beforeGrow.x) < 0.01 && Math.abs(afterGrow.y - beforeGrow.y) < 0.01,
    JSON.stringify({ beforeGrow, afterGrow }),
  );
  check(
    "the dragged button follows the taller pane instead of staying put",
    afterGrow.top > beforeGrow.top + 100 && afterGrow.bottom >= 8,
    JSON.stringify({ beforeGrow, afterGrow }),
  );
  await send("Emulation.clearDeviceMetricsOverride");
  await sleep(450);

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
    reset.right === 20 && reset.bottom === 8,
    JSON.stringify(reset),
  );

  console.log("\nAssistant context menu");
  const assistantMenu = await openAssistantMenu();
  check(
    "right-clicking the assistant owns the WebView's menu",
    assistantMenu?.prevented === true,
    JSON.stringify(assistantMenu),
  );
  check(
    "the assistant menu offers Reset position",
    assistantMenu?.labels.includes("Reset position") === true,
    JSON.stringify(assistantMenu?.labels),
  );
  check(
    "the assistant menu opens AI Assistant settings",
    assistantMenu?.labels.includes("AI Assistant Settings…") === true,
    JSON.stringify(assistantMenu?.labels),
  );
  check(
    "the assistant menu can turn the assistant off",
    assistantMenu?.labels.includes("Disable AI Assistant") === true,
    JSON.stringify(assistantMenu?.labels),
  );
  check(
    "the assistant menu separates the destructive toggle",
    assistantMenu?.separators === 1,
    String(assistantMenu?.separators),
  );

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
  check(
    "Escape closes the assistant menu",
    (await evaluate(`document.querySelectorAll('.ai-menu').length`)) === 0,
  );

  // Move the button by hand so this check measures the menu command, not the
  // earlier Preferences reset.
  await evaluate(`(() => {
    const box = document.querySelector('.ai-fab').style;
    box.left = '77px';
    box.top = '99px';
  })()`);
  await openAssistantMenu();
  check("the menu's Reset position runs", await chooseAssistantMenuItem("reset"));
  const menuReset = await evaluate(`(() => {
    const pane = document.getElementById('editor-pane').getBoundingClientRect();
    const box = document.querySelector('.ai-fab').getBoundingClientRect();
    return { right: Math.round(pane.right - box.right), bottom: Math.round(pane.bottom - box.bottom) };
  })()`);
  check(
    "the menu's Reset position returns the button to the anchor",
    menuReset.right === 20 && menuReset.bottom === 8,
    JSON.stringify(menuReset),
  );
  check(
    "the menu closed after its command",
    (await evaluate(`document.querySelectorAll('.ai-menu').length`)) === 0,
  );

  await openAssistantMenu();
  check("the menu's Settings command runs", await chooseAssistantMenuItem("settings"));
  check(
    "the menu opens the AI Assistant Preferences section",
    (await waitFor(
      `document.querySelector('.prefs-section-title')?.textContent === 'AI Assistant'`,
    )) === true,
  );
  await closePrefs();

  await openAssistantMenu();
  check("the menu's toggle command runs", await chooseAssistantMenuItem("toggle"));
  check(
    "disabling from the menu hides the assistant button",
    (await evaluate(`document.querySelector('.ai-assistant').hidden`)) === true,
  );
  await openAiSection();
  check("the assistant can be turned back on", await setCheckbox("Enable AI Assistant", true));
  await closePrefs();
  await waitFor(`!document.querySelector('.ai-assistant').hidden`);

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
  const improveContext = await evaluate(
    `document.querySelector('.ai-context-summary')?.textContent ?? ''`,
  );
  check(
    "the panel reports the tokens it sent",
    improveContext.includes("tokens sent"),
    improveContext,
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
      "<mdraft-revised>",
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
    "New tab is offered",
    improveFooter.some((b) => b.text === "New tab" && !b.disabled),
  );
  check(
    "Regenerate moved to the answer head",
    (await evaluate(`!document.querySelector('.ai-regenerate')?.hidden`)) &&
      !improveFooter.some((b) => b.text === "Regenerate"),
  );
  check(
    "the Regenerate icon carries its own name",
    await evaluate(
      `(() => { const b = document.querySelector('.ai-regenerate'); return b?.title === 'Regenerate' && b?.getAttribute('aria-label') === 'Regenerate'; })()`,
    ),
  );
  const footerRow = await evaluate(`(() => {
    const row = document.querySelector('.ai-panel .ai-footer-actions');
    const buttons = [...(row?.querySelectorAll('button') ?? [])];
    if (!buttons.length) return null;
    const pane = document.querySelector('.ai-panel').getBoundingClientRect();
    return {
      rows: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
      overflow: Math.round(row.scrollWidth - row.clientWidth),
      inside: buttons.every((b) => b.getBoundingClientRect().right <= pane.right - 4),
    };
  })()`);
  check(
    "the four destinations share one row",
    footerRow?.rows === 1 && footerRow.overflow <= 0 && footerRow.inside === true,
    JSON.stringify(footerRow),
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
  check(
    "Continue offers New tab",
    (await footerButtons()).some((b) => b.text === "New tab" && !b.disabled),
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
  const usageBeforeSummarize = await storedUsage();
  await clickEditorWord("Regular");
  await chooseAction("Summarize");
  await waitPanelDone();
  const usageAfterSummarize = await waitForStoredUsage("summarize");
  const summarizeBefore = usageBeforeSummarize.find((entry) => entry.id === "summarize");
  const summarizeAfter = usageAfterSummarize.find((entry) => entry.id === "summarize");
  check(
    "a completed request records its use",
    Boolean(summarizeAfter) &&
      summarizeAfter.at > (summarizeBefore?.at ?? 0) &&
      summarizeAfter.score > 0,
    `${JSON.stringify(summarizeBefore ?? null)} -> ${JSON.stringify(summarizeAfter ?? null)}`,
  );
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
  check(
    "Summarize offers New tab",
    (await footerButtons()).some((b) => b.text === "New tab" && !b.disabled),
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

  // The section is computed from the live settings, not a snapshot taken when
  // the palette was built, so reopening it after a use must show the ranking
  // the same module produces from the stored list.
  await closePanel();
  await openPalette();
  const summarizedSections = await evaluate(`(() => {
    const sections = [];
    let current = null;
    for (const child of document.querySelector('.ai-actions').children) {
      if (child.classList.contains('ai-group')) {
        current = { label: child.textContent, labels: [] };
        sections.push(current);
      } else if (child.classList.contains('ai-row') && current) {
        current.labels.push(child.querySelector('.ai-row-label')?.textContent ?? '');
      }
    }
    return sections;
  })()`);
  const summarizeExpected = rankMostUsed(await storedUsage()).map((action) => action.label);
  check(
    "the shortcut section reflects the new use",
    JSON.stringify(summarizedSections[0]?.labels) === JSON.stringify(summarizeExpected),
    `${JSON.stringify(summarizedSections[0]?.labels)} vs ${JSON.stringify(summarizeExpected)}`,
  );
  const usageConfigPath = path.join(process.env.APPDATA ?? "", appIdentifier, "settings.json");
  let usageOnDisk = [];
  const diskDeadline = Date.now() + 5000;
  while (Date.now() < diskDeadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(usageConfigPath, "utf8"));
      usageOnDisk = Array.isArray(parsed.aiActionUsage) ? parsed.aiActionUsage : [];
      if (usageOnDisk.some((entry) => entry.id === "summarize")) break;
    } catch {
      /* the queued write may still be in flight */
    }
    await sleep(100);
  }
  check(
    "the recorded use reaches settings.json",
    usageOnDisk.some((entry) => entry.id === "summarize"),
    JSON.stringify(usageOnDisk.map((entry) => entry.id)),
  );
  await closePalette();

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
    handleBox?.width === 20 && handleBox?.height === 20 && handleBox?.cursor === "nwse-resize",
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

  // The target field is a combo, not a datalist: the list is the application's
  // own element, it opens whole, it is drawn above the panel, and the value it
  // commits is the readable name that reaches the prompt.
  check(
    "the target field is a combo, not a datalist",
    await evaluate(
      `Boolean(document.querySelector('.ai-params .combo-toggle')) && !document.querySelector('.ai-params datalist')`,
    ),
  );
  await evaluate(`document.querySelector('.ai-params .combo-toggle').click()`);
  await waitFor(`Boolean(document.querySelector('.combo-popup'))`, 3000);
  const languageRows = await evaluate(
    `[...document.querySelectorAll('.combo-popup .combo-option')].map(o => o.textContent)`,
  );
  check(
    "the caret lists every suggested language",
    languageRows.length === 34,
    `${languageRows.length} rows`,
  );
  check(
    "the list opens on the likely targets",
    JSON.stringify(languageRows.slice(0, 4)) ===
      JSON.stringify([
        "English (US)",
        "English (UK)",
        "Portuguese (Brazil)",
        "Portuguese (Portugal)",
      ]),
    languageRows.slice(0, 4).join(", "),
  );
  const popupGeometry = await evaluate(`(() => {
    const popup = document.querySelector('.combo-popup');
    const field = document.querySelector('.ai-params input[type=text]');
    if (!popup || !field) return null;
    const p = popup.getBoundingClientRect();
    const f = field.getBoundingClientRect();
    const hit = document.elementFromPoint(p.left + p.width / 2, p.top + Math.min(p.height / 2, 40));
    return {
      wider: p.width >= f.width - 1,
      inside: p.left >= 0 && p.right <= window.innerWidth,
      onTop: Boolean(hit && popup.contains(hit)),
    };
  })()`);
  check(
    "the list spans the field, stays on screen and paints above the panel",
    popupGeometry?.wider === true &&
      popupGeometry?.inside === true &&
      popupGeometry?.onTop === true,
    JSON.stringify(popupGeometry),
  );

  await evaluate(`document.querySelector('.ai-params input[type=text]').focus()`);
  await send("Input.insertText", { text: "port" });
  await sleep(150);
  const filteredLanguages = await evaluate(
    `[...document.querySelectorAll('.combo-popup .combo-option')].map(o => o.textContent)`,
  );
  check(
    "typing filters the language list",
    JSON.stringify(filteredLanguages) ===
      JSON.stringify(["Portuguese (Brazil)", "Portuguese (Portugal)"]),
    filteredLanguages.join(", "),
  );

  const choseLanguage = await evaluate(`(() => {
    const option = [...document.querySelectorAll('.combo-popup .combo-option')].find(
      (o) => o.textContent === 'Portuguese (Brazil)',
    );
    if (!option) return false;
    option.click();
    return true;
  })()`);
  await sleep(150);
  check(
    "clicking a language writes its readable name",
    choseLanguage &&
      (await evaluate(`document.querySelector('.ai-params input[type=text]').value`)) ===
        "Portuguese (Brazil)",
  );
  check(
    "choosing a language closes the list",
    await evaluate(`!document.querySelector('.combo-popup')`),
  );

  await evaluate(`document.querySelector('.ai-params .combo-toggle').click()`);
  await waitFor(`Boolean(document.querySelector('.combo-popup'))`, 3000);
  check(
    "the current language is marked in the list",
    (await evaluate(
      `document.querySelector('.combo-popup .combo-option[aria-selected="true"]')?.textContent ?? ''`,
    )) === "Portuguese (Brazil)",
  );

  await pressKey("Escape", "Escape", 27);
  check(
    "the first Escape closes only the list",
    await evaluate(`!document.querySelector('.combo-popup')`),
  );
  check(
    "the panel is still open after that Escape",
    await evaluate(`!document.querySelector('.ai-panel')?.hidden`),
  );

  await evaluate(`document.querySelector('.ai-params .combo-toggle').click()`);
  await waitFor(`Boolean(document.querySelector('.combo-popup'))`, 3000);
  const requestsBeforeEnter = control.requests.length;
  // The list opens on the field's current value, so ArrowDown moves from
  // "Portuguese (Brazil)" to the next row rather than starting at the top.
  await pressKey("ArrowDown", "ArrowDown", 40);
  await pressKey("Enter", "Enter", 13);
  check(
    "Enter chooses the row the arrows reached",
    (await evaluate(`document.querySelector('.ai-params input[type=text]').value`)) ===
      "Portuguese (Portugal)",
  );
  check(
    "choosing with Enter does not send a request",
    control.requests.length === requestsBeforeEnter,
    `${control.requests.length - requestsBeforeEnter} sent`,
  );

  // A <label> cannot wrap the field and the caret together, so the caption is
  // explicit. A real click on it must still focus the field.
  const captionPoint = await evaluate(`(() => {
    const caption = document.querySelector('.ai-param-caption');
    const field = document.querySelector('.ai-params input[type=text]');
    if (!caption || !field) return null;
    field.blur();
    const rect = caption.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  })()`);
  if (captionPoint) {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: captionPoint.x,
      y: captionPoint.y,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: captionPoint.x,
      y: captionPoint.y,
      button: "left",
      clickCount: 1,
    });
    await sleep(150);
  }
  check(
    "clicking the caption focuses the field",
    await evaluate(
      `document.activeElement === document.querySelector('.ai-params input[type=text]')`,
    ),
  );

  const requestsBeforeTranslate = control.requests.length;
  check(
    "Translate does not send before Generate",
    (await panelStatus()).includes("Choose a value"),
  );
  await evaluate(
    `(() => { const input = document.querySelector('.ai-params input[type=text]'); input.value = 'Portuguese'; input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); })()`,
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

  console.log("\nTranslate without the wrapper");
  control.mode = "noisy";
  await clickEditorWord("Regular");
  await chooseAction("Translate…");
  await evaluate(
    `(() => { const input = document.querySelector('.ai-params input[type=text]'); input.value = 'Portuguese'; input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); })()`,
  );
  await sleep(100);
  await evaluate(`document.querySelector('.ai-params .ai-generate').click()`);
  await waitPanelDone();
  const noisyAnswer = await evaluate(`document.querySelector('.ai-answer')?.textContent ?? ''`);
  check(
    "a noisy answer keeps only the translation",
    noisyAnswer.trim() === "Texto traduzido pelo mock.",
    noisyAnswer.trim(),
  );
  check("a noisy answer drops the change summary", !/summary of changes/i.test(noisyAnswer));
  check("the clean translation replaces the passage", await clickFooter("Replace selection"));
  const cleanText = await editorText();
  check(
    "the document received only the translation",
    cleanText.includes("Texto traduzido pelo mock.") && !/summary of changes/i.test(cleanText),
  );
  await undo();
  control.mode = "normal";

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
  check(
    "Convert marks New tab as the primary",
    await evaluate(
      `document.querySelector('.ai-panel .ai-footer-actions .ai-action.is-primary')?.textContent === 'New tab'`,
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
  check(
    "Ask offers New tab",
    (await footerButtons()).some((b) => b.text === "New tab" && !b.disabled),
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
  const stoppedAnswer = await evaluate(`document.querySelector('.ai-answer')?.textContent ?? ''`);
  check(
    "no delta arrives after Stop",
    stoppedAnswer.trim().length <= 12,
    `${stoppedAnswer.trim().length}: ${JSON.stringify(stoppedAnswer)}`,
  );
  control.mode = "normal";
  await closePanel();

  console.log("\nRejected key");
  control.mode = "unauthorized";
  const usageBefore401 = await storedUsage();
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
  const usageAfter401 = await storedUsage();
  const shortenBefore401 = usageBefore401.find((entry) => entry.id === "shorten")?.score ?? 0;
  const shortenAfter401 = usageAfter401.find((entry) => entry.id === "shorten")?.score ?? 0;
  check(
    "a rejected request records no use",
    Math.abs(shortenAfter401 - shortenBefore401) < 1e-9,
    `${shortenBefore401} -> ${shortenAfter401}`,
  );
  control.mode = "normal";
  check("Retry re-issues the request", await clickFooter("Retry"));
  await waitPanelDone();
  const usageAfterRetry = await waitForStoredUsage("shorten");
  check(
    "the successful retry records one use",
    (usageAfterRetry.find((entry) => entry.id === "shorten")?.score ?? 0) > shortenBefore401,
    `${shortenBefore401} -> ${usageAfterRetry.find((entry) => entry.id === "shorten")?.score ?? 0}`,
  );
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
  check(
    "a changed document still offers New tab",
    staleFooter.find((b) => b.text === "New tab")?.disabled === false,
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
    history.at(-1)?.title === "Convert to table" &&
      !history.some((row) => row.title === "Continue writing") &&
      !history.some((row) => row.title === "Summarize") &&
      !history.some((row) => row.title === "Key points"),
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
    history.find((row) => row.title === "Convert to table")?.preview.includes("one"),
    history.find((row) => row.title === "Convert to table")?.preview,
  );
  check(
    "the noisy translation is recorded without its change summary",
    history.filter((row) => row.title === "Translate · Portuguese").length === 2 &&
      !history.some((row) => /summary of changes/i.test(row.preview)),
    JSON.stringify(history.map((row) => row.preview)),
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
    "the detail offers Copy, Insert below and New tab",
    askDetail.actions.includes("Copy") &&
      askDetail.actions.includes("Insert below") &&
      askDetail.actions.includes("New tab"),
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
  const usageBeforeRegenerate = await waitForStoredUsage("improve");
  const beforeRegenerate = control.requests.length;
  check("Regenerate sends the request again", await clickRegenerate());
  const regenerateDeadline = Date.now() + 8000;
  while (control.requests.length === beforeRegenerate && Date.now() < regenerateDeadline) {
    await sleep(80);
  }
  await waitPanelDone();
  await sleep(300);
  const usageAfterRegenerate = await storedUsage();
  const improveBefore = usageBeforeRegenerate.find((entry) => entry.id === "improve")?.score ?? 0;
  const improveAfter = usageAfterRegenerate.find((entry) => entry.id === "improve")?.score ?? 0;
  check(
    "Regenerate does not add another use",
    improveAfter < improveBefore + 0.5,
    `${improveBefore} -> ${improveAfter}`,
  );
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
  // New tab
  // -------------------------------------------------------------------------

  console.log("\nNew tab");
  const improveAnswer = (
    await evaluate(`document.querySelector('.ai-answer')?.textContent?.trim() ?? ''`)
  ).trim();
  check(
    "the panel holds the improved answer",
    improveAnswer === "Improved passage from the mock.",
    improveAnswer,
  );
  const tabsBeforeNewTab = await tabState();
  check(
    "the answer on screen can open in a new tab",
    (await footerButtons()).some((b) => b.text === "New tab" && !b.disabled),
  );
  await clickFooter("New tab");
  await waitFor(
    `document.querySelectorAll('.doc-tab').length === ${tabsBeforeNewTab.count + 1}`,
    6000,
  );
  await waitFor(
    `[...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\\n').includes('Improved passage from the mock.')`,
    6000,
  );
  const tabsAfterNewTab = await tabState();
  check(
    "New tab opened exactly one tab",
    tabsAfterNewTab.count === tabsBeforeNewTab.count + 1,
    `${tabsBeforeNewTab.count} -> ${tabsAfterNewTab.count}`,
  );
  check(
    "the generated tab is active",
    tabsAfterNewTab.active === tabsAfterNewTab.count - 1,
    JSON.stringify(tabsAfterNewTab),
  );
  check(
    "the generated tab is dirty",
    tabsAfterNewTab.dirty[tabsAfterNewTab.active] === true,
    JSON.stringify(tabsAfterNewTab.dirty),
  );
  check(
    "the answer is the whole buffer",
    (await editorText()).includes("Improved passage from the mock."),
    JSON.stringify((await editorText()).slice(0, 90)),
  );
  check(
    "opening a tab closes the panel",
    await evaluate(`document.querySelector('.ai-panel').hidden`),
  );
  await evaluate(`document.querySelectorAll('.doc-tab')[0].click()`);
  await waitFor(
    `document.querySelectorAll('.doc-tab')[0]?.getAttribute('aria-selected') === 'true'`,
    4000,
  );
  await waitFor(
    `![...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\\n').includes('Improved passage from the mock.')`,
    4000,
  );
  // The buffer is compared by what it must not contain rather than by bytes: a
  // long fixture renders only the lines in the viewport, so two whole-text reads
  // at different scroll offsets are not equal even when nothing was written.
  check(
    "the original buffer does not gain the answer",
    !(await editorText()).includes("Improved passage from the mock."),
  );
  check(
    "the original tab stays clean",
    (await tabState()).dirty[0] === false,
    JSON.stringify((await tabState()).dirty),
  );
  check("closing the generated tab asks first", await discardGeneratedTab());
  check(
    "Discard removed the generated tab",
    (await tabState()).count === tabsBeforeNewTab.count,
    String((await tabState()).count),
  );

  // The same destination exists for a remembered answer.
  console.log("\nNew tab from History");
  await openHistory();
  check("the history detail opens", await openHistoryDetail(0));
  const historyNewTab = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.ai-history-detail-actions button')].find(b => b.textContent === 'New tab');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  check("the history detail opens a new tab", historyNewTab);
  await waitFor(
    `document.querySelectorAll('.doc-tab').length === ${tabsBeforeNewTab.count + 1}`,
    6000,
  );
  await waitFor(
    `[...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\\n').includes('Improved passage from the mock.')`,
    6000,
  );
  const historyTabs = await tabState();
  check(
    "the remembered answer is in a dirty tab",
    historyTabs.count === tabsBeforeNewTab.count + 1 &&
      historyTabs.dirty[historyTabs.active] === true,
    JSON.stringify(historyTabs),
  );
  check(
    "the remembered answer is the buffer",
    (await editorText()).includes("Improved passage from the mock."),
  );
  check("closing the history tab asks first", await discardGeneratedTab());

  // Convert answers in a different markup, so its tab must be typed as that
  // markup; a Markdown tab holding Typst would highlight and preview it wrongly.
  console.log("\nNew tab in the converted markup");
  await clickEditorWord("Regular");
  await chooseAction("Convert markup…");
  await evaluate(
    `(() => { const select = document.querySelector('.ai-params select'); select.value = 'typst'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await sleep(100);
  await evaluate(`document.querySelector('.ai-params .ai-generate').click()`);
  await waitPanelDone();
  check(
    "Convert makes New tab primary",
    await evaluate(
      `document.querySelector('.ai-panel .ai-footer-actions .ai-action.is-primary')?.textContent === 'New tab'`,
    ),
  );
  await clickFooter("New tab");
  await waitFor(
    `[...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\\n').includes('Converted by the mock')`,
    6000,
  );
  // `menu_state` is the native-menu probe, and the two Typst view items are
  // checked only for a Typst buffer. That is the proof the target markup reached
  // the host; the check is pushed asynchronously, so poll.
  const convertedLanguage = await waitFor(
    `window.__TAURI_INTERNALS__.invoke('menu_state').then((items) => items.some((item) => (item.id === 'view.typstDocument' || item.id === 'view.typstPages') && item.checked) ? 'typst' : '')`,
    5000,
  );
  check(
    "the converted tab is typed as Typst",
    convertedLanguage === "typst",
    String(convertedLanguage ?? ""),
  );
  check(
    "the converted tab holds the answer",
    (await editorText()).includes("Converted by the mock"),
  );
  await discardGeneratedTab();
  check(
    "the converted tab is gone",
    (await tabState()).count === tabsBeforeNewTab.count,
    String((await tabState()).count),
  );

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
  // Reasoning off
  // -------------------------------------------------------------------------

  console.log("\nReasoning");

  await openAiSection();
  const reasoningBox = await evaluate(`(() => {
    const row = ${rowSelector("Disable reasoning (thinking)")};
    const input = row?.querySelector('input[type=checkbox]');
    return { present: Boolean(input), checked: input?.checked ?? null };
  })()`);
  check(
    "the reasoning box exists and is off by default",
    reasoningBox.present && reasoningBox.checked === false,
    JSON.stringify(reasoningBox),
  );

  // The test asks the model, not the checkbox: it must work before opting in.
  await clickPrefsButton("Test with the configured model");
  const acceptedNote = await waitReasoningNote("accepted the reasoning-off request");
  check(
    "the test accepts a model that allows reasoning off",
    acceptedNote.length > 0,
    acceptedNote,
  );

  check("the reasoning box can be ticked", await setCheckbox("Disable reasoning (thinking)", true));
  await closePrefs();
  await clickEditorWord("Regular");
  await chooseAction("Summarize");
  await waitPanelDone();
  const anthropicOff = control.requests.at(-1);
  check(
    "Anthropic asks for thinking off",
    anthropicOff?.body?.thinking?.type === "disabled",
    JSON.stringify(anthropicOff?.body?.thinking),
  );
  await closePanel();

  // Sonnet 5.5 refuses "disabled" and names "between_tools"; the client must
  // translate the reader's intent instead of surfacing that 400.
  control.mode = "rejectReasoning";
  const beforeRetry = control.requests.length;
  await clickEditorWord("Regular");
  await chooseAction("Summarize");
  await waitPanelDone();
  const retried = control.requests.slice(beforeRetry);
  check(
    "a model that wants between_tools is asked again",
    retried.length === 2 &&
      retried[0].body?.thinking?.type === "disabled" &&
      retried[1].body?.thinking?.type === "between_tools",
    JSON.stringify(retried.map((request) => request.body?.thinking?.type)),
  );
  check(
    "the retried request answers",
    (await panelStatus()).startsWith("Answer ready"),
    await panelStatus(),
  );
  await closePanel();

  // A model whose thinking cannot be turned off at all: the test reports the
  // refusal, and Generate names the setting that caused it.
  control.mode = "rejectAllReasoning";
  await openAiSection();
  await clickPrefsButton("Test with the configured model");
  const refusedNote = await waitReasoningNote("refused the reasoning-off request");
  check(
    "the test reports a model that refuses it",
    refusedNote.includes("thinking.type.disabled"),
    refusedNote,
  );

  await closePrefs();
  await clickEditorWord("Regular");
  await chooseAction("Summarize");
  await waitPanelDone(8000);
  const refusalStatus = await panelStatus();
  check(
    "a refused request names the reasoning setting",
    refusalStatus.includes("Disable reasoning (thinking)"),
    refusalStatus,
  );
  await closePanel();

  // The OpenAI-compatible shape.
  control.mode = "normal";
  await openAiSection();
  await setSelect("Provider", "openai");
  await setText("Base URL", baseUrl);
  await setText("Model", "test-model");
  await closePrefs();
  await clickEditorWord("Regular");
  await chooseAction("Summarize");
  await waitPanelDone();
  const openaiOff = control.requests.at(-1);
  check(
    "OpenAI-compatible asks for reasoning_effort none",
    openaiOff?.body?.reasoning_effort === "none",
    JSON.stringify(openaiOff?.body?.reasoning_effort),
  );
  await closePanel();

  await openAiSection();
  await setCheckbox("Disable reasoning (thinking)", false);
  await closePrefs();
  await clickEditorWord("Regular");
  await chooseAction("Summarize");
  await waitPanelDone();
  const openaiDefault = control.requests.at(-1);
  check(
    "unticking removes the field",
    Boolean(openaiDefault?.body) && !("reasoning_effort" in openaiDefault.body),
    JSON.stringify(openaiDefault?.body),
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
    "the fetch status counts the models once",
    (gzipStatus.match(/2 models found/g) ?? []).length === 1 &&
      !gzipStatus.includes("2 models available"),
    gzipStatus,
  );
  control.mode = "normal";

  // A model id from the previous endpoint used to filter a datalist down to
  // nothing; the picker opens the whole list whatever the field contains.
  await setText("Model", "not-offered-here");
  const openedPicker = await openModelPicker();
  const staleOptions = await modelOptionIds();
  check(
    "a model from another endpoint does not hide the fetched list",
    openedPicker && staleOptions.includes("test-model") && staleOptions.includes("second-model"),
    staleOptions.join(", "),
  );
  const pickerGeometry = await evaluate(`(() => {
    const modelRow = ${rowSelector("Model")};
    const baseRow = ${rowSelector("Base URL")};
    const combo = modelRow?.querySelector('.prefs-combo');
    const base = baseRow?.querySelector('input[type=text]');
    const popup = document.querySelector('.combo-popup');
    if (!combo || !base || !popup) return null;
    const c = combo.getBoundingClientRect();
    const b = base.getBoundingClientRect();
    const p = popup.getBoundingClientRect();
    return {
      width: Math.round(c.width),
      baseWidth: Math.round(b.width),
      right: Math.round(c.right),
      baseRight: Math.round(b.right),
      popupWidth: Math.round(p.width),
      popupLeft: Math.round(p.left),
      popupRight: Math.round(p.right),
      comboLeft: Math.round(c.left),
    };
  })()`);
  check(
    "the Model field matches the other inputs' width",
    pickerGeometry &&
      pickerGeometry.width === pickerGeometry.baseWidth &&
      Math.abs(pickerGeometry.right - pickerGeometry.baseRight) <= 1,
    pickerGeometry ? `${pickerGeometry.width} vs ${pickerGeometry.baseWidth}` : "no geometry",
  );
  check(
    "the picker spans the whole field",
    pickerGeometry &&
      Math.abs(pickerGeometry.popupWidth - pickerGeometry.width) <= 1 &&
      Math.abs(pickerGeometry.popupLeft - pickerGeometry.comboLeft) <= 1 &&
      Math.abs(pickerGeometry.popupRight - pickerGeometry.right) <= 1,
    pickerGeometry ? `${pickerGeometry.popupWidth}/${pickerGeometry.width}` : "no geometry",
  );

  // Typing filters; an id that matches no fetched model stays free text.
  await filterModelPicker("sec");
  const filteredOptions = await modelOptionIds();
  check(
    "typing filters the fetched models",
    filteredOptions.length === 1 && filteredOptions[0] === "second-model",
    filteredOptions.join(", "),
  );
  const noMatch = await filterModelPicker("not-a-listed-model");
  const noMatchText = await evaluate(
    `document.querySelector('.combo-popup .combo-empty')?.textContent ?? ''`,
  );
  check(
    "a search that matches nothing says so",
    noMatch && noMatchText.includes("No fetched model matches"),
    noMatchText,
  );

  // The keyboard path: ArrowDown highlights the first offered id, Enter picks it.
  await filterModelPicker("");
  const keyboardPicked = await evaluate(`(() => {
    const input = (${rowSelector("Model")})?.querySelector('input[type=text]');
    if (!input) return false;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(150);
  check(
    "the keyboard chooses a fetched model",
    keyboardPicked && (await modelInputValue()) === "second-model",
  );
  check(
    "the keyboard choice closes the list",
    await evaluate(`!document.querySelector('.combo-popup')`),
  );

  await filterModelPicker("test");
  const chosen = await chooseModelFromPicker("test-model");
  check(
    "choosing a fetched model writes the field",
    chosen && (await modelInputValue()) === "test-model",
  );
  const persistedModel = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('get_settings').then(s => s.aiModel)`,
  );
  check("choosing a fetched model persists it", persistedModel === "test-model", persistedModel);
  check(
    "choosing a fetched model closes the list",
    await evaluate(`!document.querySelector('.combo-popup')`),
  );

  // The reported case: a successful list no longer offers the saved id.
  await setText("Model", "retired-model");
  const beforeReconcile = control.requests.length;
  await pressFetchModels();
  await waitFor(
    `window.__TAURI_INTERNALS__.invoke('get_settings').then(s => s.aiModel === '')`,
    8000,
  );
  const reconcileStatus = await aiStatusNote();
  const reconciledModel = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('get_settings').then(s => s.aiModel)`,
  );
  check(
    "a stale model is cleared after a successful fetch",
    control.requests.length === beforeReconcile + 1 && reconciledModel === "",
    reconcileStatus,
  );
  check("the cleared model leaves the field empty", (await modelInputValue()) === "");
  const clearedNote = await modelFieldNote();
  check(
    "the field explains the clear",
    clearedNote.includes("retired-model") &&
      clearedNote.includes("not offered") &&
      clearedNote.includes("2 fetched models"),
    clearedNote,
  );

  // An endpoint without a list is supported by typing the id, so only proof
  // may clear it.
  await setText("Model", "hand-typed-model");
  control.mode = "emptyModels";
  const beforeEmpty = control.requests.length;
  await pressFetchModels();
  await waitFor(
    `[...document.querySelectorAll('.prefs-row')].some(r => r.querySelector('.prefs-note')?.textContent.includes('empty response'))`,
    8000,
  );
  const emptyStatus = await aiStatusNote();
  const keptModel = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('get_settings').then(s => s.aiModel)`,
  );
  check("an empty list keeps a hand-typed model", keptModel === "hand-typed-model", keptModel);
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

  // A real pointer, not element.click(): typing leaves the Model field focused,
  // and a blur that re-rendered the panel used to replace Fetch before mouseup.
  await evaluate(`(() => {
    const input = (${rowSelector("Model")})?.querySelector('input[type=text]');
    if (!input) return false;
    input.focus();
    input.value = 'second-model';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await closeModelPicker();
  const fetchRect = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.prefs-row')].find(r => [...r.querySelectorAll('button')].some(b => b.textContent === 'Fetch model list'));
    const button = [...(row?.querySelectorAll('button') ?? [])].find(b => b.textContent === 'Fetch model list');
    if (!button) return null;
    button.scrollIntoView({ block: 'center' });
    const box = button.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  if (!fetchRect) throw new Error("no Fetch model list button");
  const beforeFirstClick = control.requests.length;
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fetchRect.x,
    y: fetchRect.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: fetchRect.x,
    y: fetchRect.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(800);
  check(
    "Fetch works on the first click after typing",
    control.requests.length === beforeFirstClick + 1,
    String(control.requests.length - beforeFirstClick),
  );
  const firstClickModel = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('get_settings').then(s => s.aiModel)`,
  );
  check(
    "the first click keeps a model the endpoint offers",
    firstClickModel === "second-model",
    firstClickModel,
  );

  // Saving the key fetches once; the button remains for a manual refresh.
  const openAiStatus = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('ai_status', { provider: 'openai', baseUrl: ${JSON.stringify(baseUrl)} })`,
  );
  if (!openAiStatus.hasKey) {
    await setText("Base URL", baseUrl);
    await setText("Model", "hand-typed-model");
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
    await waitFor(
      `window.__TAURI_INTERNALS__.invoke('get_settings').then(s => s.aiModel === '')`,
      8000,
    );
    const savedReconcile = await evaluate(
      `window.__TAURI_INTERNALS__.invoke('get_settings').then(s => s.aiModel)`,
    );
    check("saving the key reconciles a stale model too", savedReconcile === "", savedReconcile);
    const savedPicker = await openModelPicker();
    check(
      "saving the key fills the picker",
      savedPicker && (await modelOptionIds()).includes("second-model"),
    );
    await closeModelPicker();
    createdOpenAiKey = true;
  } else {
    check("saving the key leaves an existing key alone", true, "an existing key was used");
  }
  await closePrefs();

  // -------------------------------------------------------------------------
  // Typed parameters
  // -------------------------------------------------------------------------

  // The language field is free text: "Catalan" and "pt-BR" are not in the
  // datalist, so typing is the only way to ask for them. This runs after the
  // History checks because every Generate adds a distinct history entry.
  console.log("\nTranslate with a typed target");

  // The Model list section ends on purpose with an empty model (the stale-id
  // reconcile), and an assistant without a model is hidden by `sync()`. Restore
  // one before asking it to translate, or the palette opens Preferences and the
  // panel below is invisible.
  await openAiSection();
  check("the model is restored for the typed target", await setText("Model", "test-model"));
  await closePrefs();
  await waitFor(`!document.querySelector('.ai-assistant')?.hidden`, 5000);

  // CDP inserts into whatever holds focus at dispatch time. A stray focus
  // change would put the language into the editor instead, so prove the field
  // is focused and received the text before anything is generated.
  const typeTargetLanguage = async (value) => {
    const focus = await evaluate(`(() => {
      const panel = document.querySelector('.ai-panel');
      const input = document.querySelector('.ai-params input[type=text]');
      const details = {
        input: Boolean(input),
        panelOpen: !panel?.hidden,
        rootHidden: document.querySelector('.ai-assistant')?.hidden ?? null,
        paletteHidden: document.querySelector('.ai-palette')?.hidden ?? null,
        prefsOpen: Boolean(document.querySelector('.prefs-overlay')?.offsetParent),
        title: document.querySelector('.ai-panel-title')?.textContent ?? '',
        params: (document.querySelector('.ai-params')?.innerHTML ?? '').slice(0, 120),
        active: document.activeElement?.className || document.activeElement?.tagName || '',
      };
      if (!input) return { ok: false, ...details };
      input.focus();
      input.select();
      return { ok: document.activeElement === input, ...details };
    })()`);
    if (!focus.ok) {
      throw new Error(`the language field could not take focus: ${JSON.stringify(focus)}`);
    }
    await send("Input.insertText", { text: value });
    await sleep(120);
    const actual = await evaluate(
      `document.querySelector('.ai-params input[type=text]')?.value ?? ''`,
    );
    if (actual !== value) {
      throw new Error(`the language field holds ${JSON.stringify(actual)}, not ${value}`);
    }
  };

  await clickEditorWord("Regular");
  await chooseAction("Translate…");
  await typeTargetLanguage("Portuguese");
  await evaluate(`document.querySelector('.ai-params .ai-generate').click()`);
  await waitPanelDone();
  check(
    "an answer is visible for the target it was sent with",
    await evaluate(`!document.querySelector('.ai-result').hidden`),
  );
  const beforeTypedTarget = control.requests.length;
  await typeTargetLanguage("Catalan");
  check(
    "typing another target clears the answer the old one produced",
    await evaluate(`document.querySelector('.ai-result').hidden`),
  );
  // Enter is the only submit gesture a single-line field needs. Without it the
  // old answer stayed on screen and the typed target looked ignored.
  await pressKey("Enter", "Enter", 13);
  const typedDone = await waitPanelDone();
  check(
    "Enter sends the typed target",
    typedDone && control.requests.length === beforeTypedTarget + 1,
    `${typedDone ? "done" : "no request"} · ${control.requests.length - beforeTypedTarget} sent`,
  );
  const typedSystem = control.requests.at(-1)?.system ?? "";
  check(
    "the model receives the typed language",
    typedSystem.includes("into Catalan"),
    typedSystem.match(/document into ([^.\n]+)\./)?.[1] ?? "missing",
  );
  await closePanel();

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

  // -------------------------------------------------------------------------
  // File-name suggestions
  // -------------------------------------------------------------------------
  console.log("\nFile-name suggestions");
  await closePanel();
  await closePrefs();
  await closePalette();
  // The native Save picker cannot be photographed or read from the DOM. Stub
  // its IPC reply and record the defaultPath it was given; everything else goes
  // through the untouched fetch transport.
  await evaluate(`(() => {
    const state = window.__filenameTest = { original: window.fetch, defaults: [], next: null };
    window.fetch = async function (input, options) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.hostname !== 'ipc.localhost') return state.original.call(window, input, options);
      const command = decodeURIComponent(url.pathname.slice(1));
      if (command !== 'plugin:dialog|save') return state.original.call(window, input, options);
      const args = typeof options?.body === 'string' ? JSON.parse(options.body) : {};
      state.defaults.push(args.options?.defaultPath ?? args.defaultPath);
      const chosen = state.next;
      state.next = null;
      return new Response(JSON.stringify(chosen), {
        headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
      });
    };
  })()`);
  const nameDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-name-"));
  try {
    // Heading-less text: the assistant is asked and its answer becomes the name.
    await openAiSection();
    check(
      "Suggest file names when saving can be enabled",
      await setCheckbox("Suggest file names when saving", true),
    );
    await closePrefs();
    await newTab();
    await evaluate(`document.querySelector('.cm-content').focus()`);
    await send("Input.insertText", {
      text: "Par de caixas torre Monitor Audio Silver 300 7G, no acabamento Natural Walnut.",
    });
    await sleep(200);
    const beforeName = control.requests.filter((request) => request.action === "filename").length;
    await evaluate(
      `window.__filenameTest.next = ${JSON.stringify(path.join(nameDir, "first.md"))}`,
    );
    await pressCtrl("s", "KeyS", 83);
    await waitFor(
      `[...document.querySelectorAll('.doc-tab-name')].some((tab) => tab.textContent === 'first.md')`,
      12000,
    );
    const firstDefault = await evaluate(`window.__filenameTest.defaults.at(-1)`);
    check(
      "the save dialog uses the assistant's name",
      path.basename(firstDefault ?? "") === "Relações EUA China na Era da IA.md",
      firstDefault,
    );
    const nameRequests = control.requests.filter((request) => request.action === "filename");
    check(
      "one naming request carried the opening",
      nameRequests.length === beforeName + 1,
      String(nameRequests.length - beforeName),
    );
    check(
      "the naming request asked for one line",
      (nameRequests.at(-1)?.system ?? "").includes("file name only"),
    );

    // A heading is authoritative: no request, and the heading is the name.
    await newTab();
    await evaluate(`document.querySelector('.cm-content').focus()`);
    await send("Input.insertText", { text: "# A heading of its own" });
    await sleep(200);
    const beforeHeading = control.requests.filter(
      (request) => request.action === "filename",
    ).length;
    await evaluate(
      `window.__filenameTest.next = ${JSON.stringify(path.join(nameDir, "heading.md"))}`,
    );
    await pressCtrl("s", "KeyS", 83);
    await waitFor(
      `[...document.querySelectorAll('.doc-tab-name')].some((tab) => tab.textContent === 'heading.md')`,
      12000,
    );
    const headingDefault = await evaluate(`window.__filenameTest.defaults.at(-1)`);
    check(
      "a heading is used without asking the model",
      path.basename(headingDefault ?? "") === "A heading of its own.md" &&
        control.requests.filter((request) => request.action === "filename").length ===
          beforeHeading,
      headingDefault,
    );

    // Turning the option off restores the deterministic name and stops requests.
    await openAiSection();
    check(
      "Suggest file names can be turned off",
      await setCheckbox("Suggest file names when saving", false),
    );
    await closePrefs();
    await newTab();
    await evaluate(`document.querySelector('.cm-content').focus()`);
    await send("Input.insertText", { text: "A quiet deterministic line." });
    await sleep(200);
    const beforeQuiet = control.requests.filter((request) => request.action === "filename").length;
    await evaluate(
      `window.__filenameTest.next = ${JSON.stringify(path.join(nameDir, "quiet.md"))}`,
    );
    await pressCtrl("s", "KeyS", 83);
    await waitFor(
      `[...document.querySelectorAll('.doc-tab-name')].some((tab) => tab.textContent === 'quiet.md')`,
      12000,
    );
    const quietDefault = await evaluate(`window.__filenameTest.defaults.at(-1)`);
    check(
      "turning the option off stops the request and keeps the first line",
      path.basename(quietDefault ?? "") === "A quiet deterministic line.md" &&
        control.requests.filter((request) => request.action === "filename").length === beforeQuiet,
      quietDefault,
    );

    // A failing endpoint falls back and the dialog still opens.
    await openAiSection();
    await setCheckbox("Suggest file names when saving", true);
    await closePrefs();
    await newTab();
    await evaluate(`document.querySelector('.cm-content').focus()`);
    await send("Input.insertText", { text: "A line that must survive a failed request." });
    await sleep(200);
    control.mode = "unauthorized";
    await evaluate(
      `window.__filenameTest.next = ${JSON.stringify(path.join(nameDir, "fallback.md"))}`,
    );
    await pressCtrl("s", "KeyS", 83);
    const fallbackOpened = await waitFor(
      `[...document.querySelectorAll('.doc-tab-name')].some((tab) => tab.textContent === 'fallback.md')`,
      12000,
    );
    control.mode = "normal";
    const fallbackDefault = await evaluate(`window.__filenameTest.defaults.at(-1)`);
    check(
      "a failed name request still opens Save with the first line",
      Boolean(fallbackOpened) &&
        path.basename(fallbackDefault ?? "") === "A line that must survive a failed request.md",
      fallbackDefault,
    );
  } finally {
    control.mode = "normal";
    try {
      await evaluate(
        `window.fetch = window.__filenameTest?.original ?? window.fetch; delete window.__filenameTest`,
      );
    } catch {
      /* the app may be gone */
    }
    fs.rmSync(nameDir, { recursive: true, force: true });
  }

  console.log("\nEditable prompts");
  const promptsPath = path.join(process.env.APPDATA ?? "", appIdentifier, "ai-prompts.md");
  // This block owns the prompt file for its duration. A developer running the
  // suite outside the harness must get their own prompts back, and a file left
  // by an earlier run must not decide what this one measures.
  const promptsBackup = fs.existsSync(promptsPath) ? fs.readFileSync(promptsPath) : null;
  try {
    const resetDisabled = () =>
      evaluate(`(() => {
        const button = [...document.querySelectorAll('.prefs-row .prefs-button')].find(b => b.textContent === 'Reset prompts to defaults');
        return button ? button.disabled : null;
      })()`);
    const activateTab = (name) =>
      evaluate(`(() => {
        const tab = [...document.querySelectorAll('.doc-tab')].find(t => t.querySelector('.doc-tab-name')?.textContent === ${JSON.stringify(name)});
        if (!tab) return false;
        tab.click();
        return true;
      })()`);
    const MARKER = "Count the words in the passage and stop.";

    await closePanel();
    await openAiSection();
    const initialNote = await waitFor(
      `(() => {
        const note = [...document.querySelectorAll('.prefs-row')].find(r => r.querySelector('.prefs-label')?.textContent.replace(/\\?$/, '') === 'Prompts file')?.querySelector('.prefs-note')?.textContent ?? '';
        return note && !note.startsWith('Reading') ? note : null;
      })()`,
      8000,
    );
    check(
      "the AI section says which prompts are in use",
      /built-in|matches the generated file|customised/.test(String(initialNote)),
      String(initialNote),
    );
    check("Edit prompts is offered", await clickPrefsButton("Edit prompts…"));
    check(
      "ai-prompts.md opens as a tab",
      Boolean(
        await waitFor(
          `[...document.querySelectorAll('.doc-tab-name')].some(t => t.textContent === 'ai-prompts.md')`,
          12_000,
        ),
      ),
    );
    await closePrefs();
    check(
      "the generated file carries the header and the prompts",
      fs.existsSync(promptsPath) &&
        (() => {
          const generated = fs.readFileSync(promptsPath, "utf8");
          return (
            generated.startsWith("# MDraft AI prompts") &&
            generated.includes("## preamble") &&
            generated.includes("## summarize") &&
            generated.includes("## improve")
          );
        })(),
    );

    // A partial file is a valid override: only the section it names changes.
    await activateTab("ai-prompts.md");
    await sleep(150);
    await evaluate(`document.querySelector('.cm-content').focus()`);
    await pressCtrl("a", "KeyA", 65);
    await send("Input.insertText", {
      text: ["## summarize", "", "```", MARKER, "```", ""].join("\n"),
    });
    await sleep(250);
    await pressCtrl("s", "KeyS", 83);
    let savedPrompt = false;
    for (let attempt = 0; attempt < 60 && !savedPrompt; attempt += 1) {
      savedPrompt =
        fs.existsSync(promptsPath) && fs.readFileSync(promptsPath, "utf8").includes(MARKER);
      if (!savedPrompt) await sleep(100);
    }
    check("the edited prompt is saved to disk", savedPrompt);

    check("the fixture tab is back", await activateTab("feature-tour.md"));
    await sleep(200);
    await clickEditorWord("Regular");
    await chooseAction("Summarize");
    await waitPanelDone();
    const editedRequest = control.requests.at(-1);
    check(
      "the edited prompt reaches the model",
      (editedRequest?.system ?? "").includes(MARKER),
      (editedRequest?.system ?? "").slice(0, 70),
    );
    check(
      "the wrapper tag is still imposed by the application",
      (editedRequest?.system ?? "").includes("<mdraft-summary>"),
    );
    await closePanel();

    await openAiSection();
    const counted = await waitFor(
      `(() => {
        const note = [...document.querySelectorAll('.prefs-row')].find(r => r.querySelector('.prefs-label')?.textContent.replace(/\\?$/, '') === 'Prompts file')?.querySelector('.prefs-note')?.textContent ?? '';
        return note.includes('customised') ? note : null;
      })()`,
      8000,
    );
    check(
      "the note counts the customised prompt",
      String(counted ?? "").includes("1 of 16"),
      String(counted),
    );
    check("Reset is enabled for a clean file", (await resetDisabled()) === false);
    check("Reset prompts to defaults", await clickPrefsButton("Reset prompts to defaults"));
    const resetNote = await waitFor(
      `(() => {
        const note = [...document.querySelectorAll('.prefs-row')].find(r => r.querySelector('.prefs-label')?.textContent.replace(/\\?$/, '') === 'Prompts file')?.querySelector('.prefs-note')?.textContent ?? '';
        return note.includes('built-in') ? note : null;
      })()`,
      8000,
    );
    const restored = fs.existsSync(promptsPath) ? fs.readFileSync(promptsPath, "utf8") : "";
    check(
      "Reset rewrites the built-in prompts",
      Boolean(resetNote) && restored.includes("## preamble") && !restored.includes(MARKER),
      String(resetNote),
    );
    await closePrefs();
    await activateTab("ai-prompts.md");
    await sleep(150);
    await scrollEditorTop();
    check(
      "the open prompts tab is reloaded",
      (await waitFor(
        `(document.querySelector('.cm-line')?.textContent ?? '') === '# MDraft AI prompts'`,
        8000,
      )) === true,
    );

    // The safety net: a file that no longer parses must be reported, and Reset
    // must work anyway, because that is the only way back.
    fs.writeFileSync(
      promptsPath,
      ["## summarise", "", "```", "A typo in the section name.", "```", ""].join("\n"),
      "utf8",
    );
    await activateTab("feature-tour.md");
    await sleep(200);
    await clickEditorWord("Regular");
    await chooseAction("Summarize");
    const failure = await waitFor(
      `(() => {
        const status = document.querySelector('.ai-status')?.textContent ?? '';
        return status.includes('ai-prompts.md') ? status : null;
      })()`,
      8000,
    );
    check(
      "a file that does not parse is reported in the panel",
      String(failure ?? "").includes("unknown action"),
      String(failure),
    );
    await closePanel();
    await openAiSection();
    check(
      "Reset recovers a file that cannot be used",
      await clickPrefsButton("Reset prompts to defaults"),
    );
    const recovered = await waitFor(
      `(() => {
        const note = [...document.querySelectorAll('.prefs-row')].find(r => r.querySelector('.prefs-label')?.textContent.replace(/\\?$/, '') === 'Prompts file')?.querySelector('.prefs-note')?.textContent ?? '';
        return note.includes('built-in') ? note : null;
      })()`,
      8000,
    );
    check(
      "the file parses again after Reset",
      Boolean(recovered) &&
        fs.existsSync(promptsPath) &&
        fs.readFileSync(promptsPath, "utf8").includes("## preamble"),
      String(recovered),
    );
    await closePrefs();

    // A dirty buffer is the one thing Reset must refuse: a rewrite would throw
    // away an edit the reader has not saved.
    await activateTab("ai-prompts.md");
    await sleep(150);
    await evaluate(`document.querySelector('.cm-content').focus()`);
    await send("Input.insertText", { text: "x" });
    await sleep(250);
    await openAiSection();
    const dirtyRefusal = await waitFor(
      `(() => {
        const button = [...document.querySelectorAll('.prefs-row .prefs-button')].find(b => b.textContent === 'Reset prompts to defaults');
        return button ? button.disabled : false;
      })()`,
      5000,
    ).catch(() => false);
    check("Reset is refused while the prompts tab has unsaved changes", dirtyRefusal === true);
    await closePrefs();
    await evaluate(`document.querySelector('.cm-content').focus()`);
    await undo();
    await waitFor(
      `![...document.querySelectorAll('.doc-tab')].some(t => t.querySelector('.doc-tab-name')?.textContent === 'ai-prompts.md' && t.classList.contains('is-dirty'))`,
      4000,
    );
  } finally {
    try {
      if (promptsBackup) fs.writeFileSync(promptsPath, promptsBackup);
      else fs.rmSync(promptsPath, { force: true });
    } catch {
      /* the app may be gone */
    }
  }

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
  // -------------------------------------------------------------------------
  // Request and anchor ownership (audit F4, F15)
  // -------------------------------------------------------------------------

  console.log("\nOwnership: a covered request still completes");
  await closePanel();
  await closeHistory();
  control.mode = "hold";
  await clickEditorWord("Regular");
  await chooseAction("Summarize");
  await waitFor(`(document.querySelector('.ai-answer')?.textContent ?? '').length > 0`, 5000);
  await openPalette();
  control.release?.();
  control.mode = "normal";
  await sleep(1200);
  await closePalette();
  await openHistory();
  const coveredRows = await historyRows();
  check(
    "a request covered by the palette completes into History",
    coveredRows[0]?.title === "Summarize",
    coveredRows[0]?.title,
  );
  await closeHistory();

  console.log("\nOwnership: a new action abandons the old request");
  control.mode = "hold";
  const cancelledBeforeReplace = control.cancelled;
  await clickEditorWord("Regular");
  await chooseAction("Expand");
  await waitFor(`(document.querySelector('.ai-answer')?.textContent ?? '').length > 0`, 5000);
  control.mode = "normal";
  await chooseAction("Shorten");
  check(
    "choosing another action cancels the abandoned request at the provider",
    await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (control.cancelled > cancelledBeforeReplace) return true;
        await sleep(80);
      }
      return false;
    })(),
    `${cancelledBeforeReplace} -> ${control.cancelled}`,
  );
  await waitPanelDone();
  await closePanel();

  console.log("\nOwnership: Stop before the provider sends headers");
  control.mode = "stallHeaders";
  const cancelledBeforeStall = control.cancelled;
  await clickEditorWord("Regular");
  await chooseAction("Expand");
  await waitFor(
    `[...document.querySelectorAll('.ai-panel .ai-footer-actions button')].some(b => b.textContent === 'Stop')`,
    5000,
  );
  await sleep(400);
  const stopClickedAt = Date.now();
  await clickFooter("Stop");
  const stalledStop = await waitFor(
    `document.querySelector('.ai-status')?.textContent?.startsWith('Stopped')`,
    6000,
  );
  check(
    "Stop ends a request whose provider withholds headers",
    stalledStop !== null && Date.now() - stopClickedAt < 6000,
    await panelStatus(),
  );
  const closedAt = Date.now();
  while (control.cancelled === cancelledBeforeStall && Date.now() - closedAt < 3000)
    await sleep(80);
  check(
    "the stalled connection is closed",
    control.cancelled > cancelledBeforeStall,
    String(control.cancelled - cancelledBeforeStall),
  );
  const stalledFooter = await footerButtons();
  check(
    "an empty stopped answer cannot be copied",
    stalledFooter.find((b) => b.text === "Copy")?.disabled === true,
    JSON.stringify(stalledFooter),
  );
  control.release?.();
  control.mode = "normal";
  await closePanel();

  console.log("\nOwnership: Insert below follows an edit above the passage");
  const beforeAnchor = await editorText();
  control.mode = "hold";
  await clickEditorWord("Regular");
  const anchorLine = await evaluate(
    `[...document.querySelectorAll('.cm-line')].find(l => l.textContent.includes('Regular'))?.textContent ?? ''`,
  );
  await chooseAction("Improve writing");
  await waitFor(`(document.querySelector('.ai-answer')?.textContent ?? '').length > 0`, 5000);
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await pressCtrl("Home", "Home", 36);
  await send("Input.insertText", { text: "Inserted lead paragraph.\n\n" });
  await sleep(200);
  control.release?.();
  control.mode = "normal";
  await waitPanelDone(10_000);
  check("Insert below is still offered for a mappable target", await clickFooter("Insert below"));
  const afterAnchor = (await editorText()).split("\n");
  const answerIndex = afterAnchor.findIndex((line) =>
    line.includes("Improved passage from the mock."),
  );
  let previous = answerIndex - 1;
  while (previous >= 0 && afterAnchor[previous].trim() === "") previous -= 1;
  check(
    "the answer lands below the paragraph it was requested for",
    answerIndex > 0 && afterAnchor[previous] === anchorLine,
    `${JSON.stringify(afterAnchor[previous])} vs ${JSON.stringify(anchorLine)}`,
  );
  await undo();
  check(
    "the mapped insertion undoes as one step",
    !(await editorText()).includes("Improved passage from the mock.") &&
      (await editorText()).startsWith("Inserted lead paragraph."),
  );
  await undo();
  await closePanel();
  check("the document is back to its text", (await editorText()) === beforeAnchor);

  console.log("\nOwnership: a deleted target is not guessed");
  control.mode = "hold";
  await clickEditorWord("Regular");
  await chooseAction("Improve writing");
  await waitFor(`(document.querySelector('.ai-answer')?.textContent ?? '').length > 0`, 5000);
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await pressCtrl("a", "KeyA", 65);
  await send("Input.insertText", { text: "Everything was replaced." });
  await sleep(200);
  control.release?.();
  control.mode = "normal";
  await waitPanelDone(10_000);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.ai-panel .ai-footer-actions button')].find(b => b.textContent === 'Insert below');
    if (button && !button.disabled) button.click();
  })()`);
  await sleep(250);
  check(
    "Insert below refuses when its paragraph was deleted",
    (await editorText()) === "Everything was replaced." &&
      /deleted|is gone/.test(await panelStatus()),
    await panelStatus(),
  );
  await closePanel();
  await undo();
  check("the replaced document is restored", (await editorText()) === beforeAnchor);

  console.log("\nOwnership: choosing the same target again keeps one history row");
  await clickEditorWord("Regular");
  await chooseAction("Translate…");
  const setTarget = () =>
    evaluate(
      `(() => { const input = document.querySelector('.ai-params input[type=text]'); input.value = 'Portuguese'; input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); })()`,
    );
  await setTarget();
  await sleep(100);
  await evaluate(`document.querySelector('.ai-params .ai-generate').click()`);
  await waitPanelDone();
  await setTarget();
  await sleep(100);
  await clickRegenerate();
  await waitPanelDone();
  await closePanel();
  await openHistory();
  const sameTargetRows = await historyRows();
  await closeHistory();
  check(
    "Regenerate after re-choosing the same target replaces its history row",
    sameTargetRows[0]?.title === "Translate · Portuguese" &&
      sameTargetRows[1]?.title !== "Translate · Portuguese",
    JSON.stringify(sameTargetRows.slice(0, 3).map((row) => row.title)),
  );
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
      aiContextTokens: original.aiContextTokens,
      aiDisableReasoning: original.aiDisableReasoning,
      aiSuggestFilename: original.aiSuggestFilename,
      // The suite's own requests are uses of the action; a standalone run
      // against the developer's profile must put the counter back.
      aiActionUsage: original.aiActionUsage,
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
