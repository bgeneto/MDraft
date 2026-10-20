// Verify that the source pane really is syntax highlighted, and that the
// palette setting changes it.
//
//   node scripts/_test-syntax.mjs 9222
const PORT = Number(process.argv[2] ?? 9222);
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
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 700));
  }
  const v = r.result.result.value;
  return typeof v === "string" ? JSON.parse(v) : v;
};

await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");

const probe = `(() => {
  const editor = document.querySelector('.cm-editor');
  const tokens = [];
  for (const span of document.querySelectorAll('.cm-line span')) {
    const style = getComputedStyle(span);
    const text = (span.textContent ?? '').trim();
    if (!text || text.length > 24) continue;
    tokens.push({
      text,
      color: style.color,
      weight: style.fontWeight,
      italic: style.fontStyle === 'italic'
    });
  }
  const distinct = [...new Set(tokens.map((t) => t.color))];
  return JSON.stringify({
    surface: getComputedStyle(editor).backgroundColor,
    sync: getComputedStyle(editor).getPropertyValue('--editor-sync').trim(),
    bodyColor: getComputedStyle(document.querySelector('.cm-content')).color,
    tokenCount: tokens.length,
    distinctColors: distinct.length,
    palette: distinct,
    samples: tokens.filter((t) => /^(#|##|\\*\\*|\\[|\\x60)/.test(t.text)).slice(0, 8),
    headings: tokens.filter((t) => t.weight === '700').map((t) => t.text).slice(0, 5),
    italics: tokens.filter((t) => t.italic).map((t) => t.text).slice(0, 4)
  });
})()`;

const switchPalette = (value) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const overlay = document.querySelector('.prefs-overlay');
  if (overlay.hidden) document.getElementById('btn-prefs').click();
  await sleep(150);
  const sections = [...document.querySelectorAll('.prefs-section')];
  sections.find((s) => s.textContent === 'Appearance').click();
  await sleep(120);
  const row = [...document.querySelectorAll('.prefs-row')].find((r) =>
    (r.querySelector('.prefs-label')?.textContent ?? '').startsWith('Editor Syntax Theme'));
  const select = row.querySelector('select');
  select.value = ${JSON.stringify(value)};
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(400);
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(250);
  return JSON.stringify({
    selected: [...document.querySelectorAll('.prefs-row')].length,
    value: ${JSON.stringify(value)}
  });
})()`;

// Source mode, so the editor occupies the whole workspace.
await evaluate(`(() => { document.getElementById('mode-source').click(); return 1; })()`);
await new Promise((r) => setTimeout(r, 700));

// Scroll back to the top first. CodeMirror only renders the visible lines, so
// this probe inspects whatever is on screen: leave the editor scrolled into a
// section without emphasis — as a previous script or a manual click can — and
// the "italics exist" check fails for a reason that has nothing to do with
// highlighting. Start from a known position instead.
await evaluate(`(() => {
  const scroller = document.querySelector('.cm-scroller');
  if (scroller) scroller.scrollTop = 0;
  return 1;
})()`);
await new Promise((r) => setTimeout(r, 700));

const auto = await evaluate(probe);
console.log("=== palette: auto (follows app theme) ===");
for (const [k, v] of Object.entries(auto)) {
  console.log(`  ${k.padEnd(15)} ${Array.isArray(v) ? JSON.stringify(v) : v}`);
}

const chosen = "nord";
await evaluate(switchPalette(chosen));
const nord = await evaluate(probe);
console.log(`\n=== palette: ${chosen} ===`);
for (const [k, v] of Object.entries(nord)) {
  console.log(`  ${k.padEnd(15)} ${Array.isArray(v) ? JSON.stringify(v) : v}`);
}

const dark = { nord };
for (const id of ["ink", "solarized-dark"]) {
  await evaluate(switchPalette(id));
  dark[id] = await evaluate(probe);
  console.log(`\n=== palette: ${id} ===`);
  console.log(`  ${"surface".padEnd(15)} ${dark[id].surface}`);
  console.log(`  ${"sync".padEnd(15)} ${dark[id].sync}`);
}

const rgb = (value) => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value ?? "");
  if (hex) {
    return [0, 2, 4].map((at) => parseInt(hex[1].slice(at, at + 2), 16));
  }
  const parts = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(value ?? "");
  return parts ? parts.slice(1, 4).map(Number) : null;
};

// The mark must stay amber (R > G > B) and stand off its own surface. This is
// the measurement the old translucent wash failed on Solarized Dark:
// rgb(61, 84, 60), green.
const syncVisible = (sample) => {
  const mark = rgb(sample.sync);
  const surface = rgb(sample.surface);
  return (
    mark !== null &&
    surface !== null &&
    mark[0] > mark[1] &&
    mark[1] > mark[2] &&
    mark[0] - surface[0] >= 70
  );
};

console.log("\n=== assertions ===");
const checks = [
  ["auto: several distinct token colours", auto.distinctColors >= 4],
  ["auto: bold headings exist", auto.headings.length >= 2],
  ["auto: italics exist (emphasis)", auto.italics.length >= 1],
  ["nord: several distinct token colours", nord.distinctColors >= 4],
  ["palette changes the surface", nord.surface !== auto.surface],
  ["palette changes token colours", JSON.stringify(nord.palette) !== JSON.stringify(auto.palette)],
  ["nord surface is #2e3440", nord.surface === "rgb(46, 52, 64)"],
  ["nord: the sync mark is amber and visible", syncVisible(dark.nord)],
  ["ink: the sync mark is amber and visible", syncVisible(dark.ink)],
  ["solarized-dark: the sync mark is amber and visible", syncVisible(dark["solarized-dark"])],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

// Leave the setting on auto and the app back in split view.
await evaluate(switchPalette("auto"));
await evaluate(`(() => { document.getElementById('mode-split').click(); return 1; })()`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
