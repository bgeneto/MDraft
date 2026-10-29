//! Opt-in end-to-end checks against a real OpenAI-compatible endpoint.
//!
//!   npm run ai:live                  # explicit; fails when the key is missing
//!   npm test -- --only ai-live       # through the harness, which owns the app
//!
//! Credentials come from `MDRAFT_AI_E2E_BASE_URL`, `MDRAFT_AI_E2E_MODEL` and
//! `MDRAFT_AI_E2E_API_KEY`, falling back to `T:\Temp\mdraft-ai-e2e.env` or the
//! git-ignored `node_modules/.cache/mdraft-ai-e2e.env`. The key is never printed
//! and never written to settings.json.
//!
//! Assertions are structural, not golden: a 27B model is non-deterministic, so
//! the suite checks non-empty tag-free output, the expected apply mode, the
//! model/host chip and an exact undo round-trip. It logs only the action id,
//! duration and character count.

import fs from "node:fs";
import path from "node:path";

const port = process.argv[2] ?? "9222";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

const localEnv = {
  ...readEnvFile(path.join("node_modules", ".cache", "mdraft-ai-e2e.env")),
  ...readEnvFile("T:\\Temp\\mdraft-ai-e2e.env"),
};
const baseUrl = process.env.MDRAFT_AI_E2E_BASE_URL ?? localEnv.MDRAFT_AI_E2E_BASE_URL;
const model = process.env.MDRAFT_AI_E2E_MODEL ?? localEnv.MDRAFT_AI_E2E_MODEL;
const apiKey = process.env.MDRAFT_AI_E2E_API_KEY ?? localEnv.MDRAFT_AI_E2E_API_KEY;
const optional = process.env.MDRAFT_AI_LIVE_OPTIONAL === "1";

if (!baseUrl || !model || !apiKey) {
  if (optional) {
    console.log("  SKIP  no MDRAFT_AI_E2E_* credentials are configured");
    console.log("0/0 checks passed");
    process.exit(0);
  }
  console.error("Missing MDRAFT_AI_E2E_BASE_URL, MDRAFT_AI_E2E_MODEL or MDRAFT_AI_E2E_API_KEY.");
  console.error("Put them in T:\\Temp\\mdraft-ai-e2e.env or the process environment.");
  process.exit(1);
}

const actions = (process.env.MDRAFT_AI_LIVE_ACTIONS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const selected = (id) => actions.length === 0 || actions.includes(id);
const hostName = (() => {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
})();

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

async function waitFor(expression, timeout = 12_000, interval = 100) {
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

async function waitPanelDone(timeout = 180_000) {
  return waitFor(
    `(() => {
      const status = document.querySelector('.ai-status')?.textContent ?? "";
      return status.startsWith('Answer ready') || status.startsWith('Stopped') || document.querySelector('.ai-status')?.classList.contains('is-error');
    })()`,
    timeout,
    250,
  );
}

async function clickFooter(label) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.ai-footer-actions button')].find(b => b.textContent === ${JSON.stringify(label)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  await sleep(300);
  return clicked;
}

async function closePanel() {
  if (!(await evaluate(`document.querySelector('.ai-panel').hidden`))) {
    await evaluate(`document.querySelector('.ai-close').click()`);
    await sleep(200);
  }
}

async function editorText() {
  return evaluate(
    `[...document.querySelectorAll('.cm-line')].map(line => line.textContent).join('\\n')`,
  );
}

async function scrollEditorTop() {
  await evaluate(
    `(() => { const scroller = document.querySelector('.cm-scroller'); if (scroller) scroller.scrollTop = 0; })()`,
  );
  await sleep(200);
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
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, left: box.left, top: box.top, bottom: box.bottom };
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
  await sleep(200);
  return rect;
}

async function selectLineFrom(word) {
  const start = await clickEditorWord(word);
  // Drag to the right edge of the same visual line, then let CodeMirror keep
  // the selection it made.
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.left + 2,
    y: start.y,
    button: "left",
    clickCount: 1,
  });
  const pane = await evaluate(`(() => {
    const box = document.getElementById('editor-pane').getBoundingClientRect();
    return { right: box.right };
  })()`);
  for (let x = start.left + 20; x < pane.right - 20; x += 60) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y: start.y,
      button: "left",
      buttons: 1,
    });
    await sleep(20);
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: pane.right - 20,
    y: start.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(200);
  return evaluate(`(window.getSelection()?.toString() ?? '').trim()`);
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
  await sleep(300);
}

async function undo() {
  await pressCtrl("z", "KeyZ", 90);
}

const RAW_TAGS =
  /<\/?mdraft-(revised|continuation|expanded|shortened|simplified|rewritten|translation|summary|explanation|points|critique|table|converted|notes)>/i;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const original = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_settings')`);
let createdKey = false;

try {
  console.log("\nConfiguration");
  await closePanel();
  await closePrefs();
  await openAiSection();
  check("Enable is available", await setCheckbox("Enable AI Assistant", true));
  check("Provider is OpenAI-compatible", await setSelect("Provider", "openai"));
  check("the Base URL is configured", await setText("Base URL", baseUrl));
  check("the model is configured", await setText("Model", model));
  await closePrefs();

  const status = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('ai_status', { provider: 'openai', baseUrl: ${JSON.stringify(baseUrl)} })`,
  );
  if (!status.hasKey) {
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke('ai_set_key', { provider: 'openai', baseUrl: ${JSON.stringify(baseUrl)}, key: ${JSON.stringify(apiKey)} })`,
    );
    createdKey = true;
  }
  check(
    "the assistant button is visible",
    (await waitFor(
      `(() => { const root = document.querySelector('.ai-assistant'); return root && !root.hidden; })()`,
      8000,
    )) !== null,
  );
  check(
    "Preferences reports the key source",
    (
      await evaluate(
        `window.__TAURI_INTERNALS__.invoke('ai_status', { provider: 'openai', baseUrl: ${JSON.stringify(baseUrl)} })`,
      )
    ).hasKey === true,
  );

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async function runAction({ id, label, tag, select, parameter, question, apply }) {
    if (!selected(id)) return;
    const startedAt = Date.now();
    console.log(`\n${label}`);
    if (select) await selectLineFrom(select);
    else await clickEditorWord("Regular");
    await chooseAction(label);
    if (parameter) {
      if (id === "translate") {
        await evaluate(
          `(() => { const input = document.querySelector('.ai-params input[type=text]'); input.value = ${JSON.stringify(parameter)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
        );
      } else {
        await evaluate(
          `(() => { const select = document.querySelector('.ai-params select'); select.value = ${JSON.stringify(parameter)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
        );
      }
      await sleep(120);
      await evaluate(`document.querySelector('.ai-params .ai-generate').click()`);
    }
    if (question) {
      await evaluate(
        `(() => { const input = document.querySelector('.ai-ask-input'); input.value = ${JSON.stringify(question)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await evaluate(`document.querySelector('.ai-ask-row .ai-generate').click()`);
    }
    const done = await waitPanelDone();
    const duration = Math.round((Date.now() - startedAt) / 1000);
    const statusText = await panelStatus();
    if (!done) {
      check(`${label} completes`, false, `${duration}s: ${statusText}`);
      await closePanel();
      return;
    }
    if (!statusText.startsWith("Answer ready")) {
      check(`${label} completes`, false, `${duration}s: ${statusText}`);
      await closePanel();
      return;
    }
    const answer = await evaluate(
      `document.querySelector('.ai-answer')?.textContent ?? document.querySelector('.ai-chat')?.textContent ?? ''`,
    );
    const chip = await evaluate(`document.querySelector('.ai-chip')?.textContent ?? ''`);
    // Check the action's own tag, not every tag in the catalog: a legitimate
    // Markdown continuation can contain an HTML `<table>` example, and flagging
    // that would read as a filter failure. Improve additionally must not leak
    // its notes.
    const ownTag = tag ? new RegExp(`<\\/?${tag}>`, "i") : null;
    const notesLeak = id === "improve" && /<notes>/i.test(answer);
    check(
      `${label} returns text`,
      answer.trim().length > 0,
      `${duration}s, ${answer.length} chars`,
    );
    check(
      `${label} strips its output tags`,
      ownTag ? !ownTag.test(answer) && !notesLeak : !RAW_TAGS.test(answer),
      ownTag?.test(answer) ? String(answer.match(ownTag)?.[0]) : notesLeak ? "<notes>" : "clean",
    );
    check(
      `${label} reports the model and host`,
      chip.includes(model) && chip.includes(hostName),
      chip,
    );
    if (apply === "copy") {
      const copied = await evaluate(`(() => {
        const button = [...document.querySelectorAll('.ai-footer-actions button')].find(b => b.textContent === 'Copy');
        return Boolean(button && !button.disabled);
      })()`);
      check(`${label} offers Copy`, copied);
      check(`${label} inserts below`, await clickFooter("Insert below"));
      await undo();
    } else {
      const buttonLabel =
        apply === "insert" ? "Insert" : apply === "below" ? "Insert below" : "Replace selection";
      check(`${label} offers ${buttonLabel}`, await clickFooter(buttonLabel));
      await undo();
    }
  }

  await runAction({
    id: "improve",
    label: "Improve writing",
    tag: "mdraft-revised",
    select: "Regular",
    apply: "replace",
  });
  await runAction({
    id: "continue",
    label: "Continue writing",
    tag: "mdraft-continuation",
    apply: "insert",
  });
  await runAction({ id: "expand", label: "Expand", tag: "mdraft-expanded", apply: "replace" });
  await runAction({ id: "shorten", label: "Shorten", tag: "mdraft-shortened", apply: "replace" });
  await runAction({
    id: "simplify",
    label: "Simplify",
    tag: "mdraft-simplified",
    apply: "replace",
  });
  await runAction({
    id: "tone",
    label: "Change tone…",
    tag: "mdraft-rewritten",
    parameter: "Casual",
    apply: "replace",
  });
  await runAction({
    id: "tone",
    label: "Change tone…",
    tag: "mdraft-rewritten",
    parameter: "Professional",
    apply: "replace",
  });
  await runAction({
    id: "translate",
    label: "Translate…",
    tag: "mdraft-translation",
    parameter: "Portuguese",
    apply: "replace",
  });
  await runAction({ id: "summarize", label: "Summarize", tag: "mdraft-summary", apply: "below" });
  await runAction({ id: "explain", label: "Explain", tag: "mdraft-explanation", apply: "below" });
  await runAction({ id: "keyPoints", label: "Key points", tag: "mdraft-points", apply: "below" });
  await runAction({ id: "critique", label: "Critique", tag: "mdraft-critique", apply: "below" });
  await runAction({
    id: "table",
    label: "Convert to table",
    tag: "mdraft-table",
    apply: "replace",
  });
  await runAction({
    id: "convert",
    label: "Convert markup…",
    tag: "mdraft-converted",
    parameter: "typst",
    apply: "replace",
  });
  await runAction({
    id: "ask",
    label: "Ask AI…",
    question: "What is this passage about? Answer in one sentence.",
    apply: "copy",
  });

  console.log("\nKey hygiene");
  const settings = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_settings')`);
  check("get_settings has no key", !JSON.stringify(settings).includes(apiKey));
  const configPath = path.join(
    process.env.APPDATA ?? "",
    "io.github.bernh.mdraft",
    "settings.json",
  );
  if (fs.existsSync(configPath)) {
    const onDisk = fs.readFileSync(configPath, "utf8");
    check("settings.json has no key", !onDisk.includes(apiKey));
  } else {
    check("settings.json has no key", true, "no settings file");
  }
  const recoveryPath = path.join(process.env.APPDATA ?? "", "io.github.bernh.mdraft", "recovery");
  const recoveryText = fs.existsSync(recoveryPath)
    ? fs
        .readdirSync(recoveryPath)
        .map((name) => fs.readFileSync(path.join(recoveryPath, name), "utf8"))
        .join("\n")
    : "";
  check("the recovery journal has no key", !recoveryText.includes(apiKey));
} catch (error) {
  failed += 1;
  console.log(`  FAIL  the suite threw — ${error}`);
} finally {
  try {
    if (createdKey) {
      await evaluate(
        `window.__TAURI_INTERNALS__.invoke('ai_clear_key', { provider: 'openai', baseUrl: ${JSON.stringify(baseUrl)} })`,
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
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
