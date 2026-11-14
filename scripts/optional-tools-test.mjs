// First-run Optional tools offer, with no startup document.
//
//   node scripts/optional-tools-test.mjs [port]
//
// The harness launches this layer with `noDocument`, so a fresh profile shows the
// Welcome document and the one-time offer. If every optional tool is already
// present on the host, the correct outcome is *no* dialog; the test then opens
// Tools › Optional Tools to prove the surface exists and that the absence was not
// a broken handler. The second-launch suppression is covered by the manual
// matrix; this layer owns the first launch and the approved copy.

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

console.log("=== Optional tools first run ===");

for (let attempt = 0; attempt < 80; attempt += 1) {
  if (await evaluate(`Boolean(document.querySelector(".cm-content"))`)) break;
  await sleep(250);
}
for (let attempt = 0; attempt < 60; attempt += 1) {
  if (await evaluate(`Array.isArray(window.__mdraftMenuIds)`)) break;
  await sleep(250);
}

// The dialog probes the three tools before it opens; the Welcome document is up
// first, so wait for the offer rather than assuming the paint is the proof.
let opened = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  opened = await evaluate(`Boolean(document.querySelector(".optional-tools-dialog[open]"))`);
  if (opened) break;
  await sleep(200);
}

const dialog = opened
  ? await evaluate(`
      (() => {
        const dialog = document.querySelector(".optional-tools-dialog[open]");
        const rows = [...dialog.querySelectorAll(".optional-tools-row")];
        return {
          title: dialog.querySelector("#optional-tools-title")?.textContent ?? "",
          subtitle: dialog.querySelector(".optional-tools-subtitle")?.textContent ?? "",
          rowTitles: rows.map(
            (row) => row.querySelector(".optional-tools-row-title")?.textContent ?? "",
          ),
          pandoc: (() => {
            const row = dialog.querySelector('.optional-tools-row[data-tool="pandoc"]');
            if (!row) return null;
            const input = row.querySelector("input");
            return {
              checked: input ? input.checked : null,
              ready: row.classList.contains("is-ready"),
              title: row.querySelector(".optional-tools-row-title")?.textContent ?? "",
            };
          })(),
          primary: dialog.querySelector(".optional-tools-primary")?.textContent ?? "",
          secondary: dialog.querySelector(".optional-tools-secondary")?.textContent ?? "",
        };
      })()
    `)
  : null;

if (opened) {
  check(dialog?.title === "Optional tools", "the first-run dialog opens");
  check(
    (dialog?.subtitle ?? "").includes("MDraft uses separate open-source tools"),
    "the purpose sentence is present",
    dialog?.subtitle,
  );
  check(
    (dialog?.rowTitles ?? []).length === 3,
    "the first-run dialog has three rows",
    String(dialog?.rowTitles.length),
  );
  check(
    (dialog?.rowTitles ?? []).some((text) =>
      text.includes("Word, EPUB and more conversion formats"),
    ),
    "the Pandoc row uses the approved outcome wording",
  );
  const pandocSelectable = dialog?.pandoc != null && dialog.pandoc.checked !== null;
  check(
    dialog?.pandoc?.ready === true || dialog?.pandoc?.checked === true,
    "Pandoc is either ready or selected for the first download",
    JSON.stringify(dialog?.pandoc),
  );
  check(
    pandocSelectable
      ? (dialog?.primary ?? "").startsWith("Download")
      : (dialog?.primary ?? "") === "Done",
    pandocSelectable
      ? "the primary offers the Pandoc download"
      : "with Pandoc already ready, the optional rows start unselected",
    dialog?.primary,
  );
  check(
    (dialog?.secondary ?? "") === "Not now",
    "the dismiss action is Not now",
    dialog?.secondary,
  );

  // Not now must leave no download behind and close the dialog.
  await evaluate(
    `document.querySelector(".optional-tools-dialog[open] .optional-tools-secondary")?.click()`,
  );
  await sleep(400);
  check(
    (await evaluate(`Boolean(document.querySelector(".optional-tools-dialog[open]"))`)) === false,
    "Not now closes the dialog",
  );
  const indicator = await evaluate(
    `Boolean(document.querySelector("#status-download:not([hidden])"))`,
  );
  check(indicator === false, "no download starts from Not now");
} else {
  // The only correct reason for no offer is that every tool is already present.
  // Open the manage view to tell that apart from a handler that never ran.
  await evaluate(`
    (async () => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "menu",
        payload: "tools.optionalTools",
      });
    })()
  `);
  let manage = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    manage = await evaluate(`Boolean(document.querySelector(".optional-tools-dialog[open]"))`);
    if (manage) break;
    await sleep(150);
  }
  check(manage, "Tools › Optional Tools still opens the dialog");
  const rows = manage
    ? await evaluate(`
        [...document.querySelectorAll(".optional-tools-dialog[open] .optional-tools-row")].map(
          (row) => ({
            tool: row.dataset.tool ?? "",
            title: row.querySelector(".optional-tools-row-title")?.textContent ?? "",
            ready: row.classList.contains("is-ready"),
            off: row.classList.contains("is-off"),
          }),
        )
      `)
    : [];
  const missing = rows.filter((row) => !row.ready && !row.off);
  check(
    missing.length === 0,
    "no first-run offer, and no tool is actually missing",
    missing.map((row) => row.title).join("; ") || "all ready",
  );
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
}

check(
  (await evaluate(`Boolean(document.querySelector(".cm-content"))`)) === true,
  "the editor is usable afterwards",
);

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
socket.close();
process.exit(failed === 0 ? 0 : 1);
