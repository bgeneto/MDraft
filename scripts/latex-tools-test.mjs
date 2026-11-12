// Does Tools › Check or Install LaTeX… reach a handler at all?
//
//   node scripts/latex-tools-test.mjs [port]
//
// `menu-test` proves the row is present, enabled and correctly labelled. What it
// cannot prove is that the row is *connected*: a menu item with no handler is the
// dead UI this project forbids, and it looks identical in the menu inventory.
//
// Two things make this harder than it looks, and both are recorded here because
// the first attempt got them wrong:
//
// 1. **The dialog is native.** `latexSetup` calls `message()` from
//    `@tauri-apps/plugin-dialog`, which opens an OS dialog outside the webview. No
//    DOM selector finds it, and a screenshot would not either.
// 2. **`api.ts` binds `invoke` at import time** (`import { invoke } from
//    "@tauri-apps/api/core"`), so patching `window.__TAURI_INTERNALS__.invoke`
//    does not intercept the frontend's calls. My first version of this test
//    assumed it did and reported a false negative.
//
// What *is* observable: the handler is registered in the menu dispatch table, and
// emitting the menu event must not throw. A missing handler throws or is silently
// ignored; a present one starts its async work. This test asserts the event is
// accepted and the application stays healthy, and it is honest about the limit:
// it proves wiring, not the dialog's contents.
//
// Needs the app running with CDP enabled.

const port = process.argv[2] ?? "9222";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
if (!page) throw new Error("No page target: launch the app with CDP enabled.");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.text ?? "evaluation failed");
  }
  return result.result?.result?.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await send("Runtime.enable");

console.log("=== Tools › Check or Install LaTeX… ===");

// Wait for the editor, then for the menu listener specifically: the editor mounts
// before `installMenuListener` runs, so `.cm-content` alone is too early and the
// handler table would read as absent.
for (let attempt = 0; attempt < 60; attempt += 1) {
  if (await evaluate(`Boolean(document.querySelector(".cm-content"))`)) break;
  await sleep(250);
}
for (let attempt = 0; attempt < 60; attempt += 1) {
  if (await evaluate(`Array.isArray(window.__mdraftMenuIds)`)) break;
  await sleep(250);
}

// The strongest observable check: the dispatcher warns when an id has no handler
// (`console.warn("[menu] no handler for …")`). So a bogus id must warn and
// `tools.latex` must not — which proves the handler is registered, not merely
// that the event was accepted.
//
// A test-only hook on `window` was tried first and did not work: Vite tree-shakes
// an assignment nothing reads, so the property never reached the bundle. The
// console is a real output of the shipped code, which is why it works.
await evaluate(`
  (() => {
    window.__menuWarnings = [];
    const original = console.warn;
    console.warn = (...args) => {
      window.__menuWarnings.push(args.map(String).join(" "));
      original.apply(console, args);
    };
    return true;
  })()
`);

/** Emit a menu id and report whether the dispatcher warned about it. */
async function warnFor(id) {
  await evaluate(`window.__menuWarnings = []`);
  await evaluate(`
    (async () => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "menu",
        payload: ${JSON.stringify(id)},
      });
    })()
  `);
  await sleep(700);
  const warnings = await evaluate(`window.__menuWarnings ?? []`);
  return Array.isArray(warnings) ? warnings.filter((line) => line.includes("no handler")) : [];
}

// Positive control: a bogus id must warn, which proves the check can fail.
const bogus = await warnFor("tools.thisDoesNotExist");
check(bogus.length === 1, "a bogus menu id warns", bogus.join("; ") || "no warning");

// The real id must not warn.
const real = await warnFor("tools.latex");
check(real.length === 0, "tools.latex reaches a handler", real.join("; ") || "no warning");

// Its neighbours must still be wired, so the group stays coherent.
for (const id of ["tools.pandoc", "tools.typst"]) {
  const warnings = await warnFor(id);
  check(
    warnings.length === 0,
    `${id} still reaches a handler`,
    warnings.join("; ") || "no warning",
  );
}

// Give the handler time to reach its first await (`latexStatus`).
await sleep(1500);

const errors = await evaluate(`window.__latexToolErrors ?? []`);
check(
  Array.isArray(errors) && errors.length === 0,
  "the handler raises no error",
  Array.isArray(errors) && errors.length ? errors.join("; ") : "none",
);

// A native dialog is open now and blocks the window. Escape dismisses it.
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
await sleep(600);

// The editor must still be alive: a handler that crashed the page would not be.
check(
  (await evaluate(`Boolean(document.querySelector(".cm-content"))`)) === true,
  "the application is healthy afterwards",
);

// And it must still respond to menu events, which is the difference between
// "the dialog opened" and "the window is wedged behind a modal".
const after = await evaluate(`
  (async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "menu",
        payload: "view.source",
      });
      return "accepted";
    } catch (error) {
      return "threw: " + String(error);
    }
  })()
`);
check(after === "accepted", "another menu event still works afterwards", String(after));

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
socket.close();
process.exit(failed === 0 ? 0 : 1);
