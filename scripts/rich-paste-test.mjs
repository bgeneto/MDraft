// Rich paste through the real UI.
//
//   node scripts/rich-paste-test.mjs [port]
//
// Start the application with samples/feature-tour.md open (test-all does this).
// The suite creates new tabs for each destination so the fixture is not the
// subject of most checks: an unsaved tab is the only way to exercise the
// default-extension fallback and the detected-destination notice.

const port = Number(process.argv[2] ?? 9222);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("no page target; start the application with the debug port open");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const exceptions = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method === "Runtime.exceptionThrown") {
    exceptions.push(
      message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text,
    );
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.result?.exceptionDetails) {
    throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 900));
  }
  return result.result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let total = 0;
function check(ok, label, detail = "") {
  total += 1;
  if (ok) passed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const lines = () =>
  evaluate(
    "JSON.stringify([...document.querySelectorAll('.cm-line')].map((line) => line.textContent))",
  ).then((raw) => JSON.parse(raw).join("\n"));
const toast = () =>
  evaluate("document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent");
const title = () => evaluate("document.title");

async function newTab() {
  await evaluate("document.querySelector('.cm-content').focus()");
  await evaluate(
    "document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true }))",
  );
  await sleep(450);
  await evaluate("document.querySelector('.cm-content').focus()");
}

async function type(text) {
  await evaluate("document.querySelector('.cm-content').focus()");
  await send("Input.insertText", { text });
  await sleep(250);
}

async function paste(html, plain = null) {
  const raw = await evaluate(`(() => {
    const data = new DataTransfer();
    ${html ? `data.setData('text/html', ${JSON.stringify(html)});` : ""}
    ${plain !== null ? `data.setData('text/plain', ${JSON.stringify(plain)});` : ""}
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector('.cm-content').dispatchEvent(event);
    return String(event.defaultPrevented);
  })()`);
  await sleep(700);
  return raw === "true";
}

async function key(code, keyName, extras = {}) {
  await evaluate(`(() => {
    const target = document.querySelector('.cm-content');
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown', Object.assign({
      code: ${JSON.stringify(code)}, key: ${JSON.stringify(keyName)}, bubbles: true
    }, ${JSON.stringify(extras)})));
  })()`);
  await sleep(350);
}

async function openSection(section) {
  await evaluate("document.getElementById('btn-prefs').click()");
  await sleep(250);
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.prefs-section')]
      .find((node) => node.textContent.trim() === ${JSON.stringify(section)});
    if (!item) throw new Error('missing preference section: ${section}');
    item.click();
  })()`);
  await sleep(250);
}

async function closePrefs() {
  await evaluate(
    "document.querySelector('.prefs-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
  );
  await sleep(250);
}

async function row(label) {
  return `(() => {
    const found = [...document.querySelectorAll('.prefs-row')].find((node) => {
      const value = (node.querySelector('.prefs-label')?.textContent ?? '').replace(/\\?$/, '').trim();
      return value === ${JSON.stringify(label)};
    });
    if (!found) throw new Error('missing preference row: ${label}');
    return found;
  })()`;
}

async function setCheckbox(label, value) {
  await evaluate(`(() => {
    const row = ${await row(label)};
    const box = row.querySelector('input[type=checkbox]');
    if (box.checked !== ${value}) box.click();
    return box.checked;
  })()`);
  await sleep(200);
}

async function setSelect(label, value) {
  await evaluate(`(() => {
    const row = ${await row(label)};
    const select = row.querySelector('select');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  await sleep(250);
}

await new Promise((resolve) => ws.addEventListener("open", resolve));
await send("Runtime.enable");

console.log("=== rich paste ===");
{
  check((await title()).includes("feature-tour.md"), "the fixture document is open", await title());

  await newTab();
  const blocked = await paste(
    "<h2>From HTML</h2><p>Hello <strong>world</strong> and <em>you</em>.</p>" +
      "<ul><li>One</li><li>Two</li></ul>" +
      "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    "From HTML",
  );
  const text = await lines();
  check(blocked, "the HTML paste is consumed");
  check(text.includes("## From HTML"), "heading converted", text.split("\n")[0]);
  check(text.includes("**world**") && text.includes("*you*"), "emphasis converted");
  check(text.includes("- One") && text.includes("- Two"), "bullets converted");
  check(text.includes("| A | B |") && text.includes("| --- | --- |"), "table converted");
  const preview = JSON.parse(
    await evaluate(
      "JSON.stringify({ h2: document.querySelectorAll('#preview h2').length, strong: document.querySelectorAll('#preview strong').length, table: document.querySelectorAll('#preview table').length, ul: document.querySelectorAll('#preview ul').length })",
    ),
  );
  check(
    preview.h2 === 1 && preview.strong >= 1 && preview.table === 1 && preview.ul === 1,
    "the preview renders the converted structure",
    JSON.stringify(preview),
  );

  await newTab();
  await paste(null, "# Title\n\nA **bold** line.");
  check((await lines()).includes("A **bold** line."), "Markdown into Markdown is native");

  await newTab();
  await paste(null, "A sentence with no markup at all.");
  check((await lines()).includes("A sentence with no markup at all."), "plain prose is untouched");

  await newTab();
  await type("= Title\n\n#set text(size: 10pt)\n\n");
  await paste("<p>Hello <strong>world</strong></p>", "Hello world");
  const typst = await lines();
  check(typst.includes("*world*"), "Typst content selects the Typst destination", typst);
  check((await toast()).includes("Pasted as Typst"), "the detected destination is announced", await toast());

  await openSection("Files");
  await setSelect("Default File Extension", "typ");
  await closePrefs();
  await newTab();
  await type("# Title\n\nA **bold** line.\n\n");
  await paste("<p>Hello <strong>world</strong></p>", "Hello world");
  const markdown = await lines();
  check(markdown.includes("**world**"), "Markdown content beats a Typst default", markdown);
  check((await toast()).includes("Pasted as Markdown"), "the Markdown destination is announced", await toast());
  await openSection("Files");
  await setSelect("Default File Extension", "md");
  await closePrefs();

  await newTab();
  await type("<h1>Title</h1>\n<p>Before</p>\n");
  await paste("<p>After <strong>bold</strong></p>", "After bold");
  const html = await lines();
  check(html.includes("<p>After <strong>bold</strong></p>"), "an HTML buffer pastes HTML", html);
  check((await toast()).includes("Pasted as HTML"), "the HTML destination is announced", await toast());

  // A snippet copied as *source* is not a rendering: the highlighting must not
  // come along, and the tag must not be dropped on the way (the sanitizer has
  // no use for `link`).
  const snippet =
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.2.1/reset.min.css">';
  const highlighted =
    `<meta charset='utf-8'><div style="color: #d4d4d4;white-space: pre;"><div>` +
    `<span style="color: #808080;">&lt;</span><span style="color: #9CDCFE;">link</span>` +
    `<span style="color: #9CDCFE;"> rel</span>=<span style="color: #CE9178;">"stylesheet"</span> ` +
    `<span style="color: #9CDCFE;">href</span>=<span style="color: #CE9178;">"https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.2.1/reset.min.css"</span>` +
    `<span style="color: #808080;">&gt;</span></div></div>`;

  await newTab();
  await type("<h1>Title</h1>\n<p>Before</p>\n");
  await paste(highlighted, snippet);
  const fromEditor = await lines();
  check(fromEditor.includes(snippet), "a snippet from a highlighting editor keeps its own characters", fromEditor);
  check(!fromEditor.includes("<span"), "the editor highlighting is not pasted", fromEditor);

  await newTab();
  await type("<h1>Title</h1>\n<p>Before</p>\n");
  await paste(snippet, snippet);
  const fromTag = await lines();
  check(fromTag.includes(snippet), "a bare link tag is not thrown away", fromTag);

  await newTab();
  await paste("<p>Inline <strong>word</strong></p>", "Inline word");
  check((await lines()).startsWith("Inline **word**"), "an inline fragment does not add a leading blank line", JSON.stringify(await lines()));

  await newTab();
  await type("```\n");
  await paste("<p>Inside <strong>code</strong></p>", "Inside code");
  check((await lines()).includes("Inside code"), "a code fence receives the clipboard verbatim", await lines());

  await newTab();
  await key("KeyV", "v", { ctrlKey: true, shiftKey: true });
  await paste("<p>Plain <strong>bypass</strong></p>", "<p>Plain <strong>bypass</strong></p>");
  check((await lines()).includes("<p>Plain <strong>bypass</strong></p>"), "Ctrl+Shift+V bypasses the conversion", await lines());

  await openSection("Editor");
  await setCheckbox("Convert Rich Text on Paste", false);
  await closePrefs();
  await newTab();
  await paste("<p>Unconverted <strong>html</strong></p>", "<p>Unconverted <strong>html</strong></p>");
  check((await lines()).includes("<p>Unconverted <strong>html</strong></p>"), "the preference off pastes plain text");
  await openSection("Editor");
  await setCheckbox("Convert Rich Text on Paste", true);
  await closePrefs();

  await newTab();
  await type("Before");
  await paste("<p>After</p>", "After");
  check((await lines()).includes("After"), "the paste inserted content before undo");
  await key("KeyZ", "z", { ctrlKey: true });
  check((await lines()).trim() === "Before", "one undo restores the buffer", JSON.stringify(await lines()));

  await openSection("Image");
  const select = await evaluate(`(() => {
    const found = [...document.querySelectorAll('.prefs-row')].find((node) =>
      (node.querySelector('.prefs-label')?.textContent ?? '').replace(/\\?$/, '').trim() === 'Remote Images in Pasted Rich Text');
    if (!found) return 'missing';
    const control = found.querySelector('select');
    return JSON.stringify({ value: control.value, options: [...control.options].map((option) => option.value) });
  })()`);
  check(select !== "missing" && select.includes('"download"') && select.includes('"url"'), "the image preference exposes both values", select);
  await closePrefs();
}

if (exceptions.length > 0) {
  console.log("\n=== console exceptions ===");
  for (const line of exceptions.slice(0, 6)) console.log("  " + String(line).split("\n")[0]);
}
check(exceptions.length === 0, "no runtime exception", exceptions.length ? exceptions[0] : "");

console.log(`\n${passed}/${total} checks passed`);
ws.close();
process.exit(passed === total ? 0 : 1);
