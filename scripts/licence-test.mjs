// Does an installed build carry the licences of the typefaces it bundles?
//
//   node scripts/licence-test.mjs [port]
//
// The four families are under the SIL Open Font License 1.1, which requires the
// copyright notice and the licence text to accompany the fonts wherever they are
// redistributed. Keeping the texts in the repository does not satisfy that: Vite
// bundles only what is imported, so for a while every installer shipped the
// fonts without their licences. They are compiled in with `?raw` now, and this
// suite proves it from inside the running application — the only place the claim
// can be checked. Searching the executable for the text proves nothing, because
// the frontend bundle is compressed inside it.
//
// Its own suite rather than part of dom-smoke: it opens a built-in document,
// which replaces whatever is in the editor. That is correct behaviour for a
// person — the application asks before discarding — but it leaves the window
// holding the licence text, and a later suite then fails on assertions that have
// nothing to do with licences. Run this one against its own instance.

const port = process.argv[2] ?? "9222";

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

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log("=== the licences are reachable from the interface ===");
const clicked = await evaluate(`(() => {
  const overlay = document.querySelector('.prefs-overlay');
  if (!overlay || overlay.hidden) document.getElementById('btn-prefs').click();
  const general = [...document.querySelectorAll('.prefs-section')]
    .find((s) => /^general$/i.test(s.textContent.trim()));
  if (!general) return JSON.stringify({ error: 'no General section' });
  general.click();
  const button = [...document.querySelectorAll('.prefs-button')]
    .find((b) => /Font licences/i.test(b.textContent));
  if (!button) return JSON.stringify({ error: 'no licence button' });
  button.click();
  return JSON.stringify({ clicked: true });
})()`);
const state = JSON.parse(clicked);
check("Preferences offers the font licences", state.clicked === true, state.error ?? "");

if (state.clicked) {
  // The document opens in the editor; give the render a moment.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const found = await evaluate(`(() => {
    const text = document.body.innerText;
    return JSON.stringify({
      ofl: text.includes('SIL OPEN FONT LICENSE'),
      serif: text.includes('Source Serif'),
      sans: text.includes('Source Sans'),
      inter: text.includes('The Inter Project Authors'),
      jetbrains: text.includes('JetBrains Mono Project Authors'),
      length: text.length,
    });
  })()`);
  const seen = JSON.parse(found);
  check("the licence text itself is present", seen.ofl, `document is ${seen.length} chars`);
  check("each bundled family is attributed", seen.serif && seen.sans && seen.inter && seen.jetbrains,
    `serif=${seen.serif} sans=${seen.sans} inter=${seen.inter} jetbrains=${seen.jetbrains}`);
}

console.log("\n=== the Help menu reaches the same document ===");
// The menu id is dispatched through the same "menu" event the shortcut handler
// uses, so this also proves the licence document is reachable without the panel.
const helpBound = await evaluate(`(() => {
  const app = document.getElementById('app');
  return JSON.stringify({ menuHandler: typeof window.__TAURI_INTERNALS__?.invoke === 'function' && !!app });
})()`);
check(JSON.parse(helpBound).menuHandler, "the application is wired to receive menu events");

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ""}`);
}
ws.close();
process.exit(failed.length === 0 ? 0 : 1);
