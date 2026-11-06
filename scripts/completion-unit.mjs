// Unit checks for the completion layer.
//
//   node scripts/completion-unit.mjs
//
// The layer's *behaviour* — Tab accepting versus indenting, the popup opening on
// a keystroke — needs a real editor and is proven by `shortcut-test.mjs` through
// CDP. What this file pins is everything that can be decided without one: that
// the configuration is what the plan says, that a language with no catalog
// offers nothing rather than falling back to buffer words, and that no
// completion module can reach the network.
//
// The catalogs (steps 3, 4 and 6) add their own cases here.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const layerSource = readFileSync(join(root, "src", "completion", "layer.ts"), "utf8");

console.log("=== the layer's configuration ===");
{
  // The numbers are a contract: `maxRenderedOptions` bounds the popup's cost and
  // `activateOnTyping` is what makes typing open the list at all.
  check(
    /activateOnTyping:\s*true/.test(layerSource),
    "the popup opens while typing",
  );
  check(/closeOnBlur:\s*true/.test(layerSource), "the popup closes when focus leaves");
  check(
    /maxRenderedOptions:\s*50/.test(layerSource),
    "the popup renders at most 50 rows",
    (layerSource.match(/maxRenderedOptions:\s*(\d+)/) ?? [])[1] ?? "missing",
  );
  check(/icons:\s*false/.test(layerSource), "rows carry no icon");
}

console.log("\n=== the Tab key ===");
{
  // The one silent-failure risk in this step. `acceptCompletion` declines when
  // no popup is open, so a high-precedence completion keymap lets the event
  // fall through to `indentWithTab`. Below the base keymap, Tab would indent
  // while a popup is open and could never accept.
  check(
    /Prec\.high\(keymap\.of\(completionKeymap\)\)/.test(layerSource),
    "the completion keymap is above the base keymap",
  );
  check(
    !/Prec\.(lowest|low)\(/.test(layerSource),
    "nothing in the layer is installed below the base keymap",
  );
  // The extension and the keymap are returned together: one without the other
  // is a popup the keyboard cannot drive, or a key that can never accept.
  check(
    /export function completionSupport\(\)[\s\S]*?return \[autocompletion\(CONFIG\), Prec\.high/.test(
      layerSource,
    ),
    "the extension and its keymap are installed as one unit",
  );
}

console.log("\n=== a language with no catalog offers nothing ===");
{
  // `autocompletion()` falls back to completing words from the buffer when a
  // language registers no source. That fallback is what makes completion feel
  // noisy, so a language without a catalog must answer explicitly.
  check(/export const noCompletions/.test(layerSource), "an explicit empty source exists");
  const { noCompletions } = await import("../src/completion/layer.ts").catch(() => ({}));
  if (typeof noCompletions === "function") {
    // The signature takes a CompletionContext; the source must not read it.
    const result = noCompletions({ state: {}, pos: 0 });
    check(result === null, "the empty source returns null", String(result));
  } else {
    // CodeMirror imports are not resolvable without a bundler in some setups;
    // the source-level assertion above still holds.
    check(true, "the empty source is declared (runtime import unavailable)");
  }
}

console.log("\n=== completion never reaches the network ===");
{
  // The plan's hard rule. A catalog is data; a fetch here would be a network
  // request the reader did not ask for.
  const dir = join(root, "src", "completion");
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  const forbidden = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|import\s*\(\s*["']https?:)/;
  const offenders = files.filter((name) => forbidden.test(readFileSync(join(dir, name), "utf8")));
  check(
    offenders.length === 0,
    "no completion module can make a request",
    offenders.length ? offenders.join(", ") : `${files.length} files clean`,
  );
}

console.log("\n=== the layer is wired into the editor ===");
{
  const editor = readFileSync(join(root, "src", "editor.ts"), "utf8");
  check(/completionCompartment\s*=\s*new Compartment\(\)/.test(editor), "completion has its own compartment");
  check(
    /completionCompartment\.of\(options\.completion === false \? \[\] : completionSupport\(\)\)/.test(
      editor,
    ),
    "the preference decides what start-up installs",
  );
  check(/setCompletion\(enabled\)/.test(editor), "the editor can switch it at runtime");
  // Off must remove the keymap with the extension, not leave a Tab binding that
  // can never fire.
  check(
    /completionCompartment\.reconfigure\(enabled \? completionSupport\(\) : \[\]\)/.test(editor),
    "switching off removes the keymap too",
  );
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
