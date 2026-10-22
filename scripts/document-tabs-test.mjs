// Document tabs: what a reader sees when several documents are open.
//
//   node scripts/document-tabs-test.mjs [port]
//
// Why this suite exists: `dom-smoke` asserts that a launch has one tab,
// `shortcut-test` covers Ctrl+N and Ctrl+W, and `html-preview-test` parks and
// restores one HTML tab. None of them touch the rest of the plan's acceptance
// criteria, and every fixture they use is small — which is why a `RangeError`
// that only appears after a large document has been open went unnoticed.
//
// Covered here:
//   * a sidebar click adds a tab, and a `.typ` file is offered at all
//   * a path that is already open is focused, not read again (Recent)
//   * the open-files event adds a tab
//   * the active tab is bold and carries an accent edge
//   * right-click opens the tab menu, with the right entries disabled
//   * ArrowLeft / ArrowRight move between tabs and focus follows
//   * a large document, then Ctrl+N: no error, the tab appears (regression)
//   * the caret and both scroll offsets come back with their tab
//   * the dirty dot belongs to the edited tab
//   * × closes a tab, active or inactive, without activating it
//   * Ctrl+Tab / Ctrl+Shift+Tab change the active tab
//   * middle-click closes a tab
//   * dragging reorders the strip, and Alt+Shift+Arrow moves one place
//   * the disk poll reloads a clean inactive tab and leaves a dirty one alone
//   * Auto Save writes every dirty tab, not just the visible one
//   * a crowded strip scrolls with the arrows and the wheel, and reveals the
//     active tab; Close Others clears the rest
//   * closing the last tab leaves a fresh untitled document

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = process.argv[2] ?? "9222";

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("no page target; start the application with the debug port open");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
});
await new Promise((resolve) => ws.addEventListener("open", resolve));
await send("Runtime.enable");

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return result.result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`));
const tabs = () =>
  json(`[...document.querySelectorAll(".doc-tab-name")].map((e) => e.textContent)`);
const tabCount = () => evaluate(`document.querySelectorAll(".doc-tab").length`);
const activeTab = () =>
  evaluate(
    `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent ?? ""`,
  );
const dirtyCount = () => evaluate(`document.querySelectorAll(".doc-tab.is-dirty").length`);
const isDirty = (name) =>
  evaluate(
    `[...document.querySelectorAll(".doc-tab")].some((t) => t.classList.contains("is-dirty") && (t.querySelector(".doc-tab-name")?.textContent || "") === ${JSON.stringify(name)})`,
  );
const cursor = () => evaluate(`document.getElementById("status-cursor").textContent`);
const title = () => evaluate(`document.title`);
const toast = () =>
  evaluate(
    `document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent`,
  );
const editorText = () =>
  evaluate(`document.querySelector(".cm-content").innerText.replace(/\\u200b/g, "")`);
const guestCount = () => evaluate(`document.querySelectorAll(".html-preview-frame").length`);
const lineOf = (text) => Number((text.match(/Ln (\d+)/) ?? [])[1] ?? 0);

function press({ code, key, ctrl = false, shift = false }) {
  return evaluate(
    `(() => {
      const e = new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)},
        ctrlKey: ${ctrl}, shiftKey: ${shift}, bubbles: true, cancelable: true,
      });
      document.querySelector(".cm-content")?.dispatchEvent(e);
      return e.defaultPrevented ? "handled" : "passed-through";
    })()`,
  );
}

async function clickTab(name) {
  return evaluate(
    `(() => {
      const tab = [...document.querySelectorAll(".doc-tab")]
        .find((t) => t.querySelector(".doc-tab-name")?.textContent === ${JSON.stringify(name)});
      if (!tab) return "missing";
      tab.click();
      return "clicked";
    })()`,
  );
}

async function clickClose(name) {
  return evaluate(
    `(() => {
      const tab = [...document.querySelectorAll(".doc-tab")]
        .find((t) => t.querySelector(".doc-tab-name")?.textContent === ${JSON.stringify(name)});
      if (!tab) return "missing";
      tab.querySelector(".doc-tab-close").click();
      return "clicked";
    })()`,
  );
}

async function pollFor(expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(200);
  }
  return false;
}

/** Ask the window to open paths the way a second instance would. */
async function emitOpenFiles(paths) {
  return evaluate(
    `window.__TAURI_INTERNALS__
      .invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify(paths)} })
      .then(() => "ok", (error) => { throw new Error(String(error)); })`,
  );
}

const workDir = mkdtempSync(path.join(tmpdir(), "mdraft-tabs-"));
const tmp = (name) => path.join(workDir, name);

try {
  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  console.log("=== a launch with one file ===");
  const booted = await pollFor(
    `document.title.endsWith(" — MDraft") && document.querySelectorAll(".cm-line").length > 0`,
    60000,
  );
  check(booted, "the window finished booting");
  check((await tabCount()) === 1, "one document, one tab", String(await tabCount()));
  check(
    (await activeTab()) === "feature-tour.md",
    "the tab is the file that was opened",
    await activeTab(),
  );
  check(
    (await evaluate(`document.getElementById("app").classList.contains("mode-split")`)) === true,
    "the window is in split view, so the preview scroll can be measured",
  );

  // -------------------------------------------------------------------------
  // A favorite opens a tab; the row is a real second route to a document
  // -------------------------------------------------------------------------
  console.log("\n=== the Favorites panel ===");
  await emitOpenFiles([path.resolve("samples", "typst-tour.typ")]);
  await sleep(1500);
  const favorited = await evaluate(`(() => {
    const tab = [...document.querySelectorAll(".doc-tab")].find(
      (entry) => entry.querySelector(".doc-tab-name")?.textContent === "typst-tour.typ",
    );
    if (!tab) return "missing tab";
    const bounds = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2,
      clientX: bounds.left + 12, clientY: bounds.top + 12,
    }));
    const button = document.querySelector('.tab-menu-item[data-action="favorite"]');
    if (!button) return "missing item";
    button.click();
    return "clicked";
  })()`);
  await sleep(500);
  check(favorited === "clicked", "the typst tab can be added to Favorites");
  await evaluate(`document.getElementById("tab-favorites").click(); "ok"`);
  const listed = await pollFor(
    `[...document.querySelectorAll("#sidebar-body .favorite-item")].some((e) => (e.title || "").endsWith("typst-tour.typ"))`,
  );
  check(listed, "the Favorites panel offers a .typ document", "Typst is a first-class format");
  const rowShape = await evaluate(`(() => {
    const row = [...document.querySelectorAll("#sidebar-body .favorite-item")]
      .find((e) => (e.title || "").endsWith("typst-tour.typ"));
    return row
      ? Boolean(row.querySelector(".favorite-open") && row.querySelector(".favorite-remove") && row.querySelector(".favorite-star"))
      : false;
  })()`);
  check(rowShape, "the favorite row has Open, a star and a single-entry ×");
  const closedFavoriteTab = await clickClose("typst-tour.typ");
  await sleep(700);
  check(
    closedFavoriteTab === "clicked" && (await tabCount()) === 1,
    "the typst tab was closed before reopening it from Favorites",
    String(await tabCount()),
  );
  const opened = await evaluate(`(() => {
    const row = [...document.querySelectorAll("#sidebar-body .favorite-item")]
      .find((e) => (e.title || "").endsWith("typst-tour.typ"));
    if (!row) return "missing";
    row.querySelector(".favorite-open").click();
    return "clicked";
  })()`);
  await sleep(2500);
  check(opened === "clicked", "the favorite row was clickable");
  check((await tabCount()) === 2, "clicking a favorite adds a tab", String(await tabCount()));
  check((await activeTab()) === "typst-tour.typ", "the new tab is that file", await activeTab());

  // -------------------------------------------------------------------------
  // An already-open path is focused, not read again
  // -------------------------------------------------------------------------
  console.log("\n=== a path that is already open ===");
  await evaluate(`document.getElementById("tab-recent").click(); "ok"`);
  const recent = await pollFor(
    `[...document.querySelectorAll(".sidebar-body .recent-item")].some((e) => (e.title || "").endsWith("feature-tour.md"))`,
  );
  check(recent, "the Recent panel lists the open document");
  await evaluate(
    `(() => {
      const row = [...document.querySelectorAll(".sidebar-body .recent-item")]
        .find((e) => (e.title || "").endsWith("feature-tour.md"));
      row.click();
      return "ok";
    })()`,
  );
  await sleep(1200);
  const afterRecent = await tabs();
  check(
    afterRecent.length === 2,
    "opening it again does not add a second tab",
    afterRecent.join(", "),
  );
  check(
    (await activeTab()) === "feature-tour.md",
    "it focuses the existing tab",
    await activeTab(),
  );

  // -------------------------------------------------------------------------
  // The active tab is unmistakable
  // -------------------------------------------------------------------------
  console.log("\n=== the active tab is unmistakable ===");
  const tabStyles = await json(
    `[...document.querySelectorAll(".doc-tab")].map((tab) => ({
      selected: tab.getAttribute("aria-selected") === "true",
      weight: Number(getComputedStyle(tab.querySelector(".doc-tab-name")).fontWeight),
      edge: getComputedStyle(tab).boxShadow,
    }))`,
  );
  const activeStyle = tabStyles.find((tab) => tab.selected) ?? { weight: 0, edge: "none" };
  const inactiveStyle = tabStyles.find((tab) => !tab.selected) ?? { weight: 0, edge: "none" };
  check(activeStyle.weight >= 600, "the active tab's name is bold", String(activeStyle.weight));
  check(inactiveStyle.weight < 600, "an inactive tab's name is not", String(inactiveStyle.weight));
  check(activeStyle.edge !== "none", "the active tab carries its accent edge", activeStyle.edge);

  // -------------------------------------------------------------------------
  // The context menu on a tab
  // -------------------------------------------------------------------------
  console.log("\n=== the tab context menu ===");
  const menuState = await json(
    `(() => {
      const tab = [...document.querySelectorAll(".doc-tab")].find(
        (entry) => entry.querySelector(".doc-tab-name")?.textContent === "feature-tour.md",
      );
      const bounds = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2,
        clientX: bounds.left + 12, clientY: bounds.top + 12,
      }));
      const menu = document.querySelector(".tab-menu");
      return {
        open: !menu.hidden,
        focused: document.activeElement?.dataset?.action ?? "",
        items: [...menu.querySelectorAll(".tab-menu-item")].map((button) => ({
          action: button.dataset.action,
          disabled: button.disabled,
          label: button.querySelector(".tab-menu-label")?.textContent ?? "",
        })),
      };
    })()`,
  );
  const menuAction = (id) => menuState.items.find((item) => item.action === id);
  check(menuState.open, "right-click opens the tab menu");
  check(menuState.focused === "close", "the first enabled action takes focus", menuState.focused);
  check(
    menuAction("closeOthers") && !menuAction("closeOthers").disabled,
    "Close Others is available with two tabs",
  );
  check(
    menuAction("closeLeft") && menuAction("closeLeft").disabled,
    "Close All to the Left is disabled on the first tab",
  );
  check(
    menuAction("closeRight") && !menuAction("closeRight").disabled,
    "Close All to the Right is available",
  );
  check(menuAction("save") && menuAction("save").disabled, "Save is disabled on a clean tab");
  check(
    menuAction("reveal") && !menuAction("reveal").disabled,
    "Reveal is offered for a saved file",
  );
  const menuClosed = await evaluate(
    `(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return document.querySelector(".tab-menu").hidden;
    })()`,
  );
  check(menuClosed, "Escape closes the menu");

  // -------------------------------------------------------------------------
  // Keyboard navigation between tabs
  // -------------------------------------------------------------------------
  console.log("\n=== keyboard navigation between tabs ===");
  await evaluate(
    `(() => {
      const tab = [...document.querySelectorAll(".doc-tab")].find(
        (entry) => entry.querySelector(".doc-tab-name")?.textContent === "feature-tour.md",
      );
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      return "sent";
    })()`,
  );
  await sleep(900);
  check(
    (await activeTab()) === "typst-tour.typ",
    "ArrowRight activates the next tab",
    await activeTab(),
  );
  check(
    (await evaluate(
      `document.activeElement?.querySelector?.(".doc-tab-name")?.textContent === "typst-tour.typ"`,
    )) === true,
    "and focus follows the active tab",
  );
  await evaluate(
    `(() => {
      const tab = document.querySelector('.doc-tab[aria-selected="true"]');
      tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
      return "sent";
    })()`,
  );
  await sleep(900);
  check((await activeTab()) === "feature-tour.md", "ArrowLeft comes back", await activeTab());

  // -------------------------------------------------------------------------
  // The regression: a large document, then a new tab
  // -------------------------------------------------------------------------
  console.log("\n=== a large document, then Ctrl+N ===");
  // Generate the fixture rather than borrowing README.md: the repository's own
  // README is 5.5 KB now, so a test that assumed its old 63 KB size silently
  // stopped exercising a large document.
  const largeDoc = tmp("large-document.md");
  writeFileSync(
    largeDoc,
    Array.from(
      { length: 1400 },
      (_, index) =>
        `## Section ${index + 1}\n\nParagraph ${index + 1} with enough text to make this document large.\n`,
    ).join("\n"),
  );
  await emitOpenFiles([largeDoc]);
  const openedLarge = await pollFor(
    `[...document.querySelectorAll(".doc-tab-name")].some((e) => e.textContent === "large-document.md")`,
  );
  check(openedLarge, "the open-files event adds a tab", (await tabs()).join(", "));
  // CodeMirror renders only the visible lines, so counting `.cm-content` text
  // would measure the viewport, not the document. The status bar reports the
  // buffer's real length.
  const docChars = await evaluate(
    `(() => {
      const title = document.getElementById("status-words")?.title ?? "";
      const match = title.match(/([0-9,]+) characters/);
      return match ? Number(match[1].replace(/,/g, "")) : 0;
    })()`,
  );
  check(docChars > 50000, "the large document really is loaded", docChars + " characters");

  const closedLarge = await clickClose("large-document.md");
  await sleep(900);
  check(closedLarge === "clicked", "its tab closes without a prompt", "the document was clean");
  check((await tabCount()) === 2, "the two file tabs remain", (await tabs()).join(", "));
  await clickTab("feature-tour.md");
  await sleep(900);

  await press({ code: "KeyN", key: "n", ctrl: true });
  await sleep(1500);
  const afterLarge = await tabs();
  check(
    afterLarge.length === 3,
    "Ctrl+N adds a tab after a large document was open",
    afterLarge.join(", "),
  );
  check(
    (await activeTab()) === "Untitled",
    "and the new tab is on screen at once",
    await activeTab(),
  );
  check(
    !(await toast()).includes("RangeError"),
    "no error was reported",
    (await toast()) || "no toast",
  );

  await clickClose("Untitled");
  await sleep(800);
  check((await tabCount()) === 2, "the probe tab is closed again", String(await tabCount()));
  await clickTab("feature-tour.md");
  await sleep(900);

  // -------------------------------------------------------------------------
  // The caret comes back with its tab
  // -------------------------------------------------------------------------
  console.log("\n=== the caret comes back with its tab ===");
  await evaluate(
    `(() => {
      const block = document.querySelector('#preview [data-line="21"]');
      if (!block) return "missing";
      block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      return "ok";
    })()`,
  );
  await sleep(500);
  const caretBefore = await cursor();
  check(lineOf(caretBefore) === 21, "a click in the preview put the caret on line 21", caretBefore);

  await clickTab("typst-tour.typ");
  await sleep(900);
  const caretOther = await cursor();
  check(caretOther !== caretBefore, "the other tab has its own caret", caretOther);

  await clickTab("feature-tour.md");
  await sleep(1000);
  const caretBack = await cursor();
  check(
    lineOf(caretBack) === lineOf(caretBefore),
    "switching back restores the caret from that tab's state",
    `${caretBefore} -> ${caretBack}`,
  );

  // -------------------------------------------------------------------------
  // Both scroll offsets come back with the tab
  // -------------------------------------------------------------------------
  console.log("\n=== scroll comes back with its tab ===");
  const setScroll = (preview, editor) =>
    evaluate(
      `(() => {
        const previewPane = document.getElementById("preview-pane");
        const scroller = document.querySelector(".cm-scroller");
        if (previewPane) previewPane.scrollTop = ${preview};
        if (scroller) scroller.scrollTop = ${editor};
        return JSON.stringify({ preview: previewPane?.scrollTop ?? -1, editor: scroller?.scrollTop ?? -1 });
      })()`,
    ).then((value) => JSON.parse(value));
  const readScroll = () =>
    evaluate(
      `JSON.stringify({
        preview: document.getElementById("preview-pane")?.scrollTop ?? -1,
        editor: document.querySelector(".cm-scroller")?.scrollTop ?? -1,
      })`,
    ).then((value) => JSON.parse(value));

  // Synchronised scrolling makes the two panes one coordinate system: restoring
  // the preview re-aligns the source, so both offsets could never come back
  // independently with sync on. Turn it off here to measure the tab's own memory
  // of each pane, and back on afterwards for the rest of the suite.
  const syncWasOn = await evaluate(
    `(() => {
      const flag = document.getElementById("flag-sync");
      const on = flag?.dataset.on === "true";
      if (on) flag.click();
      return on;
    })()`,
  );
  await sleep(400);
  check(
    (await evaluate(`document.getElementById("flag-sync").dataset.on`)) === "false",
    "sync scroll is off for the scroll measurement",
    syncWasOn ? "was on" : "already off",
  );

  const wanted = await setScroll(520, 340);
  await sleep(300);
  check(
    wanted.preview > 300 && wanted.editor > 200,
    "both panes were scrolled away from the top",
    JSON.stringify(wanted),
  );

  await clickTab("typst-tour.typ");
  await sleep(900);
  await clickTab("feature-tour.md");
  await sleep(1500);
  const restored = await readScroll();
  check(
    Math.abs(restored.preview - wanted.preview) <= 30,
    "the preview comes back to the offset it had",
    `${wanted.preview} -> ${restored.preview}`,
  );
  check(
    Math.abs(restored.editor - wanted.editor) <= 30,
    "the source comes back to the offset it had",
    `${wanted.editor} -> ${restored.editor}`,
  );

  // Put the reader's setting back: the sections after this one rely on the
  // default (sync on).
  await evaluate(`(() => {
    const flag = document.getElementById("flag-sync");
    if (flag.dataset.on !== "true") flag.click();
    return flag.dataset.on;
  })()`);
  await sleep(300);

  // -------------------------------------------------------------------------
  // The dirty dot belongs to the edited tab
  // -------------------------------------------------------------------------
  console.log("\n=== the dirty dot ===");
  await press({ code: "KeyN", key: "n", ctrl: true });
  await sleep(1000);
  check((await tabCount()) === 3, "Ctrl+N adds a tab", String(await tabCount()));
  check((await activeTab()) === "Untitled", "an untitled tab is active", await activeTab());

  await evaluate(`document.querySelector(".cm-content").focus()`);
  await send("Input.insertText", { text: "AUDIT" });
  await sleep(500);
  const dirtyNames = await json(
    `[...document.querySelectorAll(".doc-tab.is-dirty .doc-tab-name")].map((e) => e.textContent)`,
  );
  check(
    dirtyNames.length === 1 && dirtyNames[0] === "Untitled",
    "exactly the edited tab carries the dot",
    dirtyNames.join(", ") || "none",
  );
  check((await title()).includes("•"), "the title marks the document modified", await title());

  await press({ code: "KeyZ", key: "z", ctrl: true });
  await sleep(500);
  check((await dirtyCount()) === 0, "undo clears it", String(await dirtyCount()));
  check(!(await title()).includes("•"), "and the title loses the mark", await title());

  await clickClose("Untitled");
  await sleep(800);
  check((await tabCount()) === 2, "the edited tab is closed again", String(await tabCount()));

  // -------------------------------------------------------------------------
  // Close buttons
  // -------------------------------------------------------------------------
  console.log("\n=== the × button ===");
  const activeNow = await activeTab();
  const inactiveNow = (await tabs()).find((name) => name !== activeNow);
  const bufferBefore = await editorText();
  const closedInactive = await clickClose(inactiveNow);
  await sleep(900);
  check(closedInactive === "clicked", "an inactive tab has a ×", inactiveNow);
  check((await tabCount()) === 1, "closing it removes only that tab", String(await tabCount()));
  check((await activeTab()) === activeNow, "the visible tab does not change", await activeTab());
  check((await editorText()) === bufferBefore, "and its buffer is untouched");

  await emitOpenFiles([path.resolve("samples", "feature-tour.md")]);
  await sleep(1200);
  check(
    (await tabCount()) === 2,
    "a tab is opened again for the next check",
    (await tabs()).join(", "),
  );
  const activeForClose = await activeTab();
  const closedActive = await clickClose(activeForClose);
  await sleep(900);
  check(closedActive === "clicked", "the active tab has a ×");
  check((await tabCount()) === 1, "closing it leaves one tab", String(await tabCount()));
  check((await activeTab()) !== activeForClose, "the neighbour takes over", await activeTab());

  // -------------------------------------------------------------------------
  // Next and previous
  // -------------------------------------------------------------------------
  console.log("\n=== next and previous ===");
  const onlyFile = await activeTab();
  await press({ code: "KeyN", key: "n", ctrl: true });
  await sleep(1000);
  check((await tabCount()) === 2, "two tabs to cycle", (await tabs()).join(", "));
  const cycleStart = await activeTab();
  await press({ code: "Tab", key: "Tab", ctrl: true });
  await sleep(700);
  const cycleNext = await activeTab();
  check(
    cycleNext !== cycleStart,
    "Ctrl+Tab changes the active tab",
    `${cycleStart} -> ${cycleNext}`,
  );
  check(cycleNext === onlyFile, "it lands on the other tab", cycleNext);
  await press({ code: "Tab", key: "Tab", ctrl: true, shift: true });
  await sleep(700);
  check((await activeTab()) === cycleStart, "Ctrl+Shift+Tab returns", await activeTab());
  await clickClose(cycleStart);
  await sleep(800);

  // -------------------------------------------------------------------------
  // Middle-click
  // -------------------------------------------------------------------------
  console.log("\n=== middle-click ===");
  await emitOpenFiles([path.resolve("samples", "feature-tour.md")]);
  await sleep(1200);
  const beforeMiddle = await tabs();
  const activeBeforeMiddle = await activeTab();
  const middleTarget = beforeMiddle.find((name) => name !== activeBeforeMiddle);
  const sent = await evaluate(
    `(() => {
      const tab = [...document.querySelectorAll(".doc-tab")]
        .find((t) => t.querySelector(".doc-tab-name")?.textContent === ${JSON.stringify(middleTarget)});
      if (!tab) return "missing";
      tab.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
      return "sent";
    })()`,
  );
  await sleep(800);
  check(sent === "sent", "the middle click reached the tab", middleTarget);
  check((await tabCount()) === 1, "middle-click closed it", String(await tabCount()));

  // -------------------------------------------------------------------------
  // The disk poll
  // -------------------------------------------------------------------------
  console.log("\n=== the disk poll ===");
  const docA = tmp("a.md");
  const docB = tmp("b.md");
  const docC = tmp("c.md");
  writeFileSync(docA, "# A\n\nfirst version\n");
  writeFileSync(docB, "# B\n\nsecond document\n");
  writeFileSync(docC, "# C\n\nthird document\n");
  await emitOpenFiles([docA, docB, docC]);
  const polled = await pollFor(
    `[...document.querySelectorAll(".doc-tab-name")].some((e) => e.textContent === "c.md")`,
  );
  check(polled, "three temporary documents open as tabs", (await tabs()).join(", "));
  await sleep(800);

  // -------------------------------------------------------------------------
  // Dragging a tab reorders the strip
  // -------------------------------------------------------------------------
  console.log("\n=== dragging a tab reorders the strip ===");
  const beforeDrag = await tabs();
  const dragged = await evaluate(
    `(() => {
      const bar = document.getElementById("doc-tabs");
      const find = (name) => [...bar.querySelectorAll(".doc-tab")].find(
        (tab) => tab.querySelector(".doc-tab-name")?.textContent === name,
      );
      const from = find("a.md");
      const to = find("c.md");
      if (!from || !to) return "missing";
      const data = typeof DataTransfer === "function" ? new DataTransfer() : null;
      const fromRect = from.getBoundingClientRect();
      from.dispatchEvent(new DragEvent("dragstart", {
        bubbles: true, cancelable: true, dataTransfer: data,
        clientX: fromRect.left + fromRect.width / 2, clientY: fromRect.top + fromRect.height / 2,
      }));
      const target = to.getBoundingClientRect();
      const x = target.right - 2;
      const y = target.top + target.height / 2;
      bar.dispatchEvent(new DragEvent("dragover", {
        bubbles: true, cancelable: true, dataTransfer: data, clientX: x, clientY: y,
      }));
      bar.dispatchEvent(new DragEvent("drop", {
        bubbles: true, cancelable: true, dataTransfer: data, clientX: x, clientY: y,
      }));
      from.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: data }));
      return "sent";
    })()`,
  );
  await sleep(500);
  const afterDrag = await tabs();
  check(dragged === "sent", "the drag events reached the strip");
  check(afterDrag[afterDrag.length - 1] === "a.md", "a.md moved to the end", afterDrag.join(", "));
  check(afterDrag.length === beforeDrag.length, "no tab was lost", String(afterDrag.length));
  check(
    (await activeTab()) === "c.md",
    "dragging does not activate the dragged tab",
    await activeTab(),
  );

  await evaluate(
    `(() => {
      const tab = [...document.querySelectorAll(".doc-tab")].find(
        (entry) => entry.querySelector(".doc-tab-name")?.textContent === "a.md",
      );
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowLeft", altKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
      return "sent";
    })()`,
  );
  await sleep(400);
  const afterKeyMove = await tabs();
  check(
    afterKeyMove.indexOf("a.md") === afterKeyMove.length - 2,
    "Alt+Shift+ArrowLeft moves the focused tab one place left",
    afterKeyMove.join(", "),
  );
  check(
    (await activeTab()) === "c.md",
    "the keyboard move leaves the active tab alone",
    await activeTab(),
  );

  // A clean inactive tab reloads when its file changes.
  await clickTab("a.md");
  await sleep(800);
  writeFileSync(docC, "# C\n\nthird document\n\nCHANGED-ON-DISK\n");
  // The watcher polls every 2.5 s; two turns is enough for one reload.
  await sleep(4000);
  await clickTab("c.md");
  await sleep(1200);
  check(
    (await editorText()).includes("CHANGED-ON-DISK"),
    "a clean inactive tab is reloaded when its file changes",
    (await editorText()).slice(0, 40),
  );

  // A dirty inactive tab is left alone.
  await evaluate(`document.querySelector(".cm-content").focus()`);
  await send("Input.insertText", { text: "LOCAL-EDIT" });
  await sleep(400);
  check(await isDirty("c.md"), "the tab is dirty before the file changes");
  await clickTab("a.md");
  await sleep(800);
  writeFileSync(docC, "# C\n\nthird document\n\nCHANGED-AGAIN\n");
  await sleep(4000);
  await clickTab("c.md");
  await sleep(1200);
  const dirtyText = await editorText();
  check(
    dirtyText.includes("LOCAL-EDIT"),
    "a dirty tab keeps the reader's text",
    dirtyText.slice(0, 40),
  );
  check(!dirtyText.includes("CHANGED-AGAIN"), "and is not reloaded underneath them");
  await press({ code: "KeyZ", key: "z", ctrl: true });
  await sleep(500);

  // -------------------------------------------------------------------------
  // Auto Save walks the list
  // -------------------------------------------------------------------------
  console.log("\n=== Auto Save across tabs ===");
  const autoSaveOn = await evaluate(
    `(() => {
      const flag = document.getElementById("flag-auto-save");
      if (!flag) return "missing";
      if (flag.dataset.on !== "true") flag.click();
      return flag.dataset.on;
    })()`,
  );
  check(autoSaveOn === "true", "Auto Save is on", String(autoSaveOn));

  await clickTab("a.md");
  await sleep(700);
  await evaluate(`document.querySelector(".cm-content").focus()`);
  await send("Input.insertText", { text: "AUTOSAVE-A" });
  await sleep(400);
  await clickTab("b.md");
  await sleep(700);
  await evaluate(`document.querySelector(".cm-content").focus()`);
  await send("Input.insertText", { text: "AUTOSAVE-B" });
  await sleep(400);
  check((await dirtyCount()) === 2, "two tabs are dirty at once", String(await dirtyCount()));

  // Auto Save runs on a 20 s interval; give it one full turn plus slack, and
  // read the files from here rather than the DOM: what matters is the bytes.
  let savedBoth = false;
  const saveDeadline = Date.now() + 28000;
  while (Date.now() < saveDeadline) {
    if (
      readFileSync(docA, "utf8").includes("AUTOSAVE-A") &&
      readFileSync(docB, "utf8").includes("AUTOSAVE-B")
    ) {
      savedBoth = true;
      break;
    }
    await sleep(1000);
  }
  check(savedBoth, "Auto Save wrote the inactive tab as well as the active one", "a.md and b.md");
  check(
    !readFileSync(docA, "utf8").includes("AUTOSAVE-B"),
    "and it wrote each buffer to its own file",
  );
  await sleep(800);
  check(
    (await dirtyCount()) === 0,
    "the dots clear once both are saved",
    String(await dirtyCount()),
  );

  // -------------------------------------------------------------------------
  // A strip wider than the window
  // -------------------------------------------------------------------------
  console.log("\n=== a strip wider than the window ===");
  const overflowFiles = Array.from({ length: 14 }, (_, index) =>
    tmp(`overflow-document-with-a-long-name-${String(index + 1).padStart(2, "0")}.md`),
  );
  for (const [index, file] of overflowFiles.entries()) {
    writeFileSync(file, `# Overflow ${index + 1}\n\nbody\n`);
  }
  await emitOpenFiles(overflowFiles);
  const overflowed = await pollFor(
    `document.querySelectorAll(".doc-tab").length === ${4 + overflowFiles.length}`,
    20000,
  );
  check(overflowed, "enough tabs are open to overflow the strip", String(await tabCount()));
  await sleep(900);
  const activeVisible = await evaluate(
    `(() => {
      const viewport = document.getElementById("doc-tabs").getBoundingClientRect();
      const tab = document.querySelector('.doc-tab[aria-selected="true"]').getBoundingClientRect();
      return tab.left >= viewport.left - 1 && tab.right <= viewport.right + 1;
    })()`,
  );
  check(activeVisible, "the active tab is scrolled fully into view", `${await tabCount()} tabs`);
  const afterActive = await json(
    `(() => {
      const tabs = [...document.querySelectorAll(".doc-tab")];
      const index = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
      return tabs.slice(index + 1).map((tab) => tab.querySelector(".doc-tab-name")?.textContent ?? "");
    })()`,
  );
  check(
    afterActive.includes("a.md") && afterActive.includes("c.md"),
    "documents remain to the right of the active tab",
    afterActive.join(", "),
  );

  const strip = await json(
    `(() => {
      const bar = document.getElementById("doc-tabs");
      return {
        scrollWidth: bar.scrollWidth,
        clientWidth: bar.clientWidth,
        scrollLeft: bar.scrollLeft,
        overflowing: document.getElementById("doc-tabs-bar").classList.contains("is-overflowing"),
        toolbar: getComputedStyle(document.getElementById("doc-tabs-toolbar")).display,
        leftDisabled: document.getElementById("doc-tabs-left").disabled,
        rightDisabled: document.getElementById("doc-tabs-right").disabled,
      };
    })()`,
  );
  check(
    strip.scrollWidth > strip.clientWidth,
    "the tabs are wider than the viewport",
    `${strip.scrollWidth} > ${strip.clientWidth}`,
  );
  check(strip.overflowing && strip.toolbar !== "none", "the arrow toolbar appears");
  check(
    !strip.leftDisabled && !strip.rightDisabled,
    "both arrows are available when tabs remain on both sides",
    JSON.stringify(strip),
  );

  const stripLeft = strip.scrollLeft;
  await evaluate(`document.getElementById("doc-tabs-left").click()`);
  await sleep(800);
  const afterLeft = await json(
    `(() => {
      const bar = document.getElementById("doc-tabs");
      return {
        scrollLeft: bar.scrollLeft,
        leftDisabled: document.getElementById("doc-tabs-left").disabled,
        rightDisabled: document.getElementById("doc-tabs-right").disabled,
      };
    })()`,
  );
  check(
    afterLeft.scrollLeft < stripLeft,
    "the left arrow scrolls the strip",
    `${stripLeft} -> ${afterLeft.scrollLeft}`,
  );
  check(!afterLeft.rightDisabled, "the right arrow becomes enabled away from the edge");

  const wheel = await evaluate(
    `(() => {
      const bar = document.getElementById("doc-tabs");
      const event = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
      const before = bar.scrollLeft;
      bar.dispatchEvent(event);
      return { prevented: event.defaultPrevented, before, after: bar.scrollLeft };
    })()`,
  );
  check(wheel.prevented, "a vertical wheel is claimed by the strip");
  check(
    wheel.after > wheel.before,
    "and moves it horizontally",
    `${wheel.before} -> ${wheel.after}`,
  );

  await evaluate(`document.getElementById("doc-tabs-right").click()`);
  await sleep(1400);
  const firstRight = await json(
    `(() => {
      const bar = document.getElementById("doc-tabs");
      return {
        scrollLeft: bar.scrollLeft,
        rightDisabled: document.getElementById("doc-tabs-right").disabled,
      };
    })()`,
  );
  check(
    firstRight.scrollLeft > wheel.after,
    "the right arrow scrolls back",
    `${wheel.after} -> ${firstRight.scrollLeft}`,
  );
  check(!firstRight.rightDisabled, "one page is not the end of a long strip");
  // A second page reaches the edge, where the arrow disables itself.
  await evaluate(`document.getElementById("doc-tabs-right").click()`);
  const rightSettled = await pollFor(
    `(() => {
      const bar = document.getElementById("doc-tabs");
      return document.getElementById("doc-tabs-right").disabled &&
        bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 2;
    })()`,
    6000,
  );
  const afterRight = await json(
    `(() => {
      const bar = document.getElementById("doc-tabs");
      return {
        scrollLeft: bar.scrollLeft,
        rightDisabled: document.getElementById("doc-tabs-right").disabled,
      };
    })()`,
  );
  check(
    rightSettled && afterRight.rightDisabled,
    "a second page reaches the edge and disables the arrow",
    `${afterRight.scrollLeft}`,
  );

  await clickTab("feature-tour.md");
  await sleep(900);
  check(
    (await activeTab()) === "feature-tour.md",
    "a tab outside the viewport can be activated",
    await activeTab(),
  );
  const visible = await evaluate(
    `(() => {
      const viewport = document.getElementById("doc-tabs").getBoundingClientRect();
      const tab = [...document.querySelectorAll(".doc-tab")].find(
        (entry) => entry.querySelector(".doc-tab-name")?.textContent === "feature-tour.md",
      ).getBoundingClientRect();
      return tab.left >= viewport.left - 1 && tab.right <= viewport.right + 1;
    })()`,
  );
  check(visible, "and the strip scrolls it into view");

  // -------------------------------------------------------------------------
  // Close Others, from the tab menu
  // -------------------------------------------------------------------------
  console.log("\n=== Close Others ===");
  const closeOthers = await evaluate(
    `(() => {
      const tab = [...document.querySelectorAll(".doc-tab")].find(
        (entry) => entry.querySelector(".doc-tab-name")?.textContent === "feature-tour.md",
      );
      const bounds = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2,
        clientX: bounds.left + 10, clientY: bounds.top + 10,
      }));
      const button = [...document.querySelectorAll(".tab-menu-item")].find(
        (entry) => entry.dataset.action === "closeOthers",
      );
      if (!button) return "missing";
      button.click();
      return "clicked";
    })()`,
  );
  const cleaned = await pollFor(`document.querySelectorAll(".doc-tab").length === 1`, 15000);
  check(closeOthers === "clicked", "the Close Others menu entry was clicked");
  check(cleaned, "Close Others leaves one tab", (await tabs()).join(", "));
  check(
    (await activeTab()) === "feature-tour.md",
    "and it is the tab the menu targeted",
    await activeTab(),
  );

  // -------------------------------------------------------------------------
  // Closing the last tab
  // -------------------------------------------------------------------------
  console.log("\n=== closing the last tab ===");
  check((await tabCount()) === 1, "one file tab is left", (await tabs()).join(", "));
  check((await activeTab()) === "feature-tour.md", "and it is the file", await activeTab());

  await evaluate(`document.querySelector(".cm-content").focus()`);
  await press({ code: "KeyW", key: "w", ctrl: true });
  await sleep(1200);
  check((await tabCount()) === 1, "the strip still holds one tab", String(await tabCount()));
  check(
    (await activeTab()) === "Untitled",
    "the file tab became a fresh untitled document",
    await activeTab(),
  );
  check((await editorText()).replace(/\s+/g, "") === "", "the buffer is empty");
  check((await title()) === "Untitled — MDraft", "the title follows", await title());
  check((await dirtyCount()) === 0, "the fresh document is clean", String(await dirtyCount()));
  check((await guestCount()) === 0, "and no HTML guest is left behind", String(await guestCount()));
} finally {
  rmSync(workDir, { recursive: true, force: true });
  ws.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ""}`);
}
process.exit(failed.length === 0 ? 0 : 1);
