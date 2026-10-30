// Real typing and geometry regression for Typewriter Mode and reset zoom.
// Run via test-all for owned settings/profile; optional MDRAFT_TYPEWRITER_VISUAL_DIR
// holds the owned window for physical-input review until done.json appears.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
ws.addEventListener("close", () => {
  for (const resolve of pending.values()) resolve({ error: { message: "The test window closed" } });
  pending.clear();
});
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-typewriter-"));
const fixture = path.join(work, "typewriter-check.md");
const original = Array.from(
  { length: 180 },
  (_, i) =>
    "Line " +
    String(i + 1).padStart(3, "0") +
    " — Writing a document with enough source lines for scrolling.",
).join("\n");
fs.writeFileSync(fixture, original);
const visualDir = process.env.MDRAFT_TYPEWRITER_VISUAL_DIR;
const evidence = visualDir
  ? path.resolve(visualDir)
  : path.join(os.tmpdir(), "typewriter-evidence");
fs.mkdirSync(evidence, { recursive: true });
async function key(key, code, virtual, modifiers = 0) {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: virtual,
    modifiers,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: virtual,
    modifiers: 0,
  });
}
const home = () => key("Home", "Home", 36, 2),
  end = () => key("End", "End", 35, 2);
async function focus() {
  await evaluate("document.querySelector('.cm-content').focus()");
}
async function geometry() {
  return evaluate(
    `(()=>{const s=document.querySelector('.cm-scroller'),c=document.querySelector('.cm-cursor-primary');if(!c)return null;const a=s.getBoundingClientRect(),b=c.getBoundingClientRect();return {fraction:((b.top+b.bottom)/2-a.top)/a.height,top:s.scrollTop,height:a.height,padding:document.querySelector('.cm-content').style.paddingTop}})()`,
  );
}
async function centered(label) {
  let g = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(150);
    g = await geometry();
    if (g && Math.abs(g.fraction - 0.5) < 0.12) break;
  }
  check(g && Math.abs(g.fraction - 0.5) < 0.12, label, JSON.stringify(g));
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(evidence, name + ".png"), Buffer.from(r.result.data, "base64"));
}
try {
  await invoke("plugin:event|emit", { event: "open-files", payload: [fixture] });
  await wait("document.title.includes('typewriter-check.md')");
  if (!(await evaluate("document.getElementById('app').classList.contains('mode-source')")))
    await action("view.source");
  await focus();
  await home();
  await sleep(300);
  if (await evaluate("document.querySelector('.cm-content').style.paddingTop!==''"))
    await key("F9", "F9", 120);
  const before = await geometry();
  check(before && before.fraction < 0.3, "disabled Typewriter leaves the first line at the top");
  await key("F9", "F9", 120);
  await centered("F9 centers the first source line");
  await send("Input.insertText", { text: "Starting to write. ".repeat(18) });
  await centered("typing a wrapped first line keeps the caret centered");
  await shot("typewriter-start");
  await key("z", "KeyZ", 90, 2);
  await home();
  for (let n = 0; n < 80; n++) await key("ArrowDown", "ArrowDown", 40);
  await send("Input.insertText", { text: "Middle typing\nNew paragraph while writing\n" });
  await centered("typing and Enter in the middle keep the caret centered");
  await shot("typewriter-middle");
  await end();
  await send("Input.insertText", { text: "\nWriting at the end. ".repeat(5) });
  await centered("typing at the end has sufficient scroll space");
  await shot("typewriter-end");
  await evaluate("document.querySelector('.cm-scroller').scrollTop-=220");
  await sleep(400);
  const scrolled = await geometry();
  await sleep(400);
  const settled = await geometry();
  check(
    scrolled && settled && Math.abs(scrolled.top - settled.top) < 3,
    "manual scroll stays where the reader left it",
  );
  await send("Input.insertText", { text: " Next keystroke." });
  await centered("the next keystroke recenters after manual scrolling");
  await key("F8", "F8", 119);
  await send("Input.insertText", { text: " Focus-mode typing." });
  await centered("Typewriter works together with Focus mode");
  await shot("typewriter-focus");
  await key("F8", "F8", 119);
  await send("Input.imeSetComposition", { text: "ação", selectionStart: 4, selectionEnd: 4 });
  await sleep(150);
  await send("Input.insertText", { text: "ação" });
  await centered("IME commit keeps a stable primary caret");

  await key("ArrowUp", "ArrowUp", 38, 3);
  await sleep(150);
  check(
    await evaluate("document.querySelectorAll('.cm-cursor-secondary').length>0"),
    "multiple cursors remain available with Typewriter",
  );
  await send("Input.insertText", { text: "Multi" });
  await centered("multi-cursor typing centers the primary caret");
  await key("Escape", "Escape", 27);
  await key("z", "KeyZ", 90, 2);
  await centered("undo keeps the primary caret centered");
  await key("y", "KeyY", 89, 2);
  await centered("redo keeps the primary caret centered");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await send("Input.insertText", { text: " Reduced motion." });
  await centered("reduced motion reaches the same centered position");
  await send("Emulation.setEmulatedMedia", { features: [] });
  await action("file.new");
  await focus();
  await send("Input.insertText", { text: "Fresh tab text" });
  await centered("a new tab uses its own caret and document");
  check(
    await evaluate("document.querySelector('.cm-content').innerText.includes('Fresh tab text')"),
    "tab replacement does not reuse an old document offset",
  );
  await action("file.close");
  await wait("!!document.querySelector('.unsaved-dialog[open]')");
  await evaluate("document.querySelector('.unsaved-dialog [data-decision=discard]').click()");
  await sleep(350);
  await focus();
  await send("Input.insertText", { text: " Back in original tab." });
  await centered("returning to the original tab keeps Typewriter functional");

  await key("F9", "F9", 120);
  await sleep(200);
  check(
    await evaluate("document.querySelector('.cm-content').style.paddingTop===''"),
    "disabling restores the ordinary content padding",
  );
  await home();
  await send("Input.insertText", { text: "Ordinary writing." });
  await sleep(300);
  const off = await geometry();
  check(off && off.fraction < 0.3, "disabled Typewriter no longer forces the caret to the centre");
  await action("view.zoomIn");
  await action("view.zoomIn");
  const width = await evaluate(
    "window.getComputedStyle(document.querySelector('.cm-editor')).maxWidth",
  );
  await key("0", "Digit0", 48, 3);
  await sleep(350);
  check(
    await evaluate("document.getElementById('status-zoom').hidden"),
    "Ctrl+Alt+0 resets zoom through the shortcut",
  );
  check(
    (await evaluate("window.getComputedStyle(document.querySelector('.cm-editor')).maxWidth")) ===
      width,
    "reset preserves Content Width",
  );
  if (visualDir) {
    await key("F9", "F9", 120);
    await home();
    await centered("visual review starts with Typewriter active");
    fs.writeFileSync(
      path.join(evidence, "ready.json"),
      JSON.stringify({ port, fixture, evidence }),
    );
    console.log("Visual review ready: " + path.join(evidence, "ready.json"));
    const deadline = Date.now() + 15 * 60 * 1000;
    while (!fs.existsSync(path.join(evidence, "done.json"))) {
      if (Date.now() > deadline) throw Error("Visual review was not completed");
      await sleep(300);
    }
  }
} catch (error) {
  console.error(error.stack ?? error);
  check(false, "Typewriter suite completed", String(error));
} finally {
  try {
    await invoke("plugin:event|emit", { event: "menu", payload: "file.closeAll" });
    for (let n = 0; n < 10; n++) {
      await evaluate("document.querySelector('.unsaved-dialog [data-decision=discard]')?.click()");
      await sleep(120);
    }
  } catch {}
  fs.rmSync(work, { recursive: true, force: true });
  const passed = checks.filter(Boolean).length;
  console.log("\n" + passed + "/" + checks.length + " checks passed");
  console.log("Screenshots: " + evidence);
  ws.close();
  process.exit(passed === checks.length ? 0 : 1);
}
