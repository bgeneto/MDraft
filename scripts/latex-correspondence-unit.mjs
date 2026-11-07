// Unit checks for LaTeX scroll correspondence.
//
//   node scripts/latex-correspondence-unit.mjs
//
// Step 10 of the LaTeX product plan. The click path already answered "which
// source line is under this point"; scroll correspondence asks the same question
// in both directions, continuously. The rule that matters is the one the plan
// names: **fail closed on ambiguity**. A wrong jump is worse than no jump,
// because it moves the reader's view away from what they were reading.
//
// Everything here is pure: a hand-built SyncTeX mapping and a fake parser stand
// in for a compile, so the whole rule set is testable without an engine, a PDF or
// an editor.
//
// No application.

import {
  pageCount,
  pageFraction,
  previewTargetForLine,
  projectName,
  regionsForLine,
  sourceTargetForPoint,
} from "../src/latex-correspondence.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * A fake engine: a mapping plus the two lookups the correspondence uses.
 *
 * `forward` is keyed `file:line`; `inverse` is keyed `page:x,y`. Building the
 * fixtures by hand keeps each check about one rule instead of about a document.
 */
function makeResult({ forward = {}, inverse = {}, pages = {}, inputs = {}, files = [] } = {}) {
  const mapping = {
    inputs: new Map(Object.entries(inputs).map(([tag, path]) => [Number(tag), path])),
    pages: new Map(Object.entries(pages).map(([page, nodes]) => [Number(page), nodes])),
    magnification: 1,
    unit: 1,
  };
  const parser = {
    forwardLookupDetailed: (_data, file, line) => forward[`${file}:${line}`] ?? null,
    inverseLookupDetailed: (_data, page, x, y) => inverse[`${page}:${x},${y}`] ?? null,
  };
  return { parser, mapping, files: new Set(files), pdf: new Uint8Array(), log: "", mainFile: "main.tex" };
}

const region = (page, y, height = 12, x = 72) => ({ page, x, y, width: 300, height });

console.log("=== project names are normalised the same way in both directions ===");
{
  check(projectName("chapters/intro.tex") === "chapters/intro.tex", "a plain path is unchanged");
  check(projectName(".\\chapters\\intro.tex") === "chapters/intro.tex", "a Windows path is normalised");
  check(projectName("./main.tex") === "main.tex", "a leading ./ is dropped");
}

console.log("\n=== a source line maps to its regions, or to nothing ===");
{
  const result = makeResult({
    files: ["main.tex"],
    forward: {
      "main.tex:10": { match: "exact", regions: [region(1, 100)] },
      "main.tex:11": { match: "nearby", regions: [region(1, 120)] },
      "main.tex:12": { match: "exact", regions: [] },
      "main.tex:13": {
        match: "exact",
        regions: Array.from({ length: 40 }, (_, index) => region(1, index * 10)),
      },
    },
  });

  const exact = regionsForLine(result, "main.tex", 10);
  check(Array.isArray(exact) && exact.length === 1, "an exact match returns its regions");
  check(exact?.[0].y === 100, "the region keeps its position");

  // A "nearby" match is the engine guessing. The click path refuses it, and so
  // does scroll: a guess that scrolls the preview is worse than standing still.
  check(regionsForLine(result, "main.tex", 11) === null, "a nearby match fails closed");
  check(regionsForLine(result, "main.tex", 12) === null, "an empty region list fails closed");
  check(regionsForLine(result, "main.tex", 13) === null, "a structural line fails closed");
  check(regionsForLine(result, "main.tex", 99) === null, "an unmapped line fails closed");
  check(regionsForLine(result, "other.tex", 10) === null, "a file outside the project fails closed");
  check(regionsForLine(result, "main.tex", 0) === null, "line zero fails closed");
}

console.log("\n=== the preview target follows the direction of travel ===");
{
  // A paragraph of prose is one \par spanning several typeset lines, so the same
  // source line owns several regions. Taking the first would snap back to the top
  // of the paragraph on every scroll event.
  const result = makeResult({
    files: ["main.tex"],
    forward: {
      "main.tex:20": { match: "exact", regions: [region(1, 100), region(1, 200), region(1, 300)] },
    },
  });

  const fresh = previewTargetForLine(result, "main.tex", 20);
  check(fresh?.y === 100, "without a hint the first region is chosen", String(fresh?.y));

  // **The target must not depend on the hint.**
  //
  // An earlier version consulted the current preview position, and the measurement
  // that killed it was a repeat scroll: the same editor positions gave
  // `0,0,264,345,277` and then `277,195,304,256,318`. The same source line mapped to
  // different places depending on where the preview already was, so the reader could
  // never predict the result and a second pass drifted.
  //
  // A correspondence is a function of the document. The hint is still accepted — a
  // caller may pass the current position — but it must not change the answer.
  for (const hint of [{ page: 1, y: 110 }, { page: 1, y: 190 }, { page: 1, y: 290 }]) {
    const withHint = previewTargetForLine(result, "main.tex", 20, hint);
    check(
      withHint?.y === fresh?.y,
      `a hint at y=${hint.y} does not change the target`,
      `${withHint?.y} vs ${fresh?.y}`,
    );
  }

  // Every region is returned for painting, not just the chosen one.
  check(fresh?.regions.length === 3, "all regions are offered for painting");
  check(previewTargetForLine(result, "main.tex", 99) === null, "an unmapped line has no target");
}

console.log("\n=== a hint on another page does not win ===");
{
  const result = makeResult({
    files: ["main.tex"],
    forward: {
      "main.tex:30": { match: "exact", regions: [region(2, 50), region(3, 80)] },
    },
  });
  const hinted = previewTargetForLine(result, "main.tex", 30, { page: 3, y: 90 });
  check(hinted?.page === 3, "the hinted page is honoured when the line is on it", String(hinted?.page));

  // A hint for a page the line does not appear on must not be trusted.
  const stray = previewTargetForLine(result, "main.tex", 30, { page: 9, y: 90 });
  check(stray?.page === 2, "an off-page hint falls back to the earliest page", String(stray?.page));
}

console.log("\n=== the source target fails closed on ambiguity ===");
{
  const inside = (page, x, y) => ({
    source: { file: "main.tex", line: 42 },
    region: region(page, 100),
    container: { page, x: 72, y: 100, width: 300, height: 12 },
    nodeType: "hbox",
    method: "container",
    distance: 0,
    match: "contains",
    // The click point used below sits inside this container.
    ...(x === 200 && y === 106 ? {} : {}),
  });

  const single = makeResult({
    files: ["main.tex"],
    inputs: { 1: "main.tex" },
    pages: { 1: [{ input: 1, line: 42, page: 1 }] },
    forward: { "main.tex:42": { match: "exact", regions: [region(1, 100)] } },
    inverse: { "1:200,106": inside(1, 200, 106) },
  });
  const target = sourceTargetForPoint(single, 1, 200, 106);
  check(target?.file === "main.tex" && target?.line === 42, "one candidate resolves", JSON.stringify(target));

  // Two source lines sharing a region is genuine ambiguity — a macro expansion,
  // or a table where every cell reports the same row.
  const ambiguous = makeResult({
    files: ["main.tex"],
    inputs: { 1: "main.tex" },
    pages: { 1: [{ input: 1, line: 42, page: 1 }, { input: 1, line: 43, page: 1 }] },
    forward: {
      "main.tex:42": { match: "exact", regions: [region(1, 100)] },
      "main.tex:43": { match: "exact", regions: [region(1, 100)] },
    },
    inverse: { "1:200,106": inside(1, 200, 106) },
  });
  check(sourceTargetForPoint(ambiguous, 1, 200, 106) === null, "two candidates fail closed");

  // No container means no bracket to search, so there is nothing to stand on.
  const noContainer = makeResult({
    files: ["main.tex"],
    inputs: { 1: "main.tex" },
    pages: { 1: [{ input: 1, line: 42, page: 1 }] },
    forward: { "main.tex:42": { match: "exact", regions: [region(1, 100)] } },
    inverse: {
      "1:200,106": { ...inside(1, 200, 106), container: null },
    },
  });
  check(sourceTargetForPoint(noContainer, 1, 200, 106) === null, "a missing container fails closed");

  // A click outside the matched container is not evidence for it.
  const outside = makeResult({
    files: ["main.tex"],
    inputs: { 1: "main.tex" },
    pages: { 1: [{ input: 1, line: 42, page: 1 }] },
    forward: { "main.tex:42": { match: "exact", regions: [region(1, 100)] } },
    inverse: {
      "1:900,900": {
        ...inside(1, 900, 900),
        container: { page: 1, x: 72, y: 100, width: 300, height: 12 },
      },
    },
  });
  check(sourceTargetForPoint(outside, 1, 900, 900) === null, "a point outside the container fails closed");

  check(sourceTargetForPoint(single, 1, 5, 5) === null, "an unmapped point fails closed");
}

console.log("\n=== page geometry helpers ===");
{
  check(pageFraction(0, 800) === 0, "the top of a page is fraction 0");
  check(pageFraction(400, 800) === 0.5, "the middle is fraction 0.5");
  check(pageFraction(800, 800) === 1, "the bottom is fraction 1");
  check(pageFraction(900, 800) === 1, "past the bottom clamps to 1");
  check(pageFraction(-10, 800) === 0, "above the top clamps to 0");
  // A page with no height must not divide by zero.
  check(pageFraction(100, 0) === 0, "a zero-height page is fraction 0");
  check(pageFraction(100, -5) === 0, "a negative height is fraction 0");

  const mapping = { pages: new Map([[1, []], [2, []], [7, []]]) };
  check(pageCount(mapping) === 7, "the page count is the highest page", String(pageCount(mapping)));
  check(pageCount({ pages: new Map() }) === 0, "an empty mapping has no pages");
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
