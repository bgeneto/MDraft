// Unit tests for the Typst Pages source map.
//
//   node scripts/typst-page-map-unit.mjs
//
// `src/typst-page-map.ts` uses the existing Typst parser; Node 24 strips its types and
// runs it directly. These are the rules that decide whether a click in the PDF
// text layer names a source occurrence or paints nothing:
//
// - a repeated one-word line must not fall back to the nearest occurrence;
// - the neighbouring visual lines can identify the occurrence when the word
//   alone cannot;
// - a ligature or a soft hyphen must not break an otherwise exact word;
// - generated text still maps to nothing.

import { decodeRenderedTypstBinary } from "../src/api.ts";
import { buildPdfWordAnchors } from "../src/pdf-page-build.ts";
import { PdfPageMap } from "../src/pdf-page-map.ts";
import { annotateTypstLines } from "../src/typst-map.ts";
import { createTypstPageMap } from "../src/typst-page-map.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function mapLines(source, rows, region = "left") {
  return createTypstPageMap(
    source,
    rows.map((text) => ({ text, region })),
  );
}
console.log("\n=== context and fallbacks ===");
{
  const rows = ["Same", "target", "Same", "Same", "target", "Same"];
  const ambiguous = await createTypstPageMap(
    rows.join("\n"),
    rows.map((text, i) => ({ text, region: i < 3 ? "a" : "b" })),
  );
  check(
    ambiguous.wordAt(1, 0) === null && ambiguous.wordAt(4, 0) === null,
    "identical neighbours paint nothing",
  );
  const unique = await mapLines("One\ntarget\nTwo\nOther\ntarget\nThird", [
    "One",
    "target",
    "Two",
    "Other",
    "target",
    "Third",
  ]);
  const first = unique.wordAt(1, 0),
    second = unique.wordAt(4, 0);
  check(
    first && second && first.from < second.from,
    "different neighbours pick different occurrences",
  );
  check(
    first?.text === "target" && second?.text === "target",
    "the mapped word is the clicked word",
  );
  const two = await mapLines("alpha beta gamma", ["alpha", "beta gamma"]);
  check(two.wordAt(1, 0)?.from === 6, "a two-word line maps with established context");
  const repeated = await createTypstPageMap("beta gamma\nbeta gamma", [
    { text: "beta gamma", region: "a" },
    { text: "beta gamma", region: "b" },
  ]);
  check(
    repeated.wordAt(0, 0) === null && repeated.wordAt(1, 0) === null,
    "a repeated two-word line never uses the caret as evidence",
  );
  const alone = await mapLines("target", ["target"]);
  check(alone.wordAt(0, 0) === null, "a one-word line with no context paints nothing");
  const generated = await mapLines("#let x = 1", ["Lorem"]);
  check(generated.wordAt(0, 0) === null, "generated text paints nothing");
  const ligature = await mapLines("The file ends", ["The", "ﬁle", "ends"]);
  check(ligature.wordAt(1, 0)?.text === "file", "a PDF ligature matches the source word");
  const soft = await mapLines("begin co\u00adoperate now", ["begin", "cooperate", "now"]);
  check(soft.wordAt(1, 0)?.text === "co\u00adoperate", "a soft hyphen matches the joined PDF word");
}
console.log("\n=== bidirectional prose index ===");
{
  const source =
    '// com velocidade 2,0\nNo instante zero, uma partícula está em $x = "4,0" thin "m"$ e\n$y = "3,0" thin "m"$, com velocidade\n$arrow(v)_0 = ("2,0" hat(i) - "9,0" hat(j)) thin "m/s"$.\nSua aceleração é constante.';
  const lines = [
    "No instante zero, uma partícula está em",
    "com velocidade 𝑣 = ( 2,0 𝑖 − 9,0 𝑗 ) m/s",
    "Sua aceleração é constante.",
  ].map((text) => ({ text, region: "left" }));
  const map = await createTypstPageMap(source, lines);
  const range = map.sourceRange(1, 4, 1, 14);
  check(
    range &&
      source.slice(range.from, range.to) === "velocidade" &&
      range.from === source.lastIndexOf("velocidade"),
    "formula numbers cannot displace the selected prose",
    JSON.stringify(range),
  );
  const phrase = map.sourceRange(1, 0, 1, 14);
  check(
    phrase && source.slice(phrase.from, phrase.to) === "com velocidade",
    "two-word phrase beside math maps exactly",
  );
  const inverse = range ? map.partsForSource(range.from, range.to) : [];
  check(
    inverse.length === 1 &&
      inverse[0].line === 1 &&
      lines[1].text.slice(inverse[0].from, inverse[0].to) === "velocidade",
    "reverse lookup uses the same accepted occurrence",
    JSON.stringify(inverse),
  );
}
{
  const source = "The pendulum rotates slowly.\nAnother pendulum rotates quickly.";
  const lines = [
    { text: "The pendulum rotates slowly.", region: "left" },
    { text: "Another pendulum rotates quickly.", region: "right" },
  ];
  const map = await createTypstPageMap(source, lines);
  const first = map.wordAt(0, 4),
    last = map.wordAt(1, 8);
  check(
    first?.from === source.indexOf("pendulum") && last?.from === source.lastIndexOf("pendulum"),
    "repeated words map their own column without a caret hint",
  );
  check(
    map.sourceRange(0, 4, 1, 16) === null,
    "a selection crossing unrelated reading regions is rejected",
  );
}
{
  const source = "We cooperate with reliable instruments.";
  const lines = [
    { text: "We coop-", region: "left" },
    { text: "erate with reliable instruments.", region: "left" },
  ];
  const map = await createTypstPageMap(source, lines);
  const range = map.sourceRange(0, 3, 1, 5);
  check(
    range && source.slice(range.from, range.to) === "cooperate",
    "line-break hyphenation maps the complete source word",
  );
  check(
    range && map.partsForSource(range.from, range.to).length === 2,
    "a hyphenated source word has two separate preview ranges",
  );
  const actualText = await createTypstPageMap(source, [
    { text: "We coop", region: "left" },
    { text: "erate with reliable instruments.", region: "left" },
  ]);
  check(
    actualText.wordAt(0, 3)?.text === "cooperate" && actualText.wordAt(1, 0)?.text === "cooperate",
    "PDF ActualText may omit the visual hyphen without losing either half",
  );
}
{
  const source = "Before text.\n= Method\nA pendulum is useful.";
  const lines = ["Before text.", "Method", "A pendulum is useful."].map((text) => ({
    text,
    region: "left",
  }));
  const map = await createTypstPageMap(source, lines);
  check(map.wordAt(1, 0)?.text === "Method", "a one-word heading uses surrounding verified prose");
  const ambiguous = await createTypstPageMap("Same target Same\nSame target Same", [
    { text: "Same target Same", region: "a" },
    { text: "Same target Same", region: "b" },
  ]);
  check(
    ambiguous.wordAt(0, 5) === null && ambiguous.wordAt(1, 5) === null,
    "indistinguishable repeated passages remain unmapped",
  );
  const generated = await createTypstPageMap("#let label = [Visible label]\n#lorem(10)", [
    { text: "Visible label", region: "a" },
  ]);
  check(
    generated.wordAt(0, 0) === null,
    "definitions and generated text do not become source prose",
  );
  const unicode = await createTypstPageMap("The file shows café now.", [
    { text: "The ﬁle shows cafe\u0301 now.", region: "a" },
  ]);
  check(
    unicode.wordAt(0, 4)?.text === "file" && unicode.wordAt(0, 14)?.text === "café",
    "ligatures and combining accents preserve UTF-16 source ranges",
  );
}

{
  const source = "Alpha pendulum rotates slowly. Beta pendulum rotates quickly.";
  const rows = [
    { text: "Alpha pendulum rotates slowly.", region: "left" },
    { text: "Beta pendulum rotates quickly.", region: "right" },
  ];
  const map = await createTypstPageMap(source, rows);
  const anchors = map.scrollAnchors();
  check(anchors.length === 8, "scroll exposes the accepted literal occurrences only");
  check(
    anchors.every(
      (a) =>
        map.wordAt(a.line, a.start)?.from === a.from &&
        map
          .partsForSource(a.from, a.to)
          .some((p) => p.line === a.line && p.from === a.start && p.to === a.end),
    ),
    "scroll and selection use identical links in both directions",
  );
  const generated = await createTypstPageMap("#lorem(20)", [
    { text: "Generated absent words", region: "left" },
  ]);
  check(generated.scrollAnchors().length === 0, "generated text cannot become a scroll anchor");
}

{
  const source = [
    "= List sync",
    "",
    "- alpha first item",
    "  beta continuation line",
    "- gamma second item",
    "  delta continuation line",
    "",
    "+ ordered one",
    "+ ordered two",
  ].join("\n");
  const rows = [
    "alpha first item",
    "beta continuation line",
    "gamma second item",
    "delta continuation line",
    "ordered one",
    "ordered two",
  ].map((text) => ({ text, region: "left" }));
  const map = await createTypstPageMap(source, rows);
  for (const [word, occurrence, line] of [
    ["alpha", 0, 0],
    ["beta", 0, 1],
    ["gamma", 0, 2],
    ["delta", 0, 3],
    ["ordered", 1, 5],
  ]) {
    const at = occurrence === 0 ? source.indexOf(word) : source.lastIndexOf(word);
    const found = map.wordAt(line, rows[line].text.indexOf(word));
    check(
      found?.text === word && found?.from === at,
      `a multiline list word maps its own source occurrence (${word})`,
      JSON.stringify({ found, at }),
    );
    const parts = found ? map.partsForSource(found.from, found.to) : [];
    check(
      parts.some((part) => part.line === line),
      `the reverse lookup reaches the same list line (${word})`,
      JSON.stringify(parts),
    );
  }
  const repeated = map.wordAt(1, 0);
  check(
    repeated?.text === "beta" &&
      map.wordAt(3, 0)?.text === "delta" &&
      map.wordAt(1, 0)?.from !== map.wordAt(3, 0)?.from,
    "a repeated continuation word keeps its own line",
  );
}

console.log("\n=== Phase 2 & 4: AST spanMap, multi-file UTF-16 & binary IPC ===");
{
  const ch1Source = [
    "= Capítulo Um",
    "",
    "A partícula café oscila como pendulum aqui.",
    "A partícula café oscila como pendulum aqui.",
    "",
  ].join("\n");
  const mainSource = '= Índice\n\n#include "chapters/ch1.typ"\n';

  const line3Start = ch1Source.indexOf("A partícula café");
  const line3End = line3Start + "A partícula café oscila como pendulum aqui.".length;
  const line4Start = ch1Source.indexOf("A partícula café", line3End);
  const line4End = line4Start + "A partícula café oscila como pendulum aqui.".length;
  const headingStart = ch1Source.indexOf("Capítulo Um");
  const headingEnd = headingStart + "Capítulo Um".length;

  const spanMap = [
    {
      file: "chapters/ch1.typ",
      line: 1,
      column: 3,
      byteOffset: headingStart,
      utf16Start: headingStart,
      utf16End: headingEnd,
      page: 1,
      xPt: 72,
      yPt: 40 - 18 * 0.85,
      widthPt: 110,
      heightPt: 18,
    },
    {
      file: "chapters/ch1.typ",
      line: 3,
      column: 1,
      byteOffset: line3Start,
      utf16Start: line3Start,
      utf16End: line3End,
      page: 1,
      xPt: 72,
      yPt: 72 - 11 * 0.85,
      widthPt: 260,
      heightPt: 11,
    },
    {
      file: "chapters/ch1.typ",
      line: 4,
      column: 1,
      byteOffset: line4Start,
      utf16Start: line4Start,
      utf16End: line4End,
      page: 1,
      xPt: 72,
      yPt: 92 - 11 * 0.85,
      widthPt: 260,
      heightPt: 11,
    },
  ];

  const files = [
    { path: "main.typ", source: mainSource },
    { path: "chapters/ch1.typ", source: ch1Source },
  ];
  const pdfLines = [
    {
      text: "1 Capítulo Um",
      region: "1:0:-1",
      page: 1,
      yPt: 40,
      leftPt: 72,
      rightPt: 182,
      heightPt: 18,
    },
    {
      text: "A partícula café oscila como pendulum aqui.",
      region: "1:0:-1",
      page: 1,
      yPt: 72,
      leftPt: 72,
      rightPt: 332,
      heightPt: 11,
    },
    {
      text: "A partícula café oscila como pendulum aqui.",
      region: "1:0:-1",
      page: 1,
      yPt: 92,
      leftPt: 72,
      rightPt: 332,
      heightPt: 11,
    },
  ];

  const anchors = await buildPdfWordAnchors("typst", files, pdfLines, spanMap);
  const pdfMap = new PdfPageMap(pdfLines, anchors, false);

  const cafeOffset = pdfLines[1].text.indexOf("café");
  const wLine3 = pdfMap.wordAt(1, cafeOffset);
  const wLine4 = pdfMap.wordAt(2, cafeOffset);
  check(
    wLine3?.file === "chapters/ch1.typ" &&
      ch1Source.slice(wLine3.from, wLine3.to) === "café" &&
      wLine3.from === ch1Source.indexOf("café"),
    "spanMap anchors UTF-16 accented word into included chapter line 3",
    JSON.stringify(wLine3),
  );
  check(
    wLine4?.file === "chapters/ch1.typ" &&
      ch1Source.slice(wLine4.from, wLine4.to) === "café" &&
      wLine4.from === ch1Source.lastIndexOf("café") &&
      wLine4.from > (wLine3?.to ?? 0),
    "spanMap disambiguates identical repeated sentence onto chapter line 4",
    JSON.stringify(wLine4),
  );
  const rev = wLine4 ? pdfMap.partsForSource("chapters/ch1.typ", wLine4.from, wLine4.to) : [];
  check(
    rev.length === 1 && rev[0].line === 2,
    "reverse lookup on included chapter points strictly to visual line 2",
    JSON.stringify(rev),
  );

  // Fail-safe check: compiler span pointing to #lorem(10) must NOT map "Lorem" word!
  const loremSrc = "#lorem(10)";
  const loremAnchors = await buildPdfWordAnchors(
    "typst",
    [{ path: "main.typ", source: loremSrc }],
    [
      {
        text: "Lorem ipsum dolor sit amet",
        region: "1:0:-1",
        page: 1,
        yPt: 60,
        leftPt: 72,
        rightPt: 250,
        heightPt: 11,
      },
    ],
    [
      {
        file: "main.typ",
        line: 1,
        column: 1,
        byteOffset: 0,
        utf16Start: 0,
        utf16End: loremSrc.length,
        page: 1,
        xPt: 72,
        yPt: 60 - 11 * 0.85,
        widthPt: 178,
        heightPt: 11,
      },
    ],
  );
  check(
    loremAnchors.length === 0,
    "compiler span targeting #lorem(...) stays unmapped rather than false-linking Lorem",
    JSON.stringify(loremAnchors),
  );

  // CLI fallback parity when spanMap is omitted.
  const cliFallback = await buildPdfWordAnchors(
    "typst",
    [{ path: "", source: ch1Source }],
    [{ text: "A partícula café oscila como pendulum aqui.", region: "left" }],
  );
  check(
    cliFallback.length === 0,
    "CLI fallback without spanMap still withholds ambiguous repeated prose",
  );

  // Raw binary IPC header + PDF round-trip.
  const metaJson = JSON.stringify({
    compilerOutput: "",
    compilerOutputTruncated: false,
    kind: "pages",
    html: null,
    css: null,
    pdf: null,
    warnings: [],
    ignored: [],
    pageHashes: ["aaaa", "bbbb"],
    firstChangedPage: 2,
    changedPages: [2],
    deps: [{ path: "chapters/ch1.typ", mtimeMs: 1234, size: 88 }],
    spanMap,
    backendKind: "service",
    timings: { vfsSyncMs: 0.4, typstCompileMs: 2.1, pageHashMs: 0.2, exportMs: 3.0, totalMs: 5.7 },
  });
  const metaBytes = new TextEncoder().encode(metaJson);
  const rawPdf = new TextEncoder().encode("%PDF-1.7\n%mock\n%%EOF");
  const packet = new Uint8Array(4 + metaBytes.length + rawPdf.length);
  new DataView(packet.buffer).setUint32(0, metaBytes.length, false);
  packet.set(metaBytes, 4);
  packet.set(rawPdf, 4 + metaBytes.length);
  const decoded = decodeRenderedTypstBinary(packet.buffer);
  check(
    decoded.meta.backendKind === "service" &&
      decoded.meta.pageHashes?.length === 2 &&
      decoded.meta.spanMap?.length === 3 &&
      decoded.pdfBytes !== undefined &&
      new TextDecoder().decode(decoded.pdfBytes) === "%PDF-1.7\n%mock\n%%EOF",
    "decodeRenderedTypstBinary parses big-endian frame & raw PDF bytes cleanly",
  );

  // DOM-stub test for annotateTypstLines with & without spanMap.
  globalThis.Node ??= { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  const makeEl = (tagName, text) => {
    const attrs = new Map();
    return {
      tagName,
      dataset: {},
      textContent: text,
      childNodes: [{ nodeType: 3, textContent: text }],
      setAttribute: (k, v) => attrs.set(k, v),
      getAttribute: (k) => attrs.get(k) ?? null,
    };
  };
  const docSource = ["= Título Principal", "", "#lorem(12)", "", "Parágrafo final com café."].join(
    "\n",
  );
  const hEl = makeEl("H1", "Título Principal");
  const lEl = makeEl("P", "Lorem ipsum dolor sit amet");
  const pEl = makeEl("P", "Parágrafo final com café.");
  const host = { children: [hEl, lEl, pEl] };
  const pStart = docSource.indexOf("Parágrafo final");
  const res = annotateTypstLines(host, docSource, [
    {
      file: "doc.typ",
      line: 5,
      column: 1,
      byteOffset: pStart,
      utf16Start: pStart,
      utf16End: docSource.length,
      page: 1,
      xPt: 72,
      yPt: 120,
      widthPt: 200,
      heightPt: 11,
    },
  ]);
  check(
    res.mapped === 2 &&
      hEl.getAttribute("data-line") === "1" &&
      lEl.getAttribute("data-line") === null &&
      pEl.getAttribute("data-line") === "5",
    "annotateTypstLines uses spanMap hints cleanly while leaving #lorem unmapped",
  );
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
