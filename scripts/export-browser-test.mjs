//! Browser-readability test for the native HTML and Print exports.
//!
//!     npm test -- --only export-browser
//!
//! The window must have `samples/export-tour.md` open. The suite opens the
//! AsciiDoc fixture itself. It intercepts the native save picker and the
//! `print_document` command at the IPC transport boundary, so no browser is
//! launched and no real file is printed; the HTML the frontend would write is
//! inspected directly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "parse5";

const port = Number(process.argv[2] ?? 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error(`No page target for export tests on port ${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
ws.addEventListener("message", (event) => {
  const response = JSON.parse(event.data);
  const resolve = pending.get(response.id);
  if (resolve) {
    pending.delete(response.id);
    resolve(response);
  }
});
await new Promise((resolve) => ws.addEventListener("open", resolve));

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await send("Runtime.enable");

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.error || result.result?.exceptionDetails) {
    throw new Error(
      result.result?.exceptionDetails?.exception?.description ?? JSON.stringify(result.error),
    );
  }
  return result.result.result.value;
}
const invoke = (command, args = {}) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(expression, limit = 20000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  throw new Error(`Timed out: ${expression}`);
}
const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
async function action(id) {
  await sleep(280);
  await invoke("plugin:event|emit", { event: "menu", payload: id });
}
const tab = (name) =>
  `[...document.querySelectorAll('.doc-tab')].find(t=>t.querySelector('.doc-tab-name')?.textContent===${JSON.stringify(name)})`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft export-"));
const markdownOut = path.join(work, "export tour.html");
const asciidocOut = path.join(work, "asciidoc tour.html");
const asciidocSource = path.resolve("samples/export-tour.adoc");
let hooked = false;

// ---------------------------------------------------------------------------
// parse5 helpers: find elements and read their attributes.
// ---------------------------------------------------------------------------
function elements(root, tag) {
  const found = [];
  const walk = (node) => {
    if (node.tagName === tag) found.push(node);
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(root);
  return found;
}
const attrs = (node) =>
  Object.fromEntries((node.attrs ?? []).map((attr) => [attr.name, attr.value]));
function localFile(reference, baseFile) {
  try {
    const url = new URL(reference, pathToFileURL(baseFile));
    if (url.protocol !== "file:") return null;
    return fileURLToPath(url);
  } catch {
    return null;
  }
}
const colors = (svg) => [...new Set(svg.match(/#[0-9a-fA-F]{3,8}/g) ?? [])].sort().join(",");

try {
  await wait(
    `document.querySelector('.cm-content') && document.title.includes('export-tour.md')`,
    60000,
  );

  await evaluate(`(() => {
    const state = window.__exportTest = {
      original: window.fetch,
      nextSave: null,
      printHtml: null,
      printCalls: 0,
      messages: [],
    };
    window.fetch = async function(input, options) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.hostname !== 'ipc.localhost') return state.original.call(window, input, options);
      const command = decodeURIComponent(url.pathname.slice(1));
      const args = typeof options?.body === 'string' ? JSON.parse(options.body) : {};
      const response = (value, ok = true) =>
        new Response(JSON.stringify(value), {
          headers: {
            'Content-Type': 'application/json',
            'Tauri-Response': ok ? 'ok' : 'error',
          },
        });
      if (command === 'plugin:dialog|save') {
        const chosen = state.nextSave;
        state.nextSave = null;
        return response(chosen);
      }
      if (command === 'plugin:dialog|message') {
        state.messages.push(args.message);
        return response('Ok');
      }
      if (command === 'print_document') {
        state.printHtml = args.html;
        state.printCalls += 1;
        return response('/print/export-test.html');
      }
      return state.original.call(window, input, options);
    };
  })()`);
  hooked = true;

  // The print document must ignore the editor theme. Prove it from both sides.
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await evaluate(`document.documentElement.dataset.theme`)) === "dark") break;
    await evaluate(`document.getElementById('btn-theme').click()`);
    await sleep(500);
  }
  check(
    (await evaluate(`document.documentElement.dataset.theme`)) === "dark",
    "the editor is in dark mode before the print check",
  );
  await wait(`document.querySelector('#preview svg')`, 30000);

  // -------------------------------------------------------------------------
  // Markdown -> HTML
  // -------------------------------------------------------------------------
  await evaluate(`window.__exportTest.nextSave=${JSON.stringify(markdownOut)}`);
  await action("export.html");
  await wait(`document.getElementById('toast').textContent === 'Exported HTML'`, 30000);
  check(fs.existsSync(markdownOut), "the Markdown HTML export wrote its file");
  const html = fs.readFileSync(markdownOut, "utf8");
  const document = parse(html);
  const images = elements(document, "img").map(attrs);
  const links = elements(document, "a").map(attrs);
  check(
    !html.includes("asset:") && !html.includes("mdraft-preview"),
    "the exported page contains no application-only URL",
  );
  check(images.length === 1, "the exported page kept its image", `${images.length} img`);
  const imageFile = images[0] ? localFile(images[0].src ?? "", markdownOut) : null;
  check(
    Boolean(imageFile && fs.existsSync(imageFile)),
    "the exported image resolves to the real file",
    images[0]?.src ?? "no src",
  );
  check(
    links.some((link) => link.href === "https://example.com/reference?q=1#part"),
    "the external destination survived",
  );
  check(
    links.some((link) => link.href === "#details"),
    "the heading destination stayed in the page",
  );
  const localLink = links.find((link) => {
    const file = localFile(link.href ?? "", markdownOut);
    return file !== null && path.resolve(file) === path.resolve("samples/feature-tour.md");
  });
  check(
    Boolean(localLink),
    "the local document destination resolves to the real file",
    localLink?.href ?? links.map((link) => link.href).join(", "),
  );
  check(html.includes("var(--font-body"), "the standalone page uses the typography variables");

  // -------------------------------------------------------------------------
  // Markdown -> Print, while the editor is dark
  // -------------------------------------------------------------------------
  await action("export.pdf.browser");
  await wait(`window.__exportTest.printCalls === 1`, 30000);
  const printDark = await evaluate(`window.__exportTest.printHtml`);
  check(typeof printDark === "string" && printDark.length > 0, "print produced a document");
  const printDocument = parse(printDark);
  const printImages = elements(printDocument, "img").map(attrs);
  const printLinks = elements(printDocument, "a").map(attrs);
  check(
    !printDark.includes("asset:") && !printDark.includes("mdraft-preview"),
    "the print document contains no application-only URL",
  );
  const printImage = printImages[0]?.src ?? "";
  check(
    Boolean(
      localFile(printImage, markdownOut) && fs.existsSync(localFile(printImage, markdownOut)),
    ),
    "the print image is an absolute file URL that resolves",
    printImage,
  );
  check(
    printLinks.some((link) => link.href === "https://example.com/reference?q=1#part") &&
      printLinks.some((link) => link.href === "#details"),
    "print keeps external and heading destinations",
  );
  check(
    printDark.includes("document.fonts.ready") &&
      printDark.includes("window.print") &&
      printDark.includes("image.loading = 'eager'") &&
      printDark.includes('decoding="sync"'),
    "print waits for fonts and forces images eager and sync",
  );
  const svgDark = printDark.match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? "";
  check(svgDark.length > 0, "print contains the Mermaid diagram");

  // -------------------------------------------------------------------------
  // The same document in light mode must produce the same light diagram:
  // print owns its theme instead of inheriting the editor's.
  // -------------------------------------------------------------------------
  await evaluate(`document.getElementById('btn-theme').click()`);
  await wait(`document.documentElement.dataset.theme === 'light'`);
  await sleep(500);
  await action("export.pdf.browser");
  await wait(`window.__exportTest.printCalls === 2`, 30000);
  const printLight = await evaluate(`window.__exportTest.printHtml`);
  const svgLight = printLight.match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? "";
  check(svgLight.length > 0, "the light print still contains the diagram");
  check(
    colors(svgDark) === colors(svgLight),
    "the print diagram uses the same light palette in a dark and a light editor",
  );

  // -------------------------------------------------------------------------
  // AsciiDoc -> HTML
  // -------------------------------------------------------------------------
  await invoke("plugin:event|emit", { event: "open-files", payload: [asciidocSource] });
  await wait(`${tab("export-tour.adoc")}?.getAttribute('aria-selected')==='true'`, 30000);
  await wait(`document.querySelector('#preview img')`, 30000);
  await evaluate(`window.__exportTest.nextSave=${JSON.stringify(asciidocOut)}`);
  await action("export.html");
  await wait(`document.getElementById('toast').textContent === 'Exported HTML'`, 30000);
  check(fs.existsSync(asciidocOut), "the AsciiDoc HTML export wrote its file");
  const asciidocHtml = fs.readFileSync(asciidocOut, "utf8");
  const asciidocDocument = parse(asciidocHtml);
  const asciidocImages = elements(asciidocDocument, "img").map(attrs);
  const asciidocLinks = elements(asciidocDocument, "a").map(attrs);
  const asciidocImage = asciidocImages[0]?.src ?? "";
  check(
    !asciidocHtml.includes("asset:") &&
      Boolean(
        localFile(asciidocImage, asciidocOut) &&
        fs.existsSync(localFile(asciidocImage, asciidocOut)),
      ),
    "the AsciiDoc image resolves in a browser",
    asciidocImage,
  );
  check(
    asciidocLinks.some((link) => link.href === "https://example.com/reference?q=1#part"),
    "the AsciiDoc external destination survived",
  );
  check(
    asciidocLinks.some((link) => link.href === "#details"),
    "the AsciiDoc heading destination survived",
  );
} catch (error) {
  console.error(error.stack ?? error);
  check(false, "the export browser suite completed", String(error));
  try {
    console.error(
      "diagnostics",
      await evaluate(
        `JSON.stringify({theme:document.documentElement.dataset.theme,messages:window.__exportTest?.messages,toast:document.getElementById('toast').textContent,title:document.title})`,
      ),
    );
  } catch {}
} finally {
  if (hooked) {
    try {
      await evaluate(`window.fetch=window.__exportTest.original;delete window.__exportTest`);
    } catch (error) {
      console.error("cleanup:", String(error));
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  ws.close();
  process.exit(passed === checks.length ? 0 : 1);
}
