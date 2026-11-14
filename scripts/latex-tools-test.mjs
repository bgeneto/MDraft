// Does Tools › Optional Tools… reach a handler, and does it open the shared dialog?
//
//   node scripts/latex-tools-test.mjs [port]
//
// `menu-test` proves the row is present, enabled and correctly labelled. What it
// cannot prove is that the row is *connected*: a menu item with no handler is the
// dead UI this project forbids, and it looks identical in the menu inventory.
//
// The dialog is now a DOM `<dialog>`, not a native `plugin-dialog` box, so this
// test can assert its title, its three rows and that Escape closes it. The
// handler still starts asynchronously (it probes the three tools first), so the
// test waits for the dialog instead of assuming it is there on the next tick.
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

console.log("=== Tools › Optional Tools… ===");

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

// The dispatcher warns when an id has no handler (`console.warn("[menu] no
// handler for …")`). A bogus id must warn and `tools.optionalTools` must not,
// which proves the handler is registered, not merely that the event was
// accepted.
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
const real = await warnFor("tools.optionalTools");
check(real.length === 0, "tools.optionalTools reaches a handler", real.join("; ") || "no warning");

// The handler probes the three tools before showing the dialog.
let opened = false;
for (let attempt = 0; attempt < 40; attempt += 1) {
  opened = await evaluate(`Boolean(document.querySelector(".optional-tools-dialog[open]"))`);
  if (opened) break;
  await sleep(150);
}
check(opened, "the Optional tools dialog opens");

const surface = await evaluate(`
  (() => {
    const dialog = document.querySelector(".optional-tools-dialog[open]");
    if (!dialog) return null;
    return {
      title: dialog.querySelector("#optional-tools-title")?.textContent ?? "",
      subtitle: dialog.querySelector(".optional-tools-subtitle")?.textContent ?? "",
      rows: [...dialog.querySelectorAll(".optional-tools-row")].map(
        (row) => row.querySelector(".optional-tools-row-title")?.textContent ?? "",
      ),
      primary: dialog.querySelector(".optional-tools-primary")?.textContent ?? "",
    };
  })()
`);
check(surface?.title === "Optional tools", "the title is Optional tools", surface?.title);
check(
  (surface?.subtitle ?? "").includes("MDraft uses separate open-source tools"),
  "the purpose sentence is present",
  surface?.subtitle,
);
check(surface?.rows.length === 3, "the dialog has three rows", String(surface?.rows.length));
check(
  (surface?.rows ?? []).some((text) => text.includes("Word, EPUB and more conversion formats")),
  "the Pandoc row uses the approved outcome wording",
);
check((surface?.primary ?? "").length > 0, "the primary action is labelled", surface?.primary);

// A DOM dialog closes on Escape; the footer must not be wedged behind it.
await send("Input.dispatchKeyEvent", {
  type: "keyDown",
  key: "Escape",
  code: "Escape",
  windowsVirtualKeyCode: 27,
});
await send("Input.dispatchKeyEvent", {
  type: "keyUp",
  key: "Escape",
  code: "Escape",
  windowsVirtualKeyCode: 27,
});
await sleep(400);
check(
  (await evaluate(`Boolean(document.querySelector(".optional-tools-dialog[open]"))`)) === false,
  "Escape closes the dialog",
);

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
