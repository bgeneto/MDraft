// Unit checks for the CSS font-stack helpers.
//
//   node scripts/typography-unit.mjs
//
// `src/font-stacks.ts` has no runtime imports, so Node 24 strips its types and
// loads it directly. The UI suites prove that choosing a family changes the
// document; this file pins the quoting and parsing that make an arbitrary
// system family safe to put in a stack.

import {
  cssFamily,
  firstFamily,
  isGenericFamily,
  parseFamilies,
  stackWith,
} from "../src/font-stacks.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function equal(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(ok, label, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const base = '"Source Serif 4", Georgia, serif';

console.log("=== parsing ===");
equal("a plain stack", parseFamilies(base), ["Source Serif 4", "Georgia", "serif"]);
equal("a comma inside a quoted family", parseFamilies('"Foo, Bar", serif'), ["Foo, Bar", "serif"]);
equal("single quotes", parseFamilies("'Source Serif 4', Georgia"), ["Source Serif 4", "Georgia"]);
equal("empty items are dropped", parseFamilies("Georgia,, serif,"), ["Georgia", "serif"]);
equal("an escaped quote is unescaped", parseFamilies('"Foo \\"Bar\\"", serif'), [
  'Foo "Bar"',
  "serif",
]);
equal("an escaped backslash is unescaped", parseFamilies('"Foo\\\\Bar", serif'), [
  "Foo\\Bar",
  "serif",
]);
equal("an unquoted multi-word family", parseFamilies("Times New Roman, serif"), [
  "Times New Roman",
  "serif",
]);
equal("the first family of a quoted comma", firstFamily('"Foo, Bar", serif'), "Foo, Bar");
equal("the first family of an empty stack", firstFamily(""), "");

console.log("\n=== quoting ===");
equal("a simple identifier stays bare", cssFamily("Georgia"), "Georgia");
equal("a hyphenated identifier stays bare", cssFamily("-apple-system"), "-apple-system");
equal("a spaced name is quoted", cssFamily("Source Serif 4"), '"Source Serif 4"');
equal("a comma is quoted", cssFamily("Foo, Bar"), '"Foo, Bar"');
equal("a quote is escaped", cssFamily('Foo "Bar"'), '"Foo \\"Bar\\""');
equal("a backslash is escaped", cssFamily("Foo\\Bar"), '"Foo\\\\Bar"');
equal("a leading digit is quoted", cssFamily("123Font"), '"123Font"');
equal("a generic keyword stays bare", cssFamily("monospace"), "monospace");
check(isGenericFamily("SYSTEM-UI"), "generic family detection is case-insensitive");
check(!isGenericFamily("Georgia"), "a normal family is not generic");

console.log("\n=== rebuilding a stack ===");
equal("choosing a new face", stackWith("Charter", base), "Charter, Georgia, serif");
equal(
  "choosing the built-in face is idempotent",
  stackWith("Source Serif 4", base),
  '"Source Serif 4", Georgia, serif',
);
equal("the chosen family is removed from the tail", stackWith("Georgia", base), "Georgia, serif");
equal(
  "a generic keyword stays unquoted",
  stackWith("system-ui", base),
  "system-ui, Georgia, serif",
);
equal(
  "a comma in the chosen family is quoted",
  stackWith("Foo, Bar", base),
  '"Foo, Bar", Georgia, serif',
);
equal("an empty choice leaves the base alone", stackWith("", base), base);
equal(
  "a spaced chosen family is quoted",
  stackWith("Times New Roman", base),
  '"Times New Roman", Georgia, serif',
);
equal("a selected family round-trips", firstFamily(stackWith("Foo, Bar", base)), "Foo, Bar");

const failed = checks.filter((check) => !check.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const failure of failed)
    console.log(`  - ${failure.label}${failure.detail ? `: ${failure.detail}` : ""}`);
}
process.exit(failed.length === 0 ? 0 : 1);
