// Unit tests for the Typst Pages source map.
//
//   node scripts/typst-page-map-unit.mjs
//
// `src/typst-page-map.ts` has no runtime imports, so Node 24 strips its types and
// runs it directly. These are the rules that decide whether a click in the PDF
// text layer names a source occurrence or paints nothing:
//
// - a repeated one-word line must not fall back to the nearest occurrence;
// - the neighbouring visual lines can identify the occurrence when the word
//   alone cannot;
// - a ligature or a soft hyphen must not break an otherwise exact word;
// - generated text still maps to nothing.

import { TypstSourceMap } from "../src/typst-page-map.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** The source text of the word the match points at, or null. */
function wordAt(map, match) {
  if (!match) return null;
  const word = map.wordForLineToken(match, 0);
  return word ? { text: word.text, from: word.from, to: word.to } : null;
}

function mapsTo(map, line, before, after) {
  return wordAt(map, map.mapLineWithNeighbors(line, before, after));
}

console.log("\n=== a repeated one-word line ===");
{
  const map = new TypstSourceMap("Same\ntarget\nSame\nSame\ntarget\nSame");
  const ambiguous = map.mapLineWithNeighbors("target", "Same", "Same");
  check(ambiguous === null, "identical neighbours paint nothing", JSON.stringify(ambiguous));

  const unique = new TypstSourceMap("One\ntarget\nTwo\nOther\ntarget\nThird");
  const first = mapsTo(unique, "target", "One", "Two");
  const second = mapsTo(unique, "target", "Other", "Third");
  check(
    first !== null && second !== null && first.from < second.from,
    "different neighbours pick different occurrences",
    `${first?.from} < ${second?.from}`,
  );
  check(
    first?.text === "target" && second?.text === "target",
    "the mapped word is the clicked word",
  );
}

console.log("\n=== context and fallbacks ===");
{
  const map = new TypstSourceMap("alpha beta gamma\nbeta gamma");
  const match = map.mapLine("beta gamma", 0);
  const word = wordAt(map, match);
  check(word?.text === "beta" && word.from === 6, "a two-word line still maps", String(word?.from));

  const first = map.mapLine("beta gamma", 0);
  const last = map.mapLine("beta gamma", map.source.length);
  check(
    first !== null && last !== null && first.sourceAt === 1 && last.sourceAt === 3,
    "the caret hint still disambiguates a two-word line",
    `${first?.sourceAt} / ${last?.sourceAt}`,
  );

  const alone = new TypstSourceMap("target");
  check(
    alone.mapLineWithNeighbors("target", "", "") === null,
    "a one-word line with no context paints nothing",
  );

  const generated = new TypstSourceMap("#let x = 1");
  check(
    generated.mapLineWithNeighbors("Lorem", "", "") === null,
    "generated text paints nothing",
  );
}

console.log("\n=== ligatures and soft hyphens ===");
{
  const ligature = new TypstSourceMap("The file ends");
  const word = mapsTo(ligature, "ﬁle", "The", "ends");
  check(word?.text === "file", "a PDF ligature matches the source word", String(word?.text));

  const soft = new TypstSourceMap("begin co\u00adoperate now");
  const joined = mapsTo(soft, "cooperate", "begin", "now");
  check(
    joined?.text === "co\u00adoperate",
    "a soft hyphen in the source matches the joined PDF word",
    JSON.stringify(joined?.text),
  );
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
