// AsciiDoc through the real application.
//
//   node scripts/asciidoc-test.mjs [port]
//
// Needs the application running with samples/asciidoc-tour.adoc open, which is
// what `npm test` does for this suite. It writes the image-paste assets folder
// and removes it again on every exit path.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] ?? 9222);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "samples", "asciidoc-tour.assets");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) {
  console.error(`No page target on port ${PORT}`);
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
};

const evaluate = async (expression) => {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(JSON.stringify(response.result.exceptionDetails).slice(0, 900));
  }
  const value = response.result.result.value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
};

await new Promise((resolve) => ws.addEventListener("open", resolve));
await send("Runtime.enable");

let passed = 0;
let total = 0;
function check(ok, label, detail = "") {
  total += 1;
  if (ok) passed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function press({ code, key, ctrl = false, shift = false }) {
  const expression = `(() => {
    const event = new KeyboardEvent("keydown", {
      key: ${JSON.stringify(key)},
      code: ${JSON.stringify(code)},
      ctrlKey: ${ctrl},
      shiftKey: ${shift},
      bubbles: true,
      cancelable: true,
    });
    const target = document.querySelector(".cm-content") ?? document.body;
    target.dispatchEvent(event);
    return String(event.defaultPrevented);
  })()`;
  await evaluate(expression);
  await sleep(350);
}

async function type(text) {
  await evaluate(`document.querySelector(".cm-content").focus()`);
  await send("Input.insertText", { text });
  await sleep(800);
}

async function openTab(name) {
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll(".doc-tab")].find((node) => node.textContent.includes(${JSON.stringify(name)}));
    if (tab) tab.click();
    return 1;
  })()`);
  await sleep(600);
}

console.log("=== AsciiDoc preview ===");
await sleep(1200);
{
  check((await evaluate(`document.title`)).includes("asciidoc-tour.adoc"), "the fixture is open", await evaluate(`document.title`));

  const preview = await evaluate(`(() => {
    const root = document.querySelector("#preview");
    const image = root.querySelector("img");
    const fraction = root.querySelector(".math-display .frac-line, .math-inline .frac-line");
    const admonition = root.querySelector(".admonitionblock > table");
    return JSON.stringify({
      title: root.querySelector("h1")?.textContent ?? "",
      titleLine: root.querySelector("h1")?.getAttribute("data-line") ?? "",
      paragraphs: root.querySelectorAll(".paragraph").length,
      admonitions: root.querySelectorAll(".admonitionblock").length,
      toc: root.querySelectorAll("#toc").length,
      tables: root.querySelectorAll("table").length,
      anchors: root.querySelectorAll("[data-line]").length,
      listingSpans: root.querySelectorAll("pre code span").length,
      ranged: [...root.querySelectorAll("[data-line-end]")].some(
        (node) => Number(node.getAttribute("data-line-end")) > Number(node.getAttribute("data-line")),
      ),
      include: (root.textContent ?? "").includes("Included Chapter"),
      image: image ? { src: image.getAttribute("src"), width: image.naturalWidth } : null,
      fraction: fraction ? fraction.getBoundingClientRect().width : 0,
      admonitionDisplay: admonition ? getComputedStyle(admonition).display : "",
      error: root.querySelector(".asciidoc-error")?.textContent ?? "",
    });
  })()`);

  check(preview.title === "AsciiDoc Tour", "the document title is previewed", preview.title);
  check(preview.titleLine === "1", "the title is anchored at line 1", preview.titleLine);
  check(preview.paragraphs >= 2, "paragraphs are rendered", String(preview.paragraphs));
  check(preview.admonitions >= 1, "the admonition is rendered", String(preview.admonitions));
  check(preview.toc >= 1, ":toc: produces a table of contents", String(preview.toc));
  check(preview.tables >= 1, "the table is rendered", String(preview.tables));
  check(preview.listingSpans > 0, "the listing is highlighted", String(preview.listingSpans));
  check(preview.anchors >= 4, "blocks carry source anchors", String(preview.anchors));
  check(preview.ranged, "blocks carry an end line for copy");
  check(preview.include, "the include is inlined");
  check(preview.image !== null && preview.image.width > 0, "the local image loads", JSON.stringify(preview.image));
  check(preview.fraction > 0, "the latexmath fraction bar has width", String(preview.fraction));
  check(preview.admonitionDisplay === "table", "the admonition table is reset to display:table", preview.admonitionDisplay);
  check(preview.error === "", "the conversion has no error", preview.error);
}

console.log("\n=== source highlighting and outline ===");
{
  const syntax = await evaluate(`(() => {
    const line = [...document.querySelectorAll(".cm-line")].find((node) => node.textContent.includes("= AsciiDoc Tour"));
    const spans = line ? [...line.querySelectorAll("span")].map((span) => ({
      text: span.textContent,
      color: getComputedStyle(span).color,
      weight: getComputedStyle(span).fontWeight,
    })) : [];
    return JSON.stringify({ line: line?.textContent ?? "", spans });
  })()`);
  check(syntax.line.includes("= AsciiDoc Tour"), "the fixture source is in the editor", syntax.line);
  check(
    syntax.spans.some((span) => span.weight === "700" || span.color !== "rgb(0, 0, 0)"),
    "the AsciiDoc title is highlighted",
    JSON.stringify(syntax.spans.slice(0, 3)),
  );

  await evaluate(`document.getElementById("tab-outline").click()`);
  await sleep(500);
  const outline = await evaluate(`[...document.querySelectorAll(".outline-item")].map((node) => node.textContent)`);
  check(outline.includes("AsciiDoc Tour"), "the outline lists the document title", JSON.stringify(outline.slice(0, 4)));
  check(outline.includes("Lists") && outline.includes("Mathematics"), "the outline lists sections", JSON.stringify(outline.slice(0, 6)));
  check(!outline.includes("Not a heading"), "a heading inside a literal block is skipped", JSON.stringify(outline));
}

console.log("\n=== spelling ===");
{
  await sleep(900);
  const marks = await evaluate(`[...document.querySelectorAll(".cm-spell-error")].map((node) => node.textContent)`);
  check(
    !marks.some((word) => /latexmath|stem|asciidoc|include|image::/i.test(word)),
    "spellcheck leaves AsciiDoc markup alone",
    JSON.stringify(marks.slice(0, 12)),
  );
}

console.log("\n=== preview copy ===");
{
  const copied = await evaluate(`(() => {
    const paragraph = [...document.querySelectorAll("#preview .paragraph p")][0];
    if (!paragraph) return JSON.stringify({ prevented: false, text: "", html: "" });
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const data = new DataTransfer();
    const event = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true });
    paragraph.dispatchEvent(event);
    const result = {
      prevented: event.defaultPrevented,
      text: data.getData("text/plain"),
      html: data.getData("text/html"),
    };
    selection.removeAllRanges();
    return JSON.stringify(result);
  })()`);
  check(copied.prevented === true, "the preview copy is handled");
  check(
    copied.text.includes("*strong*") && copied.text.includes("latexmath"),
    "the preview copy writes AsciiDoc source",
    copied.text.slice(0, 90),
  );
  check(copied.html.includes("<strong>"), "the preview copy keeps the selection HTML");
}

console.log("\n=== scroll sync ===");
{
  const before = await evaluate(`(() => {
    const scroller = document.querySelector(".cm-scroller");
    if (scroller) scroller.scrollTop = 0;
    return 1;
  })()`);
  await sleep(600);
  const start = await evaluate(`document.querySelector(".preview-pane").scrollTop`);
  await evaluate(`(() => {
    const scroller = document.querySelector(".cm-scroller");
    if (scroller) scroller.scrollTop = 900;
    return 1;
  })()`);
  await sleep(800);
  const end = await evaluate(`document.querySelector(".preview-pane").scrollTop`);
  check(before === 1 && end !== start, "scrolling the source moves the preview", `${start} -> ${end}`);
}

console.log("\n=== default extension and a new document ===");
{
  await evaluate(`document.getElementById("btn-prefs").click()`);
  await sleep(300);
  const options = await evaluate(`(() => {
    const row = [...document.querySelectorAll(".prefs-row")].find((node) =>
      (node.querySelector(".prefs-label")?.textContent ?? "").replace("?", "").trim() === "Default File Extension");
    return JSON.stringify(row ? [...row.querySelectorAll("option")].map((option) => option.value) : []);
  })()`);
  check(options.includes("adoc") && options.includes("asciidoc"), "the default extension offers AsciiDoc", JSON.stringify(options));

  await evaluate(`(() => {
    const row = [...document.querySelectorAll(".prefs-row")].find((node) =>
      (node.querySelector(".prefs-label")?.textContent ?? "").replace("?", "").trim() === "Default File Extension");
    const select = row?.querySelector("select");
    if (!select) return 0;
    select.value = "adoc";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return 1;
  })()`);
  await sleep(400);
  await evaluate(`document.querySelector(".prefs-overlay").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(300);

  await press({ code: "KeyN", key: "n", ctrl: true });
  await type("= New AsciiDoc\n\nA new document body.\n");
  const fresh = await evaluate(`(() => {
    const root = document.querySelector("#preview");
    return JSON.stringify({ title: root.querySelector("h1")?.textContent ?? "", body: root.textContent ?? "" });
  })()`);
  check(fresh.title === "New AsciiDoc", "a new document starts in AsciiDoc mode", fresh.title);

  await openTab("asciidoc-tour.adoc");
}

console.log("\n=== rich paste into AsciiDoc ===");
{
  const blocked = await evaluate(`(() => {
    const data = new DataTransfer();
    data.setData("text/html", "<p>Pasted <strong>strong</strong> text.</p>");
    data.setData("text/plain", "Pasted strong text.");
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector(".cm-content").dispatchEvent(event);
    return String(event.defaultPrevented);
  })()`);
  await sleep(900);
  const lines = await evaluate(`[...document.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\\n")`);
  check(blocked === true, "the HTML paste is consumed");
  check(lines.includes("*strong*"), "HTML becomes AsciiDoc emphasis", lines.split("\n").slice(-3).join(" / "));
  await press({ code: "KeyZ", key: "z", ctrl: true });
}

console.log("\n=== image paste ===");
{
  const inserted = await evaluate(`(async () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=";
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const file = new File([bytes], "pixel.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector(".cm-content").dispatchEvent(event);
    return String(event.defaultPrevented);
  })()`);
  await sleep(1600);
  const lines = await evaluate(`[...document.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\\n")`);
  check(inserted === true, "the bitmap paste is consumed");
  check(lines.includes("image::"), "a bitmap inserts an AsciiDoc block image", lines.split("\n").filter((line) => line.includes("image::")).join(" / "));
  await sleep(600);
  const images = await evaluate(`[...document.querySelectorAll("#preview img")].map((image) => image.naturalWidth)`);
  check(images.some((width) => width > 0), "the pasted image loads in the preview", JSON.stringify(images));
}

console.log("\n=== include containment ===");
{
  await press({ code: "End", key: "End", ctrl: true });
  await type("\n\ninclude::../README.md[]\n");
  await sleep(1200);
  const preview = await evaluate(`document.querySelector("#preview").textContent`);
  check(!preview.includes("A small, fast editor"), "an include outside the document directory is not read");
  check(preview.includes("outside the document directory") || preview.includes("Unresolved directive"), "the refused include is explained");
  await press({ code: "KeyZ", key: "z", ctrl: true });
  await press({ code: "KeyZ", key: "z", ctrl: true });
}

console.log("\n=== the Files panel ===");
{
  await evaluate(`(() => {
    const sidebar = document.querySelector("#sidebar");
    if (sidebar && sidebar.getBoundingClientRect().width === 0) document.getElementById("btn-sidebar").click();
    document.getElementById("tab-files").click();
    return 1;
  })()`);
  await sleep(700);
  const listed = await evaluate(`[...document.querySelectorAll(".sidebar-body .entry")].some((entry) => (entry.title || "").endsWith("asciidoc-tour.adoc"))`);
  check(listed, "the Files panel offers the .adoc document");
}

try {
  fs.rmSync(ASSETS, { recursive: true, force: true });
} catch {
  /* the paste may have failed before creating it */
}

console.log(`\n${passed}/${total} checks passed`);
ws.close();
process.exit(passed === total ? 0 : 1);
