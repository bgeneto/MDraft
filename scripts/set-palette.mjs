// Set the editor syntax palette through the Preferences UI.
//
//   node scripts/set-palette.mjs 9222 one-dark
//   node scripts/set-palette.mjs 9222 auto --split
const PORT = Number(process.argv[2] ?? 9222);
const PALETTE = process.argv[3] ?? "auto";
const ALSO_SPLIT = process.argv.includes("--split");

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};

await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");

const expression = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const overlay = document.querySelector('.prefs-overlay');
  if (overlay.hidden) document.getElementById('btn-prefs').click();
  await sleep(160);
  [...document.querySelectorAll('.prefs-section')]
    .find((s) => s.textContent === 'Appearance').click();
  await sleep(140);
  const row = [...document.querySelectorAll('.prefs-row')].find((r) =>
    (r.querySelector('.prefs-label')?.textContent ?? '').startsWith('Editor Syntax Theme'));
  const select = row.querySelector('select');
  select.value = ${JSON.stringify(PALETTE)};
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(400);
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(200);
  ${ALSO_SPLIT ? "document.getElementById('mode-split').click(); await sleep(300);" : ""}
  const surface = getComputedStyle(document.querySelector('.cm-editor')).backgroundColor;
  return JSON.stringify({ palette: ${JSON.stringify(PALETTE)}, surface });
})()`;

const result = await send("Runtime.evaluate", {
  expression,
  returnByValue: true,
  awaitPromise: true,
});
if (result.result?.exceptionDetails) {
  console.error(JSON.stringify(result.result.exceptionDetails).slice(0, 500));
  process.exit(1);
}
console.log(result.result.result.value);
ws.close();
process.exit(0);
