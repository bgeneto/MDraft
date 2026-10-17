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
    const names = ["Source Serif 4", "Source Sans 3", "Inter", "JetBrains Mono"];
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

console.log("\n=== the faces differ from each other, and from the fallback ===");
const serifShot = await shot({ family: serif }, "Hamburgefonstiv 123");
const sansShot = await shot({ family: '"Source Sans 3", sans-serif' }, "Hamburgefonstiv 123");
const interShot = await shot({ family: "Inter, sans-serif" }, "Hamburgefonstiv 123");
const fallbackShot = await shot({ family: "monospace" }, "Hamburgefonstiv 123");
check(serifShot !== sansShot, "the serif and the sans render differently");
check(interShot !== fallbackShot, "Inter renders rather than falling back to monospace");
check(sansShot !== serifShot && interShot !== sansShot, "Source Sans 3 and Inter are distinct faces");

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
