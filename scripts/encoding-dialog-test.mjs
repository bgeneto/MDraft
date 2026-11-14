// Tools › Encoding and Line Endings, through the real application.
//
// Run through test-all for an owned profile, or:
//   node scripts/encoding-dialog-test.mjs [port]
//
// What it proves, on fixtures written to the suite's own temp folder:
// - the status-bar button and the Tools menu both open the dialog;
// - Reinterpret previews another reading, Reopen replaces the buffer without
//   writing, and the dialog then offers the conversion that keeps it;
// - Convert and Save writes exactly the UTF-8/LF bytes, updates the inputenc
//   declaration as one undoable edit, and the status bar follows;
// - the fit check names the first unmappable character and blocks the save;
// - mixed line endings are reported and normalised;
// - a disk change between opening the dialog and saving is a conflict, not an
//   overwrite;
// - an untitled buffer chooses the format of its first save.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = Number(process.argv[2] ?? 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw Error("No page target for the encoding dialog tests");
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
  if (result.error || result.result?.exceptionDetails)
    throw Error(
      result.result?.exceptionDetails?.exception?.description ?? JSON.stringify(result.error),
    );
  return result.result.result.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(expression, limit = 10000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    if (await evaluate(expression)) return true;
    await sleep(80);
  }
  throw Error(`Timed out: ${expression}`);
}
async function waitFor(predicate, label, limit = 10000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(80);
  }
  throw Error(`Timed out: ${label}`);
}
const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const invoke = (command, args = {}) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
async function action(id) {
  // The shell ignores a second menu command within 250 ms.
  await sleep(280);
  await invoke("plugin:event|emit", { event: "menu", payload: id });
}
const tab = (name) =>
  `[...document.querySelectorAll('.doc-tab')].find(t=>t.querySelector('.doc-tab-name')?.textContent===${JSON.stringify(name)})`;
const text = () => evaluate(`document.querySelector('.cm-content').innerText.replace(/​/g,'')`);
const dirty = (name) => evaluate(`${tab(name)}?.classList.contains('is-dirty')??false`);
const status = () => evaluate(`document.getElementById('status-encoding')?.textContent ?? ''`);
async function open(file) {
  await invoke("plugin:event|emit", { event: "open-files", payload: [file] });
  await wait(`${tab(path.basename(file))}?.getAttribute('aria-selected')==='true'`);
}
async function key(keyName, code, virtualKey, modifiers = 0) {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: keyName,
    code,
    modifiers,
    windowsVirtualKeyCode: virtualKey,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyName,
    code,
    modifiers,
    windowsVirtualKeyCode: virtualKey,
  });
}

// ---- Dialog helpers -------------------------------------------------------
const D = (selector = "") => `document.querySelector('.encoding-dialog[open] ${selector}')`;
const isOpen = () => evaluate(`!!document.querySelector('.encoding-dialog[open]')`);
const textIn = (selector) => evaluate(`${D(selector)}?.textContent ?? ''`);
const click = (selector) => evaluate(`${D(selector)}.click()`);
async function openByStatus() {
  await sleep(280);
  await evaluate(`document.getElementById('status-encoding').click()`);
  await wait(`!!${D()}`);
}
async function openByMenu() {
  await action("tools.encoding");
  await wait(`!!${D()}`);
}
const waitInspected = () => wait(`${D(".encoding-disk")}?.textContent.startsWith('On disk')`);
const waitFitDone = () =>
  wait(
    `${D(".encoding-fit")}?.classList.contains('is-ok') || ${D(".encoding-fit")}?.classList.contains('is-error')`,
  );
const tabButton = (index) => `[role=tab]:nth-of-type(${index + 1})`;
// 0 = LF, 1 = CRLF; the legend is not a label, so nth-of-type counts rows.
const eolInput = (index) => `.encoding-eol label:nth-of-type(${index + 1}) input`;
const primaryEnabled = () => evaluate(`!${D(".encoding-primary")}.disabled`);
async function closeDialog() {
  if (await isOpen()) await click(".encoding-actions button:first-child");
  await wait(`!document.querySelector('.encoding-dialog[open]')`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-encoding-"));
const legacy = path.join(work, "thesis.tex");
const fitFile = path.join(work, "fit.md");
const mixed = path.join(work, "mixed.txt");
const conflict = path.join(work, "conflict.md");

const legacySource = [
  "\\documentclass{article}",
  "\\usepackage[latin1]{inputenc}",
  "\\begin{document}",
  "obtenção do título",
  "\\end{document}",
  "",
].join("\r\n");
fs.writeFileSync(legacy, Buffer.from(legacySource, "latin1"));
fs.writeFileSync(fitFile, "café ☃ and 😀\n");
fs.writeFileSync(mixed, "a\r\nb\nc\r\n");
fs.writeFileSync(conflict, "original\n");

try {
  await wait(
    `document.querySelector('.cm-content') && document.title.endsWith(' — MDraft')`,
    60000,
  );

  // ---- Windows-1252 thesis: reinterpret, then convert --------------------
  const legacyBytes = fs.readFileSync(legacy);
  await open(legacy);
  check(
    (await status()).includes("Windows-1252 · CRLF"),
    "the legacy file opens as Windows-1252 · CRLF",
  );
  check(
    (await evaluate(`document.getElementById('status-encoding').tagName`)) === "BUTTON",
    "the status-bar encoding is a button",
  );
  await openByStatus();
  check(true, "clicking the status-bar encoding opens the dialog");
  check(
    (await textIn(".encoding-chips")).includes("Windows-1252") &&
      (await textIn(".encoding-chips")).includes("CRLF"),
    "the dialog shows the current encoding and line ending",
  );
  await waitInspected();
  const disk = await textIn(".encoding-disk");
  check(
    disk.includes("detected Windows-1252") && disk.includes("5 CRLF") && !disk.includes("mixed"),
    "the disk inspection names the detection and the line endings",
    disk,
  );

  await click(tabButton(1));
  check(
    await evaluate(`${D('[data-encoding="UTF-8"]')}?.hidden === true`),
    "UTF-8, which cannot read the bytes, is hidden by default",
  );
  await click(".encoding-show-invalid input");
  check(
    await evaluate(
      `${D('[data-encoding="UTF-8"]')}?.hidden === false && ${D('[data-encoding="UTF-8"]')}.classList.contains('is-invalid')`,
    ),
    "showing invalid encodings marks UTF-8 as invalid",
  );
  await click('[data-encoding="windows-1251"]');
  const preview = await textIn(".encoding-sample-new");
  check(preview.includes("obtenзгo"), "the preview reads the line as Windows-1251", preview);
  check(
    (await textIn(".encoding-sample-now")).includes("obtenção"),
    "the preview shows the current reading beside it",
  );
  check(
    (await textIn(".encoding-primary")) === "Reopen as Windows-1251" && (await primaryEnabled()),
    "the primary action reopens as the chosen encoding",
  );
  await click(".encoding-primary");
  await wait(`document.querySelector('.cm-content').innerText.includes('obtenзгo')`);
  check((await status()).includes("Windows-1251"), "Reopen replaces the buffer and the status bar");
  check(fs.readFileSync(legacy).equals(legacyBytes), "Reinterpret writes nothing to disk");
  check(!(await dirty("thesis.tex")), "a reinterpreted buffer is clean");
  await wait(`!!${D(".encoding-notice:not([hidden])")}`);
  check(
    (await textIn(".encoding-notice")).includes("Reopened as Windows-1251"),
    "after Reopen the dialog offers the conversion that keeps the reading",
  );
  await closeDialog();

  await openByMenu();
  check(true, "Tools › Encoding and Line Endings opens the dialog");
  await waitInspected();
  await click(tabButton(1));
  await click('[data-encoding="windows-1252"]');
  check(
    (await textIn('[data-encoding="windows-1252"]')).includes("detected"),
    "the detected encoding is badged",
  );
  await click(".encoding-primary");
  await wait(`document.querySelector('.cm-content').innerText.includes('obtenção')`);
  check(
    (await status()).includes("Windows-1252"),
    "reinterpreting back restores the detected reading",
  );
  await wait(`!!${D(".encoding-notice:not([hidden])")}`);

  check(
    await evaluate(`${D('.encoding-targets input[value="utf8"]')}.checked`),
    "UTF-8 is the preselected target for a legacy file",
  );
  await click(`${eolInput(0)}`);
  await waitFitDone();
  check(
    (await textIn(".encoding-fit")).startsWith("Every character fits"),
    "the fit check passes for UTF-8",
  );
  const declaration = await textIn(".encoding-declaration");
  check(
    declaration.includes("“latin1” → “utf8”") && declaration.includes("line 2"),
    "the inputenc declaration is offered for update",
    declaration,
  );
  check(
    (await textIn(".encoding-summary")).includes("Windows-1252 · CRLF → UTF-8 · LF"),
    "the summary states the conversion",
  );
  check(
    (await textIn(".encoding-warnings")) === "",
    "no project warning when the file carries its own declaration",
  );
  await click(".encoding-primary");
  const expected = Buffer.from(
    legacySource.replace("[latin1]", "[utf8]").replaceAll("\r\n", "\n"),
    "utf8",
  );
  await waitFor(() => fs.readFileSync(legacy).equals(expected), "UTF-8 LF bytes on disk");
  check(true, "Convert and Save writes exactly the UTF-8 LF bytes with [utf8]");
  await wait(`document.getElementById('status-encoding').textContent.startsWith('UTF-8 · LF')`);
  check(true, "the status bar reads UTF-8 · LF");
  check(!(await dirty("thesis.tex")), "the converted document is clean");
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await key("z", "KeyZ", 90, 2);
  await wait(`document.querySelector('.cm-content').innerText.includes('[latin1]')`);
  check(true, "Ctrl+Z restores the old inputenc option");
  await key("y", "KeyY", 89, 2);
  await wait(`document.querySelector('.cm-content').innerText.includes('[utf8]')`);
  check(!(await dirty("thesis.tex")), "redo returns to the saved text");

  // ---- Fit check ----------------------------------------------------------
  await open(fitFile);
  await openByMenu();
  await evaluate(
    `(() => { const s = ${D(".encoding-select")}; s.value = 'windows-1252'; s.dispatchEvent(new Event('change')); })()`,
  );
  await waitFitDone();
  const fitText = await textIn(".encoding-fit");
  check(
    fitText.includes("2 characters cannot be stored in Windows-1252") &&
      fitText.includes("“☃”") &&
      fitText.includes("Ln 1, Col 6"),
    "the fit check names the first unmappable character and its position",
    fitText,
  );
  check(
    !(await primaryEnabled()) &&
      (await evaluate(`${D(".encoding-actions button:nth-of-type(2)")}.disabled`)),
    "an unmappable target blocks Convert and the copy",
  );
  check(
    (await textIn(".encoding-warnings")).includes("Most tools expect UTF-8"),
    "a legacy target for a UTF-8 file carries the UTF-8 advice",
  );
  await click('.encoding-targets input[value="utf16le"]');
  await waitFitDone();
  check(await primaryEnabled(), "UTF-16 stores every character");
  await evaluate(
    `(() => { const s = ${D(".encoding-select")}; s.value = 'windows-1252'; s.dispatchEvent(new Event('change')); })()`,
  );
  await waitFitDone();
  await click(".encoding-link");
  await wait(`!document.querySelector('.encoding-dialog[open]')`);
  check(
    (await evaluate(`document.getSelection().toString()`)) === "☃",
    "Go to selects the unmappable character in the editor",
  );
  await openByMenu();
  await key("Escape", "Escape", 27);
  await wait(`!document.querySelector('.encoding-dialog[open]')`);
  check(true, "Escape closes the dialog");
  check((await status()).startsWith("UTF-8 · LF"), "cancelling changes nothing");

  // ---- Mixed line endings -------------------------------------------------
  await open(mixed);
  await openByMenu();
  await waitInspected();
  const mixedDisk = await textIn(".encoding-disk");
  check(
    mixedDisk.includes("2 CRLF") && mixedDisk.includes("1 LF") && mixedDisk.includes("mixed"),
    "mixed line endings are reported",
    mixedDisk,
  );
  check(
    (await textIn(".encoding-summary")).includes("Normalises 1 mixed line ending to CRLF") &&
      (await primaryEnabled()),
    "an unchanged format can still normalise mixed endings",
  );
  await click(".encoding-primary");
  await waitFor(
    () => fs.readFileSync(mixed, "latin1") === "a\r\nb\r\nc\r\n",
    "normalised line endings",
  );
  check(true, "Convert and Save normalises the mixed line endings");

  // ---- Conflict -----------------------------------------------------------
  await open(conflict);
  await openByMenu();
  await waitInspected();
  await click(`${eolInput(1)}`);
  check(await primaryEnabled(), "choosing CRLF enables Convert and Save");
  await sleep(50);
  fs.writeFileSync(conflict, "changed on disk\n");
  await click(".encoding-primary");
  await sleep(1500);
  check(
    fs.readFileSync(conflict, "utf8") === "changed on disk\n",
    "a disk change before the save is not overwritten",
  );
  check((await status()).includes("· LF"), "a refused conversion keeps the old line ending");

  // ---- Untitled -----------------------------------------------------------
  await action("file.new");
  await wait(`document.getElementById('status-encoding').textContent.includes('not saved')`);
  await openByStatus();
  check(
    await evaluate(`${D(tabButton(1))}.hidden`),
    "an untitled buffer has nothing on disk to reinterpret",
  );
  check(
    (await textIn(".encoding-primary")) === "Apply",
    "an untitled buffer applies a save format",
  );
  await click(`${eolInput(1)}`);
  await click(".encoding-primary");
  await wait(`!document.querySelector('.encoding-dialog[open]')`);
  check(
    (await status()).startsWith("UTF-8 · CRLF · not saved"),
    "the untitled status bar shows the chosen first-save format",
    await status(),
  );
} catch (error) {
  check(false, "encoding dialog suite ran to completion", String(error?.message ?? error));
} finally {
  ws.close();
  const resolved = path.resolve(work);
  const root = path.resolve(os.tmpdir());
  if (
    resolved.startsWith(root + path.sep) &&
    path.basename(resolved).startsWith("mdraft-encoding-")
  )
    fs.rmSync(resolved, { recursive: true, force: true });
}
const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
