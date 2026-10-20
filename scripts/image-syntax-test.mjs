// Image paste in a saved Typst document, including the new remote-image option.
//
//   node scripts/image-syntax-test.mjs [port]
//
// Start the application with samples/typst-tour.typ open. The suite writes into
// samples/typst-tour.assets (the document's own assets folder) and removes that
// folder in a finally block.

import { createServer } from "node:http";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 9222);
const assets = join(process.cwd(), "samples", "typst-tour.assets");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
  "base64",
);
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "image/png", "Content-Length": PNG.length });
  response.end(PNG);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const imageUrl = `http://127.0.0.1:${server.address().port}/served.png`;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
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
const assetFiles = () => (existsSync(assets) ? readdirSync(assets) : []);

async function undo() {
  await evaluate(`(() => {
    const target = document.querySelector('.cm-content');
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', key: 'z', ctrlKey: true, bubbles: true }));
  })()`);
  await sleep(400);
}

async function openImageSection() {
  await evaluate("document.getElementById('btn-prefs').click()");
  await sleep(250);
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.prefs-section')].find((node) => node.textContent.trim() === 'Image');
    if (!item) throw new Error('missing Image section');
    item.click();
  })()`);
  await sleep(250);
}

async function setRemoteMode(value) {
  await openImageSection();
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.prefs-row')].find((node) =>
      (node.querySelector('.prefs-label')?.textContent ?? '').replace(/\\?$/, '').trim() === 'Remote Images in Pasted Rich Text');
    if (!row) throw new Error('missing remote image preference');
    const select = row.querySelector('select');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  await sleep(250);
  await evaluate(
    "document.querySelector('.prefs-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
  );
  await sleep(250);
}

async function setDefaultExtension(value) {
  await evaluate("document.getElementById('btn-prefs').click()");
  await sleep(250);
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.prefs-section')].find((node) => node.textContent.trim() === 'Files');
    if (!item) throw new Error('missing Files section');
    item.click();
  })()`);
  await sleep(250);
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.prefs-row')].find((node) =>
      (node.querySelector('.prefs-label')?.textContent ?? '').replace(/\\?$/, '').trim() === 'Default File Extension');
    if (!row) throw new Error('missing default extension preference');
    const select = row.querySelector('select');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  await sleep(250);
  await evaluate(
    "document.querySelector('.prefs-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
  );
  await sleep(250);
}

async function newTab() {
  await evaluate("document.querySelector('.cm-content').focus()");
  await evaluate(`document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown', {
    code: 'KeyN', key: 'n', ctrlKey: true, bubbles: true
  }))`);
  await sleep(500);
  await evaluate("document.querySelector('.cm-content').focus()");
}

async function pasteBitmap() {
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 6; canvas.height = 6;
    const context = canvas.getContext('2d');
    context.fillStyle = '#3b7ddd';
    context.fillRect(0, 0, 6, 6);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'clipboard.png', { type: 'image/png' }));
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true
    }));
  })()`);
  await sleep(2800);
}

await new Promise((resolve) => ws.addEventListener("open", resolve));

let initial = new Set();
try {
  await send("Runtime.enable");
  console.log("=== images in a Typst document ===");
  const before = assetFiles().length;
  initial = new Set(assetFiles());

  // A clipboard bitmap goes through the existing image path, not rich paste.
  await pasteBitmap();
  const bitmap = await lines();
  check(bitmap.includes("#image("), "a clipboard bitmap becomes #image", bitmap);
  check(!bitmap.includes("!["), "no Markdown image syntax in Typst");
  check(
    assetFiles().length === before + 1,
    "the bitmap wrote one asset file",
    JSON.stringify(assetFiles()),
  );
  await undo();

  // A remote image inside a pasted fragment uses the new preference.
  await evaluate(`(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<p>Remote image</p><img src="${imageUrl}" alt="served">');
    data.setData('text/plain', 'Remote image');
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true
    }));
  })()`);
  await sleep(4000);
  const downloaded = await lines();
  check(
    downloaded.includes("#image("),
    "a remote pasted image is downloaded and inserted",
    downloaded,
  );
  check(!downloaded.includes("http://"), "the source has no remote URL left", downloaded);
  check(
    assetFiles().length === before + 2,
    "the remote image wrote one asset file",
    JSON.stringify(assetFiles()),
  );
  await undo();

  await setRemoteMode("url");
  await evaluate(`(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<p>Remote image</p><img src="${imageUrl}" alt="served">');
    data.setData('text/plain', 'Remote image');
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true
    }));
  })()`);
  await sleep(1500);
  const kept = await lines();
  check(!kept.includes("#image("), "Keep the original URL does not save the image", kept);
  check(kept.includes("served.png"), "the URL is kept in the document", kept);
  check(
    assetFiles().length === before + 2,
    "Keep the original URL writes no file",
    JSON.stringify(assetFiles()),
  );
  await setRemoteMode("download");

  console.log("=== images in Markdown and HTML tabs ===");
  await setDefaultExtension("md");
  await newTab();
  await pasteBitmap();
  const markdown = await lines();
  check(markdown.includes("!["), "a clipboard bitmap becomes Markdown image syntax", markdown);
  check(!markdown.includes("#image("), "Markdown does not receive Typst image syntax");

  await setDefaultExtension("html");
  await newTab();
  await pasteBitmap();
  const html = await lines();
  check(html.includes("<img"), "a clipboard bitmap becomes an HTML img", html);
  check(!html.includes("!["), "HTML does not receive Markdown image syntax");
  await setDefaultExtension("md");
} finally {
  ws.close();
  server.close();
  try {
    for (const file of assetFiles()) {
      if (!initial.has(file)) rmSync(join(assets, file), { force: true });
    }
    if (initial.size === 0) rmSync(assets, { recursive: true, force: true });
  } catch {
    /* the next run will see whatever was left */
  }
}

if (exceptions.length > 0) {
  console.log("\n=== console exceptions ===");
  for (const line of exceptions.slice(0, 6)) console.log("  " + String(line).split("\n")[0]);
}
check(exceptions.length === 0, "no runtime exception", exceptions.length ? exceptions[0] : "");

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
