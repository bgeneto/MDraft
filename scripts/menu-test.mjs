#!/usr/bin/env node
//! The menu's information architecture, availability and new routes.
//!
//! This suite owns what the other UI layers do not: the shape of the native
//! menu (`menu_items`), its context-sensitive labels and enabled states, the
//! Preferences deep links, Paste without Formatting, the zoom-only reset,
//! the block-equation normalisation and both Close All Tabs routes.
//!
//!   node scripts/menu-test.mjs [port]
//!
//! Needs the window already running with `samples/feature-tour.md`, the same
//! fixture every menu assertion was written against.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const port = process.argv[2] ?? "9222";
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
await send("Runtime.enable");

const evaluate = async (expression) => {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(JSON.stringify(response.result.exceptionDetails));
  }
  return response.result?.result?.value;
};
const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );
const emitMenu = (id) =>
  invoke("plugin:event|emit", { event: "menu", payload: id }).then(() => undefined);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function waitFor(expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(150);
  }
  return false;
}

async function key(keyValue, code, modifiers = 0) {
  const virtualKey = code.startsWith("Key")
    ? code.charCodeAt(3)
    : code.startsWith("Digit")
      ? code.charCodeAt(5)
      : keyValue === "ArrowRight"
        ? 39
        : keyValue === "Home"
          ? 36
          : keyValue === "Escape"
            ? 27
            : keyValue.toUpperCase().charCodeAt(0);
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: keyValue,
    code,
    windowsVirtualKeyCode: virtualKey,
    modifiers,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyValue,
    code,
    windowsVirtualKeyCode: virtualKey,
    modifiers,
  });
  await sleep(450);
}

const menuItems = () => invoke("menu_items");
const menuState = () => invoke("menu_state");
const itemById = async (id) => (await menuItems()).find((item) => item.id === id);
const settings = () => invoke("get_settings");
const activeTab = () =>
  evaluate(
    `[...document.querySelectorAll(".doc-tab")].find((tab) => tab.getAttribute("aria-selected") === "true")?.querySelector(".doc-tab-name")?.textContent ?? ""`,
  );
const tabCount = () => evaluate(`document.querySelectorAll(".doc-tab").length`);
const bufferText = () =>
  evaluate(
    `[...document.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\\n")`,
  );

async function openPaths(paths) {
  await invoke("plugin:event|emit", { event: "open-files", payload: paths });
  await sleep(1800);
}

async function preferencesSection() {
  return evaluate(`(() => {
    const overlay = document.querySelector(".prefs-overlay");
    if (!overlay || overlay.hidden) return null;
    return document.querySelector(".prefs-section[aria-selected='true']")?.textContent ?? "";
  })()`);
}

async function openPreferencesAt(id) {
  await emitMenu(id);
  await sleep(500);
  return preferencesSection();
}

async function closePreferences() {
  await evaluate(`document.querySelector(".prefs-close")?.click()`);
  await sleep(300);
}

async function setContentWidth(value) {
  await emitMenu("file.preferences");
  await sleep(400);
  const clicked = await evaluate(`(() => {
    const section = [...document.querySelectorAll(".prefs-section")].find((button) => button.textContent === "Editor");
    if (!section) return false;
    section.click();
    return true;
  })()`);
  if (!clicked) return false;
  await sleep(250);
  const changed = await evaluate(`(() => {
    const row = [...document.querySelectorAll(".prefs-row")].find(
      (entry) => (entry.querySelector(".prefs-label")?.textContent ?? "").replace("?", "").trim() === "Content Width",
    );
    const select = row?.querySelector("select");
    if (!select) return false;
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  await closePreferences();
  return changed;
}

const workDir = mkdtempSync(join(tmpdir(), "mdraft-menu-"));
const temp = (name) => join(workDir, name);

try {
  const booted = await waitFor(
    `document.title.endsWith(" — MDraft") && document.querySelectorAll(".cm-line").length > 0`,
    60000,
  );
  check(booted, "the window finished booting");
  check(
    (await activeTab()) === "feature-tour.md",
    "the Markdown fixture is active",
    await activeTab(),
  );

  // -------------------------------------------------------------------------
  // Structure and labels
  // -------------------------------------------------------------------------
  console.log("\n=== the eight categories and where commands live ===");
  const all = await menuItems();
  const topLevel = all
    .filter((item) => item.parent === "" && item.kind === "submenu")
    .map((item) => item.text);
  check(
    topLevel.join(",") === "File,Edit,Insert,Format,Navigate,View,Tools,Help",
    "the bar has the eight approved categories in order",
    topLevel.join(", "),
  );

  const parentOf = (id) => all.find((item) => item.id === id)?.parent ?? "MISSING";
  for (const [id, parent] of [
    ["format.link", "Insert"],
    ["para.table", "Insert"],
    ["para.mathBlock", "Insert"],
    ["format.bold", "Format"],
    ["para.h1", "Paragraph Style"],
    ["edit.uppercase", "Convert Selection"],
    ["file.favorite", "File"],
    ["themes.system", "Interface Theme"],
    ["view.syntax.nord", "Code Colors"],
    ["navigate.openTarget", "Navigate"],
    ["tools.spellcheck", "Tools"],
    ["help.welcome", "Help"],
  ]) {
    check(parentOf(id) === parent, `${id} lives under ${parent}`, parentOf(id));
  }

  const textOf = (id) => all.find((item) => item.id === id)?.text ?? "MISSING";
  for (const [id, expected] of [
    ["format.bold", "Bold"],
    ["format.italic", "Italic"],
    ["para.taskDone", "Mark as Done"],
    ["para.taskPlain", "Convert to Plain Text"],
    ["file.reveal", "Show in Folder"],
    ["file.favorite", "Add to Favorites"],
    ["para.yaml", "YAML Front Matter"],
    ["export.html", "HTML…"],
    ["export.pdf", "Print (opens browser)…"],
    ["tools.spellcheck", "Check Spelling While Typing"],
    ["tools.spellLanguage", "Spelling Language…"],
    ["edit.pastePlain", "Paste without Formatting"],
    ["edit.find", "Find"],
    ["navigate.gotoLine", "Go to Line…"],
    ["view.zoomIn", "Zoom In"],
  ]) {
    check(textOf(id) === expected, `${id} is labelled ${JSON.stringify(expected)}`, textOf(id));
  }
  check(
    textOf("para.increaseHeading").includes("H2 → H1") &&
      textOf("para.decreaseHeading").includes("H1 → H2"),
    "promote/demote heading labels state their direction",
    `${textOf("para.increaseHeading")} / ${textOf("para.decreaseHeading")}`,
  );
  check(
    textOf("export.pandoc.docx").endsWith("…"),
    "an export that chooses a file ends with an ellipsis",
    textOf("export.pandoc.docx"),
  );
  check(
    !textOf("edit.find").endsWith("…") && !textOf("edit.replace").endsWith("…"),
    "find and replace do not pretend to be dialogs",
  );

  // -------------------------------------------------------------------------
  // Availability on the Markdown fixture
  // -------------------------------------------------------------------------
  console.log("\n=== availability follows the context ===");
  const closed = await itemById("file.closeOthers");
  check(
    closed?.enabled === false,
    "Close Other Tabs is disabled with one tab",
    String(closed?.enabled),
  );
  check(
    (await itemById("file.closeAll"))?.enabled === true,
    "Close All Tabs is available with one tab",
  );
  check(
    (await itemById("view.typstPreview"))?.enabled === false,
    "Typst Preview is disabled for Markdown",
  );
  check((await itemById("edit.delete"))?.enabled === false, "Delete Selection starts disabled");
  check((await itemById("navigate.openTarget"))?.enabled === false, "Open Target starts disabled");

  // A selection enables the commands that need one.
  await evaluate(`document.querySelector(".cm-content").focus()`);
  await key("a", "KeyA", 2);
  await sleep(350);
  check(
    (await itemById("edit.delete"))?.enabled === true &&
      (await itemById("edit.uppercase"))?.enabled === true &&
      (await itemById("edit.selectAllOccurrences"))?.enabled === true,
    "a selection enables Delete, conversion and Select All Occurrences",
  );
  await key("Home", "Home", 2);
  check(
    (await itemById("edit.delete"))?.enabled === false,
    "collapsing the selection disables it again",
  );

  // A link under the caret enables the one dynamic Navigate action.
  const point = await evaluate(`(() => {
    const line = [...document.querySelectorAll(".cm-line")].find((element) =>
      element.textContent.includes("link to the Tauri project"),
    );
    if (!line) return null;
    const span = [...line.querySelectorAll("span")].find((element) =>
      element.textContent.includes("link to"),
    );
    const rect = (span ?? line).getBoundingClientRect();
    return { x: rect.left + Math.min(20, rect.width / 2), y: rect.top + rect.height / 2 };
  })()`);
  if (point) {
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
    await sleep(500);
  }
  const target = await itemById("navigate.openTarget");
  check(
    target?.enabled === true && target.text === "Open Link Under Cursor",
    "the caret on a link enables Open Link Under Cursor",
    JSON.stringify(target ?? null),
  );

  // Mode-dependent view commands.
  await emitMenu("view.source");
  await sleep(450);
  check(
    (await itemById("view.syncScroll"))?.enabled === false,
    "Sync Scroll is disabled outside Split",
  );
  await emitMenu("view.preview");
  await sleep(450);
  check((await itemById("view.zoomIn"))?.enabled === true, "Zoom stays available in Preview Only");
  await emitMenu("view.split");
  await sleep(500);
  check(
    (await itemById("view.syncScroll"))?.enabled === true &&
      (await itemById("view.zoomIn"))?.enabled === true,
    "Split restores Sync Scroll and keeps Zoom available",
  );

  // -------------------------------------------------------------------------
  // Preferences deep links
  // -------------------------------------------------------------------------
  console.log("\n=== menu commands open the right Preferences section ===");
  check(
    (await openPreferencesAt("tools.spellLanguage")) === "Editor",
    "Spelling Language opens Editor",
  );
  await closePreferences();
  check(
    (await openPreferencesAt("tools.exportConfig")) === "Export",
    "Configure Export opens Export",
  );
  await closePreferences();
  check(
    (await openPreferencesAt("view.typography")) === "Typography",
    "Fonts and Reading opens Typography",
  );
  await closePreferences();

  // -------------------------------------------------------------------------
  // Code colours and zoom-only reset
  // -------------------------------------------------------------------------
  console.log("\n=== View state and document zoom ===");
  await emitMenu("view.syntax.nord");
  await sleep(650);
  check((await settings()).syntaxTheme === "nord", "Code Colors writes the palette to settings");
  check(
    (await menuState()).find((item) => item.id === "view.syntax.nord")?.checked === true,
    "the Nord menu item carries the check",
  );
  await emitMenu("view.syntax.auto");
  await sleep(500);

  check(await setContentWidth("1180"), "Content Width can be set to 1180");
  const beforeZoom = await settings();
  await emitMenu("view.zoomIn");
  await sleep(500);
  const zoomed = await settings();
  await emitMenu("view.zoomReset");
  await sleep(500);
  const reset = await settings();
  check(
    zoomed.zoomLevel > beforeZoom.zoomLevel,
    "Zoom In raises the document zoom",
    `${beforeZoom.zoomLevel} -> ${zoomed.zoomLevel}`,
  );
  check(reset.zoomLevel === 100, "Reset Zoom returns to 100%", String(reset.zoomLevel));
  check(
    reset.editorFontSize === 15,
    "Reset Zoom leaves the base editor font size alone",
    String(reset.editorFontSize),
  );
  check(
    reset.editorMaxWidth === 1180,
    "Reset Zoom does not change the content width",
    String(reset.editorMaxWidth),
  );
  await setContentWidth("980");

  // -------------------------------------------------------------------------
  // Open Tabs and favorites
  // -------------------------------------------------------------------------
  console.log("\n=== Navigate › Open Tabs and File › Favorites ===");
  await evaluate(`document.querySelector(".cm-content").focus()`);
  await key("n", "KeyN", 2);
  await sleep(600);
  check((await tabCount()) === 2, "a new tab is open", String(await tabCount()));
  const tabRows = (await menuItems()).filter((item) => item.id.startsWith("navigate.tab:"));
  check(tabRows.length === 2, "Navigate lists both open tabs", String(tabRows.length));
  check(
    tabRows.filter((item) => item.checked === true).length === 1,
    "exactly one open-tab row is checked",
  );
  const firstRow = tabRows[0];
  if (firstRow) {
    await emitMenu(firstRow.id);
    await sleep(700);
    check(
      (await activeTab()) === "feature-tour.md",
      "clicking an Open Tabs row activates that document",
      await activeTab(),
    );
  }

  await emitMenu("file.favorite");
  await sleep(700);
  check(
    (await itemById("file.favorite"))?.text === "Remove from Favorites",
    "favoriting the document flips the File label",
    (await itemById("file.favorite"))?.text ?? "MISSING",
  );
  await emitMenu("file.favorite");
  await sleep(600);
  check(
    (await itemById("file.favorite"))?.text === "Add to Favorites",
    "removing it restores the label",
    (await itemById("file.favorite"))?.text ?? "MISSING",
  );

  // -------------------------------------------------------------------------
  // Close All Tabs from both routes
  // -------------------------------------------------------------------------
  console.log("\n=== Close All Tabs ===");
  // Close the blank tab from the Open Tabs test, leaving the fixture clean.
  const blankClicked = await evaluate(`(() => {
    const tab = [...document.querySelectorAll(".doc-tab")].find((entry) =>
      (entry.querySelector(".doc-tab-name")?.textContent ?? "").startsWith("Untitled"),
    );
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  await sleep(500);
  await key("w", "KeyW", 2);
  await sleep(700);
  check(
    blankClicked && (await tabCount()) === 1,
    "the extra tab is closed before the batch checks",
    String(await tabCount()),
  );

  writeFileSync(temp("close-a.md"), "# A\n");
  writeFileSync(temp("close-b.md"), "# B\n");
  await openPaths([temp("close-a.md"), temp("close-b.md")]);
  check((await tabCount()) === 3, "two temporary documents are open", String(await tabCount()));

  // The batch close must use the same three-way guard as a single close. A dirty
  // document in the batch has to stop the whole operation at Cancel.
  await evaluate(`document.querySelector(".cm-content").focus()`);
  await send("Input.insertText", { text: "UNSAVED" });
  await sleep(400);
  const openedDialog = await evaluate(`(() => {
    const tab = document.querySelectorAll(".doc-tab")[0];
    const bounds = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2,
      clientX: bounds.left + 10, clientY: bounds.top + 10,
    }));
    const button = document.querySelector('.tab-menu-item[data-action="closeAll"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  const dialogOpen = await waitFor(
    `Boolean(document.querySelector(".unsaved-dialog[open]"))`,
    5000,
  );
  check(openedDialog && dialogOpen, "Close All from the tab context asks about a dirty document");
  await evaluate(`document.querySelector('.unsaved-dialog [data-decision="cancel"]')?.click()`);
  await sleep(900);
  check(
    (await tabCount()) === 3,
    "Cancel leaves every tab in the batch open",
    String(await tabCount()),
  );
  check(
    (await bufferText()).includes("UNSAVED"),
    "Cancel preserves the dirty buffer",
    JSON.stringify((await bufferText()).slice(0, 40)),
  );
  await evaluate(`document.querySelector(".cm-content").focus()`);
  await emitMenu("file.save");
  await waitFor(`document.querySelectorAll(".doc-tab.is-dirty").length === 0`, 4000);

  const contextCloseAll = await evaluate(`(() => {
    const tab = document.querySelectorAll(".doc-tab")[0];
    const bounds = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2,
      clientX: bounds.left + 10, clientY: bounds.top + 10,
    }));
    const button = document.querySelector('.tab-menu-item[data-action="closeAll"]');
    if (!button || button.disabled) return "missing";
    button.click();
    return "clicked";
  })()`);
  const contextClosed = await waitFor(`document.querySelectorAll(".doc-tab").length === 1`, 15000);
  check(contextCloseAll === "clicked", "the tab context menu offers Close All Tabs");
  check(
    contextClosed && (await activeTab()) === "Untitled",
    "the context route leaves one blank document",
    await activeTab(),
  );

  await openPaths([temp("close-a.md"), temp("close-b.md")]);
  check(
    (await tabCount()) === 3,
    "the temporary documents are open again",
    String(await tabCount()),
  );
  await emitMenu("file.closeAll");
  const mainClosed = await waitFor(`document.querySelectorAll(".doc-tab").length === 1`, 15000);
  check(
    mainClosed && (await activeTab()) === "Untitled",
    "File › Close Tabs › All Tabs has the same reach",
    await activeTab(),
  );
  check(
    (await evaluate(`document.title`)) === "Untitled — MDraft",
    "the window stays open on the new empty document",
  );

  // -------------------------------------------------------------------------
  // Paste without Formatting and block equation
  // -------------------------------------------------------------------------
  console.log("\n=== Paste without Formatting and the block equation ===");
  await key("n", "KeyN", 2);
  await sleep(600);
  await evaluate(`document.querySelector(".cm-content").focus()`);
  const clipboardStub = await evaluate(`(() => {
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          read: async () => [{
            types: ["text/plain", "text/html"],
            getType: async (type) => new Blob(
              [type === "text/html" ? "<strong>bold</strong>" : "# plain probe"],
              { type },
            ),
          }],
          readText: async () => "# plain probe",
          writeText: async () => {},
        },
      });
      return "stubbed";
    } catch (error) {
      return String(error);
    }
  })()`);
  await emitMenu("edit.pastePlain");
  await sleep(900);
  check(
    clipboardStub === "stubbed" && (await bufferText()).trim() === "# plain probe",
    "Edit › Paste without Formatting inserts the plain text, not the HTML flavour",
    JSON.stringify(await bufferText()),
  );
  await key("a", "KeyA", 2);
  await send("Input.insertText", { text: "a+b" });
  await sleep(300);
  await key("a", "KeyA", 2);
  await emitMenu("para.mathBlock");
  await sleep(700);
  check(
    (await bufferText()).trim() === "$$a+b$$",
    "Block Equation wraps the selected expression instead of inserting a second block",
    JSON.stringify(await bufferText()),
  );

  // -------------------------------------------------------------------------
  // Language-specific availability
  // -------------------------------------------------------------------------
  console.log("\n=== the same tree adapts to Typst, AsciiDoc and HTML ===");
  const typstStatus = await invoke("typst_status");
  await openPaths([join(repoRoot, "samples", "typst-tour.typ")]);
  const typstPreview = await itemById("view.typstPreview");
  check(
    typstPreview &&
      typstPreview.text === (typstStatus.found ? "Typst Preview" : "Typst Preview — needs Typst"),
    "the Typst preview item names the missing compiler",
    JSON.stringify(typstPreview ?? null),
  );
  check((await itemById("para.task"))?.enabled === false, "Typst disables task lists");
  check((await itemById("para.yaml"))?.enabled === false, "Typst disables document metadata");
  check((await itemById("format.math"))?.enabled === true, "Typst keeps equations");
  check((await itemById("format.document"))?.enabled === true, "Typst keeps Format Document");
  check((await itemById("view.blocks"))?.enabled === true, "Typst keeps folding");

  await openPaths([join(repoRoot, "samples", "asciidoc-tour.adoc")]);
  check(
    (await itemById("para.yaml"))?.text === "Document Attributes",
    "AsciiDoc names document attributes",
    (await itemById("para.yaml"))?.text ?? "MISSING",
  );
  check((await itemById("format.document"))?.enabled === false, "AsciiDoc has no Format Document");
  check((await itemById("view.blocks"))?.enabled === false, "AsciiDoc has no folding commands");
  check((await itemById("para.task"))?.enabled === true, "AsciiDoc keeps task lists");

  await openPaths([join(repoRoot, "samples", "html-tour", "index.html")]);
  check((await itemById("format.math"))?.enabled === false, "HTML disables equations");
  check((await itemById("para.task"))?.enabled === false, "HTML disables task lists");
  check(
    (await itemById("para.toc"))?.enabled === false,
    "HTML disables an inserted table of contents",
  );
  check((await itemById("format.document"))?.enabled === true, "HTML keeps Format Document");
  check((await itemById("tools.spellcheck"))?.enabled === false, "HTML disables spelling");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
