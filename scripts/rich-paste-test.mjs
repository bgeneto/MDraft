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
      message.params.exceptionDetails.exception?.description ??
        message.params.exceptionDetails.text,
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
  evaluate(
    "document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent",
  );
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

  // The same clipboard shape as the HTML-document checks below — source text
  // plus a decorated representation — but a Markdown destination, where the
  // intent is the opposite: convert the markup, do not paste it.
  await newTab();
  await type("# Title\n\n");
  await paste(
    "<p>Elsewhere</p>",
    '<p>Enviar sua chave Pix pode expor dados sensíveis como <strong>CPF, e-mail ou telefone</strong> a estranhos, abrindo portas para golpes, <a href="/blog/o-que-e-doxxing-e-como-evitar/">doxing</a> e exposição indesejada.</p>',
  );
  const article = await lines();
  check(
    article.includes("**CPF, e-mail ou telefone**") &&
      article.includes("[doxing](/blog/o-que-e-doxxing-e-como-evitar/)") &&
      !article.includes("<p>") &&
      !article.includes("<strong>"),
    "an HTML source pasted into Markdown is converted, not inserted",
    article,
  );

  // A rendered copy may wrap every text run in an inline element (a browser
  // extension, a word processor); the spaces then sit at those elements' edges.
  await newTab();
  await type("# Title\n\n");
  await paste(
    "<meta charset='utf-8'>" +
      "<span>Enviar sua chave Pix pode expor dados sensíveis como </span>" +
      "<strong>CPF, e-mail ou telefone</strong>" +
      "<span> a estranhos, abrindo portas para golpes, </span>" +
      "<a href=/blog/o-que-e-doxxing-e-como-evitar/>doxing</a>" +
      "<span> e exposição indesejada.</span>",
    "Enviar sua chave Pix pode expor dados sensíveis como CPF, e-mail ou telefone a estranhos, abrindo portas para golpes, doxing e exposição indesejada.",
  );
  const spaced = await lines();
  check(
    spaced.includes("como **CPF, e-mail ou telefone** a estranhos") &&
      spaced.includes("golpes, [doxing](/blog/o-que-e-doxxing-e-como-evitar/) e exposição"),
    "spaces survive around inline elements in a rendered copy",
    spaced,
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
  check(
    (await toast()).includes("Pasted as Typst"),
    "the detected destination is announced",
    await toast(),
  );

  await openSection("Files");
  await setSelect("Default File Extension", "typ");
  await closePrefs();
  await newTab();
  await type("# Title\n\nA **bold** line.\n\n");
  await paste("<p>Hello <strong>world</strong></p>", "Hello world");
  const markdown = await lines();
  check(markdown.includes("**world**"), "Markdown content beats a Typst default", markdown);
  check(
    (await toast()).includes("Pasted as Markdown"),
    "the Markdown destination is announced",
    await toast(),
  );
  await openSection("Files");
  await setSelect("Default File Extension", "md");
  await closePrefs();

  await newTab();
  await type("<h1>Title</h1>\n<p>Before</p>\n");
  await paste("<p>After <strong>bold</strong></p>", "After bold");
  const html = await lines();
  check(html.includes("<p>After <strong>bold</strong></p>"), "an HTML buffer pastes HTML", html);
  check(
    (await toast()).includes("Pasted as HTML"),
    "the HTML destination is announced",
    await toast(),
  );

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
  check(
    fromEditor.includes(snippet),
    "a snippet from a highlighting editor keeps its own characters",
    fromEditor,
  );
  check(!fromEditor.includes("<span"), "the editor highlighting is not pasted", fromEditor);

  await newTab();
  await type("<h1>Title</h1>\n<p>Before</p>\n");
  await paste(snippet, snippet);
  const fromTag = await lines();
  check(fromTag.includes(snippet), "a bare link tag is not thrown away", fromTag);

  await newTab();
  await paste("<p>Inline <strong>word</strong></p>", "Inline word");
  check(
    (await lines()).startsWith("Inline **word**"),
    "an inline fragment does not add a leading blank line",
    JSON.stringify(await lines()),
  );

  await newTab();
  await type("```\n");
  await paste("<p>Inside <strong>code</strong></p>", "Inside code");
  check(
    (await lines()).includes("Inside code"),
    "a code fence receives the clipboard verbatim",
    await lines(),
  );

  await newTab();
  await key("KeyV", "v", { ctrlKey: true, shiftKey: true });
  await paste("<p>Plain <strong>bypass</strong></p>", "<p>Plain <strong>bypass</strong></p>");
  check(
    (await lines()).includes("<p>Plain <strong>bypass</strong></p>"),
    "Ctrl+Shift+V bypasses the conversion",
    await lines(),
  );

  await openSection("Editor");
  await setCheckbox("Convert Rich Text on Paste", false);
  await closePrefs();
  await newTab();
  await paste(
    "<p>Unconverted <strong>html</strong></p>",
    "<p>Unconverted <strong>html</strong></p>",
  );
  check(
    (await lines()).includes("<p>Unconverted <strong>html</strong></p>"),
    "the preference off pastes plain text",
  );
  await openSection("Editor");
  await setCheckbox("Convert Rich Text on Paste", true);
  await closePrefs();

  await newTab();
  await type("Before");
  await paste("<p>After</p>", "After");
  check((await lines()).includes("After"), "the paste inserted content before undo");
  await key("KeyZ", "z", { ctrlKey: true });
  check(
    (await lines()).trim() === "Before",
    "one undo restores the buffer",
    JSON.stringify(await lines()),
  );

  await openSection("Image");
  const select = await evaluate(`(() => {
    const found = [...document.querySelectorAll('.prefs-row')].find((node) =>
      (node.querySelector('.prefs-label')?.textContent ?? '').replace(/\\?$/, '').trim() === 'Remote Images in Pasted Rich Text');
    if (!found) return 'missing';
    const control = found.querySelector('select');
    return JSON.stringify({ value: control.value, options: [...control.options].map((option) => option.value) });
  })()`);
  check(
    select !== "missing" && select.includes('"download"') && select.includes('"url"'),
    "the image preference exposes both values",
    select,
  );
  await closePrefs();
}

console.log("\n=== native currency paste contract ===");
const amounts = ["R$50", "R$ 10.000", "R$ 15.200,75", "US$5", "US$5.00", "C$8,123.50"];
for (const amount of amounts) {
  await newTab();
  await paste(null, amount + " and " + amount + " and $ a + b $");
  const expected =
    amount.replace("$", "\\$") + " and " + amount.replace("$", "\\$") + " and $ a + b $";
  check(
    (await lines()) === expected,
    "native currency bytes: " + amount,
    JSON.stringify(await lines()),
  );
  const preview = await evaluate(
    "JSON.stringify({text:document.querySelector('#preview').textContent, math:[...document.querySelectorAll('#preview .math-inline')].map(node=>node.dataset.tex)})",
  ).then(JSON.parse);
  check(
    preview.text.includes(amount) && JSON.stringify(preview.math) === '["a + b"]',
    "currency text and padded formula: " + amount,
    JSON.stringify(preview),
  );
  await newTab();
  await paste("<p>" + amount + " and " + amount + "</p>", amount + " and " + amount);
  check(
    (await lines()) === amount.replace("$", "\\$") + " and " + amount.replace("$", "\\$"),
    "HTML currency bytes: " + amount,
    await lines(),
  );
}
const originalSnippets = [
  "Você está autorizando uma média de **R$50/dia, R$350/semana e ~R\\$1.500/mês**, e aceitando disputar cliques oferecendo **até R\\$13,50 por clique",
  "Você pode subir gradualmente (em dólares canadenses): C$5 → C$6 → C$7,50 etc. Eu evitaria começar diretamente em C$13,50.",
];
for (const snippet of originalSnippets) {
  await newTab();
  await paste(null, snippet);
  check(
    (await lines()) === snippet.replace(/(?<!\\)\$/g, "\\$"),
    "original snippet minimally escaped",
    await lines(),
  );
  check(
    (await evaluate(
      "document.querySelectorAll('#preview .math-inline, #preview .math-display').length",
    )) === 0,
    "original snippet creates no math",
  );
}
await newTab();
await paste(null, "\n\nR$50\n\n");
check(
  (await lines()) === "\n\nR\\$50\n\n",
  "native leading and trailing blank lines survive",
  JSON.stringify(await lines()),
);
await newTab();
await evaluate(
  `(() => { const data = new DataTransfer(); data.setData('text/markdown',${JSON.stringify("\n\nR$50\n\n")}); document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true})); })()`,
);
await sleep(500);
check(
  (await lines()) === "\n\nR\\$50\n\n",
  "Markdown-only MIME preserves native whitespace",
  JSON.stringify(await lines()),
);
await newTab();
await type("Before ");
await paste(null, "R$50");
await key("KeyZ", "z", { ctrlKey: true });
check(
  (await lines()) === "Before ",
  "currency escaping and insertion undo together",
  await lines(),
);
await key("KeyY", "y", { ctrlKey: true });
await type("!");
check(
  (await lines()) === "Before R\\$50!",
  "redo and caret follow inserted escapes",
  await lines(),
);
await newTab();
await key("KeyV", "v", { ctrlKey: true, shiftKey: true });
await paste(null, "R$50");
check((await lines()) === "R$50", "plain currency paste bypass");
await newTab();
await paste(null, "R$50");
check((await lines()) === "R\\$50", "plain bypass clears before ordinary currency paste");
await openSection("Editor");
await setCheckbox("Convert Rich Text on Paste", false);
await closePrefs();
await newTab();
await paste(null, "R$50");
check((await lines()) === "R$50", "rich paste off keeps currency bytes");
await openSection("Editor");
await setCheckbox("Convert Rich Text on Paste", true);
await closePrefs();
for (const [source, left] of [
  ["`code`", 1],
  ["```\ncode", 0],
  ["$x + y$", 1],
  ["# Markdown\n\n[label](https://example.com/)", 1],
  ['# Markdown\n\n<span title="">', 2],
]) {
  await newTab();
  await type(source);
  const steps = source.includes("https:") ? source.length - source.indexOf("https:") : left;
  for (let n = 0; n < steps; n++) await key("ArrowLeft", "ArrowLeft");
  await paste(null, "R$50");
  check(
    (await lines()).includes("R$50") && !(await lines()).includes("R\\$50"),
    "protected destination keeps raw currency: " + source,
    await lines(),
  );
}
// A real copy event with empty selection invokes CodeMirror's linewise copy.
await newTab();
await type("R$5");
const copiedLine = await evaluate(
  `(() => {const data=new DataTransfer();document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain');})()`,
);
await paste(null, copiedLine);
check(
  (await lines()) === "R\\$5\nR$5",
  "linewise source copy inserts an escaped whole line",
  JSON.stringify(await lines()),
);
await newTab();
await type("A A");
const firstCursor = await evaluate(
  `(() => {const node=document.querySelector('.cm-line').firstChild;const range=document.createRange();range.setStart(node,1);range.collapse(true);const box=range.getBoundingClientRect();return {x:box.left,y:box.top+box.height/2};})()`,
);
for (const type of ["mousePressed", "mouseReleased"])
  await send("Input.dispatchMouseEvent", {
    type,
    ...firstCursor,
    button: "left",
    clickCount: 1,
    modifiers: 2,
  });
await paste(null, "C$6");
check(
  (await lines()) === "AC\\$6 AC\\$6",
  "multiple native selections retain currency normalization",
  JSON.stringify(await lines()),
);

// The same input facet processes drops, which must not inherit a paste policy.
await newTab();
await paste(null, "R$5 ");
await evaluate(
  `(() => {const line=document.querySelector('.cm-line');const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);let last;for(let node=walker.nextNode();node;node=walker.nextNode())last=node;const range=document.createRange();range.setStart(last,last.length);range.collapse(true);const box=range.getBoundingClientRect();const data=new DataTransfer();data.setData('text/plain','R$7');document.querySelector('.cm-content').dispatchEvent(new DragEvent('drop',{dataTransfer:data,clientX:box.left+1,clientY:box.top+box.height/2,bubbles:true,cancelable:true}));})()`,
);
await sleep(500);
check(
  (await lines()).includes("R$7") && !(await lines()).includes("R\\$7"),
  "text drops bypass the previous currency paste policy",
  JSON.stringify(await lines()),
);
for (const source of [
  "<h1>HTML</h1>\n<p>Before</p>\n",
  "= Typst\n\n#set text(size: 10pt)\n\n",
  "= AsciiDoc\n:toc:\n\n",
]) {
  await newTab();
  await type(source);
  await paste(null, "R$50");
  check(
    (await lines()).includes("R$50") && !(await lines()).includes("R\\$50"),
    "native currency remains raw in another language: " + source.split("\n")[0],
  );
}

console.log("\n=== real Ctrl+V in Find and Replace ===");
const permission = await send("Browser.grantPermissions", {
  permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
});
if (permission.error) throw new Error(permission.error.message);
// Materialize every format before writing test data: clipboard items can be lazy.
await evaluate(`(async () => {
  const items = (await navigator.clipboard.read()).filter(item => item.types.length > 0);
  window.__findPasteClipboard = await Promise.all(items.map(async item =>
    new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type =>
      [type, await item.getType(type)]))))));
})()`);
try {
  for (const field of ["search", "replace"]) {
    for (const rich of [false, true]) {
      for (const shift of [false, true]) {
        await newTab();
        await type("Source must stay unchanged.");
        const before = await lines();
        await key(field === "search" ? "KeyF" : "KeyH", field === "search" ? "f" : "h", {
          ctrlKey: true,
        });
        const text = "busca çã $1 [.*]";
        await evaluate(`(async () => {
          const input = document.querySelector('.cm-search input[name="${field}"]');
          input.focus();
          input.value = 'left SELECT right';
          input.setSelectionRange(5, 11);
          await navigator.clipboard.write([new ClipboardItem({
            'text/plain': new Blob([${JSON.stringify(text)}], {type: 'text/plain'}),
            ${rich ? `'text/html': new Blob([${JSON.stringify(`<p><strong>${text}</strong></p>`)}], {type: 'text/html'}),` : ""}
          })]);
        })()`);
        for (const type of ["keyDown", "keyUp"]) {
          const result = await send("Input.dispatchKeyEvent", {
            type,
            key: "v",
            code: "KeyV",
            windowsVirtualKeyCode: 86,
            modifiers: shift ? 10 : 2,
          });
          if (result.error) throw new Error(result.error.message);
        }
        await sleep(500);
        const input = await evaluate(`(() => {
          const input = document.querySelector('.cm-search input[name="${field}"]');
          return {value: input.value, focused: document.activeElement === input};
        })()`);
        check(
          input.value === `left ${text} right` && input.focused && (await lines()) === before,
          `${field}: Ctrl+${shift ? "Shift+" : ""}V pastes ${rich ? "rich" : "plain"} clipboard text into the field`,
          JSON.stringify({ ...input, source: await lines() }),
        );
      }
    }
  }
} finally {
  await evaluate(`(async () => {
    if (window.__findPasteClipboard.length) await navigator.clipboard.write(window.__findPasteClipboard);
    else await navigator.clipboard.writeText('');
    delete window.__findPasteClipboard;
  })()`);
}

console.log("\n=== Find and Replace own their paste events ===");
for (const field of ["search", "replace"]) {
  for (const [label, payload] of [
    ["plain text", { "text/plain": "literal query" }],
    [
      "rich text",
      { "text/plain": "bold query", "text/html": "<p><strong>bold query</strong></p>" },
    ],
    ["Markdown-only text", { "text/markdown": "**literal query**" }],
    ["image path", { "text/plain": "./find-replace-query.png" }],
    ["currency", { "text/plain": "R$50" }],
  ]) {
    await newTab();
    await type("Source must stay unchanged.");
    const before = await lines();
    await key("KeyF", "f", { ctrlKey: true });
    const result = await evaluate(`(() => {
      const input = document.querySelector('.cm-search input[name="${field}"]');
      if (!input) throw new Error('missing ${field} field');
      input.focus();
      const data = new DataTransfer();
      for (const [type, value] of Object.entries(${JSON.stringify(payload)})) data.setData(type, value);
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return { consumed: event.defaultPrevented };
    })()`);
    await sleep(700);
    const focused = await evaluate(
      `document.activeElement === document.querySelector('.cm-search input[name="${field}"]')`,
    );
    check(
      !result.consumed && focused && (await lines()) === before,
      `${field}: ${label} stays native and never edits the source`,
      JSON.stringify({ consumed: result.consumed, focused, source: await lines() }),
    );
  }
}

// A plain-paste gesture in Find must not arm the document's next rich paste.
await newTab();
await key("KeyF", "f", { ctrlKey: true });
await evaluate(`(() => {
  const input = document.querySelector('.cm-search input[name="search"]');
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true
  }));
  const data = new DataTransfer();
  data.setData('text/plain', 'query');
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  document.querySelector('.cm-content').focus();
})()`);
await paste("<p><strong>Document paste</strong></p>", "Document paste");
check(
  (await lines()) === "**Document paste**",
  "plain paste in Find cannot bypass the next document conversion",
  await lines(),
);

if (exceptions.length > 0) {
  console.log("\n=== console exceptions ===");
  for (const line of exceptions.slice(0, 6)) console.log("  " + String(line).split("\n")[0]);
}
check(exceptions.length === 0, "no runtime exception", exceptions.length ? exceptions[0] : "");

console.log(`\n${passed}/${total} checks passed`);
ws.close();
process.exit(passed === total ? 0 : 1);
