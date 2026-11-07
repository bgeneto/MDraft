// Does an installed build carry the licences of the typefaces it bundles?
//
//   node scripts/licence-test.mjs [port]
//
// The thirteen families are under the SIL Open Font License 1.1, which requires the
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
// The route is Help › Font Licences. Preferences used to offer a duplicate
// button in a General section that had no setting in it; that section is gone,
// so this suite proves the Help route — the one a reader actually uses — works.
const clicked = await evaluate(`(() => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') return JSON.stringify({ error: 'no IPC bridge' });
  return invoke('plugin:event|emit', { event: 'menu', payload: 'help.licences' })
    .then(() => JSON.stringify({ clicked: true }))
    .catch((error) => JSON.stringify({ error: String(error) }));
})()`);
const state = JSON.parse(clicked);
check("Help offers the font licences", state.clicked === true, state.error ?? "");

if (state.clicked) {
  // The document opens in the editor; give the render a moment.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const found = await evaluate(`(() => {
    const text = document.body.innerText;
    return JSON.stringify({
      ofl: text.includes('SIL OPEN FONT LICENSE'),
      serif: text.includes('2014 - 2023 Adobe'),
      sans: text.includes('2010-2022 Adobe'),
      jetbrains: text.includes('JetBrains Mono Project Authors'),
      fira: text.includes('Fira Code Project Authors'),
      eb: text.includes('EB Garamond Project Authors'),
      ibm: text.includes('IBM Corp.'),
      playfair: text.includes('The Playfair Project Authors'),
      archivo: text.includes('Archivo Project Authors'),
      jost: text.includes('Jost Project Authors'),
      azeret: text.includes('Azeret Project Authors'),
      alegreya: text.includes('Alegreya Project Authors'),
      caveat: text.includes('Caveat Project Authors'),
      victor: text.includes('Rune Bjørnerås'),
      length: text.length,
    });
  })()`);
  const seen = JSON.parse(found);
  check("the licence text itself is present", seen.ofl, `document is ${seen.length} chars`);
  check(
    "each bundled family is attributed",
    seen.serif &&
      seen.sans &&
      seen.jetbrains &&
      seen.fira &&
      seen.eb &&
      seen.ibm &&
      seen.playfair &&
      seen.archivo &&
      seen.jost &&
      seen.azeret &&
      seen.alegreya &&
      seen.caveat &&
      seen.victor,
    Object.entries(seen)
      .filter(([key]) => key !== "length")
      .map(([key, value]) => `${key}=${value}`)
      .join(" "),
  );
}

console.log("\n=== Preferences no longer duplicates the route ===");
// The duplicate button lived in a General section that held no setting. Its
// removal is what makes the Help route the only one, so assert it is gone
// rather than leaving a reader to discover a dead reference.
const generalGone = await evaluate(`(() => {
  const overlay = document.querySelector('.prefs-overlay');
  if (!overlay || overlay.hidden) document.getElementById('btn-prefs').click();
  const names = [...document.querySelectorAll('.prefs-section')].map((s) => s.textContent.trim());
  document.querySelector('.prefs-close')?.click();
  return JSON.stringify({ names });
})()`);
const sections = JSON.parse(generalGone).names;
check("Preferences has no General section", !sections.includes("General"), sections.join(", "));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ""}`);
}
ws.close();
process.exit(failed.length === 0 ? 0 : 1);
