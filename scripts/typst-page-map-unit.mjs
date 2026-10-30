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

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
