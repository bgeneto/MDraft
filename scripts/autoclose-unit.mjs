// Unit checks for the tag closer's matcher.
//
//   node scripts/autoclose-unit.mjs
//
// `src/tag-name.ts` has no runtime imports, so Node 24 strips its types and
// loads it directly — no build, no DOM, no editor. The CDP suite proves that
// typing really closes a tag; this file pins the shapes that must not.

import { tagToClose } from "../src/tag-name.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const cases = [
  ["<p", "p", "a bare opening tag"],
  ['<a href="x"', "a", "attributes"],
  ['<my-component data-x="1"', "my-component", "a hyphenated custom element"],
  ['<a href="http://example.com"', "a", "a URL attribute is still a tag"],
  ["body <p", "p", "the last tag on the line"],
  ["<p ", "p", "a trailing space before the caret"],
  ["<br", null, "a void element"],
  ['<img src="x"', null, "a void element with attributes"],
  ["<br /", null, "an explicit self-closing tag"],
  ["<https://example.com", null, "an autolink"],
  ["<mailto:me@example.com", null, "a mailto autolink"],
  ["\\<p", null, "an escaped less-than"],
  ["<!DOCTYPE html", null, "a declaration"],
  ["<p>text", null, "the caret is not at the end of a tag"],
  ["plain text", null, "prose"],
  ["<3", null, "a heart"],
  ["<P", "P", "the name keeps its case"],
];

for (const [before, expected, label] of cases) {
  const actual = tagToClose(before);
  check(
    actual === expected,
    label,
    `tagToClose(${JSON.stringify(before)}) = ${JSON.stringify(actual)}`,
  );
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
