// Asynchronous ownership in the real window (audit F2, F3, F5, F16).
//
//   node scripts/ownership-test.mjs [port]
//
// Run through `npm test -- --only ownership` for an owned profile. Every delay
// is a gate in this script's own `window.fetch` wrapper around the IPC
// transport, released by the script, never a sleep that hopes for an ordering:
//
// - two concurrent opens of one path leave one tab (F3);
// - an image paste whose tab was hidden lands in that tab, undoably, and one
//   whose tab was closed inserts nothing and names the saved file (F2);
// - a menu paste whose target changed during the clipboard read inserts
//   nothing (F2);
// - Auto Save during an open close dialog does not void Discard (F16);
// - a failed HTML preview render is not treated as current (F5).
//
// The image and clipboard routes answer from the wrapper, so no file is written
// to the fixture folder and the system clipboard is never read.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPage, emitMenu, sleep } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";
const page = await openPage(port);
const evaluate = page.evaluate;

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
async function waitFor(expression, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
}
const invoke = (command, args = {}) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
const tab = (name) =>
  `[...document.querySelectorAll('.doc-tab')].find(t=>t.querySelector('.doc-tab-name')?.textContent===${JSON.stringify(name)})`;
const names = () =>
  evaluate(`[...document.querySelectorAll('.doc-tab-name')].map(t=>t.textContent)`);
const text = () =>
  evaluate(
    `[...document.querySelectorAll('.cm-line')].map(l=>l.textContent).join('\\n').replace(/​/g,'').trimEnd()`,
  );
const dirty = (name) => evaluate(`${tab(name)}?.classList.contains('is-dirty')??false`);
const toastText = () => evaluate(`document.getElementById('toast')?.textContent ?? ''`);
async function select(name) {
  await evaluate(`${tab(name)}?.click()`);
  await waitFor(`${tab(name)}?.getAttribute('aria-selected')==='true'`);
  await sleep(250);
}
async function open(file) {
  await invoke("plugin:event|emit", { event: "open-files", payload: [file] });
  await waitFor(`${tab(path.basename(file))}?.getAttribute('aria-selected')==='true'`);
  await sleep(250);
}
async function key(keyName, code, virtualKey, modifiers = 0) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: keyName,
      code,
      windowsVirtualKeyCode: virtualKey,
      modifiers,
    });
  }
  await sleep(80);
}
async function typeAtEnd(value) {
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await key("End", "End", 35, 2);
  await page.send("Input.insertText", { text: value });
  await sleep(250);
}
async function closeTab(name, decision = "discard") {
  await evaluate(`${tab(name)}?.querySelector('.doc-tab-close')?.click()`);
  if (await waitFor(`!!document.querySelector('.unsaved-dialog[open]')`, 1500)) {
    await evaluate(
      `document.querySelector('.unsaved-dialog [data-decision=${JSON.stringify(decision)}]').click()`,
    );
  }
  await waitFor(`!${tab(name)}`, 4000);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-ownership-"));
const files = {
  a: path.join(work, "a.md"),
  b: path.join(work, "b.md"),
  c: path.join(work, "c.md"),
  html: path.join(work, "page.html"),
};
fs.writeFileSync(files.a, "Alpha paragraph.\n");
fs.writeFileSync(files.b, "Bravo paragraph.\n");
fs.writeFileSync(files.c, "Charlie paragraph.\n");
fs.writeFileSync(
  files.html,
  "<!doctype html>\n<html><body><h1>HTML owner</h1>\n<p>One paragraph.</p>\n</body></html>\n",
);
const savedImage = {
  absolutePath: path.join(work, "assets", "pasted.png"),
  markdownPath: "assets/pasted.png",
  bytes: 4,
  source: "clipboard",
};

let hooked = false;
try {
  await waitFor(
    `document.querySelector('.cm-content') && document.title.endsWith(' — MDraft')`,
    60000,
  );
  await sleep(500);

  // Test-only interception. Production code has no test globals or commands.
  await evaluate(`(() => {
    const state = window.__ownershipTestOnly = { original: window.fetch, calls: {}, gates: {}, fail: {} };
    const response = (value, ok = true) => new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json', 'Tauri-Response': ok ? 'ok' : 'error' },
    });
    window.fetch = async function (input, options) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.hostname !== 'ipc.localhost') return state.original.call(window, input, options);
      const command = decodeURIComponent(url.pathname.slice(1));
      const args = typeof options?.body === 'string' ? JSON.parse(options.body) : {};
      state.calls[command] = (state.calls[command] ?? 0) + 1;
      if (state.fail[command]) {
        delete state.fail[command];
        return response('Injected ' + command + ' failure', false);
      }
      const gate = state.gates[command];
      if (gate && !gate.entered && (!gate.path || args?.path === gate.path)) {
        gate.entered = true;
        await new Promise((resolve) => { gate.release = resolve; });
        if ('answer' in gate) return response(gate.answer);
      }
      return state.original.call(window, input, options);
    };
  })()`);
  hooked = true;
  const gate = (command, extra = {}) =>
    evaluate(
      `window.__ownershipTestOnly.gates[${JSON.stringify(command)}] = Object.assign({ entered: false }, ${JSON.stringify(extra)})`,
    );
  const entered = (command) =>
    waitFor(`window.__ownershipTestOnly.gates[${JSON.stringify(command)}]?.entered === true`);
  const release = (command) =>
    evaluate(
      `(() => { const g = window.__ownershipTestOnly.gates[${JSON.stringify(command)}]; delete window.__ownershipTestOnly.gates[${JSON.stringify(command)}]; g?.release?.(); })()`,
    );
  const calls = (command) =>
    evaluate(`window.__ownershipTestOnly.calls[${JSON.stringify(command)}] ?? 0`);

  await open(files.a);
  await open(files.b);

  // -------------------------------------------------------------------------
  console.log("\n=== two opens of one path (F3) ===");
  await gate("read_document", { path: files.c });
  // Drag and drop calls `openPath` directly, outside the bulk-open chain.
  for (let n = 0; n < 2; n += 1) {
    await invoke("plugin:event|emit", {
      event: "tauri://drag-drop",
      payload: { paths: [files.c], position: { x: 120, y: 120 } },
    });
  }
  check("the first read of c.md is held", await entered("read_document"));
  await sleep(300);
  await release("read_document");
  await waitFor(`${tab("c.md")}?.getAttribute('aria-selected')==='true'`);
  await sleep(800);
  check(
    "two concurrent opens of one path leave one tab",
    (await names()).filter((name) => name === "c.md").length === 1,
    JSON.stringify(await names()),
  );
  await closeTab("c.md");

  // -------------------------------------------------------------------------
  console.log("\n=== an image paste whose tab was hidden (F2) ===");
  const pasteImage = () =>
    evaluate(`(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'pasted.png', { type: 'image/png' }));
      document.querySelector('.cm-content').focus();
      document.querySelector('.cm-content').dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    })()`);
  await select("a.md");
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await key("End", "End", 35, 2);
  await gate("save_clipboard_image", { answer: savedImage });
  await pasteImage();
  check("the image save is held", await entered("save_clipboard_image"));
  await select("b.md");
  await release("save_clipboard_image");
  await waitFor(`document.getElementById('toast')?.textContent.includes('Pasted into')`, 4000);
  check("the tab on screen is not edited", (await text()) === "Bravo paragraph.", await text());
  check(
    "the reader is told which tab received the paste",
    (await toastText()).includes("a.md"),
    await toastText(),
  );
  check("the hidden tab is marked dirty", await dirty("a.md"));
  await select("a.md");
  check(
    "the image lands in the tab it was pasted into",
    (await text()).startsWith("Alpha paragraph.") && (await text()).includes("assets/pasted.png"),
    JSON.stringify(await text()),
  );
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await key("z", "KeyZ", 90, 2);
  await sleep(300);
  check(
    "the hidden-tab paste undoes as one step",
    (await text()) === "Alpha paragraph." && !(await dirty("a.md")),
    JSON.stringify(await text()),
  );

  console.log("\n=== an image paste whose tab was closed (F2) ===");
  await gate("save_clipboard_image", { answer: savedImage });
  await pasteImage();
  check("the second image save is held", await entered("save_clipboard_image"));
  await closeTab("a.md");
  await select("b.md");
  await release("save_clipboard_image");
  await waitFor(`document.getElementById('toast')?.textContent.includes('not inserted')`, 4000);
  check(
    "a paste whose tab was closed inserts nothing and names the saved image",
    (await text()) === "Bravo paragraph." && (await toastText()).includes(savedImage.absolutePath),
    await toastText(),
  );
  await open(files.a);

  // -------------------------------------------------------------------------
  console.log("\n=== a menu paste whose target changed during the read (F2) ===");
  await evaluate(`(() => {
    const clip = navigator.clipboard;
    window.__ownershipTestOnly.clipboardRead = clip.read;
    window.__ownershipTestOnly.clipboard = {};
    Object.defineProperty(clip, 'read', {
      configurable: true,
      value: () => new Promise((resolve) => {
        window.__ownershipTestOnly.clipboard.release = () => resolve([
          new ClipboardItem({ 'text/plain': new Blob(['PASTED FROM CLIPBOARD'], { type: 'text/plain' }) }),
        ]);
      }),
    });
  })()`);
  await select("a.md");
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await emitMenu(page, "edit.pastePlain");
  check(
    "the clipboard read is held",
    await waitFor(`typeof window.__ownershipTestOnly.clipboard.release === 'function'`),
  );
  await select("b.md");
  await evaluate(`window.__ownershipTestOnly.clipboard.release()`);
  await waitFor(`document.getElementById('toast')?.textContent.includes('paste again')`, 4000);
  const bAfterClip = await text();
  await select("a.md");
  check(
    "a paste whose target changed is cancelled, not redirected",
    bAfterClip === "Bravo paragraph." && (await text()) === "Alpha paragraph.",
    `${JSON.stringify(bAfterClip)} / ${JSON.stringify(await text())}`,
  );
  await evaluate(`(() => {
    const original = window.__ownershipTestOnly.clipboardRead;
    delete navigator.clipboard.read;
    if (navigator.clipboard.read !== original) {
      Object.defineProperty(navigator.clipboard, 'read', { configurable: true, value: original });
    }
  })()`);

  // -------------------------------------------------------------------------
  console.log("\n=== Auto Save while the close dialog is open (F16) ===");
  const autoSave = async () => (await invoke("get_settings")).autoSave;
  if (!(await autoSave())) await emitMenu(page, "file.autoSave");
  await waitFor(`window.__TAURI_INTERNALS__.invoke('get_settings').then(s => s.autoSave)`, 4000);
  check("Auto Save is on", await autoSave());
  await select("a.md");
  await typeAtEnd(" Edited.");
  check("a.md is dirty before the close", await dirty("a.md"));
  await evaluate(`${tab("a.md")}?.querySelector('.doc-tab-close')?.click()`);
  check(
    "the close asks about unsaved changes",
    await waitFor(`!!document.querySelector('.unsaved-dialog[open]')`, 3000),
  );
  // One full Auto Save interval (20 s) passes with the dialog open.
  await sleep(21500);
  await evaluate(`document.querySelector('.unsaved-dialog [data-decision="discard"]').click()`);
  const closed = await waitFor(`!${tab("a.md")}`, 4000);
  check("Discard closes the tab although Auto Save ran meanwhile", closed);
  check(
    "Auto Save did not write the discarded text",
    fs.readFileSync(files.a, "utf8") === "Alpha paragraph.\n",
    JSON.stringify(fs.readFileSync(files.a, "utf8")),
  );
  await emitMenu(page, "file.autoSave");
  await waitFor(`window.__TAURI_INTERNALS__.invoke('get_settings').then(s => !s.autoSave)`, 4000);

  // -------------------------------------------------------------------------
  console.log("\n=== a failed HTML render is not current (F5) ===");
  await emitMenu(page, "view.split");
  await open(files.html);
  check(
    "the HTML guest shows the page",
    await waitFor(`!!document.querySelector('.html-preview-frame.active')`, 12000),
  );
  await sleep(600);
  await evaluate(`window.__ownershipTestOnly.fail['set_html_preview'] = true`);
  await typeAtEnd("\n<p>Edited after the guest loaded.</p>");
  await waitFor(`!window.__ownershipTestOnly.fail['set_html_preview']`, 4000);
  await sleep(800);
  const before = await calls("set_html_preview");
  await emitMenu(page, "view.source");
  await sleep(400);
  await emitMenu(page, "view.split");
  await waitFor(`(window.__ownershipTestOnly.calls['set_html_preview'] ?? 0) > ${before}`, 5000);
  check(
    "returning to Split after a failed render rebuilds the preview",
    (await calls("set_html_preview")) > before,
    `${before} -> ${await calls("set_html_preview")}`,
  );
  check(
    "the rebuilt guest is promoted",
    await waitFor(`!!document.querySelector('.html-preview-frame.active')`, 12000),
  );
} catch (error) {
  failed += 1;
  console.log(`  FAIL  the suite aborted: ${error?.message ?? error}`);
} finally {
  try {
    for (const name of ["page.html", "a.md", "b.md", "c.md"]) {
      if (await evaluate(`!!${tab(name)}`)) await closeTab(name);
    }
    if (hooked) {
      await evaluate(`window.fetch = window.__ownershipTestOnly.original`);
    }
  } catch {
    /* the app may be gone */
  }
  fs.rmSync(work, { recursive: true, force: true });
  page.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
