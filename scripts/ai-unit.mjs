// Pure checks for the AI Assistant's catalog, context rules, edit plans,
// button geometry and diff. No application, no build, no network.
//
// Run with `npm run ai:unit`. Node 24 strips the TypeScript types, which is why
// the imported modules must stay free of Tauri, CodeMirror and CSS imports.

import assert from "node:assert/strict";

import {
  ACTIONS,
  GROUP_ORDER,
  convertTargets,
  defaultParameter,
  groupedActions,
  parameterIsValid,
  searchActions,
} from "../src/ai/actions.ts";
import {
  applyPlan,
  blockInsertion,
  captureContext,
  clampButtonPosition,
  continuationPlan,
  defaultButtonPosition,
  joinContinuation,
  movedEnough,
  paragraphRange,
  resolveAiLanguage,
  targetIsCurrent,
  trimHistory,
  trimPreceding,
} from "../src/ai/context.ts";
import { diffSummary, wordDiff } from "../src/ai/diff.ts";
import {
  MAX_AI_HISTORY,
  formatHistoryAge,
  historyTitle,
  previewText,
  rememberRequest,
} from "../src/ai/history.ts";
import { filterModelIds } from "../src/model-combo.ts";

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

function equal(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    passed++;
    console.log(`  PASS  ${name}`);
  } catch {
    failed++;
    console.log(
      `  FAIL  ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const document = [
  "# Title",
  "",
  "First paragraph line one.",
  "First paragraph line two.",
  "",
  "- item one",
  "- item two",
  "",
  "> quoted line",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "Last paragraph.",
].join("\n");

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

console.log("\nCatalog");
equal("fourteen actions", ACTIONS.length, 14);
equal("every action id is unique", new Set(ACTIONS.map((action) => action.id)).size, 14);
equal(
  "the catalog covers the five groups",
  [...new Set(ACTIONS.map((action) => action.group))].sort(),
  [...GROUP_ORDER].sort(),
);
equal(
  "Most used keeps the original three first",
  ACTIONS.filter((action) => action.group === "mostUsed").map((action) => action.id),
  ["continue", "improve", "ask"],
);
equal(
  "rewrite actions can replace",
  ACTIONS.filter((action) => action.apply === "replace").map((action) => action.id),
  ["improve", "expand", "shorten", "simplify", "tone", "translate", "table", "convert"],
);
equal(
  "understand actions only insert a block",
  ACTIONS.filter((action) => action.apply === "block").map((action) => action.id),
  ["summarize", "explain", "keyPoints", "critique"],
);
equal(
  "the three parameterised actions are named",
  ACTIONS.filter((action) => action.parameter !== "none").map((action) => action.id),
  ["tone", "translate", "convert"],
);

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

console.log("\nPalette search");
equal("an empty query returns everything", searchActions("").length, 14);
equal(
  "translate finds Translate",
  searchActions("translate").map((a) => a.id),
  ["translate"],
);
equal(
  "tone finds Change tone",
  searchActions("tone").map((a) => a.id),
  ["tone"],
);
equal(
  "summarize finds Summarize",
  searchActions("summarize").map((a) => a.id),
  ["summarize"],
);
equal(
  "table finds Convert to table",
  searchActions("table").map((a) => a.id),
  ["table"],
);
equal(
  "the Understand group finds its four actions",
  searchActions("understand").map((a) => a.id),
  ["summarize", "explain", "keyPoints", "critique"],
);
equal(
  "a synonym reaches the action",
  searchActions("proofread").map((a) => a.id),
  ["improve"],
);
equal(
  "an accented synonym is normalised",
  searchActions("traduzir").map((a) => a.id),
  ["translate"],
);
equal(
  "multiple words all have to match",
  searchActions("table markup").map((a) => a.id),
  [],
);
equal(
  "grouped output keeps group order",
  groupedActions(searchActions("")).map((group) => group.group),
  GROUP_ORDER,
);

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

console.log("\nParameters");
check("Professional is a valid tone", parameterIsValid("tone", "Professional", "markdown"));
check("Sarcastic is not", !parameterIsValid("tone", "Sarcastic", "markdown"));
check("a target language is required", !parameterIsValid("translate", "  ", "markdown"));
check("a target language is enough", parameterIsValid("translate", "Portuguese", "markdown"));
check(
  "converting to the same markup is refused",
  !parameterIsValid("convert", "markdown", "markdown"),
);
check("converting to another markup is accepted", parameterIsValid("convert", "typst", "markdown"));
equal(
  "the first convert target is the first other markup",
  defaultParameter("convert", "markdown"),
  "typst",
);
equal(
  "convert offers the three languages other than the document's own",
  convertTargets("typst").map((markup) => markup.id),
  ["markdown", "html", "asciidoc"],
);
equal("the default tone is Professional", defaultParameter("tone", "markdown"), "Professional");
equal("translate starts empty", defaultParameter("translate", "markdown"), "");

// ---------------------------------------------------------------------------
// Paragraph expansion
// ---------------------------------------------------------------------------

console.log("\nParagraph expansion");
const firstLine = document.indexOf("First paragraph line one.");
const secondLine = document.indexOf("line two.");
equal(
  "a position expands to the whole paragraph",
  document.slice(paragraphRange(document, firstLine).from, paragraphRange(document, firstLine).to),
  "First paragraph line one.\nFirst paragraph line two.",
);
equal(
  "a blank line ends the paragraph",
  paragraphRange(document, document.indexOf("- item one")).to -
    paragraphRange(document, document.indexOf("- item one")).from,
  "- item one\n- item two".length,
);
equal(
  "a heading is its own block",
  document.slice(paragraphRange(document, 2).from, paragraphRange(document, 2).to),
  "# Title",
);
equal(
  "a fenced code block is one block",
  document.slice(
    paragraphRange(document, document.indexOf("const x")).from,
    paragraphRange(document, document.indexOf("const x")).to,
  ),
  "```js\nconst x = 1;\n```",
);
equal(
  "a quote is one block",
  document.slice(
    paragraphRange(document, document.indexOf("quoted")).from,
    paragraphRange(document, document.indexOf("quoted")).to,
  ),
  "> quoted line",
);
equal(
  "a selection ending at a line start stays on the line above",
  document.slice(
    paragraphRange(document, firstLine, secondLine - 1).from,
    paragraphRange(document, firstLine, secondLine - 1).to,
  ),
  "First paragraph line one.\nFirst paragraph line two.",
);

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

console.log("\nContext capture");
const noSelection = captureContext({
  text: document,
  from: secondLine,
  to: secondLine,
  caret: secondLine,
  language: "markdown",
});
check("no selection has no selection text", noSelection.selection === "");
equal(
  "the passage falls back to the paragraph",
  noSelection.passage,
  "First paragraph line one.\nFirst paragraph line two.",
);
equal("the passage range is the paragraph", noSelection.passageFrom, firstLine);
check("the locale is carried", noSelection.language === "markdown");
check(
  "preceding is everything before the caret",
  noSelection.preceding === document.slice(0, secondLine),
);

const selected = captureContext({
  text: document,
  from: secondLine,
  to: secondLine + "line two.".length,
  caret: secondLine + "line two.".length,
  language: "markdown",
});
equal("a selection becomes the passage", selected.passage, "line two.");
equal("the selection is exact", selected.selection, "line two.");
check("the selection trims outer whitespace", selected.selectionFrom === secondLine);
check("the paragraph still covers both lines", selected.paragraph.includes("line one."));
check("a selection is flagged", selected.hasSelection);

const padded = captureContext({
  text: "  alpha  ",
  from: 0,
  to: 9,
  caret: 9,
  language: "typst",
});
equal("outer whitespace is outside the replaced range", padded.selection, "alpha");
equal("the trimmed range starts at the first letter", padded.selectionFrom, 2);
equal("the trimmed range ends after the last letter", padded.selectionTo, 7);

// ---------------------------------------------------------------------------
// Continue
// ---------------------------------------------------------------------------

console.log("\nContinue");
equal("prose takes one space", joinContinuation("Hello", "world"), " world");
equal("existing whitespace is kept", joinContinuation("Hello ", "world"), "world");
equal("a newline already separates", joinContinuation("Hello\n", "world"), "world");
equal("punctuation takes no space", joinContinuation("Hello", ". And then"), ". And then");
equal("an opening parenthesis takes no space", joinContinuation("(", "alpha"), "alpha");
equal("an em dash takes no space", joinContinuation("word—", "next"), "next");
equal("CJK takes no space", joinContinuation("你好", "世界"), "世界");
equal("CJK after a full stop still takes no space", joinContinuation("你好。", "世界"), "世界");
equal("an empty preceding adds nothing", joinContinuation("", "world"), "world");
equal("an empty answer adds nothing", joinContinuation("Hello", "   "), "");

const continuation = continuationPlan(
  captureContext({ text: "Hello", from: 5, to: 5, caret: 5, language: "markdown" }),
  "world",
);
equal("continue inserts at the caret", continuation.from, 5);
equal("continue inserts one space", continuation.text, " world");

// ---------------------------------------------------------------------------
// Block insertion
// ---------------------------------------------------------------------------

console.log("\nInsert below");
equal("between paragraphs", blockInsertion("A\n\nB", 1, "X"), "\n\nX");
equal("at the document start", blockInsertion("A\n\nB", 0, "X"), "X\n\n");
equal("at the document end", blockInsertion("A\n\nB", 4, "X"), "\n\nX\n");
equal("with a single newline after the anchor", blockInsertion("A\nB", 1, "X"), "\n\nX\n");
equal("the answer is trimmed", blockInsertion("A", 1, "  X  "), "\n\nX\n");
equal("an empty answer inserts nothing", blockInsertion("A", 1, "   "), "");

const blockCapture = captureContext({
  text: "A\n\nB",
  from: 1,
  to: 1,
  caret: 1,
  language: "markdown",
});
const blockPlan = applyPlan(blockCapture, "summarize", "Summary");
equal("a new-block action inserts after the paragraph", blockPlan?.kind, "insert");
equal("a new-block action anchors on paragraphTo", blockPlan?.from, 1);
equal("a new-block action separates with a blank line", blockPlan?.text, "\n\nSummary");
const replacePlan = applyPlan(blockCapture, "improve", "Better");
equal("a rewrite replaces the passage", replacePlan?.kind, "replace");
equal("a rewrite uses the passage range", [replacePlan?.from, replacePlan?.to], [0, 1]);

// ---------------------------------------------------------------------------
// Stale targets and history
// ---------------------------------------------------------------------------

console.log("\nStale targets and history");
const target = { sessionId: "doc-1", revision: 7, from: 0, to: 5, text: "Hello" };
check("an unchanged target is current", targetIsCurrent(target, "doc-1", 7, "Hello world"));
check("a changed revision is stale", !targetIsCurrent(target, "doc-1", 8, "Hello world"));
check("a changed session is stale", !targetIsCurrent(target, "doc-2", 7, "Hello world"));
check("changed text is stale", !targetIsCurrent(target, "doc-1", 7, "Hella world"));
check("an out-of-range target is stale", !targetIsCurrent(target, "doc-1", 7, "Hi"));

const turns = Array.from({ length: 20 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: `turn ${index}`,
}));
const trimmed = trimHistory(turns);
equal("history keeps twelve turns", trimmed.history.length, 12);
check("trimming is reported", trimmed.dropped);
equal("the newest turn survives", trimmed.history.at(-1).content, "turn 19");
const longTurns = Array.from({ length: 6 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: "x".repeat(6000),
}));
equal(
  "history is capped by characters in pairs",
  trimHistory(longTurns, 12, 20_000).history.length,
  2,
);

// ---------------------------------------------------------------------------
// Session history
// ---------------------------------------------------------------------------

console.log("\nSession history");

const historyEntry = (id, overrides = {}) => ({
  id,
  action: "improve",
  parameter: null,
  question: "",
  contextSummary: "Selection · 12 characters",
  context: "<passage>\nRegular text\n</passage>",
  answer: `Answer ${id}`,
  notes: "",
  model: "test-model",
  host: "127.0.0.1:1",
  documentName: "feature-tour.md",
  language: "markdown",
  createdAt: 1_000,
  truncated: false,
  ...overrides,
});

const firstEntry = historyEntry("first", { createdAt: 2_000 });
equal(
  "a new request becomes the first history row",
  rememberRequest([], firstEntry).map((entry) => entry.id),
  ["first"],
);
const secondEntry = historyEntry("second", { createdAt: 3_000 });
equal(
  "newer requests stay in front",
  rememberRequest([firstEntry], secondEntry).map((entry) => entry.id),
  ["second", "first"],
);
const many = Array.from({ length: MAX_AI_HISTORY + 3 }, (_, index) =>
  historyEntry(`entry-${index}`, { createdAt: index }),
);
const cappedByTen = many.reduce((entries, entry) => rememberRequest(entries, entry), []);
equal("the history keeps ten entries", cappedByTen.length, MAX_AI_HISTORY);
equal("the newest entry survives the cap", cappedByTen[0].id, "entry-12");
equal("the oldest entry is dropped", cappedByTen.at(-1).id, "entry-3");
equal("an empty cap keeps nothing", rememberRequest([firstEntry], secondEntry, 0).length, 0);

const regenerated = rememberRequest(
  [secondEntry, firstEntry],
  historyEntry("first", { answer: "Regenerated answer", createdAt: 9_000 }),
);
equal("regenerate keeps the row count", regenerated.length, 2);
equal("regenerate keeps the row position", regenerated[1].id, "first");
equal("regenerate replaces the answer", regenerated[1].answer, "Regenerated answer");
equal("regenerate refreshes the timestamp", regenerated[1].createdAt, 9_000);
check(
  "an unknown cap argument still yields an array",
  Array.isArray(rememberRequest([firstEntry], secondEntry)),
);

equal("a tone title names the parameter", historyTitle("tone", "Casual"), "Change tone · Casual");
equal(
  "a translation title names the language",
  historyTitle("translate", "Portuguese"),
  "Translate · Portuguese",
);
equal(
  "a markup title uses the readable label",
  historyTitle("convert", "html"),
  "Convert markup · HTML",
);
equal(
  "an action without a parameter keeps its label",
  historyTitle("improve", null),
  "Improve writing",
);
equal("preview text collapses whitespace", previewText("  one\n\t two  "), "one two");
const cutPreview = previewText("abcdefghijklmnopqrstuvwxyz", 10);
check("a long preview is cut", cutPreview.endsWith("…") && cutPreview.length === 10, cutPreview);
equal("a fresh answer reads as just now", formatHistoryAge(0, 30_000), "Just now");
equal("a two-minute-old answer reads in minutes", formatHistoryAge(0, 125_000), "2 min ago");
equal("an hour-old answer reads in hours", formatHistoryAge(0, 3_600_000), "1 h ago");
check("an old answer gets a date", formatHistoryAge(0, 15 * 24 * 3_600_000).length > 0);

// ---------------------------------------------------------------------------
// Preceding trim
// ---------------------------------------------------------------------------

console.log("\nPreceding trim");
const short = trimPreceding("hello");
check("short text is untouched", !short.truncated && short.text === "hello");
const long = trimPreceding(`${"a".repeat(13_000)}\n\nTail paragraph`, 12_000);
check("long text is trimmed", long.truncated);
equal("trimming starts at the paragraph boundary", long.text, "Tail paragraph");

// ---------------------------------------------------------------------------
// Button geometry
// ---------------------------------------------------------------------------

console.log("\nButton geometry");
equal("the default anchor is bottom-right with 20 px", defaultButtonPosition(800, 600, 40), {
  x: 740,
  y: 540,
});
equal("clamping the top-left corner", clampButtonPosition({ x: -20, y: -20 }, 800, 600, 40), {
  x: 8,
  y: 8,
});
equal("clamping the bottom-right corner", clampButtonPosition({ x: 900, y: 700 }, 800, 600, 40), {
  x: 752,
  y: 552,
});
check("a three-pixel movement is a click", !movedEnough({ x: 0, y: 0 }, { x: 3, y: 0 }));
check("a five-pixel movement is a drag", movedEnough({ x: 0, y: 0 }, { x: 5, y: 0 }));

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

console.log("\nChanges view");
equal("identical text is one unchanged part", wordDiff("a b c", "a b c"), [
  { value: "a b c", kind: "same" },
]);
const replaced = wordDiff("a b", "a c");
check(
  "a replacement marks the old word removed and the new word added",
  replaced.some((part) => part.kind === "removed" && part.value === "b") &&
    replaced.some((part) => part.kind === "added" && part.value === "c"),
);
const inserted = wordDiff("a c", "a b c");
check(
  "an insertion is marked added",
  inserted.some((part) => part.kind === "added" && part.value.includes("b")),
);
const removed = wordDiff("a b c", "a c");
check(
  "a deletion is marked removed",
  removed.some((part) => part.kind === "removed" && part.value.includes("b")),
);
equal("the summary counts added and removed words", diffSummary(wordDiff("one two", "one three")), {
  added: 1,
  removed: 1,
});
const huge = wordDiff("x ".repeat(2000), "y ".repeat(2000), 100);
equal("above the cap the whole text is shown", huge.length, 2);
check(
  "the fallback marks removed then added",
  huge[0].kind === "removed" && huge[1].kind === "added",
);

// ---------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------

console.log("\nModel picker");
equal(
  "an empty search keeps the endpoint's order",
  filterModelIds(["zeta-model", "Alpha-model"], "  "),
  ["zeta-model", "Alpha-model"],
);
equal(
  "a search ignores case and surrounding space",
  filterModelIds(["zeta-model", "Alpha-model"], " ALPHA "),
  ["Alpha-model"],
);
equal(
  "a search matches anywhere in the id",
  filterModelIds(["gpt-4o-mini", "qwen2.5-coder"], "CODER"),
  ["qwen2.5-coder"],
);
equal("a search that matches nothing is empty", filterModelIds(["one", "two"], "three"), []);

// ---------------------------------------------------------------------------
// Assistant markup
// ---------------------------------------------------------------------------

console.log("\nAssistant markup");
equal(
  "a saved file ignores content that looks like another markup",
  resolveAiLanguage(true, "markdown", "= Introduction\n\n#let value = 5"),
  "markdown",
);
equal(
  "an unsaved Typst buffer is detected from its text",
  resolveAiLanguage(
    false,
    "markdown",
    "= Introduction\n\n#let value = 5\n\n#table(columns: 2, [a], [b])",
  ),
  "typst",
);
equal(
  "an unsaved Markdown buffer is detected from its text",
  resolveAiLanguage(false, "typst", "# Title\n\n**bold** and [link](https://example.com)"),
  "markdown",
);
equal(
  "an ambiguous unsaved buffer keeps the editor's language",
  resolveAiLanguage(false, "typst", "Just a plain sentence."),
  "typst",
);

// ---------------------------------------------------------------------------

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
