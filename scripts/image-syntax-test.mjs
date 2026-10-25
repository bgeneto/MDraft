// Image paste in a saved Typst document, including the remote-image option,
// the formats Typst cannot read, and the syntax a bitmap becomes in a saved
// Markdown or HTML document.
//
//   node scripts/image-syntax-test.mjs [port]
//
// Start the application with samples/typst-tour.typ open. The suite writes into
// samples/typst-tour.assets (that document's own assets folder) and removes
// what it added in a finally block. The Markdown and HTML fixtures live in a
// temporary directory, never in the repository.

import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 9222);
const assets = join(process.cwd(), "samples", "typst-tour.assets");
const workDir = mkdtempSync(join(tmpdir(), "mdraft-image-syntax-"));
const markdownFile = join(workDir, "syntax.md");
const htmlFile = join(workDir, "syntax.html");
writeFileSync(markdownFile, "# Syntax\n\nStart.\n");
writeFileSync(htmlFile, "<p>Start.</p>\n");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
  "base64",
);
// A 1x1 lossless WebP; Typst decodes it, which the AVIF case below cannot be.
const WEBP = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=", "base64");
// The `ftyp` box an AVIF writer emits: enough for the bytes-in, format-out
// sniff, which is the decision under test. Typst cannot decode AVIF at all.
const AVIF = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x1c]),
  Buffer.from("ftypmif1"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("avifmif1miaf"),
]);
const server = createServer((request, response) => {
  if (request.url === "/signin.png") {
    const body = Buffer.from('{"detail":"Not authenticated"}');
    response.writeHead(401, { "Content-Type": "application/json", "Content-Length": body.length });
    response.end(body);
    return;
  }
  if (request.url === "/html.png") {
    const body = Buffer.from("<!DOCTYPE html><html><body>Please sign in</body></html>");
    response.writeHead(200, { "Content-Type": "text/html", "Content-Length": body.length });
    response.end(body);
    return;
  }
  const body = request.url === "/modern.webp" ? WEBP : request.url === "/modern.avif" ? AVIF : PNG;
  const type =
    request.url === "/modern.webp"
      ? "image/webp"
      : request.url === "/modern.avif"
        ? "image/avif"
        : "image/png";
  response.writeHead(200, { "Content-Type": type, "Content-Length": body.length });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const imageUrl = `${base}/served.png`;
const webpUrl = `${base}/modern.webp`;
const avifUrl = `${base}/modern.avif`;

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
const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );

/** Open `file` and wait until its tab is active and has rendered. */
async function openFile(file, name) {
  await invoke("plugin:event|emit", { event: "open-files", payload: [file] });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const active = await evaluate(
      `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent`,
    );
    if (active === name && (await evaluate("document.querySelectorAll('.cm-line').length > 0"))) {
      return true;
    }
    await sleep(120);
  }
  return false;
}

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

  // WebP decodes in both the webview and Typst, so it is a normal image.
  await evaluate(`(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<p>WebP</p><img src="${webpUrl}" alt="modern">');
    data.setData('text/plain', 'WebP');
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true
    }));
  })()`);
  await sleep(4000);
  const webp = await lines();
  check(webp.includes(".webp"), "a WebP image is downloaded and inserted", webp);
  check(
    assetFiles().some((file) => file.endsWith(".webp")),
    "the WebP file is saved",
    JSON.stringify(assetFiles()),
  );
  await undo();

  // AVIF is decodable by the webview but not by Typst 0.15.1. The file is kept
  // (the rule says copy it) and no `#image` that cannot compile is inserted.
  await evaluate(`(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<p>AVIF</p><img src="${avifUrl}" alt="modern">');
    data.setData('text/plain', 'AVIF');
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true
    }));
  })()`);
  await sleep(4000);
  const avif = await lines();
  check(!avif.includes("#image("), "Typst receives no AVIF reference", avif);
  check(
    assetFiles().some((file) => file.endsWith(".avif")),
    "the AVIF file is still saved",
    JSON.stringify(assetFiles()),
  );
  const avifToast = await evaluate(`document.getElementById('toast')?.textContent ?? ''`);
  check(
    avifToast.includes("AVIF") && avifToast.includes("cannot display"),
    "the AVIF limitation is explained",
    avifToast,
  );

  console.log("=== the Image menu command ===");
  await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
    event: 'menu', payload: 'format.image'
  })`);
  await sleep(500);
  const placeholder = await lines();
  check(
    placeholder.includes('#image("./image.png"'),
    "Format > Image inserts Typst image syntax",
    placeholder,
  );
  await undo();

  await setRemoteMode("url");
  const beforeKeep = assetFiles().length;
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
    assetFiles().length === beforeKeep,
    "Keep the original URL writes no file",
    JSON.stringify(assetFiles()),
  );
  await setRemoteMode("download");

  console.log("=== images in saved Markdown and HTML tabs ===");
  check(await openFile(markdownFile, "syntax.md"), "the Markdown fixture opens");
  await pasteBitmap();
  const markdown = await lines();
  check(markdown.includes("!["), "a clipboard bitmap becomes Markdown image syntax", markdown);
  check(!markdown.includes("#image("), "Markdown does not receive Typst image syntax");

  check(await openFile(htmlFile, "syntax.html"), "the HTML fixture opens");
  await pasteBitmap();
  const html = await lines();
  check(html.includes("<img"), "a clipboard bitmap becomes an HTML img", html);
  check(!html.includes("!["), "HTML does not receive Markdown image syntax");
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
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
}

if (exceptions.length > 0) {
  console.log("\n=== console exceptions ===");
  for (const line of exceptions.slice(0, 6)) console.log("  " + String(line).split("\n")[0]);
}
check(exceptions.length === 0, "no runtime exception", exceptions.length ? exceptions[0] : "");

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
