// Prove that math is really rendered, not merely emitted.
//
//   node scripts/math-render-check.mjs 9222
//
// Checks font loading, then the geometry that collapses when KaTeX's stylesheet
// is absent: fraction bars, radicals and large delimiters.
import { writeFileSync, readFileSync } from "node:fs";
import katex from "katex";

const baseline = JSON.parse(
  readFileSync(new URL("./fixtures/math-inventory.json", import.meta.url), "utf8"),
)["docs/samples/physrevb_70_035307.md"].entries;

const PORT = Number(process.argv[2] ?? 9222);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const exceptions = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === "Runtime.exceptionThrown") {
    exceptions.push(m.params.exceptionDetails.text);
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
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  }
  const v = r.result.result.value;
  return typeof v === "string" ? JSON.parse(v) : v;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");

const report = await evaluate(`(async () => {
  const faces = [...document.fonts]
    .filter((f) => f.family.startsWith('KaTeX'))
    .map((f) => ({ family: f.family, status: f.status }));
  const loaded = faces.filter((f) => f.status === 'loaded').map((f) => f.family).sort();
  const failed = faces.filter((f) => f.status === 'error').map((f) => f.family).sort();

  const families = ['KaTeX_Main','KaTeX_Math','KaTeX_AMS','KaTeX_Caligraphic',
                    'KaTeX_Fraktur','KaTeX_SansSerif','KaTeX_Script','KaTeX_Typewriter',
                    'KaTeX_Size1','KaTeX_Size2','KaTeX_Size3','KaTeX_Size4'];

  // A @font-face rule existing is not the same as its file being reachable.
  // Browsers fetch faces lazily, so force each one and then re-check: a 404 or a
  // bad URL rewrite shows up here as a face that never becomes available.
  const declared = new Set(faces.map((f) => f.family));
  const check = {};
  for (const family of families) {
    if (!declared.has(family)) { check[family] = 'not-declared'; continue; }
    try {
      await document.fonts.load('1em ' + family);
      check[family] = document.fonts.check('1em ' + family) ? 'loaded' : 'unavailable';
    } catch (error) {
      check[family] = 'fetch-failed';
    }
  }

  const display = [...document.querySelectorAll('#preview .katex-display')];
  const sqrtEls = [...document.querySelectorAll('#preview .katex .sqrt')];
  const fracEls = [...document.querySelectorAll('#preview .katex .mfrac')];
  const delimEls = [...document.querySelectorAll('#preview .katex .delimsizing')];

  // A radical draws its sign in a hidden-tail span. With no stylesheet that span
  // collapses, so its box is the honest test.
  const radicals = sqrtEls.map((s) => {
    const tail = s.querySelector('.hide-tail');
    const box = (tail ?? s).getBoundingClientRect();
    const radicand = s.querySelector('.vlist')?.getBoundingClientRect();
    return {
      tailWidth: +box.width.toFixed(1),
      tailHeight: +box.height.toFixed(1),
      radicandWidth: radicand ? +radicand.width.toFixed(1) : null
    };
  });

  // A fraction bar is a border on a zero-height span; width 0 means no CSS.
  const fractions = fracEls.map((f) => {
    const line = f.querySelector('.frac-line');
    return line ? +line.getBoundingClientRect().width.toFixed(1) : null;
  });

  const sample = document.querySelector('#preview .katex .mord, #preview .katex .mrel');
  return JSON.stringify({
    faceCount: faces.length,
    loadedCount: loaded.length,
    failed,
    loaded,
    check,
    katexElements: document.querySelectorAll('#preview .katex').length,
    displayBlocks: display.length,
    sqrtCount: sqrtEls.length,
    fracCount: fracEls.length,
    delimCount: delimEls.length,
    radicalsWithoutTail: radicals.filter((r) => r.tailWidth <= 0).length,
    smallestRadicalWidth: radicals.length ? Math.min(...radicals.map((r) => r.tailWidth)) : null,
    fractionsWithoutBar: fractions.filter((w) => !w || w <= 0).length,
    smallestFractionBar: fractions.length ? Math.min(...fractions.filter(Boolean)) : null,
    sampleFont: sample ? getComputedStyle(sample).fontFamily : null
    , inventory: [...document.querySelectorAll('#preview .math-inline, #preview .math-display')].map(node => ({ body: node.dataset.tex, display: node.classList.contains('math-display') }))
    , errors: document.querySelectorAll('#preview .katex-error, #preview .math-error').length
  });
})()`);

console.log("=== KaTeX font faces ===");
console.log(
  `  discovered ${report.faceCount}, loaded ${report.loadedCount}, failed ${report.failed.length}`,
);
console.log(`  families: ${report.loaded.join(", ")}`);
if (report.failed.length) console.log(`  FAILED: ${report.failed.join(", ")}`);

console.log("\n=== every face forced to load ===");
for (const [family, status] of Object.entries(report.check)) {
  console.log(`  ${status === "loaded" ? "ok  " : "BAD "}  ${family.padEnd(20)} ${status}`);
}

console.log("\n=== rendered geometry ===");
console.log(`  katex elements     ${report.katexElements}`);
console.log(`  display blocks     ${report.displayBlocks}`);
console.log(
  `  radicals           ${report.sqrtCount}  (without a tail box: ${report.radicalsWithoutTail})`,
);
console.log(`  smallest radical   ${report.smallestRadicalWidth} px wide`);
console.log(
  `  fractions          ${report.fracCount}  (without a bar: ${report.fractionsWithoutBar})`,
);
console.log(`  smallest frac bar  ${report.smallestFractionBar} px wide`);
console.log(`  large delimiters   ${report.delimCount}`);
console.log(`  sample font-family ${report.sampleFont}`);

const checks = [
  [
    "every baseline formula body and display kind renders in order",
    JSON.stringify(report.inventory) ===
      JSON.stringify(baseline.map(({ body, display }) => ({ body, display }))),
  ],
  [
    "KaTeX errors do not increase from the independent baseline",
    report.errors ===
      baseline.filter(({ body, display }) =>
        katex
          .renderToString(body, {
            displayMode: display,
            throwOnError: false,
            strict: false,
            output: "html",
          })
          .includes('class="katex-error"'),
      ).length,
  ],
  [
    "all 12 KaTeX families declared and fetchable",
    Object.values(report.check).every((s) => s === "loaded"),
  ],
  ["no font face failed to load", report.failed.length === 0],
  ["every declared face is accounted for", report.faceCount === 20],
  ["math elements rendered", report.katexElements > 100],
  ["display blocks present", report.displayBlocks >= 5],
  [
    "radicals rendered with a visible sign",
    report.sqrtCount > 0 && report.radicalsWithoutTail === 0,
  ],
  ["radical sign has real width", (report.smallestRadicalWidth ?? 0) > 4],
  ["fraction bars have real width", report.fracCount > 0 && report.fractionsWithoutBar === 0],
  ["large delimiters rendered", report.delimCount > 0],
  ["math uses a KaTeX font", (report.sampleFont ?? "").includes("KaTeX")],
];

console.log("\n=== assertions ===");
let failedChecks = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failedChecks++;
}
console.log(`\n${checks.length - failedChecks}/${checks.length} checks passed`);

// ---- capture the same equation in both themes -----------------------------
const setTheme = (mode) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const overlay = document.querySelector('.prefs-overlay');
  if (overlay.hidden) document.getElementById('btn-prefs').click();
  await sleep(160);
  [...document.querySelectorAll('.prefs-section')].find((s) => s.textContent === 'Appearance').click();
  await sleep(140);
  const row = [...document.querySelectorAll('.prefs-row')].find((r) =>
    (r.querySelector('.prefs-label')?.textContent ?? '').trim() === 'Theme');
  const select = row.querySelector('select');
  select.value = ${JSON.stringify(mode)};
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(500);
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(250);
  // Park the first display equation under the top of the preview pane.
  const pane = document.getElementById('preview-pane');
  const first = document.querySelector('#preview .katex-display');
  if (first && pane) pane.scrollTop += first.getBoundingClientRect().top - pane.getBoundingClientRect().top - 40;
  await sleep(400);
  return 1;
})()`;

const shoot = async (mode, file) => {
  await evaluate(setTheme(mode));
  await sleep(400);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  console.log(`wrote ${file}`);
};

await shoot("dark", "docs/screenshots/math-dark.png");
await shoot("light", "docs/screenshots/math-light.png");
await evaluate(setTheme("system"));

if (exceptions.length) {
  console.log("\n=== exceptions ===");
  for (const line of exceptions.slice(0, 5)) console.log("  " + line.split("\n")[0]);
}
ws.close();
process.exit(failedChecks === 0 ? 0 : 1);
