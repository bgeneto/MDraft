// Unit tests for the pure Edit › Lines and Edit › Blank Operations helpers.
//
//   node scripts/editor-tools-unit.mjs
//
// No application and no build: both modules are plain TypeScript with no DOM
// access at import time, so Node 24 strips the types and runs them directly.
// The cases that are awkward to see through the UI — a remainder after a tab
// stop, a blank line in EOL-to-space, the heading cap — are pinned here.

import {
  BLANK_TAB_WIDTH,
  countWords,
  dedupeLines,
  eolToSpace,
  sortLines,
  spacesToTabsAll,
  spacesToTabsLeading,
  tabsToSpaces,
  trimBothAndEolToSpace,
  trimBothSpace,
  trimLeadingSpace,
  trimTrailingSpace,
} from "../src/editor-tools.ts";
import { HEADING_PICKER_LIMIT, headingLabel, headingRows } from "../src/heading-picker.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

console.log("=== line order and duplicates ===");
{
  const source = ["b", "a", "c", "a"];
  const asc = sortLines(source, "asc");
  check(same(asc, ["a", "a", "b", "c"]), "ascending sort", asc.join(", "));
  const desc = sortLines(source, "desc");
  check(same(desc, ["c", "b", "a", "a"]), "descending sort", desc.join(", "));
  check(same(source, ["b", "a", "c", "a"]), "sort does not mutate the source");

  const deduped = dedupeLines(["a", "b", "a", "c", "b"]);
  check(same(deduped, ["a", "b", "c"]), "dedupe keeps the first occurrence", deduped.join(", "));
}

console.log("\n=== trimming ===");
{
  const trailing = trimTrailingSpace(["a  ", " b\t", "c"]);
  check(same(trailing, ["a", " b", "c"]), "trim trailing space and tab", trailing.join("|"));

  const leading = trimLeadingSpace(["  a", "\tb", " c "]);
  check(same(leading, ["a", "b", "c "]), "trim leading only", leading.join("|"));

  const both = trimBothSpace(["  a  ", "\tb\t", " c "]);
  check(same(both, ["a", "b", "c"]), "trim both edges", both.join("|"));
}

console.log("\n=== EOL conversion ===");
{
  const joined = eolToSpace(["a", "", "b"]);
  check(same(joined, ["a  b"]), "EOL to space keeps the blank-line space", JSON.stringify(joined));

  const cleaned = trimBothAndEolToSpace([" a ", "", " b "]);
  check(same(cleaned, ["a b"]), "trim both and EOL drops empty lines", JSON.stringify(cleaned));

  const noContent = trimBothAndEolToSpace(["", "   ", ""]);
  check(
    same(noContent, [""]),
    "an all-blank block becomes one empty line",
    JSON.stringify(noContent),
  );
}

console.log("\n=== tabs and spaces ===");
{
  check(
    BLANK_TAB_WIDTH === 2,
    "the blank-operation tab width is the editor indent",
    String(BLANK_TAB_WIDTH),
  );

  const expanded = tabsToSpaces(["\ta\tb"]);
  check(same(expanded, ["  a  b"]), "each tab becomes two spaces", JSON.stringify(expanded));

  const all = spacesToTabsAll(["a    b", "  c", "a   b"]);
  check(
    same(all, ["a\t\tb", "\tc", "a\t b"]),
    "Space to TAB (All) converts every run and leaves the remainder",
    JSON.stringify(all),
  );

  const leading = spacesToTabsLeading(["    a  b", "  c"]);
  check(
    same(leading, ["\t\ta  b", "\tc"]),
    "Space to TAB (Leading) leaves internal spaces alone",
    JSON.stringify(leading),
  );
}

console.log("\n=== selected words ===");
{
  check(countWords("") === 0, "empty text has no words");
  check(countWords("   ") === 0, "whitespace has no words");
  check(countWords("one") === 1, "one word");
  check(countWords("one two\tthree") === 3, "tabs split words");
  check(countWords("one\ntwo") === 2, "line breaks split words");
}

console.log("\n=== heading rows ===");
{
  const label = headingLabel({ level: 2, text: "Methods", line: 14 });
  check(label === "H2 · Methods", "heading label carries the level", label);

  const headings = Array.from({ length: HEADING_PICKER_LIMIT + 1 }, (_, index) => ({
    level: 1,
    text: `Heading ${index + 1}`,
    line: index + 1,
  }));
  const rows = headingRows(headings);
  check(rows.length === HEADING_PICKER_LIMIT, "the picker cap is enforced", String(rows.length));
  check(rows[0].keywords.includes("h1"), "the level is searchable");
  check(rows[0].keywords.includes("line 1"), "the line number is searchable");
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  for (const entry of failed) console.log(`  FAILED: ${entry.label}`);
  process.exitCode = 1;
}
