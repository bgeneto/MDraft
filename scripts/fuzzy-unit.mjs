// Unit checks for the Explorer filter's fuzzy matcher.
//
//   node scripts/fuzzy-unit.mjs
//
// `src/fuzzy.ts` has no runtime imports, so Node 24 strips its types and loads
// it directly — no build, no DOM. The CDP suite proves the filter box drives
// the tree; this file pins which paths match and in what order.

import { match, prepare, prepareQuery, rank } from "../src/fuzzy.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

// A LaTeX book laid out the way readers' projects are, breadth-first and in
// natural order as `workspace_index` returns it.
const paths = [
  "config",
  "figs",
  "fonts",
  "txt",
  "main.bib",
  "main.tex",
  "config/ambientes.tex",
  "config/configuracao-apendices.tex",
  "config/figuras.tex",
  "config/matematica.tex",
  "config/texto.tex",
  "figs/a-map-b.png",
  "figs/ação.svg",
  "figs/logoUnB.pdf",
  "fonts/Lato-Regular.ttf",
  "txt/cap1.tex",
  "txt/cap2.tex",
  "txt/cap10.tex",
  "txt/apendices/apendiceA.tex",
];
const prepared = new Map(paths.map((path) => [path, prepare(path)]));
const ranked = (query) => rank(paths, (path) => prepared.get(path), query).map((r) => r.item);

function first(query, expected, label) {
  const got = ranked(query);
  check(got[0] === expected, label, `${JSON.stringify(query)} → ${got.slice(0, 3).join(", ")}`);
}

first("amb", "config/ambientes.tex", "a word-start run in the name beats scattered letters");
first("texto", "config/texto.tex", "an exact name wins");
first("acao", "figs/ação.svg", "accents are ignored");
first("AÇÃO", "figs/ação.svg", "case and accents in the query are ignored too");
first("main.t", "main.tex", "punctuation matches literally");
first("conf/tex", "config/texto.tex", "a slash matches folder then name");
first("txt cap2", "txt/cap2.tex", "every space-separated term must match");
first("lub", "figs/logoUnB.pdf", "camelCase humps count as word starts");
first("apA", "txt/apendices/apendiceA.tex", "deep paths are still found");

const caps = ranked("cap");
check(
  caps.slice(0, 3).join(",") === "txt/cap1.tex,txt/cap2.tex,txt/cap10.tex",
  "ties keep natural order, shorter first",
  caps.join(", "),
);
check(ranked("zzz").length === 0, "no match is no result");
check(ranked("   ").length === 0, "an empty query ranks nothing");
check(
  ranked("tex").length === paths.filter((p) => p.includes("tex")).length,
  "every path containing the letters in order is a result",
);

// Positions point into the original string, even across folded accents.
const accent = match(prepareQuery("acao"), prepare("figs/ação.svg"));
check(
  JSON.stringify(accent?.positions) === JSON.stringify([5, 6, 7, 8]),
  "highlight positions survive accent folding",
  JSON.stringify(accent?.positions),
);
const run = match(prepareQuery("texto"), prepare("config/texto.tex"));
check(
  JSON.stringify(run?.positions) === JSON.stringify([7, 8, 9, 10, 11]),
  "the best alignment is the contiguous one in the name",
  JSON.stringify(run?.positions),
);
const windows = match(prepareQuery("conf\\tex"), prepare("config/texto.tex"));
check(windows !== null, "a backslash in the query works as a separator");

// Speed: a keystroke over an index at its 50 000-entry bound stays interactive
// (typical projects hold a few hundred names and rank in well under 1 ms).
const big = [];
for (let i = 0; i < 50_000; i += 1)
  big.push(prepare(`part${i % 40}/chapter-${i}/section_${i}.tex`));
const started = performance.now();
const hits = rank(big, (p) => p, "chsec12");
const elapsed = performance.now() - started;
check(
  hits.length > 0 && elapsed < 250,
  "50 000 paths rank in under 250 ms",
  `${elapsed.toFixed(1)} ms, ${hits.length} hits`,
);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
