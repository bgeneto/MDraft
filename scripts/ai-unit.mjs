// Pure checks for the AI Assistant's catalog, context rules, edit plans,
// button geometry and diff. No application, no build, no network.
//
// Run with `npm run ai:unit`. Node 24 strips the TypeScript types, which is why
// the imported modules must stay free of Tauri, CodeMirror and CSS imports.

import assert from "node:assert/strict";
import { EditorState, MapMode } from "@codemirror/state";

import {
  ACTIONS,
  DEFAULT_MOST_USED,
  GROUP_ORDER,
  answerLanguage,
  actionById,
  convertTargets,
  defaultParameter,
  groupedActions,
  parameterIsValid,
  searchActions,
} from "../src/ai/actions.ts";
import {
  anchorFromPosition,
  applyPlan,
  blockInsertion,
  captureContext,
  clampButtonPosition,
  continuationPlan,
  defaultButtonPosition,
  joinContinuation,
  movedEnough,
  paragraphRange,
  positionFromAnchor,
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
import { filterEntries } from "../src/combo.ts";
import { LANGUAGES, filterLanguages } from "../src/ai/languages.ts";
import {
  MAX_USAGE_ENTRIES,
  USAGE_HALF_LIFE_MS,
  decay,
  rankMostUsed,
  recordUsage,
  sanitizeUsage,
} from "../src/ai/usage.ts";

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
  "the catalog covers the four real groups",
  [...new Set(ACTIONS.map((action) => action.group))].sort(),
  ["refine", "transform", "understand", "write"],
);
equal("the palette order puts the derived group first", GROUP_ORDER, [
  "mostUsed",
  "write",
  "refine",
  "understand",
  "transform",
]);
equal("the cold-start shortcuts are the three the palette used to pin", DEFAULT_MOST_USED, [
  "continue",
  "improve",
  "ask",
]);
equal("Continue writing belongs to Write", actionById("continue")?.group, "write");
equal("Improve writing belongs to Refine", actionById("improve")?.group, "refine");
equal("Ask AI belongs to Understand", actionById("ask")?.group, "understand");
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
  "the Understand group finds all five actions",
  searchActions("understand").map((a) => a.id),
  ["ask", "summarize", "explain", "keyPoints", "critique"],
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
  ["write", "refine", "understand", "transform"],
);

// ---------------------------------------------------------------------------
// Most used
// ---------------------------------------------------------------------------

console.log("\nMost used");
// One fixed instant: nothing below may depend on the wall clock.
const NOW = 1_760_000_000_000;
const nowUsed = (id) => recordUsage([], id, NOW);
const ids = (entries) => rankMostUsed(entries, NOW).map((action) => action.id);

equal("a fresh profile shows the three defaults", ids([]), ["continue", "improve", "ask"]);
equal("the section is capped at the limit", ids([]).length, 3);
equal(
  "a smaller limit trims the section",
  rankMostUsed([], NOW, 2).map((a) => a.id),
  ["continue", "improve"],
);
equal("a zero limit shows nothing", rankMostUsed([], NOW, 0), []);
equal("one use of Summarize puts it first", ids(nowUsed("summarize"))[0], "summarize");
equal("the defaults fill the rest", ids(nowUsed("summarize")), [
  "summarize",
  "continue",
  "improve",
]);
equal("a use starts at one", nowUsed("summarize")[0].score, 1);
check("a score halves after one half-life", Math.abs(decay(4, USAGE_HALF_LIFE_MS) - 2) < 1e-9);
check("a clock that went backwards does not age the score", decay(2, -5_000) === 2);
equal(
  "a recent habit outranks an older, heavier one",
  ids([
    { id: "translate", score: 5, at: NOW - 6 * USAGE_HALF_LIFE_MS },
    { id: "summarize", score: 1, at: NOW },
  ]).slice(0, 2),
  ["summarize", "translate"],
);
equal(
  "an entry that decayed to nothing stops taking a slot",
  ids([{ id: "translate", score: 1, at: NOW - 20 * USAGE_HALF_LIFE_MS }]),
  ["continue", "improve", "ask"],
);
equal(
  "equal scores fall back to catalog order",
  ids([
    { id: "translate", score: 1, at: NOW },
    { id: "continue", score: 1, at: NOW },
  ]),
  ["continue", "translate", "improve"],
);
equal(
  "a newer equal score goes first",
  ids([
    { id: "translate", score: 1, at: NOW - 1_000 },
    { id: "continue", score: 1, at: NOW },
  ]).slice(0, 2),
  ["continue", "translate"],
);

const shortcuts = rankMostUsed([], NOW);
equal(
  "the shortcut group comes first",
  groupedActions(searchActions(""), shortcuts).map((group) => group.group),
  ["mostUsed", "write", "refine", "understand", "transform"],
);
equal(
  "the shortcut rows are catalog actions",
  groupedActions(searchActions(""), shortcuts)[0].actions.map((action) => action.id),
  ["continue", "improve", "ask"],
);
equal(
  "a shortcut still appears in its own category",
  groupedActions(searchActions(""), shortcuts)[1].actions.map((action) => action.id),
  ["continue", "expand", "shorten"],
);
equal(
  "a filtered list drops the shortcut group",
  groupedActions(searchActions("summ"), shortcuts).map((group) => group.group),
  ["understand"],
);

equal("undefined usage is empty", sanitizeUsage(undefined, NOW), []);
equal(
  "an id this build does not know is dropped",
  sanitizeUsage([{ id: "vanish", score: 1, at: NOW }], NOW),
  [],
);
equal(
  "a duplicate id keeps its strongest score",
  sanitizeUsage(
    [
      { id: "summarize", score: 1, at: NOW },
      { id: "summarize", score: 3, at: NOW },
    ],
    NOW,
  ),
  [{ id: "summarize", score: 3, at: NOW }],
);
equal(
  "negative and non-finite scores are dropped",
  sanitizeUsage(
    [
      { id: "continue", score: -1, at: NOW },
      { id: "improve", score: Number.NaN, at: NOW },
    ],
    NOW,
  ),
  [],
);
equal(
  "a timestamp far in the future is dropped",
  sanitizeUsage([{ id: "continue", score: 1, at: NOW + 2 * 24 * 60 * 60 * 1000 }], NOW),
  [],
);
check(
  "a timestamp slightly ahead is tolerated",
  sanitizeUsage([{ id: "continue", score: 1, at: NOW + 1_000 }], NOW).length === 1,
);
equal("the storage guard matches the backend", MAX_USAGE_ENTRIES, 32);
check(
  "a repeat use ages the old score before adding one",
  Math.abs(
    recordUsage([{ id: "improve", score: 2, at: NOW - USAGE_HALF_LIFE_MS }], "improve", NOW)[0]
      .score - 2,
  ) < 1e-9,
);
equal(
  "recording prunes what has decayed away",
  recordUsage(
    [{ id: "translate", score: 0.02, at: NOW - 20 * USAGE_HALF_LIFE_MS }],
    "summarize",
    NOW,
  ).map((entry) => entry.id),
  ["summarize"],
);
equal("an unknown id is not recorded", recordUsage([], "vanish", NOW), []);

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
// The markup a new-tab answer opens in
// ---------------------------------------------------------------------------

console.log("\nAnswer language");
equal("Convert opens its target markup", answerLanguage("convert", "typst", "markdown"), "typst");
equal("Convert from AsciiDoc opens HTML", answerLanguage("convert", "html", "asciidoc"), "html");
equal(
  "a missing parameter falls back to the source",
  answerLanguage("convert", null, "markdown"),
  "markdown",
);
equal(
  "an unknown markup falls back to the source",
  answerLanguage("convert", "latex", "typst"),
  "typst",
);
equal(
  "a target equal to the source is not a conversion",
  answerLanguage("convert", "markdown", "markdown"),
  "markdown",
);
equal("a rewrite keeps the document's language", answerLanguage("improve", null, "typst"), "typst");
equal(
  "a language parameter is not a markup",
  answerLanguage("translate", "Portuguese", "asciidoc"),
  "asciidoc",
);
equal("Convert to table keeps the language", answerLanguage("table", null, "html"), "html");

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
equal("the frontend leaves token capping to Rust", trimHistory(longTurns, 12).history.length, 6);

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
equal(
  "the default anchor is at the bottom limit, 20 px from the right",
  defaultButtonPosition(800, 600, 40),
  {
    x: 740,
    y: 552,
  },
);
equal("clamping the top-left corner", clampButtonPosition({ x: -20, y: -20 }, 800, 600, 40), {
  x: 8,
  y: 8,
});
equal("clamping the bottom-right corner", clampButtonPosition({ x: 900, y: 700 }, 800, 600, 40), {
  x: 752,
  y: 552,
});
equal("the default anchor follows a taller pane", defaultButtonPosition(800, 1400, 40), {
  x: 740,
  y: 1352,
});
equal(
  "a position is stored as a free-space fraction",
  anchorFromPosition({ x: 380, y: 280 }, 800, 600, 40),
  { x: 0.5, y: 0.5 },
);
equal(
  "a resized pane resolves the stored fraction",
  positionFromAnchor(anchorFromPosition({ x: 380, y: 280 }, 800, 600, 40), 1200, 900, 40),
  { x: 580, y: 430 },
);
equal(
  "a dragged corner keeps its edge distance on resize",
  positionFromAnchor(anchorFromPosition({ x: 752, y: 552 }, 800, 600, 40), 1600, 1000, 40),
  { x: 1552, y: 952 },
);
equal(
  "a fraction beyond the free space clamps to the corner",
  anchorFromPosition({ x: 900, y: 700 }, 800, 600, 40),
  { x: 1, y: 1 },
);
check(
  "a resolved anchor stays inside a smaller pane",
  (() => {
    const point = positionFromAnchor({ x: 0.8, y: 0.9 }, 300, 200, 40);
    return point.x >= 8 && point.x <= 252 && point.y >= 8 && point.y <= 152;
  })(),
);
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
// Shared combo filter
// ---------------------------------------------------------------------------

console.log("\nShared combo filter");

equal(
  "an empty query keeps every entry in the caller's order",
  filterEntries([{ value: "zeta" }, { value: "Alpha" }], "  ").map((entry) => entry.value),
  ["zeta", "Alpha"],
);
equal(
  "a query matches the value and ignores case",
  filterEntries([{ value: "zeta" }, { value: "Alpha" }], " ALPH ").map((entry) => entry.value),
  ["Alpha"],
);
equal(
  "an accented value is found without the accent",
  filterEntries([{ value: "Español" }], "espanol").map((entry) => entry.value),
  ["Español"],
);
equal(
  "an accented query finds an unaccented value",
  filterEntries([{ value: "Espanol" }], "español").map((entry) => entry.value),
  ["Espanol"],
);
equal(
  "a keyword matches even though it is never displayed",
  filterEntries([{ value: "Portuguese (Brazil)", keywords: ["pt-BR"] }], "pt-br").map(
    (entry) => entry.value,
  ),
  ["Portuguese (Brazil)"],
);
equal(
  "a label matches even when the value does not",
  filterEntries([{ value: "a1", label: "Shown name" }], "shown").map((entry) => entry.value),
  ["a1"],
);
equal("a query that matches nothing is empty", filterEntries([{ value: "one" }], "three"), []);

// ---------------------------------------------------------------------------
// Language suggestions
// ---------------------------------------------------------------------------

console.log("\nLanguage suggestions");

check("the suggestion table has 34 entries", LANGUAGES.length === 34);
equal(
  "the curated head keeps the likely targets first",
  LANGUAGES.slice(0, 4).map((entry) => entry.value),
  ["English (US)", "English (UK)", "Portuguese (Brazil)", "Portuguese (Portugal)"],
);
equal(
  "an alias finds one variant",
  filterLanguages("brasil").map((entry) => entry.value),
  ["Portuguese (Brazil)"],
);
equal(
  "a short tag finds both variants, in table order",
  filterLanguages("pt").map((entry) => entry.value),
  ["Portuguese (Brazil)", "Portuguese (Portugal)"],
);
equal(
  "zh finds both Chinese variants",
  filterLanguages("zh").map((entry) => entry.value),
  ["Chinese (Simplified)", "Chinese (Traditional)"],
);
equal(
  "an English word finds the plain label",
  filterLanguages("mandarin").map((entry) => entry.value),
  ["Chinese (Simplified)"],
);
equal(
  "an unaccented query finds an accented name",
  filterLanguages("espanol").map((entry) => entry.value),
  ["Spanish (Spain)"],
);
equal(
  "an unaccented query finds an accented alias",
  filterLanguages("turkce").map((entry) => entry.value),
  ["Turkish"],
);
equal("an unknown language matches nothing", filterLanguages("klingon"), []);
equal(
  "an empty query lists every suggestion in table order",
  filterLanguages("").map((entry) => entry.value),
  LANGUAGES.map((entry) => entry.value),
);

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

// ---------------------------------------------------------------------------
// Stale insertion anchors (F15). The editor maps captured positions with
// `mapPos(pos, 1, MapMode.TrackDel)`; these checks pin that contract and the
// placement Insert below then makes.
// ---------------------------------------------------------------------------

{
  const original = "First paragraph.\n\nTarget paragraph.\n\nLast.";
  const paragraphTo = original.indexOf("Target paragraph.") + "Target paragraph.".length;
  const map = (changes, pos) => changes.mapPos(pos, 1, MapMode.TrackDel);
  const after = (state, spec) => state.update(spec);

  const start = EditorState.create({ doc: original });
  const prefixed = after(start, { changes: { from: 0, insert: "New intro.\n\n" } });
  const mapped = map(prefixed.changes, paragraphTo);
  const text = prefixed.state.doc.toString();
  const insertion = blockInsertion(text, mapped, "Answer.");
  const placed = text.slice(0, mapped) + insertion + text.slice(mapped);
  check(
    "an edit above the passage moves the Insert below anchor with it",
    placed.includes("Target paragraph.\n\nAnswer.") && placed.startsWith("New intro.\n\nFirst"),
  );
  check(
    "the stale clamped offset would have split unrelated text",
    !text.slice(0, paragraphTo).endsWith("Target paragraph."),
  );

  const typed = after(start, { changes: { from: paragraphTo, insert: " more" } });
  check(
    "text typed exactly at the anchor stays before the insertion point",
    map(typed.changes, paragraphTo) === paragraphTo + " more".length,
  );

  const targetFrom = original.indexOf("Target");
  const deleted = after(start, { changes: { from: targetFrom - 2, to: paragraphTo + 1 } });
  check(
    "deleting the paragraph makes the anchor unplaceable instead of guessing",
    map(deleted.changes, paragraphTo) === null,
  );

  const below = after(start, { changes: { from: original.length, insert: "\n\nTail." } });
  check(
    "an edit after the passage leaves the anchor where it was",
    map(below.changes, paragraphTo) === paragraphTo,
  );
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
