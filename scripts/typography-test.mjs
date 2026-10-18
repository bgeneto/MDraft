// Does each typography setting actually change what is drawn?
//
//   node scripts/typography-test.mjs [port]
//
// Width is the obvious measurement and the wrong one for half of this feature.
// A monospaced face gives every glyph the same advance by definition, and a
// programming ligature draws one glyph across two cells — so `->` measures the
// same whether or not it is an arrow. Canvas is no better: `ctx.font` accepts
// only style/variant/weight/size/family, so `font-variant-numeric` and
// `font-variant-ligatures` are dropped without complaint.
//
// So the test renders each sample twice, once with the feature off and once on,
// screenshots both through CDP, and compares the pixels. A feature that changes
// nothing on screen fails, which is the only claim worth making.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const port = process.argv[2] ?? "9222";
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target; is the application running with --remote-debugging-port?");

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
await send("Page.enable");

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

/** Screenshot a clip of the page and return a digest of the pixels. */
async function digestClip(clip) {
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { ...clip, scale: 1 },
    captureBeyondViewport: true,
  });
  const data = shot.result?.data;
  if (!data) throw new Error("screenshot failed");
  return createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
}

// A harness that renders labelled samples outside the document flow, so the
// document being edited is not disturbed while it is measured.
await evaluate(`
  (() => {
    document.getElementById("typo-harness")?.remove();
    const host = document.createElement("div");
    host.id = "typo-harness";
    host.style.cssText = [
      "position:fixed", "left:0", "top:0", "z-index:2147483647",
      "background:#ffffff", "color:#111111", "padding:12px",
      "font-size:36px", "line-height:1.5", "white-space:pre",
    ].join(";");
    document.body.appendChild(host);
    return true;
  })()
`);

/** Render one sample with a given style, and digest the result. */
async function shot(style, text) {
  const box = await evaluate(`
    (() => {
      const host = document.getElementById("typo-harness");
      host.textContent = ${JSON.stringify(text)};
      host.style.fontFamily = ${JSON.stringify(style.family)};
      host.style.fontWeight = ${JSON.stringify(String(style.weight ?? 400))};
      host.style.fontVariantLigatures = ${JSON.stringify(style.ligatures ?? "normal")};
      host.style.fontVariantNumeric = ${JSON.stringify(style.numeric ?? "normal")};
      host.style.fontKerning = ${JSON.stringify(style.kerning ?? "normal")};
      host.style.fontSize = "${style.size ?? 36}px";
      const r = host.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()
  `);
  // A hair of padding, so antialiasing at the very edge is inside the clip.
  return digestClip({ x: box.x, y: box.y, width: box.width, height: box.height });
}

console.log("=== bundled faces are available ===");
const loaded = await evaluate(`
  (async () => {
    await document.fonts.ready;
    const names = [
      "Source Serif 4", "Source Sans 3", "JetBrains Mono", "Fira Code",
      "EB Garamond", "IBM Plex Mono", "Bodoni Moda", "Archivo", "Jost",
      "Azeret Mono", "Alegreya", "Caveat", "Victor Mono",
    ];
    const found = [];
    for (const name of names) {
      try { await document.fonts.load('36px "' + name + '"', "Ag0123"); } catch {}
      const faces = [...document.fonts].filter((f) => f.family.replace(/^"|"$/g, "") === name);
      const ready = faces.filter((f) => f.status === "loaded").length;
      found.push({ name, declared: faces.length, loaded: ready });
    }
    return found;
  })()
`);
for (const face of loaded) {
  check(face.declared > 0, `${face.name} is declared to the document`, `${face.declared} face(s), ${face.loaded} loaded`);
}

console.log("\n=== a feature must change pixels, not just computed style ===");

const mono = '"JetBrains Mono", monospace';
const serif = '"Source Serif 4", serif';

const ligOff = await shot({ family: mono, ligatures: "none" }, "-> => != === ---");
const ligOn = await shot({ family: mono, ligatures: "contextual common-ligatures" }, "-> => != === ---");
check(ligOff !== ligOn, "code ligatures change the drawing", ligOff === ligOn ? "identical pixels — the feature does nothing" : "differs");

const zeroOff = await shot({ family: mono, numeric: "normal" }, "0O0O0O0O");
const zeroOn = await shot({ family: mono, numeric: "slashed-zero" }, "0O0O0O0O");
check(zeroOff !== zeroOn, "slashed zero changes the drawing", zeroOff === zeroOn ? "identical pixels — the feature does nothing" : "differs");

const lin = await shot({ family: serif, numeric: "lining-nums" }, "0123456789");
const old = await shot({ family: serif, numeric: "oldstyle-nums" }, "0123456789");
check(lin !== old, "oldstyle figures change the drawing", lin === old ? "identical pixels — the face may have no onum feature" : "differs");

const prop = await shot({ family: serif, numeric: "proportional-nums" }, "1111111111");
const tab = await shot({ family: serif, numeric: "tabular-nums" }, "1111111111");
check(prop !== tab, "tabular figures change the drawing", prop === tab ? "identical pixels" : "differs");

const kernOff = await shot({ family: serif, kerning: "none" }, "AVATAR To Wa");
const kernOn = await shot({ family: serif, kerning: "normal" }, "AVATAR To Wa");
check(kernOff !== kernOn, "kerning changes the drawing", kernOff === kernOn ? "identical pixels" : "differs");

console.log("\n=== the new faces keep the switches real ===");

const ebgNormal = await shot({ family: '"EB Garamond", serif' }, "0123456789");
const ebgOld = await shot({ family: '"EB Garamond", serif', numeric: "oldstyle-nums" }, "0123456789");
check(
  ebgNormal !== ebgOld,
  "EB Garamond oldstyle figures change the drawing",
  ebgNormal === ebgOld ? "identical pixels — the subset lost onum" : "differs",
);

const bodoniNormal = await shot({ family: '"Bodoni Moda", serif' }, "1111111111");
const bodoniTab = await shot({ family: '"Bodoni Moda", serif', numeric: "tabular-nums" }, "1111111111");
check(
  bodoniNormal !== bodoniTab,
  "Bodoni Moda tabular figures change the drawing",
  bodoniNormal === bodoniTab ? "identical pixels — the subset lost tnum" : "differs",
);

const alegreyaNormal = await shot({ family: '"Alegreya", serif' }, "1111111111");
const alegreyaTab = await shot({ family: '"Alegreya", serif', numeric: "tabular-nums" }, "1111111111");
check(
  alegreyaNormal !== alegreyaTab,
  "Alegreya tabular figures change the drawing",
  alegreyaNormal === alegreyaTab ? "identical pixels — the subset lost tnum" : "differs",
);

const plexZeroOff = await shot({ family: '"IBM Plex Mono", monospace' }, "0O0O0O0O");
const plexZeroOn = await shot({ family: '"IBM Plex Mono", monospace', numeric: "slashed-zero" }, "0O0O0O0O");
check(
  plexZeroOff !== plexZeroOn,
  "IBM Plex Mono slashed zero changes the drawing",
  plexZeroOff === plexZeroOn ? "identical pixels — the font lost zero" : "differs",
);

const azeretLigOff = await shot({ family: '"Azeret Mono", monospace', ligatures: "none" }, "->");
const azeretLigOn = await shot(
  { family: '"Azeret Mono", monospace', ligatures: "contextual common-ligatures" },
  "->",
);
check(
  azeretLigOff !== azeretLigOn,
  "Azeret Mono arrow ligature changes the drawing",
  azeretLigOff === azeretLigOn ? "identical pixels — the subset lost calt" : "differs",
);

const azeretZeroOff = await shot({ family: '"Azeret Mono", monospace' }, "0O0O0O0O");
const azeretZeroOn = await shot({ family: '"Azeret Mono", monospace', numeric: "slashed-zero" }, "0O0O0O0O");
check(
  azeretZeroOff !== azeretZeroOn,
  "Azeret Mono slashed zero changes the drawing",
  azeretZeroOff === azeretZeroOn ? "identical pixels — the subset lost zero" : "differs",
);

const victorLigOff = await shot({ family: '"Victor Mono", monospace', ligatures: "none" }, "-> => != <= >=");
const victorLigOn = await shot(
  { family: '"Victor Mono", monospace', ligatures: "contextual common-ligatures" },
  "-> => != <= >=",
);
check(
  victorLigOff !== victorLigOn,
  "Victor Mono code ligatures change the drawing",
  victorLigOff === victorLigOn ? "identical pixels — the subset lost calt" : "differs",
);

console.log("\n=== the faces differ from each other, and from the fallback ===");
const serifShot = await shot({ family: serif }, "Hamburgefonstiv 123");
const sansShot = await shot({ family: '"Source Sans 3", sans-serif' }, "Hamburgefonstiv 123");
const ebShot = await shot({ family: '"EB Garamond", serif' }, "Hamburgefonstiv 123");
const bodoniShot = await shot({ family: '"Bodoni Moda", serif' }, "Hamburgefonstiv 123");
const jostShot = await shot({ family: '"Jost", sans-serif' }, "Hamburgefonstiv 123");
const alegreyaShot = await shot({ family: '"Alegreya", serif' }, "Hamburgefonstiv 123");
const fallbackShot = await shot({ family: "monospace" }, "Hamburgefonstiv 123");
check(serifShot !== sansShot, "the serif and the sans render differently");
check(
  new Set([serifShot, ebShot, bodoniShot, jostShot, alegreyaShot]).size === 5,
  "the five body families render differently",
);
check(
  [ebShot, bodoniShot, jostShot, alegreyaShot].every((digest) => digest !== fallbackShot),
  "the new body families do not collapse to the monospace fallback",
);

// ---------------------------------------------------------------------------
// Semibold instead of Bold
// ---------------------------------------------------------------------------
//
// The face has to exist before the CSS asking for 600 can use it. With only
// 400 and 700 on disk the browser serves 700, so "Semibold" would silently be
// the Bold it was meant to replace.

console.log("\n=== Semibold is a real face, and the preview asks for it ===");
const semibold = await evaluate(`
  (async () => {
    const family = (f) => f.family.replace(/^"|"$/g, "");
    const declared = [...document.fonts].filter((f) => family(f) === "Source Sans 3");
    let loaded = [];
    try { loaded = await document.fonts.load('600 36px "Source Sans 3"', "Ag0123"); } catch {}
    return {
      sixHundred: declared.filter((f) => f.weight === "600").map((f) => f.style),
      loaded: loaded.filter((f) => f.weight === "600").length,
    };
  })()
`);
check(
  semibold.sixHundred.length >= 2,
  "Source Sans 3 ships upright and italic Semibold faces",
  semibold.sixHundred.join(", ") || "none declared",
);
check(semibold.loaded >= 1, "the Semibold face loads", `${semibold.loaded} face(s)`);

const semiboldShot = await shot(
  { family: '"Source Sans 3", sans-serif', weight: 600 },
  "Hamburgefonstiv 123",
);
const boldShot = await shot(
  { family: '"Source Sans 3", sans-serif', weight: 700 },
  "Hamburgefonstiv 123",
);
check(
  semiboldShot !== boldShot,
  "Semibold draws differently from Bold",
  semiboldShot === boldShot ? "identical pixels — 600 fell back to 700" : "differs",
);

const weights = await evaluate(`
  (() => {
    const host = document.createElement("div");
    host.className = "markdown-body";
    host.id = "weight-harness";
    // Off screen, but laid out: display:none would report no colours.
    host.style.cssText = "position:fixed;left:-3000px;top:0;width:600px";
    host.innerHTML = "<h2>Heading</h2><p><strong>Strong</strong></p>"
      + "<table><tr><th>Head</th></tr></table><hr>";
    document.body.appendChild(host);

    const styleOf = (selector, property) =>
      getComputedStyle(host.querySelector(selector))[property];
    const saved = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = "light";
    const light = {
      hr: styleOf("hr", "borderTopColor"),
      heading: styleOf("h2", "borderBottomColor"),
    };
    document.documentElement.dataset.theme = "dark";
    const dark = {
      hr: styleOf("hr", "borderTopColor"),
      heading: styleOf("h2", "borderBottomColor"),
    };
    if (saved === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = saved;

    const out = {
      strong: styleOf("strong", "fontWeight"),
      heading: styleOf("h2", "fontWeight"),
      tableHead: styleOf("th", "fontWeight"),
      pair: styleOf("strong", "fontFamily"),
      light,
      dark,
    };
    host.remove();
    return out;
  })()
`);

const rgb = (value) => (value.match(/\d+/g) ?? ["0", "0", "0"]).map(Number);
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

check(weights.strong === "600", "preview strong text is Semibold", weights.strong);
check(weights.heading === "600", "preview headings are Semibold", weights.heading);
check(weights.tableHead === "600", "preview table headers are Semibold", weights.tableHead);
check(
  luminance(rgb(weights.light.hr)) < luminance(rgb(weights.light.heading)),
  "the horizontal rule is darker than the rule under a heading",
  `rule ${weights.light.hr}, heading ${weights.light.heading}`,
);
check(
  weights.light.heading === "rgb(231, 231, 231)" && weights.dark.heading === "rgb(51, 51, 51)",
  "the rule under titles keeps the panel border colour",
  `${weights.light.heading} light, ${weights.dark.heading} dark`,
);
check(
  weights.dark.hr !== weights.dark.heading,
  "the horizontal rule remains distinct in the dark theme",
  `rule ${weights.dark.hr}, heading ${weights.dark.heading}`,
);

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
//
// Fira Code is a deliberate choice, not an inherited default: only Serif may
// name it, and only in the two code roles. Every other preset uses JetBrains
// Mono, or the system monospace for System.

console.log("\n=== preset matrix ===");
const presets = await evaluate(`
  (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const overlay = document.querySelector(".prefs-overlay");
    if (!overlay || overlay.hidden) document.getElementById("btn-prefs").click();
    await sleep(150);
    [...document.querySelectorAll(".prefs-section")]
      .find((s) => s.textContent === "Typography").click();
    await sleep(150);

    // Read the stacks the settings publish, not a control in the panel: each
    // face is one dropdown now, and a dropdown shows the family rather than the
    // fallback chain behind it. The variables are what the document renders.
    const roles = ["--font-source", "--font-body", "--font-heading", "--font-code"];
    const read = () => ({
      active: document.querySelector(".prefs-choice.active")?.textContent ?? "",
      fonts: roles.map((name) => document.documentElement.style.getPropertyValue(name).trim()),
    });
    const out = {};
    for (const label of ["System", "Serif", "Renaissance", "Editorial", "Bauhaus", "Notebook"]) {
      [...document.querySelectorAll(".prefs-choice")].find((b) => b.textContent === label).click();
      await sleep(200);
      out[label] = read();
    }
    // Leave the default in force, as a fresh profile would.
    [...document.querySelectorAll(".prefs-choice")].find((b) => b.textContent === "System").click();
    await sleep(200);
    document.querySelector(".prefs-close")?.click();
    return out;
  })()
`);

const first = (stack) => stack.split(",")[0].replace(/["']/g, "").trim();
const labels = ["System", "Serif", "Renaissance", "Editorial", "Bauhaus", "Notebook"];
const namesFira = (name) => presets[name].fonts.some((stack) => stack.includes("Fira Code"));
check(
  labels.every((name) => presets[name].active === name),
  "every preset reports itself as active when chosen",
);
check(
  presets.System.fonts[0].includes("ui-monospace") &&
    presets.System.fonts[1] === 'system-ui, "Segoe UI", -apple-system, Roboto, sans-serif' &&
    presets.System.fonts[2] === 'system-ui, "Segoe UI", -apple-system, Roboto, sans-serif' &&
    presets.System.fonts[3].includes("ui-monospace"),
  "System uses the operating system's faces for all four roles",
  presets.System.fonts.join(" | "),
);
check(
  presets.Serif.fonts[0].includes("Fira Code") && presets.Serif.fonts[3].includes("Fira Code"),
  "Serif uses Fira Code for the editor and preview code",
  `${presets.Serif.fonts[0]} | ${presets.Serif.fonts[3]}`,
);
check(
  labels.filter(namesFira).join(",") === "Serif",
  "no preset other than Serif names Fira Code",
  labels.filter(namesFira).join(",") || "none",
);

const expected = {
  Renaissance: ["IBM Plex Mono", "EB Garamond", "EB Garamond", "IBM Plex Mono"],
  Editorial: ["JetBrains Mono", "Bodoni Moda", "Archivo", "JetBrains Mono"],
  Bauhaus: ["Azeret Mono", "Jost", "Jost", "Azeret Mono"],
  Notebook: ["Victor Mono", "Alegreya", "Caveat", "Victor Mono"],
};
for (const [name, faces] of Object.entries(expected)) {
  check(
    presets[name].fonts.map(first).join("|") === faces.join("|"),
    `${name} resolves the four roles to its own system`,
    presets[name].fonts.map(first).join(" | "),
  );
}

const bodyFaces = ["Renaissance", "Editorial", "Bauhaus", "Notebook"].map((name) =>
  first(presets[name].fonts[1]),
);
check(
  new Set(bodyFaces).size === 4,
  "the four new presets use four different body faces",
  bodyFaces.join(", "),
);
const codePairs = ["Renaissance", "Editorial", "Bauhaus", "Notebook"].map(
  (name) => `${first(presets[name].fonts[0])}/${first(presets[name].fonts[3])}`,
);
check(
  new Set(codePairs).size === 4,
  "the four new presets pair the editor and code differently",
  codePairs.join(", "),
);

// The acceptance measurement: the same paragraph, rendered in each preset's
// body stack, must produce four different images. A stack string can be
// correct while the face silently falls back; pixels cannot.
const presetShots = {};
for (const name of ["Renaissance", "Editorial", "Bauhaus", "Notebook"]) {
  presetShots[name] = await shot(
    { family: presets[name].fonts[1] },
    "The quick brown fox jumps over the lazy dog. 0123",
  );
}
check(
  new Set(Object.values(presetShots)).size === 4,
  "the four new presets render the body differently",
  Object.entries(presetShots)
    .map(([name, digest]) => `${name}:${digest.slice(0, 8)}`)
    .join(" "),
);

// Leave nothing behind: the harness sits above the document while it runs.
await evaluate(`document.getElementById("typo-harness")?.remove()`);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ""}`);
}
ws.close();
process.exit(failed.length === 0 ? 0 : 1);
