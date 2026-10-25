// Follow a link from the source pane, with Ctrl+click and with the right-click
// menu, in a document that has an external URL, a relative document, an image
// and a same-document fragment.
//
//   node scripts/link-navigation-test.mjs [port]
//
// Start the application with samples/feature-tour.md open. The suite writes a
// temporary document and a sibling it links to; it never touches the fixtures.
//
// The external URL and the image are only inspected, never opened: clicking
// them would launch a browser or an image viewer. The relative document opens
// in a tab, and a missing image exercises the OS-opener path without launching
// anything.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = Number(process.argv[2] ?? 9222);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
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
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return response.result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let total = 0;
function check(ok, label, detail = "") {
  total += 1;
  if (ok) passed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function pollFor(expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(120);
  }
  return false;
}

const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );
const emit = (event, payload) => invoke("plugin:event|emit", { event, payload });

const workDir = mkdtempSync(path.join(tmpdir(), "mdraft-links-"));
const subDir = path.join(workDir, "sub");
mkdirSync(subDir);
const linked = path.join(workDir, "other.md");
const document = path.join(subDir, "links.md");
writeFileSync(linked, "# Other document\n\nLinked from the fixture.\n");
writeFileSync(
  document,
  [
    "# Links",
    "",
    "A [jump](#target) inside this document.",
    "",
    "An [external](https://tauri.app) link.",
    "",
    "A [relative](../other.md) document.",
    "",
    "An ![image](picture.png) that does not exist.",
    "",
    ...Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} fills the preview.`),
    "",
    "## Target",
    "",
    "The target section.",
    "",
  ].join("\n"),
);

const activeName = `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent`;

/** The screen point of the middle of `needle`, inside the editor. */
const pointFor = (needle) =>
  evaluate(`(() => {
    const needle = ${JSON.stringify(needle)};
    for (const line of document.querySelectorAll('.cm-line')) {
      const text = line.textContent ?? '';
      const index = text.indexOf(needle);
      if (index < 0) continue;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let seen = 0;
      let node;
      while ((node = walker.nextNode())) {
        const length = node.textContent?.length ?? 0;
        if (index >= seen && index < seen + length) {
          const range = document.createRange();
          const at = Math.min(length - 1, index - seen + Math.floor(needle.length / 2));
          range.setStart(node, at);
          range.setEnd(node, Math.min(length, at + 1));
          const rect = range.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        seen += length;
      }
    }
    return null;
  })()`);

const mouse = (type, point, modifiers = 0) =>
  send("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
    modifiers,
  });

async function ctrlClick(point) {
  await mouse("mousePressed", point, 2);
  await mouse("mouseReleased", point, 2);
  await sleep(600);
}

async function closeMenu() {
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))`,
  );
  await sleep(120);
}

/** Dispatch the context menu and read it in the same evaluate. */
const menuAt = (point) =>
  evaluate(`(() => {
    const target = document.elementFromPoint(${point.x}, ${point.y});
    if (!target) return { count: 0, items: [] };
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: ${point.x}, clientY: ${point.y}, button: 2, buttons: 2,
    }));
    const menus = [...document.querySelectorAll('.editor-menu')];
    return {
      count: menus.length,
      items: menus[0]
        ? [...menus[0].querySelectorAll('.editor-menu-item')].map((button) => ({
            action: button.dataset.action,
            label: button.querySelector('.editor-menu-label')?.textContent ?? button.textContent,
            href: button.dataset.href ?? '',
            disabled: button.disabled,
          }))
        : [],
    };
  })()`);

const choose = (action) =>
  evaluate(`(() => {
    const button = document.querySelector('.editor-menu-item[data-action="${action}"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);

try {
  await evaluate("document.querySelector('.cm-scroller').scrollTop = 0");
  const opened = await (async () => {
    await emit("open-files", [document]);
    return pollFor(
      `${activeName} === 'links.md' && document.querySelectorAll('.cm-line').length > 0`,
    );
  })();
  check(opened, "the temporary document opens as its own tab");
  await sleep(600);

  console.log("\n=== the context menu ===");
  const external = await pointFor("external");
  const externalMenu = await menuAt(external);
  const externalItem = externalMenu.items.find((item) => item.action === "openLink");
  check(
    externalMenu.count === 1,
    "right-clicking a link opens one menu",
    `menus=${externalMenu.count}`,
  );
  check(
    externalItem?.label === "Open Link" && externalItem.href === "https://tauri.app",
    "an external link offers Open Link with its address",
    JSON.stringify(externalItem),
  );
  check(externalItem?.disabled === false, "the Open Link item is enabled");
  await closeMenu();

  const prose = await pointFor("Paragraph 2 fills");
  const proseMenu = await menuAt(prose);
  check(
    proseMenu.items[0]?.action === "undo",
    "right-clicking prose still starts the editing menu",
    proseMenu.items[0]?.action ?? "none",
  );
  check(!proseMenu.items.some((item) => item.action === "openLink"), "prose has no Open Link item");
  await closeMenu();

  const relative = await pointFor("relative");
  const relativeMenu = await menuAt(relative);
  const relativeItem = relativeMenu.items.find((item) => item.action === "openLink");
  check(
    relativeItem?.label === "Open File" && relativeItem.href === "../other.md",
    "a relative document offers Open File with its path",
    JSON.stringify(relativeItem),
  );
  await closeMenu();

  const image = await pointFor("image](picture.png");
  const imageMenu = await menuAt(image);
  const imageItem = imageMenu.items.find((item) => item.action === "openLink");
  check(
    imageItem?.label === "Open Image" && imageItem.href === "picture.png",
    "an image offers Open Image with its path",
    JSON.stringify(imageItem),
  );

  // The image is missing: the OS opener refuses it and the toast says so. No
  // viewer is launched.
  check(await choose("openLink"), "the Open Image item is clickable");
  const imageToast = await pollFor(
    `(document.getElementById('toast')?.textContent ?? '').includes('was not found')`,
    6000,
  );
  check(imageToast, "a missing image reports that it was not found");

  const jump = await pointFor("jump](#target");
  const jumpMenu = await menuAt(jump);
  const jumpItem = jumpMenu.items.find((item) => item.action === "openLink");
  check(
    jumpItem?.label === "Go to Heading" && jumpItem.href === "#target",
    "a same-document link offers Go to Heading",
    JSON.stringify(jumpItem),
  );
  await closeMenu();

  console.log("\n=== Ctrl+click in the source ===");
  const sourceBefore = await evaluate(
    `[...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\\n')`,
  );
  await evaluate("document.getElementById('preview-pane').scrollTop = 0");
  const beforeScroll = await evaluate("document.getElementById('preview-pane').scrollTop");
  await ctrlClick(await pointFor("jump](#target"));
  const scrolled = await pollFor(
    `document.getElementById('preview-pane').scrollTop > ${beforeScroll + 20}`,
    6000,
  );
  const headingExists = await evaluate(`document.querySelector('#preview [id="target"]') !== null`);
  check(headingExists, "the preview rendered the target heading");
  check(scrolled, "Ctrl+click on #target scrolls the preview to it");

  const sourceAfter = await evaluate(
    `[...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\\n')`,
  );
  check(sourceAfter === sourceBefore, "Ctrl+click inserts no text");

  await evaluate("document.querySelector('.cm-scroller').scrollTop = 0");
  await mouse("mousePressed", await pointFor("Paragraph 3 fills"), 0);
  await mouse("mouseReleased", await pointFor("Paragraph 3 fills"), 0);
  await sleep(250);
  const secondaryBefore = await evaluate(
    "document.querySelectorAll('.cm-cursor-secondary').length",
  );
  await ctrlClick(await pointFor("Paragraph 4 fills"));
  const secondaryAfter = await evaluate(`document.querySelectorAll('.cm-cursor-secondary').length`);
  check(
    secondaryAfter > secondaryBefore,
    "Ctrl+click on prose still adds a cursor",
    `${secondaryBefore} -> ${secondaryAfter}`,
  );

  // A Ctrl+drag that starts on a link must not launch it.
  await evaluate("document.getElementById('preview-pane').scrollTop = 0");
  const dragStart = await pointFor("external");
  await mouse("mousePressed", dragStart, 2);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: dragStart.x + 60,
    y: dragStart.y,
    button: "left",
    buttons: 1,
    modifiers: 2,
  });
  await mouse("mouseReleased", { x: dragStart.x + 60, y: dragStart.y }, 2);
  await sleep(400);
  const afterDrag = await evaluate("document.getElementById('preview-pane').scrollTop");
  check(afterDrag === 0, "a Ctrl+drag from a link follows nothing", `scroll=${afterDrag}`);

  console.log("\n=== opening a linked document ===");
  const relativePoint = await pointFor("relative");
  await menuAt(relativePoint);
  check(await choose("openLink"), "the Open File item is clickable");
  const openedLinked = await pollFor(`${activeName} === 'other.md'`, 12000);
  check(openedLinked, "Open File opens the linked document in a tab", await evaluate(activeName));
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* the temporary directory is disposable */
  }
  ws.close();
}

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
