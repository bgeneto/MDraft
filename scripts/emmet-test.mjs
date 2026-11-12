// Emmet abbreviations on Tab, through the real editor.
//
//   node scripts/emmet-test.mjs [port]
//
// `emmet-unit.mjs` pins the context rules and the expansion text without a
// window. What only a running application can prove is the key itself: that Tab
// reaches the binding, that a word typed into a tab stop is not re-read as an
// abbreviation, that an open completion popup still accepts first, that one
// undo restores the abbreviation, that the preference removes the binding, and
// that the engine is a separate chunk fetched only when an HTML or CSS document
// opens. Run it against the staged release binary (`npm test` does): the check
// that a bundler-mangled class name once broke in the official plugin is a
// release-only failure.
//
// Everything types through `Input.dispatchKeyEvent`. The documents are empty
// temporary files opened the way a second instance would open them, so a
// cleared buffer equals its file and no tab is left dirty for the harness.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = process.argv[2] ?? "9222";

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
if (!page) {
  console.error("No page target. Is the application running with CDP enabled?");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
await new Promise((resolve) => setTimeout(resolve, 300));

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function press(key, code, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
}

async function type(text) {
  for (const character of text) {
    await send("Input.dispatchKeyEvent", { type: "char", text: character, key: character });
    await sleep(30);
  }
  await sleep(80);
}

const tab = async () => {
  await press("Tab", "Tab");
  await sleep(250);
};

const focusEditor = () => evaluate(`document.querySelector('.cm-content')?.focus() ?? null`);

const text = () =>
  evaluate(
    `[...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\\n')`,
  );

const tabNames = () =>
  evaluate(`[...document.querySelectorAll('.doc-tab-name')].map((el) => el.textContent)`);

const popupRows = () =>
  evaluate(`(() => {
    const popup = document.querySelector('.cm-tooltip-autocomplete');
    if (!popup) return null;
    return [...popup.querySelectorAll('li')].map((li) => li.textContent.trim());
  })()`);

async function clearTab() {
  await focusEditor();
  await press("a", "KeyA", 2);
  await press("Delete", "Delete");
  await sleep(150);
  if ((await text()).length > 0) {
    await focusEditor();
    await press("a", "KeyA", 2);
    await press("Delete", "Delete");
    await sleep(150);
  }
}

/**
 * Run a scenario in the current tab: empty before, empty after.
 *
 * Tabs are never closed. A `Ctrl+W` on a buffer that did not clear shows the
 * native save prompt, which blocks `Runtime.evaluate` forever.
 */
async function scenario(run) {
  await clearTab();
  try {
    await run();
  } finally {
    await clearTab();
  }
}

const emmetChunkLoaded = () =>
  evaluate(`performance.getEntriesByType('resource').some((entry) => /emmet/i.test(entry.name))`);

async function emitOpenFiles(paths) {
  return evaluate(
    `window.__TAURI_INTERNALS__
      .invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify(paths)} })
      .then(() => "ok", (error) => { throw new Error(String(error)); })`,
  );
}

async function openFile(file) {
  await emitOpenFiles([file]);
  const name = path.basename(file);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const active = await evaluate(
      `document.querySelector('.doc-tab.is-active .doc-tab-name')?.textContent ?? ''`,
    );
    if (active === name) break;
    await sleep(100);
  }
  // The grammar and the engine are dynamic imports; typing before they land is
  // a race this suite is not about.
  await sleep(1500);
  await focusEditor();
}

async function prefsVisible() {
  return evaluate(
    `(() => { const overlay = document.querySelector('.prefs-overlay'); return Boolean(overlay && !overlay.hidden); })()`,
  );
}

async function setPrefsVisible(want) {
  if ((await prefsVisible()) !== want) {
    await evaluate(`document.getElementById('btn-prefs').click()`);
    await sleep(250);
  }
}

const labelExpr = (variable) =>
  `(${variable}.querySelector('.prefs-label')?.textContent ?? '').replace(/\\?\\s*$/, '').trim()`;

async function setCheckbox(label, want) {
  await setPrefsVisible(true);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.prefs-section')]
      .find((section) => section.textContent.trim() === 'Editor');
    button?.click();
  })()`);
  await sleep(150);
  const result = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.prefs-row')]
      .find((candidate) => ${labelExpr("candidate")} === ${JSON.stringify(label)});
    const input = row?.querySelector('input[type=checkbox]');
    if (!input) return 'missing';
    if (input.checked !== ${want}) input.click();
    return input.checked;
  })()`);
  await sleep(300);
  await setPrefsVisible(false);
  return result;
}

const PREFERENCE = "Expand Emmet abbreviations with Tab";

const workDir = mkdtempSync(path.join(tmpdir(), "mdraft-emmet-"));
const fixture = (name) => {
  const file = path.join(workDir, name);
  writeFileSync(file, "");
  return file;
};

try {
  await setPrefsVisible(false);

  console.log("=== the engine is a separate chunk ===");
  check((await emmetChunkLoaded()) === false, "a Markdown session has not fetched the Emmet chunk");

  console.log("\n=== HTML: Tab expands ===");
  await openFile(fixture("emmet.html"));
  check(
    (await tabNames()).includes("emmet.html"),
    "an HTML file is open",
    (await tabNames()).join(", "),
  );
  check((await emmetChunkLoaded()) === true, "opening an HTML file fetched the Emmet chunk");

  await scenario(async () => {
    await type("ul>li*3");
    await tab();
    check(
      (await text()) === "<ul>\n  <li></li>\n  <li></li>\n  <li></li>\n</ul>",
      "ul>li*3 + Tab expands to a list indented with two spaces",
      JSON.stringify(await text()),
    );
    // A word typed into a tab stop is plain text; Tab moves on. This is the
    // check that fails when a bundler renames the class a plugin looks for.
    await type("Hello");
    await tab();
    await type("B");
    await tab();
    await type("C");
    await tab();
    await type("!");
    check(
      (await text()) === "<ul>\n  <li>Hello</li>\n  <li>B</li>\n  <li>C</li>\n</ul>!",
      "Tab walks the tab stops, and a word typed in one is not re-read as an abbreviation",
      JSON.stringify(await text()),
    );
  });

  await scenario(async () => {
    await type("div.card>h2{Title}+p");
    await tab();
    check(
      (await text()) === '<div class="card">\n  <h2>Title</h2>\n  <p></p>\n</div>',
      "classes, children, text and siblings expand together",
      JSON.stringify(await text()),
    );
  });

  await scenario(async () => {
    await type("ul>li");
    await tab();
    await press("z", "KeyZ", 2);
    await sleep(250);
    check(
      (await text()) === "ul>li",
      "one undo restores the abbreviation",
      JSON.stringify(await text()),
    );
  });

  await scenario(async () => {
    await type('<p style="m10">');
    await press("ArrowLeft", "ArrowLeft");
    await press("ArrowLeft", "ArrowLeft");
    await tab();
    check(
      (await text()).startsWith('<p style="margin: 10px;">'),
      "a style attribute takes a CSS abbreviation on one line",
      JSON.stringify(await text()),
    );
  });

  await scenario(async () => {
    await type("<style>");
    await press("Enter", "Enter");
    await type("@m");
    await tab();
    check(
      (await text()).includes("@media screen {"),
      "@m inside <style> expands to a media query",
      JSON.stringify(await text()),
    );
  });

  console.log("\n=== HTML: Tab declines ===");
  await scenario(async () => {
    await tab();
    check((await text()) === "  ", "Tab on an empty line indents", JSON.stringify(await text()));
  });

  await scenario(async () => {
    await type("<div cl");
    await tab();
    check(
      (await text()) === "  <div cl",
      "inside a tag Tab indents and does not expand",
      JSON.stringify(await text()),
    );
  });

  await scenario(async () => {
    await type("<div class=");
    await type('"ul>li');
    await tab();
    check(
      !(await text()).includes("<ul>"),
      "inside an attribute value nothing expands",
      JSON.stringify(await text()),
    );
  });

  await scenario(async () => {
    await type("<di");
    await sleep(500);
    const rows = await popupRows();
    check(Array.isArray(rows) && rows.length > 0, "a partial tag opens the completion popup");
    await tab();
    check(
      (await text()) === "<div",
      "with the popup open Tab accepts the row, not an abbreviation",
      JSON.stringify(await text()),
    );
    check((await popupRows()) === null, "accepting closes the popup");
  });

  console.log("\n=== the preference ===");
  check(
    (await setCheckbox(PREFERENCE, false)) === false,
    "the Emmet checkbox exists and turns off",
  );
  await scenario(async () => {
    await focusEditor();
    await type("ul>li*3");
    await tab();
    check(
      (await text()) === "  ul>li*3",
      "with the preference off Tab only indents",
      JSON.stringify(await text()),
    );
  });
  check((await setCheckbox(PREFERENCE, true)) === true, "the Emmet checkbox turns back on");
  await scenario(async () => {
    await focusEditor();
    await type("ul>li");
    await tab();
    check(
      (await text()).startsWith("<ul>"),
      "turning it back on takes effect without reopening the document",
      JSON.stringify(await text()),
    );
  });

  console.log("\n=== CSS ===");
  await openFile(fixture("emmet.css"));
  await scenario(async () => {
    await type("a {");
    await press("Enter", "Enter");
    await type("m10");
    await tab();
    check(
      (await text()) === "a {\n  margin: 10px;\n}",
      "m10 + Tab inside a rule is a margin declaration",
      JSON.stringify(await text()),
    );
  });

  await scenario(async () => {
    await type("a {");
    await press("Enter", "Enter");
    await type("bgc#f00");
    await tab();
    check(
      (await text()).includes("background-color: #f00;"),
      "a colour abbreviation expands",
      JSON.stringify(await text()),
    );
  });

  await scenario(async () => {
    await type("a {");
    await press("Enter", "Enter");
    await type("pos");
    await sleep(500);
    const rows = await popupRows();
    check(
      Array.isArray(rows) && rows.some((row) => /position/.test(row)),
      "typing pos opens the property popup",
      rows ? rows.slice(0, 6).join(", ") : "no popup",
    );
    await tab();
    const accepted = await text();
    // The documented rule: an open popup accepts first. Escape closes it and
    // the next Tab expands.
    check(
      /position/.test(accepted) && !/relative/.test(accepted),
      "with the popup open Tab accepts the property name",
      JSON.stringify(accepted),
    );
  });

  await scenario(async () => {
    await type("m10");
    await tab();
    check(
      (await text()) === "  m10",
      "outside every rule a word is a selector and Tab only indents",
      JSON.stringify(await text()),
    );
  });

  await scenario(async () => {
    await type("@m");
    await tab();
    check(
      (await text()).startsWith("@media screen {"),
      "@m at the top level expands to a media query",
      JSON.stringify(await text()),
    );
  });

  console.log("\n=== other documents ===");
  await openFile(fixture("emmet.md"));
  await scenario(async () => {
    await type("ul>li");
    await tab();
    check(
      !(await text()).includes("<ul>"),
      "a Markdown document never expands",
      JSON.stringify(await text()),
    );
  });

  // Back to the HTML tab: the binding follows the tab, not the last document.
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.doc-tab')]
      .find((el) => el.querySelector('.doc-tab-name')?.textContent === 'emmet.html');
    tab?.click();
  })()`);
  await sleep(800);
  await focusEditor();
  await scenario(async () => {
    await type("p>a");
    await tab();
    check(
      (await text()).startsWith("<p><a"),
      "switching back to the HTML tab restores the binding",
      JSON.stringify(await text()),
    );
  });

  await clearTab();
  await sleep(200);
  const dirty = await evaluate(`document.querySelectorAll('.doc-tab.is-dirty').length`);
  check(dirty === 0, "no tab is left dirty", `${dirty} dirty`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const item of failed)
    console.log(`  - ${item.label}${item.detail ? `: ${item.detail}` : ""}`);
}
ws.close();
process.exit(failed.length === 0 ? 0 : 1);
