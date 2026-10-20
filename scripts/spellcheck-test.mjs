// Does a misspelling get a wavy underline, and does turning spelling off remove it?
//
//   node scripts/spellcheck-test.mjs [port]
//
// The dictionary is the operating system's. This sets it to English explicitly,
// because automatic detection waits for a few sentences and a one-word document
// must not be underlined. The mark is a DOM decoration, so a synthetic insert
// and a preference click are the thing under test.

const port = process.argv[2] ?? "9222";

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
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

const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function row(label) {
  return `[...document.querySelectorAll('.prefs-row')].find((row) =>
    (row.querySelector('.prefs-label')?.textContent ?? '').replace(/\\?$/, '').trim() === ${JSON.stringify(label)})`;
}

await evaluate(`(() => {
  const scroller = document.querySelector('.cm-scroller');
  if (scroller) scroller.scrollTop = 0;
  const existing = document.querySelector('.prefs-overlay');
  if (!existing || existing.hidden) document.getElementById('btn-prefs').click();
  [...document.querySelectorAll('.prefs-section')].find((section) => section.textContent === 'Editor')?.click();
})()`);

let english = false;
for (let attempt = 0; attempt < 25 && !english; attempt++) {
  english = await evaluate(`(() => {
    const row = ${row("Dictionary")};
    const select = row?.querySelector('select');
    return Boolean(select && [...select.options].some((option) => option.value === 'en'));
  })()`);
  if (!english) await new Promise((resolve) => setTimeout(resolve, 200));
}
check(english, "English dictionary is installed");

if (english) {
  await evaluate(`(() => {
    const select = ${row("Dictionary")}?.querySelector('select');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.prefs-close')?.click();
  })()`);

  // CodeMirror ignores a synthetic beforeinput. The caret has to be in the
  // viewport too: only the visible range is checked.
  const point = await evaluate(`(() => {
    const scroller = document.querySelector('.cm-scroller');
    if (scroller) scroller.scrollTop = 0;
    const line = document.querySelector('.cm-line');
    const rect = line.getBoundingClientRect();
    return { x: rect.left + 8, y: rect.top + rect.height / 2 };
  })()`);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await send("Input.insertText", { text: "recieve " });
  const inserted = await evaluate(
    `(document.querySelector('.cm-content')?.textContent ?? '').slice(0, 40)`,
  );

  let marks = 0;
  for (let attempt = 0; attempt < 20 && marks === 0; attempt++) {
    marks = await evaluate(`document.querySelectorAll('.cm-spell-error').length`);
    if (marks === 0) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check(marks > 0, "misspelling is underlined", `marks=${marks} text=${JSON.stringify(inserted)}`);

  await evaluate(`(() => {
    const existing = document.querySelector('.prefs-overlay');
    if (!existing || existing.hidden) document.getElementById('btn-prefs').click();
    [...document.querySelectorAll('.prefs-section')].find((section) => section.textContent === 'Editor')?.click();
    const box = ${row("Check spelling while typing")}?.querySelector('input[type=checkbox]');
    if (box && box.checked) {
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);

  const after = await evaluate(`document.querySelectorAll('.cm-spell-error').length`);
  check(after === 0, "turning spelling off clears the underline", `marks=${after}`);

  // Put the preference back. The inserted word is undone so a reused window
  // is not left with a typo at the top of the fixture.
  await evaluate(`(() => {
    const box = ${row("Check spelling while typing")}?.querySelector('input[type=checkbox]');
    if (box && !box.checked) {
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
    [...document.querySelectorAll('.prefs-section')].find((section) => section.textContent === 'Editor')?.click();
    const select = ${row("Dictionary")}?.querySelector('select');
    if (select) {
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    document.querySelector('.prefs-close')?.click();
    document.querySelector('.cm-content')?.focus();
  })()`);
  // CodeMirror owns undo. A keydown on the content element is the handler it
  // actually listens to; the native accelerator is not involved.
  await evaluate(`(() => {
    const target = document.querySelector('.cm-content');
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true,
    }));
  })()`);
}

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
