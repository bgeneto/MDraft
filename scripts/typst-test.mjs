// Typst end to end: installation, PDF export through pandoc, and .typ editing.
//
//   node scripts/typst-test.mjs [port] [markdown-doc] [typst-doc]
//
// Start the application with the Typst document open
// (`mdraft.exe samples/typst-tour.typ`): the preview checks read whatever the
// window is showing, and the Markdown document is read from disk independently.
//
// What this proves, in order: the backend finds Typst; pandoc is told to use it;
// a Markdown document becomes a real PDF through it; a .typ document opens with
// the Typst grammar and is drawn by the compiler; an edit redraws it; and a
// broken document reports the compiler's complaint in the pane instead of going
// blank or taking the window down.
//
// The preview is checked by counting the rendered pages, because they are the
// compiler's own output — there is no intermediate representation to inspect.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = process.argv[2] ?? "9222";
const markdownDoc = process.argv[3] ?? "samples/feature-tour.md";
const typstDoc = process.argv[4] ?? "samples/typst-tour.typ";

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
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
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const r = pending.get(m.id);
  if (r) {
    pending.delete(m.id);
    r(m);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return r.result.result.value;
}

const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );

/**
 * Run a command whose *failure* is the interesting part.
 *
 * A rejected promise comes back through CDP as `exceptionDetails`, and the
 * helper above turns that into a generic "evaluate failed" — which loses the
 * message the whole check exists to read. Catching inside the page keeps the
 * rejection as data.
 */
const tryInvoke = async (command, args = {}) => {
  const raw = await evaluate(`
    window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})
      .then((value) => JSON.stringify({ ok: true, value }))
      .catch((error) => JSON.stringify({ ok: false, error: String(error) }))
  `);
  return JSON.parse(raw);
};

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
console.log("=== the compiler is available ===");
const status = await invoke("typst_status");
check(status.found === true, "Typst is installed", `${status.version ?? "not found"} at ${status.path ?? "-"}`);
check(
  status.source === "managed" || status.source === "path",
  "the application knows where it came from",
  status.source ?? "-",
);
if (!status.found) {
  console.log("\n  Install Typst first (Help › Install Typst) and run again.");
  ws.close();
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log("\n=== pandoc is told to drive it ===");
const pandoc = await invoke("pandoc_status");
check(
  typeof pandoc.pdfEngine === "string" && pandoc.pdfEngine.toLowerCase().includes("typst"),
  "pandoc's PDF engine is Typst, not LaTeX",
  pandoc.pdfEngine ?? "none",
);

// ---------------------------------------------------------------------------
console.log("\n=== Markdown becomes a PDF through Typst ===");
const work = mkdtempSync(join(tmpdir(), "mdraft-typst-test-"));
const pdfPath = join(work, "export.pdf");
try {
  const markdown = readFileSync(markdownDoc, "utf8");
  const outcome = await invoke("run_export", {
    request: {
      formatId: "pdf",
      markdown,
      outputPath: pdfPath,
      inputPath: join(process.cwd(), markdownDoc),
    },
  });
  check(outcome.bytes > 0, "the export reported bytes", `${outcome.bytes} bytes at ${outcome.outputPath}`);
  check(existsSync(pdfPath), "the file exists");
  if (existsSync(pdfPath)) {
    const head = readFileSync(pdfPath).subarray(0, 5).toString("latin1");
    check(head === "%PDF-", "the file really is a PDF", head);
    // A blank page compresses to almost nothing; a document with text does not.
    const size = statSync(pdfPath).size;
    check(size > 8000, "the PDF has content rather than an empty page", `${size} bytes`);
    check(
      String(outcome.warnings ?? "").length === 0 || !/error/i.test(String(outcome.warnings)),
      "pandoc reported no errors",
      String(outcome.warnings ?? "").slice(0, 120),
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\n=== a .typ document opens, highlights and previews ===");
await invoke("read_document", { path: join(process.cwd(), typstDoc) }).then(async (payload) => {
  // Opened through the application's own path so the language switch runs.
  const opened = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("read_document", { path: ${JSON.stringify(join(process.cwd(), typstDoc))} })
      .then((d) => d.content.length)`,
  );
  check(opened > 0, "the .typ file reads", `${opened} chars`);
  check(payload.content.startsWith("//!"), "its content arrives unaltered", payload.content.slice(0, 20));
});

const language = await evaluate(`(() => {
  const tokens = document.querySelectorAll(".cm-content span[class]").length;
  const text = document.querySelector(".cm-content")?.innerText ?? "";
  return JSON.stringify({ tokens, head: text.slice(0, 12) });
})()`);
const shown = JSON.parse(language);
check(shown.tokens > 0, "the Typst grammar is producing highlighted tokens", `${shown.tokens} spans`);
check(shown.head.startsWith("//!"), "the buffer holds the file as written", shown.head);

const viewState = () =>
  evaluate(`(() => {
    const bar = [...document.querySelectorAll(".typst-viewbutton")]
      .map((b) => b.textContent + (b.classList.contains("active") ? "*" : ""));
    return JSON.stringify({
      kind: document.querySelector(".typst-document") ? "document"
        : document.querySelector(".typst-preview") ? "pages" : "none",
      bar,
      blocks: document.querySelectorAll(".typst-document > *").length,
      pages: document.querySelectorAll(".typst-page").length,
      notice: document.querySelector(".typst-warning")?.textContent ?? null,
      error: document.querySelector(".typst-error")?.textContent ?? null,
    });
  })()`);

const initial = JSON.parse(await viewState());
check(initial.kind === "document", "the preview opens as a document, not as pages", initial.kind);
check(initial.blocks > 5, "it holds the document's blocks", `${initial.blocks} blocks`);
check(
  initial.bar.includes("Document*") && initial.bar.includes("Pages"),
  "both views are offered",
  initial.bar.join(" / "),
);
check(initial.error === null, "no compiler error is shown");

// The pane deliberately says nothing about constructs the document view drops.
// It was tried and it was noise: `#set page(...)` alone produced a banner on
// every single document, and the reader learns to ignore it. The information is
// still in the API for anyone who asks.
check(
  initial.notice === null,
  "the document view shows no banner about what it drops",
  initial.notice ?? "",
);

// ---------------------------------------------------------------------------
console.log("\n=== the page view is one click away, and is the compiler's output ===");
await evaluate(`[...document.querySelectorAll(".typst-viewbutton")]
  .find((b) => b.textContent === "Pages").click()`);
await sleep(2500);
const asPages = JSON.parse(await viewState());
check(asPages.kind === "pages", "switching to Pages shows the rendered pages", asPages.kind);
check(asPages.pages >= 1, "and there is at least one page", `${asPages.pages} page(s)`);

await evaluate(`[...document.querySelectorAll(".typst-viewbutton")]
  .find((b) => b.textContent === "Document").click()`);
await sleep(2500);
const back = JSON.parse(await viewState());
check(back.kind === "document", "and back again", back.kind);

// ---------------------------------------------------------------------------
console.log("\n=== the outline understands Typst headings ===");
// Typst marks a heading with `=` where Markdown uses `#`, so an outline built
// from the Markdown scanner would claim the document had none.
const outline = await evaluate(`(() => {
  document.getElementById("tab-outline")?.click();
  return JSON.stringify([...document.querySelectorAll(".outline-item")].map((e) => e.textContent.trim()));
})()`);
const headings = JSON.parse(outline);
check(headings.length >= 3, "the outline lists the document's headings", `${headings.length} heading(s)`);
check(
  headings.includes("Mathematics") || headings.some((h) => /Mathematics|Tables|Code/.test(h)),
  "the heading text is read from `= Title` markers",
  headings.slice(0, 4).join(", "),
);

// ---------------------------------------------------------------------------
console.log("\n=== an edit redraws the preview ===");
await evaluate(`document.querySelector(".cm-content").focus()`);
await send("Input.insertText", { text: "\n\n= Added by the test\n\nA paragraph.\n" });
await sleep(2500);
const afterEdit = JSON.parse(await viewState());
check(afterEdit.error === null, "the edited document still compiles");
check(
  afterEdit.blocks > initial.blocks,
  "the preview redrew with the new block",
  `${initial.blocks} -> ${afterEdit.blocks}`,
);

// ---------------------------------------------------------------------------
console.log("\n=== a broken document reports the compiler's complaint ===");
// The same command the preview uses, given deliberately invalid source. It has to
// fail loudly: a preview that silently shows nothing leaves the reader with no
// idea which line is wrong.
let compileError = null;
const broken = await tryInvoke("render_typst", {
  path: join(process.cwd(), typstDoc),
  source: "#let x = \n#this-function-does-not-exist()",
});
if (!broken.ok) compileError = broken.error;
check(compileError !== null, "invalid Typst fails instead of rendering nothing");
check(
  compileError !== null && /error|unknown/i.test(compileError),
  "the failure carries the compiler's message",
  (compileError ?? "").split("\n")[0]?.slice(0, 100) ?? "no message",
);
check(
  compileError !== null && !/evaluate failed/i.test(compileError),
  "the message is the compiler's, not the test harness's",
  compileError?.slice(0, 60) ?? "",
);

// ---------------------------------------------------------------------------
console.log("\n=== a document that would never finish ===");
// The Rust side stops a render after 60 s so a runaway document cannot wedge a
// worker thread. That path could not be exercised here, and saying so is better
// than a test that pretends: Typst rejects the obvious endless loop before it
// runs a single iteration, so there is nothing to time out.
const loop = await tryInvoke("render_typst", {
  path: join(process.cwd(), typstDoc),
  source: "#while true { }\n",
});
check(!loop.ok, "a document that would never finish is refused");
check(
  /always true/i.test(loop.error ?? ""),
  "Typst rejects the endless loop itself, before running it",
  (loop.error ?? "").split("\n")[0]?.slice(0, 80) ?? "",
);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ""}`);
}
ws.close();
process.exit(failed.length === 0 ? 0 : 1);
