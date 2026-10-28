// Does the editor's right-click menu carry the editing actions and format a
// whole document, in one undo step, without touching a document it did not
// format? Does the tab menu format the clicked tab, even in the background?
//
//   node scripts/format-document-test.mjs [port]
//   node scripts/format-document-test.mjs --unit   (math regressions, no app)
// Add --without-optional-corpus to exercise the recorded inventory fallback.
//
// The suite works on temporary copies of the fixtures, never on the repository's
// own files: it saves after formatting and after undo so the comparison is the
// bytes on disk, not a count of menu items. The launch document is left alone;
// each language is opened as its own tab and each tab is undone back to its
// original bytes before the next one is tested.
//
// The clipboard checks replace `navigator.clipboard` with an in-page fake. The
// agent session cannot own the operating system clipboard, so the suite proves
// the menu's read/write wiring and the synthetic paste path, not the OS itself.

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import katex from "katex";
import { formatDocument } from "../src/format/formatters.ts";
import { analyzeMath } from "../src/math-delimiters.ts";

const physicsPath = new URL("../docs/samples/physrevb_70_035307.md", import.meta.url);
const recordedMath = JSON.parse(
  readFileSync(new URL("./fixtures/math-inventory.json", import.meta.url), "utf8"),
)["docs/samples/physrevb_70_035307.md"].entries;
// The paper is an ignored local file. A checkout without it still exercises
// every recorded formula, rather than silently skipping the regression.
const physicsSource =
  !process.argv.includes("--without-optional-corpus") && existsSync(physicsPath)
    ? readFileSync(physicsPath, "utf8")
    : recordedMath
        .map(({ body, display }) => (display ? `$$\n${body}\n$$` : `$${body}$`))
        .join("\n\n");

function rawMath(source) {
  return analyzeMath(source).math.map(({ from, to }) => source.slice(from, to));
}

function mathErrors(source) {
  return analyzeMath(source).math.filter(({ body, display }) => {
    try {
      katex.renderToString(body, { displayMode: display, throwOnError: true, strict: false });
      return false;
    } catch {
      return true;
    }
  }).length;
}

async function mathFormattingChecks() {
  console.log("=== Markdown math preservation ===");
  const results = [];
  const assert = (ok, label) => {
    results.push({ ok, label, detail: "" });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  };
  const energy = String.raw`$E_n(\mathbf{k}) = \varepsilon_n + \hbar^2\mathbf{k}^2/(2m^*)$`;
  const boundary = String.raw`$[1/m^*(z)](\partial\chi_n/\partial z)$`;
  const mass = "$m_A^*(m_B^*)$";
  const fixtures = [
    [
      "reported equations",
      `${energy}. Matching ${boundary}, with ${mass}.`,
      [energy, boundary, mass],
    ],
    ["repeated inline equations", "$m^*$ and $m^*$", ["$m^*$", "$m^*$"]],
    [
      "backslash inline delimiters",
      String.raw`\(m^*\) and \(a_i * b_j\)`,
      [String.raw`\(m^*\)`, String.raw`\(a_i * b_j\)`],
    ],
    ["padded inline equations", "$  m^*  $ and $ a_i + b_j $", ["$  m^*  $", "$ a_i + b_j $"]],
    [
      "multiline dollar display",
      "$$ \n a_i * b_j \\\\\n\t + c^* \n$$",
      ["$$ \n a_i * b_j \\\\\n\t + c^* \n$$"],
    ],
    ["CRLF backslash display", "\\[\r\n a_i * b_j\r\n\\]", ["\\[\r\n a_i * b_j\r\n\\]"]],
    ["inline double dollars", "$$m^*$$ and $$a_i$$", ["$$m^*$$", "$$a_i$$"]],
    // The shared dialect gives $$ precedence; touching single-dollar pairs
    // are unfinished display syntax, not two inline equations.
    ["adjacent dollar boundary", "$a_i$$b_j$", []],
    [
      "adjacent explicit equations",
      String.raw`\(a_i\)\(b_j\)`,
      [String.raw`\(a_i\)`, String.raw`\(b_j\)`],
    ],
    ["emphasis and attached text", "*$a_i$* and foo$x^2$bar", ["$a_i$", "$x^2$"]],
    ["link labels", "[$a_i$](https://example.org) and **$m^*$**", ["$a_i$", "$m^*$"]],
    ["tables", "| A | B |\n|---|---|\n| $a_i$ | $m^*$ |", ["$a_i$", "$m^*$"]],
    ["list display", "- $$\n  a_i * b_j\n  $$\n\n  *text*", ["$$\n  a_i * b_j\n  $$"]],
    ["quote display", "> $$\n> a_i * b_j\n> $$\n>\n> *text*", ["$$\n> a_i * b_j\n> $$"]],
    [
      "code and currency boundaries",
      "`$a^*$` and R$50, US$5, \\$2.00 and \\$3.50; $m^*$ and $m^*$\n\n```tex\n$m^*$\n```",
      ["$m^*$", "$m^*$"],
    ],
    ["marker collisions", "MDRAFTMATH MDRAFTMATHX0END and $m^*$", ["$m^*$"]],
    ["prettier-ignore", "<!-- prettier-ignore -->\n*mixed* $m^*$ and $m^*$", ["$m^*$", "$m^*$"]],
    ["existing invalid TeX", "$m^_$ and $m^*$", ["$m^_$", "$m^*$"]],
    ["unfinished math", "*text*\n\n\\[a_i * b_j", []],
  ];
  for (const [label, source, expected] of fixtures) {
    const formatted = await formatDocument(source, "markdown");
    assert(
      JSON.stringify(rawMath(formatted)) === JSON.stringify(expected),
      `${label}: exact source`,
    );
    assert(
      (await formatDocument(formatted, "markdown")) === formatted,
      `${label}: stable second format`,
    );
    if (label === "tables") {
      const widths = formatted
        .trimEnd()
        .split("\n")
        .map((line) => line.length);
      assert(new Set(widths).size === 1, "math table columns align to the real equation widths");
    }
    if (label === "code and currency boundaries") {
      assert(
        formatted.includes("`$a^*$`") &&
          formatted.includes("R$50, US$5, \\$2.00 and \\$3.50") &&
          formatted.includes("```tex\n$m^*$\n```"),
        "code and currency keep their literal content",
      );
    }
    if (label === "marker collisions") {
      assert(
        formatted.includes("MDRAFTMATH MDRAFTMATHX0END"),
        "existing marker-like text survives",
      );
    }
    if (label === "prettier-ignore") {
      assert(
        formatted === `${source}\n`,
        "prettier-ignore retains the complete original paragraph",
      );
    }
    if (label === "unfinished math") {
      assert(
        formatted.includes("\\[a_i * b_j"),
        "an unfinished equation is not rewritten as emphasis",
      );
    }
  }
  const expectedInventory = recordedMath.map(({ body, display }) => ({ body, display }));
  const actualInventory = analyzeMath(physicsSource).math.map(({ body, display }) => ({
    body,
    display,
  }));
  assert(
    JSON.stringify(actualInventory) === JSON.stringify(expectedInventory),
    "all 292 corpus formulas match the recorded inventory",
  );
  const formattedPhysics = await formatDocument(physicsSource, "markdown");
  assert(
    JSON.stringify(rawMath(formattedPhysics)) === JSON.stringify(rawMath(physicsSource)),
    "the complete physics corpus preserves every math source byte",
  );
  assert(
    mathErrors(formattedPhysics) === mathErrors(physicsSource),
    "formatting adds no KaTeX errors to the physics corpus",
  );
  assert(
    (await formatDocument(formattedPhysics, "markdown")) === formattedPhysics,
    "the complete physics corpus is stable on a second format",
  );
  return results;
}

if (process.argv.includes("--unit")) {
  const results = await mathFormattingChecks();
  const passed = results.filter(({ ok }) => ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

const port = process.argv[2] ?? "9222";

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

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function pollFor(expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(120);
  }
  return false;
}

/** Tauri command through the same bridge the application's wrappers use. */
const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );

const emit = (event, payload) => invoke("plugin:event|emit", { event, payload });

const repoRoot = path.resolve(import.meta.dirname, "..");
const workDir = mkdtempSync(path.join(tmpdir(), "mdraft-format-document-"));

const files = {
  markdown: path.join(workDir, "format-markdown.md"),
  math: path.join(workDir, "format-math.md"),
  html: path.join(workDir, "format-document.html"),
  typst: path.join(workDir, "format-document.typ"),
  asciidoc: path.join(workDir, "format-document.adoc"),
  invalid: path.join(workDir, "format-invalid.typ"),
};
copyFileSync(path.join(repoRoot, "samples/feature-tour.md"), files.markdown);
copyFileSync(path.join(repoRoot, "samples/html-tour/index.html"), files.html);
copyFileSync(path.join(repoRoot, "samples/typst-tour.typ"), files.typst);
copyFileSync(path.join(repoRoot, "samples/asciidoc-tour.adoc"), files.asciidoc);
writeFileSync(files.invalid, "#let broken = (\n");
writeFileSync(files.math, `# Formatting regression\n\n*emphasis*\n\n${physicsSource}`);

const original = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [key, readFileSync(file)]),
);

const nameOf = (file) => path.basename(file);
const activeName = `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent`;

async function openFile(file) {
  await emit("open-files", [file]);
  return pollFor(
    `${activeName} === ${JSON.stringify(nameOf(file))} && document.querySelectorAll('.cm-line').length > 0`,
    20000,
  );
}

function mouse(type, point) {
  return send("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    button: "left",
    buttons: type === "mousePressed" ? 1 : 0,
    clickCount: 1,
  });
}

/** A point inside the Nth rendered line, after scrolling the editor to the top. */
function linePoint(index, offset = 30) {
  return evaluate(`(() => {
    const scroller = document.querySelector('.cm-scroller');
    if (scroller) scroller.scrollTop = 0;
    const line = document.querySelectorAll('.cm-line')[${index}];
    if (!line) return null;
    const rect = line.getBoundingClientRect();
    return { x: rect.left + ${offset}, y: rect.top + rect.height / 2 };
  })()`);
}

async function clickLine(index) {
  const point = await linePoint(index);
  if (!point) throw new Error(`line ${index} is not rendered`);
  await mouse("mousePressed", point);
  await mouse("mouseReleased", point);
  return point;
}

/** A synthetic right-click at page coordinates; it reaches every DOM listener. */
function rightClick(x, y) {
  return evaluate(`(() => {
    const target = document.elementFromPoint(${x}, ${y});
    if (!target) throw new Error('nothing at the point');
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, button: 2, buttons: 2,
    }));
  })()`);
}

/**
 * Right-click a rendered line, recomputing its position in the same task.
 *
 * A separate `linePoint` call is not enough here: opening the physics document
 * can schedule a preview-driven scroll that moves the editor between the
 * measurement and the event, and the contextmenu then lands outside the pane.
 * The full suite makes that window wide enough to see, while an isolated run
 * usually does not. Measuring and dispatching synchronously removes it.
 */
function rightClickLine(index) {
  return evaluate(`(() => {
    const scroller = document.querySelector('.cm-scroller');
    if (scroller) scroller.scrollTop = 0;
    const line = document.querySelectorAll('.cm-line')[${index}];
    if (!line) return 'missing';
    const rect = line.getBoundingClientRect();
    const x = rect.left + 30;
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y) ?? line;
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2,
    }));
    return 'sent';
  })()`);
}

const menuState = () =>
  evaluate(`(() => {
    const menus = [...document.querySelectorAll('.editor-menu')];
    return {
      count: menus.length,
      items: menus[0]
        ? [...menus[0].querySelectorAll('.editor-menu-item')].map((button) => ({
            action: button.dataset.action,
            label: button.querySelector('.editor-menu-label')?.textContent ?? button.textContent,
            shortcut: button.querySelector('.editor-menu-shortcut')?.textContent ?? '',
            disabled: button.disabled,
            title: button.title,
          }))
        : [],
      separators: menus[0] ? menus[0].querySelectorAll('.editor-menu-sep').length : 0,
    };
  })()`);

const chooseEditor = (action) =>
  evaluate(`(() => {
    const button = document.querySelector('.editor-menu-item[data-action="${action}"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);

const chooseFormat = () => chooseEditor("format");

const tabMenuState = () =>
  evaluate(`(() => {
    const menu = document.querySelector('.tab-menu');
    return {
      open: !menu.hidden,
      items: [...menu.querySelectorAll('.tab-menu-item')].map((button) => ({
        action: button.dataset.action,
        label: button.querySelector('.tab-menu-label')?.textContent ?? '',
        disabled: button.disabled,
        title: button.title,
      })),
    };
  })()`);

const tabByName = (name) => `[...document.querySelectorAll('.doc-tab')].find(
  (tab) => tab.querySelector('.doc-tab-name')?.textContent === ${JSON.stringify(name)}
)`;

const rightClickTab = (name) =>
  evaluate(`(() => {
    const tab = ${tabByName(name)};
    if (!tab) return false;
    const bounds = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: bounds.left + 12, clientY: bounds.top + 12,
    }));
    return true;
  })()`);

const chooseTab = (action) =>
  evaluate(`(() => {
    const button = document.querySelector('.tab-menu-item[data-action="${action}"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);

const isTabDirty = (name) =>
  evaluate(`(() => {
    const tab = ${tabByName(name)};
    return tab?.classList.contains('is-dirty') === true;
  })()`);

const activateTab = (name) =>
  evaluate(`(() => {
    const tab = ${tabByName(name)};
    if (!tab) return false;
    tab.click();
    return true;
  })()`);

const lineText = (index) =>
  evaluate(`document.querySelectorAll('.cm-line')[${index}]?.textContent ?? ''`);

async function pressKey(key, code, virtualKeyCode, modifiers = 0) {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers,
  });
}

/** Click a line, go Home, then select the whole logical line with Shift+End. */
async function selectLine(index) {
  const point = await clickLine(index);
  await pressKey("Home", "Home", 36);
  await pressKey("End", "End", 35, 8);
  return point;
}

async function openLineMenu(index) {
  const point = await selectLine(index);
  await rightClick(point.x, point.y);
  return point;
}

const cursorLine = async () => {
  const text = await evaluate(`document.getElementById('status-cursor')?.textContent ?? ""`);
  const match = /^Ln (\d+)/.exec(text);
  return match ? Number(match[1]) : 0;
};

const isDirty = () =>
  evaluate(
    `document.querySelector('.doc-tab[aria-selected="true"]')?.classList.contains('is-dirty') === true`,
  );

const toastText = () => evaluate(`document.getElementById('toast')?.textContent ?? ""`);

async function waitForToast(needle, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await toastText();
    if (text.includes(needle)) return text;
    await sleep(120);
  }
  return toastText();
}

async function waitForFile(file, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let bytes = readFileSync(file);
  while (Date.now() < deadline) {
    bytes = readFileSync(file);
    if (predicate(bytes)) return bytes;
    await sleep(120);
  }
  return bytes;
}

async function save(file, predicate) {
  // `runMenuAction` suppresses a repeat of the same menu id within 250 ms, so a
  // script that saves twice faster than a person can would silently lose the
  // second write. Wait past the guard before asking again.
  await sleep(300);
  await emit("menu", "file.save");
  // Save is asynchronous in the shell. Give the write a moment before polling,
  // so an unchanged file from a previous save cannot satisfy the predicate.
  await sleep(120);
  return waitForFile(file, predicate);
}

const undo = () =>
  evaluate(`(() => {
    const target = document.querySelector('.cm-content');
    if (!target) return false;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    return true;
  })()`);

// The Preferences panel's rows carry the help mark in their label; compare the
// text without it, exactly. A substring match would pick the wrong row.
function preferenceRow(label) {
  return `[...document.querySelectorAll('.prefs-row')].find((row) =>
    (row.querySelector('.prefs-label')?.textContent ?? '').replace(/\\?$/, '').trim() === ${JSON.stringify(label)})`;
}

async function openEditorPreferences() {
  await evaluate(`(() => {
    const overlay = document.querySelector('.prefs-overlay');
    if (!overlay || overlay.hidden) document.getElementById('btn-prefs').click();
    [...document.querySelectorAll('.prefs-section')].find((section) => section.textContent === 'Editor')?.click();
  })()`);
}

let fatal = null;
try {
  checks.push(...(await mathFormattingChecks()));
  // -------------------------------------------------------------------------
  // Launch: the formatters are lazy
  // -------------------------------------------------------------------------
  console.log("=== launch ===");
  const booted = await pollFor(
    `document.title.endsWith(" — MDraft") && document.querySelectorAll('.cm-line').length > 0`,
    60000,
  );
  check(booted, "the window finished booting");

  const formatterRequests = await evaluate(`performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => /typstyle|standalone-|prettier/i.test(name))`);
  check(
    formatterRequests.length === 0,
    "no formatter asset is requested at launch",
    formatterRequests.join(", ") || "none",
  );

  // -------------------------------------------------------------------------
  // Markdown
  // -------------------------------------------------------------------------
  console.log("\n=== Markdown ===");
  const mdOpened = await openFile(files.markdown);
  check(mdOpened, "the Markdown copy opens as its own tab");

  const mdPoint = await clickLine(9);
  const mdBeforeLine = await cursorLine();
  await rightClick(mdPoint.x, mdPoint.y);
  let menu = await menuState();
  const expectedLabels = [
    "Undo",
    "Redo",
    "Cut",
    "Copy",
    "Paste",
    "Delete",
    "Select All",
    "UPPERCASE",
    "lowercase",
    "Title Case",
    "Toggle Single Line Comment",
    "Duplicate Line",
    "Move Line Up",
    "Move Line Down",
    "Format Document",
    // Read Aloud sits between formatting and Favorites: all three act on the
    // document rather than on the selection above them.
    "Read Aloud from Here",
    "Read Aloud from the Beginning",
    "Add to Favorites",
  ];
  const labels = menu.items.map((item) => item.label);
  const item = (action) => menu.items.find((entry) => entry.action === action);
  check(menu.count === 1, "right-clicking the source opens one menu", `menus=${menu.count}`);
  check(
    labels.join("|") === expectedLabels.join("|"),
    "the menu lists every editor action in order",
    labels.join(", "),
  );
  check(
    ["cut", "copy", "delete", "uppercase", "lowercase", "titleCase"].every(
      (action) => item(action) && item(action).disabled,
    ),
    "the selection actions are disabled without a selection",
  );
  check(
    ["paste", "selectAll", "comment", "format", "favorite"].every(
      (action) => item(action) && !item(action).disabled,
    ),
    "Paste, Select All, Comment, Format and Favorites are available",
  );
  check(
    ["Cut", "Copy", "Paste", "Select All"].every((label) =>
      menu.items.some((entry) => entry.label === label && entry.shortcut !== ""),
    ),
    "the clipboard and selection items carry shortcut hints",
    menu.items.map((entry) => `${entry.label}:${entry.shortcut}`).join(", "),
  );
  const mdChosen = await chooseFormat();
  check(mdChosen, "the Format Document item is clickable");
  const mdDirty = await pollFor(
    `document.querySelector('.doc-tab[aria-selected="true"]')?.classList.contains('is-dirty') === true`,
    20000,
  );
  check(mdDirty, "formatting marks the tab dirty");

  const mdAfterLine = await cursorLine();
  check(
    mdAfterLine === mdBeforeLine && mdAfterLine > 0,
    "the caret stays on its line",
    `Ln ${mdBeforeLine} -> Ln ${mdAfterLine}`,
  );

  const mdSaved = await save(files.markdown, (bytes) => !bytes.equals(original.markdown));
  check(
    !mdSaved.equals(original.markdown),
    "the saved document changed",
    `${original.markdown.length} -> ${mdSaved.length} bytes`,
  );
  const mdText = mdSaved.toString("utf8");
  check(
    mdText.includes("_emphasis_") && !mdText.includes("*emphasis*"),
    "Prettier normalises the emphasis markers",
  );
  check(
    /^\| Feature\s{2,}\| Status\s+\| Notes\s+\|$/m.test(mdText),
    "Prettier aligns the Markdown table",
  );

  // A second format is a no-op, and says so instead of creating an empty undo
  // step.
  const mdPointAgain = await linePoint(9);
  await rightClick(mdPointAgain.x, mdPointAgain.y);
  await chooseFormat();
  const already = await waitForToast("Already formatted");
  check(already === "Already formatted", "a second format says Already formatted", already);
  check(!(await isDirty()), "a second format leaves the tab clean");
  check(
    readFileSync(files.markdown).equals(mdSaved),
    "a second format leaves the saved bytes alone",
  );

  // The main menu must reach the same command, not a second implementation.
  await evaluate(`(() => {
    const node = document.getElementById("toast");
    if (node) node.textContent = "";
    return true;
  })()`);
  await emit("menu", "format.document");
  const menuAlready = await waitForToast("Already formatted");
  check(
    menuAlready === "Already formatted",
    "Format › Format Document runs the same command",
    menuAlready,
  );
  check(!(await isDirty()), "the menu route also leaves the tab clean");

  // One undo restores the exact original.
  await undo();
  const undid = await pollFor(
    `document.querySelector('.doc-tab[aria-selected="true"]')?.classList.contains('is-dirty') === true`,
    10000,
  );
  check(undid, "one undo makes the formatted document dirty again");
  const mdRestored = await save(files.markdown, (bytes) => bytes.equals(original.markdown));
  check(
    mdRestored.equals(original.markdown),
    "one undo restores the exact original bytes",
    `${mdRestored.length} bytes`,
  );
  check(!(await isDirty()), "the restored document is clean");

  // The reported physics paper must survive the real right-click/save/undo
  // route, including a completed preview redraw rather than stale old pixels.
  console.log("\n=== equations through Format Document ===");
  check(await openFile(files.math), "the physics copy opens as its own tab");
  await pollFor(
    `document.querySelectorAll('#preview .math-inline, #preview .math-display').length === ${recordedMath.length}`,
  );
  const mathPreview = () =>
    evaluate(`(() => {
      const inventory = [...document.querySelectorAll('#preview .math-inline, #preview .math-display')]
        .map(node => ({ body: node.dataset.tex, display: node.classList.contains('math-display') }));
      const bars = [...document.querySelectorAll('#preview .katex .frac-line')];
      const radicals = [...document.querySelectorAll('#preview .katex .sqrt .hide-tail')];
      return {
        inventory,
        errors: document.querySelectorAll('#preview .katex-error, #preview .math-error').length,
        fractionsVisible: bars.length > 0 && bars.every(node => node.getBoundingClientRect().width > 0),
        radicalsVisible: radicals.length > 0 && radicals.every(node => node.getBoundingClientRect().width > 0),
      };
    })()`);
  const mathBefore = await mathPreview();
  check(
    JSON.stringify(mathBefore.inventory) ===
      JSON.stringify(recordedMath.map(({ body, display }) => ({ body, display }))),
    "the physics preview starts with all 292 recorded equations",
  );
  await evaluate(`window.__mathBeforeFormat = document.querySelector('#preview .math-inline')`);
  await clickLine(0);
  check((await rightClickLine(0)) === "sent", "the physics line accepts a right-click");
  await sleep(120);
  let mathMenu = await menuState();
  if (mathMenu.count === 0) {
    // One retry: a preview-driven scroll can move the pane between the caret
    // click and the menu. `rightClickLine` measures in the same task, but a
    // scheduled layout may still have run just before it.
    await sleep(200);
    await rightClickLine(0);
    await sleep(120);
    mathMenu = await menuState();
  }
  const mathFormat = mathMenu.items.find((item) => item.action === "format");
  if (mathMenu.count !== 1 || !mathFormat || mathFormat.disabled) {
    const spellMenus = await evaluate(`document.querySelectorAll(".spell-menu").length`);
    console.log(
      `  DIAG  physics menu ${JSON.stringify({
        count: mathMenu.count,
        spellMenus,
        items: mathMenu.items,
      })}`,
    );
  }
  check(await chooseFormat(), "the physics copy formats through the right-click menu");
  await pollFor(
    `document.querySelector('.doc-tab[aria-selected="true"]')?.classList.contains('is-dirty') === true`,
  );
  const mathSaved = await save(files.math, (bytes) => !bytes.equals(original.math));
  check(!mathSaved.equals(original.math), "the physics copy saves the formatted document");
  check(
    JSON.stringify(rawMath(mathSaved.toString("utf8"))) ===
      JSON.stringify(rawMath(original.math.toString("utf8"))),
    "the right-click action preserves every equation's exact source on disk",
  );
  check(
    await pollFor(`document.querySelector('#preview .math-inline') !== window.__mathBeforeFormat`),
    "the formatted physics preview completes a fresh redraw",
  );
  const mathAfter = await mathPreview();
  check(
    JSON.stringify(mathAfter.inventory) === JSON.stringify(mathBefore.inventory),
    "the formatted preview preserves every equation and display mode",
  );
  check(
    mathAfter.errors === mathBefore.errors,
    "the formatted preview adds no red KaTeX errors",
    `${mathBefore.errors} -> ${mathAfter.errors}`,
  );
  check(
    mathAfter.fractionsVisible && mathAfter.radicalsVisible,
    "formatted equations retain visible fraction bars and radicals",
  );
  await undo();
  const mathRestored = await save(files.math, (bytes) => bytes.equals(original.math));
  check(
    mathRestored.equals(original.math),
    "one undo restores the physics copy's exact original bytes",
  );
  check(await openFile(files.markdown), "the Markdown editing fixture is active again");

  // -------------------------------------------------------------------------
  // Editing actions in the menu
  // -------------------------------------------------------------------------
  console.log("\n=== editing actions ===");

  // The real clipboard is not available to the agent session; this fake proves
  // the menu's read/write wiring and the synthetic paste path. It is not a
  // claim about the operating system's clipboard.
  await evaluate(`(() => {
    window.__realClipboard = navigator.clipboard;
    window.__clipboardText = "";
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => { window.__clipboardText = text; },
        readText: async () => window.__clipboardText,
        read: async () => { throw new Error('rich clipboard unavailable in the test'); },
      },
    });
  })()`);

  await openLineMenu(15);
  const selected = await evaluate(`window.getSelection().toString()`);
  check(selected === "- Bullet item", "Home and Shift+End select the whole line", selected);
  const selectionMenu = await menuState();
  check(
    ["cut", "copy", "delete", "uppercase", "lowercase", "titleCase"].every(
      (action) => selectionMenu.items.find((entry) => entry.action === action)?.disabled === false,
    ),
    "a selection enables Cut, Copy, Delete and the case actions",
  );

  await chooseEditor("uppercase");
  await sleep(120);
  check((await lineText(15)) === "- BULLET ITEM", "UPPERCASE changes the selection");
  await undo();
  await sleep(120);
  check((await lineText(15)) === "- Bullet item", "undo restores the line after UPPERCASE");

  await openLineMenu(15);
  await chooseEditor("lowercase");
  await sleep(120);
  check((await lineText(15)) === "- bullet item", "lowercase changes the selection");
  await undo();
  await sleep(120);
  check((await lineText(15)) === "- Bullet item", "undo restores the line after lowercase");

  await openLineMenu(15);
  await chooseEditor("titleCase");
  await sleep(120);
  check((await lineText(15)) === "- Bullet Item", "Title Case changes the selection");
  await undo();
  await sleep(120);
  check((await lineText(15)) === "- Bullet item", "undo restores the line after Title Case");

  await openLineMenu(15);
  await chooseEditor("comment");
  await sleep(120);
  check(
    (await lineText(15)) === "<!-- - Bullet item -->",
    "Toggle Single Line Comment wraps a Markdown line",
  );
  await undo();
  await sleep(120);
  check((await lineText(15)) === "- Bullet item", "undo restores the commented line");

  await openLineMenu(15);
  await chooseEditor("duplicateLine");
  await sleep(120);
  check(
    (await lineText(15)) === "- Bullet item" && (await lineText(16)) === "- Bullet item",
    "Duplicate Line copies the selected line",
  );
  await undo();
  await sleep(120);

  await openLineMenu(15);
  await chooseEditor("moveLineDown");
  await sleep(120);
  check(
    (await lineText(15)) === "- Second item" && (await lineText(16)) === "- Bullet item",
    "Move Line Down swaps the line with its neighbour",
  );
  await undo();
  await sleep(120);

  await openLineMenu(15);
  await chooseEditor("copy");
  await sleep(150);
  check(
    (await evaluate(`window.__clipboardText`)) === "- Bullet item",
    "Copy writes the selection to the clipboard",
  );

  const beforePaste = await lineText(15);
  await clickLine(15);
  await pressKey("End", "End", 35);
  const pastePoint = await linePoint(15);
  await rightClick(pastePoint.x, pastePoint.y);
  await chooseEditor("paste");
  await sleep(200);
  const afterPaste = await lineText(15);
  check(
    afterPaste.length === beforePaste.length * 2 && afterPaste.includes(beforePaste),
    "Paste inserts what Copy put on the clipboard",
    afterPaste,
  );
  await undo();
  await sleep(120);
  check((await lineText(15)) === "- Bullet item", "undo restores the pasted line");

  await openLineMenu(15);
  await chooseEditor("cut");
  await sleep(150);
  check(
    (await evaluate(`window.__clipboardText`)) === "- Bullet item",
    "Cut writes the selection to the clipboard",
  );
  check((await lineText(15)) === "", "Cut removes the selected line");
  await undo();
  await sleep(120);
  check((await lineText(15)) === "- Bullet item", "undo restores the cut line");

  await openLineMenu(15);
  await chooseEditor("delete");
  await sleep(120);
  check((await lineText(15)) === "", "Delete removes the selection");
  await undo();
  await sleep(120);

  const selectPoint = await clickLine(15);
  await rightClick(selectPoint.x, selectPoint.y);
  await chooseEditor("selectAll");
  await sleep(120);
  check(
    (await evaluate(`window.getSelection().toString().length`)) > 100,
    "Select All selects more than the current line",
  );
  await clickLine(15);
  await sleep(120);

  await evaluate(`(() => {
    if (window.__realClipboard === undefined) delete navigator.clipboard;
    else {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: window.__realClipboard,
      });
    }
    delete window.__realClipboard;
    delete window.__clipboardText;
  })()`);

  // Dismissal and placement.
  const dismissPoint = await linePoint(9);
  await rightClick(dismissPoint.x, dismissPoint.y);
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
  );
  check((await menuState()).count === 0, "Escape closes the menu");

  await rightClick(dismissPoint.x, dismissPoint.y);
  await evaluate(
    `document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`,
  );
  check((await menuState()).count === 0, "an outside click closes the menu");

  await rightClick(dismissPoint.x, dismissPoint.y);
  await rightClick(dismissPoint.x, dismissPoint.y);
  check((await menuState()).count === 1, "a repeated right-click leaves exactly one menu");
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
  );

  const previewPoint = await evaluate(`(() => {
    const preview = document.getElementById('preview');
    const rect = preview.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + 20, 1), window.innerWidth - 2);
    const y = Math.min(Math.max(rect.top + 20, 1), window.innerHeight - 2);
    preview.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2,
    }));
    return { x, y };
  })()`);
  check(
    (await menuState()).count === 0,
    "right-clicking the preview opens no editor menu",
    JSON.stringify(previewPoint),
  );

  // -------------------------------------------------------------------------
  // The tab menu formats a background document
  // -------------------------------------------------------------------------
  console.log("\n=== tab formatting ===");
  const htmlForBackground = await openFile(files.html);
  check(htmlForBackground, "the HTML copy opens before the background format");
  const markdownTabClicked = await rightClickTab(nameOf(files.markdown));
  check(markdownTabClicked, "the Markdown tab can be right-clicked");
  const tabMenu = await tabMenuState();
  const tabFormat = tabMenu.items.find((entry) => entry.action === "format");
  check(
    tabMenu.open && tabFormat && !tabFormat.disabled,
    "the tab menu offers an enabled Format Document",
  );
  const activeBefore = await evaluate(activeName);
  await chooseTab("format");
  const backgroundToast = await waitForToast(`Formatted ${nameOf(files.markdown)}`, 20000);
  check(
    backgroundToast === `Formatted ${nameOf(files.markdown)}`,
    "the background format names the document",
    backgroundToast,
  );
  const backgroundDirty = await pollFor(
    `(() => {
      const tab = ${tabByName(nameOf(files.markdown))};
      return tab?.classList.contains('is-dirty') === true;
    })()`,
    10000,
  );
  check(backgroundDirty, "the background tab is marked dirty");
  check(
    (await evaluate(activeName)) === activeBefore,
    "formatting a background tab leaves the active tab alone",
    activeBefore,
  );
  check(!(await isTabDirty(nameOf(files.html))), "the active HTML tab stays clean");

  const markdownActivated = await activateTab(nameOf(files.markdown));
  check(markdownActivated, "the background-formatted tab can be activated");
  await pollFor(`${activeName} === ${JSON.stringify(nameOf(files.markdown))}`, 10000);
  const backgroundSaved = await save(files.markdown, (bytes) => !bytes.equals(original.markdown));
  const backgroundText = backgroundSaved.toString("utf8");
  check(
    backgroundText.includes("_emphasis_") && /^\| Feature\s{2,}\|/m.test(backgroundText),
    "the background format wrote the formatter's result",
  );
  await undo();
  await pollFor(
    `document.querySelector('.doc-tab[aria-selected="true"]')?.classList.contains('is-dirty') === true`,
    10000,
  );
  const backgroundRestored = await save(files.markdown, (bytes) => bytes.equals(original.markdown));
  check(
    backgroundRestored.equals(original.markdown),
    "one undo restores the background-formatted bytes",
  );

  // -------------------------------------------------------------------------
  // HTML
  // -------------------------------------------------------------------------
  console.log("\n=== HTML ===");
  const htmlOpened = await openFile(files.html);
  check(htmlOpened, "the HTML copy opens as its own tab");
  const htmlPoint = await clickLine(13);
  const htmlBeforeLine = await cursorLine();
  await rightClick(htmlPoint.x, htmlPoint.y);
  check((await menuState()).count === 1, "right-clicking HTML opens the menu");
  await chooseFormat();
  await pollFor(
    `document.querySelector('.doc-tab[aria-selected="true"]')?.classList.contains('is-dirty') === true`,
    20000,
  );
  const htmlAfterLine = await cursorLine();
  check(
    htmlAfterLine === htmlBeforeLine && htmlAfterLine > 0,
    "the HTML caret stays on its line",
    `Ln ${htmlBeforeLine} -> Ln ${htmlAfterLine}`,
  );
  const htmlSaved = await save(files.html, (bytes) => !bytes.equals(original.html));
  const htmlText = htmlSaved.toString("utf8");
  check(
    htmlText.startsWith("<!doctype html>") && htmlText.includes('<meta charset="utf-8" />'),
    "Prettier keeps the doctype and self-closes void elements",
    htmlText.slice(0, 48).replace(/\n/g, "\\n"),
  );
  await undo();
  const htmlRestored = await save(files.html, (bytes) => bytes.equals(original.html));
  check(htmlRestored.equals(original.html), "one undo restores the exact HTML bytes");

  // -------------------------------------------------------------------------
  // Typst
  // -------------------------------------------------------------------------
  console.log("\n=== Typst ===");
  const typstOpened = await openFile(files.typst);
  check(typstOpened, "the Typst copy opens as its own tab");
  const typstPoint = await clickLine(17);
  await rightClick(typstPoint.x, typstPoint.y);
  check((await menuState()).count === 1, "right-clicking Typst opens the menu");
  check(
    (await menuState()).items.find((entry) => entry.action === "comment")?.disabled === false,
    "Typst offers the comment action",
  );
  await chooseEditor("comment");
  await sleep(120);
  check(
    (await lineText(17)).startsWith("// Regular text"),
    "Toggle Single Line Comment prefixes a Typst line",
  );
  await undo();
  await sleep(120);
  const typstBeforeLine = await cursorLine();
  await rightClick(typstPoint.x, typstPoint.y);
  await chooseFormat();
  await pollFor(
    `document.querySelector('.doc-tab[aria-selected="true"]')?.classList.contains('is-dirty') === true`,
    20000,
  );
  const typstAfterLine = await cursorLine();
  check(
    typstAfterLine === typstBeforeLine && typstAfterLine > 0,
    "the Typst caret stays on its line",
    `Ln ${typstBeforeLine} -> Ln ${typstAfterLine}`,
  );
  const typstSaved = await save(files.typst, (bytes) => !bytes.equals(original.typst));
  const typstText = typstSaved.toString("utf8");
  check(
    typstText.includes("    table.header([*Feature*], [*Status*], [*Notes*]),"),
    "Typstyle reindents the table",
  );
  await undo();
  const typstRestored = await save(files.typst, (bytes) => bytes.equals(original.typst));
  check(typstRestored.equals(original.typst), "one undo restores the exact Typst bytes");

  // -------------------------------------------------------------------------
  // AsciiDoc keeps the menu, without a formatter
  // -------------------------------------------------------------------------
  console.log("\n=== AsciiDoc ===");
  const adocOpened = await openFile(files.asciidoc);
  check(adocOpened, "the AsciiDoc copy opens as its own tab");
  const adocPoint = await clickLine(4);
  await rightClick(adocPoint.x, adocPoint.y);
  const adocMenu = await menuState();
  const adocFormat = adocMenu.items.find((entry) => entry.action === "format");
  check(adocMenu.count === 1, "right-clicking AsciiDoc opens the editor menu");
  check(
    adocFormat && adocFormat.disabled && /no formatter/.test(adocFormat.title),
    "AsciiDoc disables Format Document with a reason",
    adocFormat?.title ?? "",
  );
  check(
    adocMenu.items.find((entry) => entry.action === "comment")?.disabled === false,
    "AsciiDoc keeps the comment action",
  );
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
  );

  await rightClickTab(nameOf(files.asciidoc));
  const adocTabMenu = await tabMenuState();
  const adocTabFormat = adocTabMenu.items.find((entry) => entry.action === "format");
  check(
    adocTabMenu.open &&
      adocTabFormat &&
      adocTabFormat.disabled &&
      /no formatter/.test(adocTabFormat.title),
    "the AsciiDoc tab disables Format Document",
    adocTabFormat?.title ?? "",
  );
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
  );

  // -------------------------------------------------------------------------
  // Spelling owns its own right-click
  // -------------------------------------------------------------------------
  console.log("\n=== spelling keeps its menu ===");
  await openFile(files.markdown);
  await openEditorPreferences();
  let english = false;
  for (let attempt = 0; attempt < 25 && !english; attempt++) {
    english = await evaluate(`(() => {
      const row = ${preferenceRow("Dictionary")};
      const select = row?.querySelector('select');
      return Boolean(select && [...select.options].some((option) => option.value === 'en'));
    })()`);
    if (!english) await sleep(200);
  }
  check(english, "an English dictionary is installed");
  if (english) {
    await evaluate(`(() => {
      const select = ${preferenceRow("Dictionary")}?.querySelector('select');
      select.value = 'en';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.prefs-close')?.click();
    })()`);

    const typoPoint = await clickLine(9);
    await mouse("mousePressed", typoPoint);
    await mouse("mouseReleased", typoPoint);
    await send("Input.insertText", { text: "recieve " });
    let marked = 0;
    for (let attempt = 0; attempt < 25 && marked === 0; attempt++) {
      marked = await evaluate(`document.querySelectorAll('.cm-spell-error').length`);
      if (marked === 0) await sleep(200);
    }
    check(marked > 0, "a misspelling is underlined", `marks=${marked}`);

    const missPoint = await evaluate(`(() => {
      const mark = document.querySelector('.cm-spell-error');
      if (!mark) return null;
      mark.scrollIntoView({ block: 'nearest' });
      const rect = mark.getBoundingClientRect();
      return { x: rect.left + Math.min(rect.width / 2, 20), y: rect.top + rect.height / 2 };
    })()`);
    if (missPoint) await rightClick(missPoint.x, missPoint.y);
    const hasSpellMenu = await evaluate(`document.querySelectorAll('.spell-menu').length === 1`);
    check(hasSpellMenu, "right-clicking a misspelling opens the spelling menu");
    check((await menuState()).count === 0, "the editor menu does not replace the spelling menu");
    await evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
    );

    await undo();
    await pollFor(`document.querySelectorAll('.cm-spell-error').length === 0`, 10000);
    const spellingRestored = await save(files.markdown, (bytes) => bytes.equals(original.markdown));
    check(
      spellingRestored.equals(original.markdown),
      "undoing the test word leaves the Markdown copy untouched",
    );

    await openEditorPreferences();
    await evaluate(`(() => {
      const select = ${preferenceRow("Dictionary")}?.querySelector('select');
      if (select) {
        select.value = 'auto';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('.prefs-close')?.click();
    })()`);
  }

  // -------------------------------------------------------------------------
  // A formatter failure leaves the buffer alone
  // -------------------------------------------------------------------------
  console.log("\n=== a formatter failure ===");
  const invalidOpened = await openFile(files.invalid);
  check(invalidOpened, "the invalid Typst copy opens as its own tab");
  const invalidPoint = await clickLine(0);
  await rightClick(invalidPoint.x, invalidPoint.y);
  await chooseFormat();
  const failedToast = await waitForToast("Could not format");
  check(
    failedToast.startsWith("Could not format:"),
    "a formatter failure names the failure in a toast",
    failedToast,
  );
  check(!(await isDirty()), "a failed format leaves the buffer untouched");
  check(
    readFileSync(files.invalid).equals(original.invalid),
    "a failed format leaves the file unchanged",
  );
} catch (error) {
  fatal = error;
  console.error(error);
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* an open editor buffer must not fail the report */
  }
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const entry of failed) {
    console.log(`  - ${entry.label}${entry.detail ? `: ${entry.detail}` : ""}`);
  }
}
if (fatal) console.log(`\nFatal: ${fatal.message}`);

// An open WebSocket keeps Node alive, so a green run would otherwise sit here
// forever and the harness would call it a failure.
ws.close();
process.exit(failed.length === 0 && !fatal ? 0 : 1);
