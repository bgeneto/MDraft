//! Native direct-PDF quality test.
//!
//!     npm test -- --only pdf-native
//!
//! The window must have `samples/pdf-quality.md` open. The suite stubs the save
//! picker, emits the real `export.pdf` menu command, waits for the file the Rust
//! print surface wrote, then rasterizes it with Poppler and measures the pages.
//! It never launches a browser and never touches the user's settings directory.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";

const port = Number(process.argv[2] ?? 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error(`No page target for the PDF test on port ${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
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
async function wait(expression, limit = 30000) {
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

// Workspace paths are also reachable by WSL Poppler; a redirected TEMP drive
// (for example T:) need not have a Linux mount.
const root = process.platform === "win32" ? path.resolve("node_modules/.cache") : os.tmpdir();
fs.mkdirSync(root, { recursive: true });
const work = fs.mkdtempSync(path.join(root, "mdraft pdf-"));
const target = path.join(work, "pdf quality.pdf");
const pages = path.join(work, "pages");
let hooked = false;
let server;
let slowResponse;
const imageUrl = pathToFileURL(path.resolve("samples/pdf-quality-blocks.png")).href;
const article = (label, extra = "") =>
  `<!doctype html><html><head><meta name="mdraft-print" content="1"><style>@page{size:A4;margin:18mm 16mm}body{font:16px serif}img{width:240px}</style></head><body><h1>${label}</h1><p>Selectable document prose verifies that this output belongs to its own print request and retains visible content.</p><img src="${imageUrl}">${extra}</body></html>`;
function inspectPdf(file, label, rejected = []) {
  const output = execFileSync(
    process.execPath,
    [
      path.resolve("scripts/pdf-visual-check.mjs"),
      "--pdf",
      file,
      "--out",
      `${file}-pages`,
      "--expect",
      label,
      ...rejected.flatMap((text) => ["--reject", text]),
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  console.log(output);
  return output.includes("checks passed") && !output.includes(" FAIL ");
}
try {
  await wait(
    `document.querySelector('.cm-content') && document.title.includes('pdf-quality.md')`,
    60000,
  );

  await evaluate(`(() => {
    const state = window.__pdfTest = {
      original: window.fetch,
      nextSave: null,
      messages: [],
      asks: [],
      printHtml: null,
      printCalls: 0,
      nativeHtml: null,
      answerAsk: false,
    };
    window.fetch = async function(input, options) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.hostname !== 'ipc.localhost') return state.original.call(window, input, options);
      const command = decodeURIComponent(url.pathname.slice(1));
      const args = typeof options?.body === 'string' ? JSON.parse(options.body) : {};
      const response = (value, ok = true) => new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json', 'Tauri-Response': ok ? 'ok' : 'error' },
      });
      if (command === 'plugin:dialog|save') {
        const chosen = state.nextSave;
        state.nextSave = null;
        return response(chosen);
      }
      if (command === 'plugin:dialog|message') {
        state.messages.push(args.message);
        // The ask helper is a message dialog with Yes/No buttons and resolves
        // to the label of the button that was pressed, not to a boolean.
        if (state.answerAsk && args.buttons) return response('Yes');
        return response('Ok');
      }
      if (command === 'print_document') {
        state.printHtml = args.html;
        state.printCalls += 1;
        return response('/print/pdf-test.html');
      }
      if (command === 'print_native_pdf') state.nativeHtml = args.html;
      return state.original.call(window, input, options);
    };
  })()`);
  hooked = true;

  await evaluate(`window.__pdfTest.nextSave=${JSON.stringify(target)}`);
  await action("export.pdf");
  await wait(
    `document.getElementById('toast').textContent === 'Exported PDF' || window.__pdfTest.messages.length > 0`,
    120000,
  );
  const state = await evaluate(
    `({ messages: window.__pdfTest.messages, asks: window.__pdfTest.asks, printCalls: window.__pdfTest.printCalls, nativeHtml: window.__pdfTest.nativeHtml })`,
  );
  if (state.nativeHtml) fs.writeFileSync(path.join(work, "quality-native.html"), state.nativeHtml);
  check(
    state.printCalls === 0,
    "the native route did not open the browser document",
    String(state.printCalls),
  );
  check(fs.existsSync(target), "the direct PDF exists");
  if (fs.existsSync(target)) {
    const bytes = fs.statSync(target).size;
    check(bytes > 10_000, "the PDF is not an empty placeholder", `${bytes} bytes`);
    check(
      fs.readFileSync(target).subarray(0, 5).toString("ascii") === "%PDF-",
      "the file starts with %PDF-",
    );
    const output = execFileSync(
      process.execPath,
      [
        path.resolve("scripts/pdf-visual-check.mjs"),
        "--pdf",
        target,
        "--out",
        pages,
        "--fixture",
        "quality",
      ],
      { cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    console.log(output);
    check(
      output.includes("checks passed") && !output.includes(" FAIL "),
      "the visual PDF checks passed",
    );
    check(fs.readdirSync(pages).includes("page-2.png"), "the fixture produced a second page image");
  }
  check(
    state.messages.length === 0,
    "the direct path did not report a dialog error",
    state.messages.join(" | "),
  );

  // -------------------------------------------------------------------------
  // Static HTML uses the same native writer; scripted HTML keeps the browser.
  // -------------------------------------------------------------------------
  const staticHtml = path.join(work, "static-print.html");
  const staticPdf = path.join(work, "static print.pdf");
  fs.writeFileSync(
    staticHtml,
    [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8">',
      "<title>Static HTML Print</title>",
      '<link rel="stylesheet" href="print.css">',
      "</head><body>",
      "<h1>Static HTML Print</h1>",
      "<p>Local image follows.</p>",
      '<img src="block.png" alt="Local image">',
      "</body></html>",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(work, "print.css"), "h1{color:#1a73e8}");
  fs.copyFileSync("samples/pdf-quality-blocks.png", path.join(work, "block.png"));
  await invoke("plugin:event|emit", { event: "open-files", payload: [staticHtml] });
  await wait(`document.title.includes('static-print.html')`, 30000);
  await sleep(700);
  await evaluate(`window.__pdfTest.nextSave=${JSON.stringify(staticPdf)}`);
  await action("export.pdf");
  await wait(
    `document.getElementById('toast').textContent === 'Exported PDF' || window.__pdfTest.messages.length > 0`,
    120000,
  );
  check(fs.existsSync(staticPdf), "a static HTML document writes a native PDF");
  if (fs.existsSync(staticPdf)) {
    const staticPages = path.join(work, "static-pages");
    const output = (() => {
      try {
        return execFileSync(
          process.execPath,
          [
            path.resolve("scripts/pdf-visual-check.mjs"),
            "--pdf",
            staticPdf,
            "--out",
            staticPages,
            "--expect",
            "Static HTML Print",
            "--expect",
            "Local image",
          ],
          { cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        );
      } catch (error) {
        console.log(error.stdout?.toString() ?? "");
        console.error(error.stderr?.toString() ?? "");
        throw error;
      }
    })();
    console.log(output);
    check(
      output.includes("checks passed") && !output.includes(" FAIL "),
      "the static HTML PDF passes its visual checks",
    );
  }

  const scriptedHtml = path.resolve("samples/html-tour/index.html");
  const scriptedPdf = path.join(work, "scripted.pdf");
  await evaluate(`window.__pdfTest.answerAsk=true;window.__pdfTest.printCalls=0`);
  await invoke("plugin:event|emit", { event: "open-files", payload: [scriptedHtml] });
  await wait(`document.title.includes('index.html')`, 30000);
  await evaluate(`window.__pdfTest.nextSave=${JSON.stringify(scriptedPdf)}`);
  await action("export.pdf");
  await wait(`window.__pdfTest.printCalls > 0`, 30000);
  check(
    !fs.existsSync(scriptedPdf),
    "a scripted HTML document does not reach the native PDF writer",
  );
  check(
    (await evaluate(`window.__pdfTest.printCalls`)) === 1,
    "a scripted HTML document opens the browser print document instead",
  );
  await evaluate(`window.__pdfTest.answerAsk=false`);

  // Parsed active-content detection includes opaque children and encoded URLs.
  const child = Buffer.from('<script>document.write("CHILD_SCRIPT_RAN")</script>').toString(
    "base64",
  );
  for (const [name, markup] of [
    ["encoded-child", `<iframe src="data:text/html;base64,${child}"></iframe>`],
    ["local-child", '<iframe src="child.html"></iframe>'],
    ["active-object", '<object data="child.html"></object>'],
    ["encoded-handler", '<a href="java&#x73;cript:alert(1)">link</a>'],
    ["refresh", '<meta http-equiv="refresh" content="0;url=child.html">'],
  ]) {
    const input = path.join(work, `${name}.html`);
    const output = path.join(work, `${name}.pdf`);
    fs.writeFileSync(input, article("Active content fallback", markup));
    await invoke("plugin:event|emit", { event: "open-files", payload: [input] });
    await wait(`document.title.includes(${JSON.stringify(name)})`);
    await evaluate(
      `window.__pdfTest.answerAsk=true;window.__pdfTest.printCalls=0;window.__pdfTest.nextSave=${JSON.stringify(output)}`,
    );
    await action("export.pdf");
    await wait("window.__pdfTest.printCalls === 1");
    check(!fs.existsSync(output), `${name} stays on the explicit browser fallback`);
  }
  await evaluate("window.__pdfTest.answerAsk=false");

  // Bypass the frontend deliberately: the Rust boundary must enforce its own
  // no-script/no-child policy, even for a caller providing active raw HTML.
  const protectedPdf = path.join(work, "protected.pdf");
  const protectedOutcome = await invoke("print_native_pdf", {
    html:
      '<!DOCTYPE html PUBLIC "x>">' +
      article(
        "Protected native article",
        `<script>document.body.append('PARENT_SCRIPT_RAN')</script><iframe src="data:text/html;base64,${child}"></iframe>`,
      ),
    name: "protected",
    target: protectedPdf,
  });
  check(
    protectedOutcome.status === "written" &&
      inspectPdf(protectedPdf, "Protected native article", [
        "PARENT_SCRIPT_RAN",
        "CHILD_SCRIPT_RAN",
      ]),
    "the native boundary blocks parent and encoded child scripts",
  );

  // Hold the first request in readiness while the second request queues. The
  // former single-label implementation destroyed the first job's surface.
  let sawImage;
  const requestedImage = new Promise((resolve) => {
    sawImage = resolve;
  });
  server = http.createServer((_request, response) => {
    slowResponse = response;
    sawImage();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const slowUrl = `http://127.0.0.1:${server.address().port}/slow.png`;
  const first = path.join(work, "first.pdf");
  const second = path.join(work, "second.pdf");
  await evaluate(
    `window.__pdfJobs=[];void window.__TAURI_INTERNALS__.invoke('print_native_pdf',${JSON.stringify({ html: article("First queued article", `<img src="${slowUrl}">`), name: "first", target: first })}).then(value=>window.__pdfJobs.push({id:1,value}),error=>window.__pdfJobs.push({id:1,error:String(error)}))`,
  );
  await Promise.race([
    requestedImage,
    sleep(15000).then(() => {
      throw new Error("First print never requested the held image");
    }),
  ]);
  await evaluate(
    `void window.__TAURI_INTERNALS__.invoke('print_native_pdf',${JSON.stringify({ html: article("Second queued article"), name: "second", target: second })}).then(value=>window.__pdfJobs.push({id:2,value}),error=>window.__pdfJobs.push({id:2,error:String(error)}))`,
  );
  await sleep(400);
  slowResponse.writeHead(200, { "Content-Type": "image/png" });
  slowResponse.end(fs.readFileSync("samples/pdf-quality-blocks.png"));
  await wait("window.__pdfJobs.length === 2", 120000);
  const jobs = await evaluate("window.__pdfJobs");
  check(
    jobs.every((job) => job.value?.status === "written"),
    "overlapping native requests both finish",
    JSON.stringify(jobs),
  );
  check(
    fs.existsSync(first) && inspectPdf(first, "First queued article", ["Second queued article"]),
    "the first job keeps its own content",
  );
  check(
    fs.existsSync(second) && inspectPdf(second, "Second queued article", ["First queued article"]),
    "the queued job keeps its own content",
  );

  const preserved = path.join(work, "existing.pdf");
  fs.writeFileSync(preserved, "ORIGINAL USER BYTES");
  let failed = false;
  try {
    await invoke("print_native_pdf", {
      html: "<p>Missing readiness marker</p>",
      name: "invalid",
      target: preserved,
    });
  } catch {
    failed = true;
  }
  check(
    failed && fs.readFileSync(preserved, "utf8") === "ORIGINAL USER BYTES",
    "a real preparation failure preserves the existing destination",
  );
} catch (error) {
  console.error(error.stack ?? error);
  check(false, "the PDF suite completed", String(error));
} finally {
  slowResponse?.destroy();
  server?.closeAllConnections();
  server?.close();
  if (hooked) {
    try {
      await evaluate(`window.fetch=window.__pdfTest.original;delete window.__pdfTest`);
    } catch {}
  }
  if (process.env.MDRAFT_PDF_KEEP === "1") console.log(`  retained PDF evidence: ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
  const passed = checks.filter(Boolean).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  ws.close();
  process.exit(passed === checks.length ? 0 : 1);
}
