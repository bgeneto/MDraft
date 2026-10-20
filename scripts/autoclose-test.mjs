// Auto-close pairs and HTML tags, through the real editor.
//
//   node scripts/autoclose-test.mjs [port]
//
// `closeBrackets` is an EditorView input handler, not a keydown binding: a
// synthetic KeyboardEvent never reaches it. Everything here types through
// `Input.dispatchKeyEvent` with `type: "char"`, the same path the webview uses.
//
// The suite starts on the Markdown fixture and opens a new tab per scenario,
// switching the default extension to reach HTML, Typst and AsciiDoc. Each tab is
// emptied before it is closed, so test-all's shutdown never meets a dirty buffer.

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

const focusEditor = () => evaluate(`document.querySelector('.cm-content')?.focus() ?? null`);

const text = () =>
  evaluate(
    `[...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\\n')`,
  );

const tabNames = () =>
  evaluate(`[...document.querySelectorAll('.doc-tab-name')].map((el) => el.textContent)`);

async function newTab() {
  await press("n", "KeyN", 2);
  await sleep(400);
  await focusEditor();
}

async function clearTab() {
  await focusEditor();
  await press("a", "KeyA", 2);
  await press("Delete", "Delete");
  await sleep(150);
  // A slow re-render can swallow the first pair; one retry is enough and keeps
  // a dirty buffer from reaching the harness shutdown, where it would prompt.
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
 * Tabs are never closed here. A `Ctrl+W` on a buffer that did not clear shows
 * the native save prompt, which blocks `Runtime.evaluate` forever; leaving the
 * tab open and clean is both simpler and harmless to the next suite.
 */
async function scenario(run) {
  await clearTab();
  try {
    await run();
  } finally {
    await clearTab();
  }
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

async function prefsSection(name) {
  const found = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.prefs-section')]
      .find((section) => section.textContent.trim() === ${JSON.stringify(name)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(150);
  return found;
}

const labelExpr = (variable) =>
  `(${variable}.querySelector('.prefs-label')?.textContent ?? '').replace(/\\?\\s*$/, '').trim()`;

async function setCheckbox(label, want) {
  await setPrefsVisible(true);
  await prefsSection("Editor");
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

async function setExtension(value) {
  await setPrefsVisible(true);
  await prefsSection("Files");
  const result = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.prefs-row')]
      .find((candidate) => ${labelExpr("candidate")} === 'Default File Extension');
    const select = row?.querySelector('select');
    if (!select) return 'missing';
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  await sleep(350);
  await setPrefsVisible(false);
  return result;
}

// ---------------------------------------------------------------------------
// Markdown: brackets, quotes, backtick, step-over, Backspace, wrapping.
// ---------------------------------------------------------------------------
console.log("\n=== Markdown pairs ===");
await setPrefsVisible(false);
await setExtension("md");
await newTab();

await scenario(async () => {
  await type("(");
  check((await text()) === "()", "( inserts the closing parenthesis", await text());
  await type("x");
  check((await text()) === "(x)", "the caret lands between the pair", await text());
  await type(")");
  check((await text()) === "(x)", "typing ) steps over the closing one", await text());
  await type("y");
  check((await text()) === "(x)y", "typing after the step-over appends", await text());
});

await scenario(async () => {
  await type("[");
  check((await text()) === "[]", "[ inserts ]", await text());
});

await scenario(async () => {
  await type("{");
  check((await text()) === "{}", "{ inserts }", await text());
});

await scenario(async () => {
  await type('"');
  check((await text()) === '""', '" inserts the second quote', await text());
});

await scenario(async () => {
  await type("'");
  check((await text()) === "''", "' inserts the second quote", await text());
});

await scenario(async () => {
  await type("don't");
  check((await text()) === "don't", "an apostrophe inside a word is not paired", await text());
});

await scenario(async () => {
  await type("`");
  check((await text()) === "``", "backtick inserts its pair", await text());
});

await scenario(async () => {
  await type("(");
  await press("Backspace", "Backspace");
  await sleep(150);
  check((await text()) === "", "Backspace deletes both halves", await text());
});

await scenario(async () => {
  await type("abc");
  await press("a", "KeyA", 2);
  await type("(");
  check((await text()) === "(abc)", "typing ( over a selection wraps it", await text());
});

// ---------------------------------------------------------------------------
// The preference turns pairing off, and back on.
// ---------------------------------------------------------------------------
console.log("\n=== the pair preference ===");
check(
  (await setCheckbox("Auto-close brackets and quotes", false)) === false,
  "the pair checkbox turns off",
);
await scenario(async () => {
  await type("(");
  check((await text()) === "(", "with pairing off ( stays alone", await text());
});
check(
  (await setCheckbox("Auto-close brackets and quotes", true)) === true,
  "the pair checkbox turns back on",
);

// ---------------------------------------------------------------------------
// Markdown inline HTML: the custom closer.
// ---------------------------------------------------------------------------
console.log("\n=== Markdown tags ===");
await scenario(async () => {
  await type('<a href="x">');
  check((await text()) === '<a href="x"></a>', "a tag with attributes closes", await text());
});

await scenario(async () => {
  await type("<img>");
  check((await text()) === "<img>", "a void element does not close", await text());
});

await scenario(async () => {
  await type("<https://example.com>");
  check((await text()) === "<https://example.com>", "an autolink is left alone", await text());
});

await scenario(async () => {
  await type("~~~");
  await press("Enter", "Enter");
  await type("<p>");
  check(!(await text()).includes("</p>"), "a tag inside a fence is left alone", await text());
});

await scenario(async () => {
  await type("\\<p>");
  check(!(await text()).includes("</p>"), "an escaped <p> is left alone", await text());
});

// ---------------------------------------------------------------------------
// The tag preference, in Markdown and in HTML.
// ---------------------------------------------------------------------------
console.log("\n=== the tag preference ===");
check((await setCheckbox("Auto-close HTML tags", false)) === false, "the tag checkbox turns off");
await scenario(async () => {
  await type("<p>");
  check((await text()) === "<p>", "with tags off <p> stays alone", await text());
});
check((await setCheckbox("Auto-close HTML tags", true)) === true, "the tag checkbox turns back on");

console.log("\n=== HTML documents ===");
await setExtension("html");
await newTab();
await scenario(async () => {
  await type("<p>");
  check((await text()) === "<p></p>", "HTML <p> closes with the built-in closer", await text());
});
await scenario(async () => {
  await type("<img>");
  check((await text()) === "<img>", "HTML <img> does not close", await text());
});
check(
  (await setCheckbox("Auto-close HTML tags", false)) === false,
  "the tag checkbox turns off for HTML too",
);
await scenario(async () => {
  await type("<p>");
  check((await text()) === "<p>", "with tags off HTML <p> stays alone", await text());
});
check(
  (await setCheckbox("Auto-close HTML tags", true)) === true,
  "the tag checkbox turns back on after HTML",
);

// ---------------------------------------------------------------------------
// Typst gets pairs but no tags; AsciiDoc gets both.
// ---------------------------------------------------------------------------
console.log("\n=== other document types ===");
await setExtension("typ");
await newTab();
await scenario(async () => {
  await type("(");
  check((await text()) === "()", "Typst pairs brackets", await text());
});
await scenario(async () => {
  await type("<p>");
  check((await text()) === "<p>", "Typst has no tag closer", await text());
});

await setExtension("adoc");
await newTab();
await scenario(async () => {
  await type("(");
  check((await text()) === "()", "AsciiDoc pairs brackets", await text());
});
await scenario(async () => {
  await type("<p>");
  check((await text()) === "<p></p>", "AsciiDoc closes tags", await text());
});

// Put the suite's settings back where the next layer expects them.
await setExtension("md");
await setPrefsVisible(false);
await clearTab();
await sleep(200);
check(
  (await evaluate(`document.querySelectorAll('.doc-tab.is-dirty').length`)) === 0,
  "no tab is left dirty",
  `${await evaluate(`document.querySelectorAll('.doc-tab.is-dirty').length`)} dirty`,
);

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const item of failed)
    console.log(`  - ${item.label}${item.detail ? `: ${item.detail}` : ""}`);
}
ws.close();
process.exit(failed.length === 0 ? 0 : 1);
