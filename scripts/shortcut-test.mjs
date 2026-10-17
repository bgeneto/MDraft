// Do the menu shortcuts actually do anything?
//
//   node scripts/shortcut-test.mjs [port]
//
// Why synthetic events are legitimate here, and where they are not: the fix for
// the "shortcuts do nothing" bug moved the binding into the frontend, so the
// mechanism under test is a DOM keydown listener. A synthetic KeyboardEvent
// exercises exactly that. A *native* menu accelerator would not be testable this
// way — it is handled by the window, above the webview, and CDP input never
// reaches it.
//
// The registry is checked first. Every accelerator the menu declares has to come
// back from the `accelerators` command, because that is the list the frontend
// binds; one missing means the platform rejected it and the shortcut is dead.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const port = process.argv[2] ?? "9222";

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("no page target; start the application with the debug port open");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 1;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = id++;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const r = pending.get(m.id);
  if (r) {
    pending.delete(m.id);
    r(m);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return r.result.result.value;
}

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Press a key the way a person would, as far as the DOM is concerned.
 *
 * Both `key` and `code` are supplied because the matcher accepts either: `key`
 * changes under Shift, so `Shift+=` reports "+" and only `code` still names the
 * key the accelerator refers to.
 */
async function press({ code, key, ctrl = false, shift = false, alt = false, meta = false }) {
  const expression = `
    (() => {
      const event = new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)},
        code: ${JSON.stringify(code)},
        ctrlKey: ${ctrl},
        shiftKey: ${shift},
        altKey: ${alt},
        metaKey: ${meta},
        bubbles: true,
        cancelable: true,
      });
      const target = document.querySelector(".cm-content") ?? document.body;
      target.dispatchEvent(event);
      return event.defaultPrevented ? "handled" : "passed-through";
    })()
  `;
  return evaluate(expression);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The accelerator registry is readable as soon as Rust is up, but the keydown
// listener is installed near the end of the frontend boot. A test that attaches
// immediately pressed Ctrl+/ before that and reported "mode-split -> mode-split",
// which reads like a broken shortcut. The document title is assigned after
// `installShortcuts`, so waiting for it proves the handler exists.
const bootDeadline = Date.now() + 60_000;
let booted = false;
while (Date.now() < bootDeadline) {
  booted = await evaluate(
    `document.title.endsWith(" — MDraft") && document.querySelectorAll(".cm-line").length > 0`,
  );
  if (booted) break;
  await sleep(250);
}
if (!booted) {
  console.error("the window did not finish booting within 60 s; no keys were pressed");
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log("=== the accelerator registry is complete ===");
const registry = await evaluate(
  `window.__TAURI_INTERNALS__.invoke("accelerators").then((r) => r)`,
);
const byId = new Map(registry.map((entry) => [entry.id, entry.accelerator]));
check(registry.length >= 39, "every accelerator was registered", `${registry.length} entries`);

// The four the report named, plus the two that were said to work by accident.
for (const [id, expected] of [
  ["file.new", "CmdOrCtrl+N"],
  ["file.open", "CmdOrCtrl+O"],
  ["file.save", "CmdOrCtrl+S"],
  ["file.saveAs", "CmdOrCtrl+Shift+S"],
  ["file.close", "CmdOrCtrl+W"],
  ["file.nextTab", "CmdOrCtrl+Tab"],
  ["file.prevTab", "CmdOrCtrl+Shift+Tab"],
  ["edit.find", "CmdOrCtrl+F"],
  ["view.source", "CmdOrCtrl+/"],
]) {
  check(byId.get(id) === expected, `${id} is bound to ${expected}`, byId.get(id) ?? "MISSING");
}

// ---------------------------------------------------------------------------
console.log("\n=== a shortcut must change state, and a near miss must not ===");

const modeOf = () =>
  evaluate(`[...document.getElementById("app").classList].find((c) => c.startsWith("mode-")) ?? ""`);
const before = await modeOf();

const handled = await press({ code: "Slash", key: "/", ctrl: true });
check(handled === "handled", "Ctrl+/ is claimed by the shortcut handler", handled);
await sleep(250);
const afterMode = await modeOf();
check(afterMode !== before, "Ctrl+/ switches the view mode", `${before} -> ${afterMode}`);
check(!afterMode.includes("split"), "the mode it switched to is not split");

// A different modifier set must not match the same accelerator.
//
// Asserted on the effect, not on `defaultPrevented`: that flag says only that
// *something* handled the key, and CodeMirror legitimately claims several
// keystrokes of its own. What matters is that the command did not run.
const beforeNearMiss = await modeOf();
await press({ code: "Slash", key: "/", ctrl: true, shift: true });
await sleep(250);
check((await modeOf()) === beforeNearMiss, "Ctrl+Shift+/ does not run the Ctrl+/ command", `${beforeNearMiss} -> ${await modeOf()}`);

// Back to split through the toolbar, so the checks below start from a known
// mode rather than whatever the previous one left behind.
await evaluate(`document.getElementById("mode-split").click()`);
await sleep(250);

// ---------------------------------------------------------------------------
console.log("\n=== Menu shortcuts that change the interface ===");

const focusOn = () => evaluate(`document.getElementById("app").classList.contains("focus-mode")`);
const menuChecks = () => evaluate(`window.__TAURI_INTERNALS__.invoke("menu_state")`);
const checkedInMenu = async (id) =>
  (await menuChecks()).find((entry) => entry.id === id)?.checked === true;
const focusBefore = await focusOn();
await press({ code: "F8", key: "F8" });
await sleep(250);
const focusAfter = await focusOn();
check(focusAfter !== focusBefore, "F8 toggles focus mode", `${focusBefore} -> ${focusAfter}`);
// The native menu cannot be seen over CDP; `menu_state` is the only way to
// prove the check mark moved with the mode.
check(
  (await checkedInMenu("view.focus")) === focusAfter,
  "F8 also checks the Focus Mode menu item",
);
await press({ code: "F8", key: "F8" });
await sleep(200);
check((await focusOn()) === focusBefore, "F8 restores the previous focus state");

// Fullscreen was a PredefinedMenuItem, which muda documents as unsupported on
// Windows and GTK3 and whose handler is a no-op. It is a custom check item now,
// and F11 has to reach it through the same frontend shortcut handler.
const fullscreenBefore = await checkedInMenu("view.fullscreen");
await press({ code: "F11", key: "F11" });
await sleep(900);
const fullscreenAfter = await checkedInMenu("view.fullscreen");
check(
  fullscreenAfter !== fullscreenBefore,
  "F11 toggles fullscreen and the menu check follows",
  `${fullscreenBefore} -> ${fullscreenAfter}`,
);
await press({ code: "F11", key: "F11" });
await sleep(900);
check(
  (await checkedInMenu("view.fullscreen")) === fullscreenBefore,
  "F11 restores the previous fullscreen state",
);

// Start from a different tab, or "the tab changed" is untestable: the outline is
// the default, so selecting it again produces no observable difference.
const outlineSelected = () =>
  evaluate(`document.getElementById("tab-outline").getAttribute("aria-selected")`);
await press({ code: "Digit2", key: "2", ctrl: true, shift: true });
await sleep(300);
const beforeOutline = await outlineSelected();
check(beforeOutline === "false", "Ctrl+Shift+2 moved off the outline tab", beforeOutline);
await press({ code: "Digit1", key: "1", ctrl: true, shift: true });
await sleep(300);
check((await outlineSelected()) === "true", "Ctrl+Shift+1 returns to the outline tab");

const fontSize = () => evaluate(`parseFloat(getComputedStyle(document.querySelector(".cm-content")).fontSize)`);
const sizeBefore = await fontSize();
await press({ code: "Equal", key: "+", ctrl: true, shift: true });
await sleep(250);
const sizeAfter = await fontSize();
check(sizeAfter > sizeBefore, "Ctrl+Shift+= zooms the editor in", `${sizeBefore}px -> ${sizeAfter}px`);

const zoomChip = () =>
  evaluate(
    `(() => { const b = document.getElementById('status-zoom'); return { hidden: b.hidden, text: b.textContent }; })()`,
  );
const zoomed = await zoomChip();
check(
  zoomed.hidden === false && /^\d+%$/.test(zoomed.text),
  "zoom in shows the percentage in the status bar",
  zoomed.text,
);

await press({ code: "Digit0", key: "0", ctrl: true, shift: true });
await sleep(200);
const zoomReset = await zoomChip();
check(zoomReset.hidden === true, "reset hides the zoom indicator");

await press({ code: "Slash", key: "/", ctrl: true });
await sleep(200);

// ---------------------------------------------------------------------------
console.log("\n=== Ctrl+F opens the search panel ===");
check(!(await evaluate(`!!document.querySelector(".cm-search")`)), "the panel starts closed");
await press({ code: "KeyF", key: "f", ctrl: true });
await sleep(400);
check(await evaluate(`!!document.querySelector(".cm-search")`), "Ctrl+F opens it");
await press({ code: "Escape", key: "Escape" });
await sleep(200);

// ---------------------------------------------------------------------------
console.log("\n=== Ctrl+S saves a document that already has a path ===");
// The path comes from the caller rather than from the application: the test is
// what opened the document, so it is what knows which file to watch. There is no
// command that reports the open document's path, and inventing one for a test
// would be a worse idea than passing it in.
const documentPath = process.argv[3] ?? "samples/feature-tour.md";
if (!existsSync(documentPath)) {
  check(false, "a document with a path on disk is open", documentPath);
} else {
  const mtimeBefore = statSync(documentPath).mtimeMs;
  const bytesBefore = readFileSync(documentPath, "utf8");
  const titleBefore = await evaluate(`document.title`);

  // Dirty the document through a real input path. A synthetic keydown does not
  // insert anything: CodeMirror reacts to the browser's input pipeline, so the
  // text has to arrive through it. `Input.insertText` is that pipeline.
  await evaluate(`document.querySelector(".cm-content").focus()`);
  await send("Input.insertText", { text: " " });
  await sleep(500);
  const dirtyTitle = await evaluate(`document.title`);
  check(
    titleBefore.includes("•") || dirtyTitle.includes("•"),
    "the document is marked modified before saving",
    dirtyTitle,
  );

  await press({ code: "KeyS", key: "s", ctrl: true });
  await sleep(1500);
  const mtimeAfter = statSync(documentPath).mtimeMs;
  const bytesAfter = readFileSync(documentPath, "utf8");
  check(mtimeAfter > mtimeBefore, "Ctrl+S wrote the file", `${mtimeBefore} -> ${mtimeAfter}`);
  check(bytesAfter !== bytesBefore, "the written bytes contain the edit");
  check(!(await evaluate(`document.title`)).includes("•"), "the modified marker cleared");

  // Leave the working tree as it was found; this is a fixture other suites read.
  writeFileSync(documentPath, bytesBefore);
}

// ---------------------------------------------------------------------------
console.log("\n=== keys the editor must keep ===");
// Asserted by effect again. CodeMirror implements undo itself and does claim
// Ctrl+Z — `defaultPrevented` is true for it, which is correct, not a fault. The
// question is whether undo still works while the shortcut handler is installed.
await evaluate(`document.querySelector(".cm-content").focus()`);
const textBefore = await evaluate(`document.querySelector(".cm-content").innerText`);
await send("Input.insertText", { text: "ZZZ" });
await sleep(400);
const textTyped = await evaluate(`document.querySelector(".cm-content").innerText`);
check(textTyped.length > textBefore.length, "typing inserts text", `${textBefore.length} -> ${textTyped.length} chars`);
await press({ code: "KeyZ", key: "z", ctrl: true });
await sleep(400);
const textUndone = await evaluate(`document.querySelector(".cm-content").innerText`);
check(
  !textUndone.includes("ZZZ"),
  "Ctrl+Z still undoes, so the handler leaves editing keys alone",
  `${textTyped.length} -> ${textUndone.length} chars`,
);

// ---------------------------------------------------------------------------
console.log("\n=== Ctrl+N adds a tab and Ctrl+W closes it ===");
// The undo above put the text back, so the document is not modified. New no
// longer replaces that buffer: it opens another tab beside it.
const cleanBefore = !(await evaluate(`document.title`)).includes("•");
check(cleanBefore, "the document is clean before New", await evaluate(`document.title`));
await press({ code: "KeyN", key: "n", ctrl: true });
await sleep(1000);
const newTitle = await evaluate(`document.title`);
check(/untitled/i.test(newTitle), "Ctrl+N starts a new document", newTitle);
check(
  (await evaluate(`document.querySelector(".cm-content").innerText.replace(/\\u200b/g, "").trim()`)) === "",
  "the new document is empty",
);
const tabNames = JSON.parse(
  await evaluate(`JSON.stringify([...document.querySelectorAll(".doc-tab-name")].map((el) => el.textContent))`),
);
check(
  tabNames.length === 2 && tabNames.some((name) => name.includes("feature-tour")),
  "Ctrl+N keeps the previous document open",
  tabNames.join(", "),
);

const editorText = () =>
  evaluate(`document.querySelector(".cm-content").innerText.replace(/\\u200b/g, "")`);
await evaluate(`document.querySelector(".cm-content").focus()`);
await send("Input.insertText", { text: "OTHER" });
await sleep(300);
await evaluate(`
  [...document.querySelectorAll(".doc-tab")].find((tab) => tab.textContent.includes("feature-tour")).click()
`);
await sleep(400);
const restored = await editorText();
check(
  restored.includes("feature tour") && !restored.includes("OTHER"),
  "switching back restores the previous buffer",
  restored.slice(0, 80),
);

await evaluate(`document.querySelector(".cm-content").focus()`);
await send("Input.insertText", { text: "KEEP" });
await sleep(300);
await evaluate(`
  [...document.querySelectorAll(".doc-tab")].find((tab) => /untitled/i.test(tab.textContent)).click()
`);
await sleep(300);
await evaluate(`
  [...document.querySelectorAll(".doc-tab")].find((tab) => tab.textContent.includes("feature-tour")).click()
`);
await sleep(400);
await press({ code: "KeyZ", key: "z", ctrl: true });
await sleep(400);
const undone = await editorText();
check(
  undone.includes("feature tour") && !undone.includes("KEEP"),
  "undo stays with the tab it belongs to",
  undone.includes("KEEP") ? "KEEP still present" : "KEEP gone",
);

await press({ code: "KeyW", key: "w", ctrl: true });
await sleep(400);
const afterClose = JSON.parse(
  await evaluate(`JSON.stringify({
    tabs: [...document.querySelectorAll(".doc-tab-name")].map((el) => el.textContent),
    text: document.querySelector(".cm-content").innerText.replace(/\\u200b/g, ""),
  })`),
);
check(
  afterClose.tabs.length === 1 && afterClose.text.includes("OTHER"),
  "Ctrl+W closes the active tab and leaves the other",
  afterClose.tabs.join(", "),
);

// ---------------------------------------------------------------------------
// Ctrl+O and Ctrl+Shift+S open native modal dialogs. Pressing them here would
// block on a window this session cannot dismiss, so they are covered by the
// registry check above — bound, and reachable — and not executed. Say so rather
// than leaving a silent gap.
console.log("\n=== not executed ===");
console.log("  Ctrl+O and Ctrl+Shift+S open native file dialogs, which cannot be");
console.log("  dismissed from this environment. Verified bound by the registry");
console.log("  above; their handlers are file.open and file.saveAs.");

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ""}`);
}
ws.close();
process.exit(failed.length === 0 ? 0 : 1);
