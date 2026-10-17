// Regression for pasting an image path into the placeholder inserted by
// Format › Image (Ctrl+Shift+I).
//
//   node scripts/image-path-paste-test.mjs [port]
//
// Launch the app with samples/feature-tour.md and CDP enabled. The script
// appends `![alt text](./image.png)`, selects `./image.png` with a real mouse
// drag, and pastes `../src-tauri/icons/32x32.png` — a file beside the document
// but not below the process working directory. It asserts that the path
// replaces the selection as text and that the preview loads it, instead of
// importing a second block and reporting the path as missing.
const PORT = Number(process.argv[2] ?? 9222);
const RELATIVE_IMAGE = "../src-tauri/icons/32x32.png";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error(`No page target on port ${PORT}. Is the app running with CDP enabled?`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 900));
  }
  const value = r.result.result.value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (ok, message) => {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${message}`);
};

await new Promise((resolve) => ws.addEventListener("open", resolve));
await send("Runtime.enable");

const documentTitle = await evaluate("document.title");
check(
  documentTitle.includes("feature-tour.md"),
  `document is samples/feature-tour.md (title: ${documentTitle})`,
);

// Append the exact text Ctrl+Shift+I inserts, at the end of the document.
const setup = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const content = document.querySelector('.cm-content');
  content.focus();
  content.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'End', code: 'End', ctrlKey: true, bubbles: true, cancelable: true
  }));
  await sleep(120);
  const data = new DataTransfer();
  data.setData('text/plain', '\\n\\n![alt text](./image.png)');
  content.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: data, bubbles: true, cancelable: true
  }));
  await sleep(350);

  const line = [...document.querySelectorAll('.cm-line')]
    .filter((l) => l.textContent.includes('![alt text](./image.png)'))
    .pop();
  if (!line) return JSON.stringify({ error: 'template line not found' });
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let node = null;
  let offset = -1;
  while ((node = walker.nextNode())) {
    const index = node.textContent.indexOf('./image.png');
    if (index >= 0) { offset = index; break; }
  }
  if (!node || offset < 0) return JSON.stringify({ error: 'url text not found' });

  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + './image.png'.length);
  const rect = range.getBoundingClientRect();
  return JSON.stringify({
    left: rect.left, right: rect.right, y: rect.top + rect.height / 2
  });
})()`);
if (setup.error) {
  check(false, setup.error);
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  ws.close();
  process.exit(1);
}

// A mouse drag, not a DOM Range: this is what the reported workflow does, and
// it is the selection CodeMirror actually knows about.
const { left, right, y } = setup;
await send("Input.dispatchMouseEvent", {
  type: "mousePressed", x: left + 1, y, button: "left", buttons: 1, clickCount: 1,
});
for (let step = 1; step <= 5; step++) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: left + 1 + ((right - left - 2) * step) / 5,
    y,
    button: "left",
    buttons: 1,
  });
  await sleep(25);
}
await send("Input.dispatchMouseEvent", {
  type: "mouseReleased", x: right - 1, y, button: "left", buttons: 0, clickCount: 1,
});
await sleep(200);

const selected = await evaluate("String(window.getSelection())");
check(selected === "./image.png", `mouse drag selected the image URL (got ${JSON.stringify(selected)})`);

// Paste the path over the selection. The handler must decline to import and
// let CodeMirror replace the text, or the placeholder stays and a second block
// is appended.
await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const content = document.querySelector('.cm-content');
  const data = new DataTransfer();
  data.setData('text/plain', ${JSON.stringify(RELATIVE_IMAGE)});
  content.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: data, bubbles: true, cancelable: true
  }));
  await sleep(1000);
  return 'ok';
})()`);

// The preview loads local images through the asset protocol; wait for its
// natural size rather than counting an <img> that may still be broken.
let image = null;
for (let attempt = 0; attempt < 15; attempt++) {
  const state = await evaluate(`(() => {
    const img = [...document.querySelectorAll('#preview img')]
      .filter((i) => (i.getAttribute('src') ?? '').includes('32x32.png'))
      .pop();
    return JSON.stringify(img ? { width: img.naturalWidth, complete: img.complete } : null);
  })()`);
  if (state && state.complete && state.width > 0) {
    image = state;
    break;
  }
  await sleep(200);
}
const text = await evaluate("document.querySelector('.cm-content').innerText");
const toast = await evaluate(
  "document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent",
);

check(
  text.includes(`![alt text](${RELATIVE_IMAGE})`) && !text.includes("](./image.png)"),
  "pasted path replaced the URL instead of leaving the placeholder and appending a block",
);
check(image !== null, "preview loaded the relative image (natural width above zero)");
check(!toast.includes("was not found"), `no false "not found" toast (toast: ${JSON.stringify(toast)})`);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
