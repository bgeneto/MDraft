//! Footnotes, highlight/subscript/superscript and ```math fences in the pure
//! preview pipeline, checked without an application or a DOM.
//!
//!   node scripts/markdown-extensions-unit.mjs
//!
//! Obsidian callouts are a DOM pass (`decorateAlerts`), so `preview:dom`
//! checks them. This suite reads `samples/markdown-extensions.md` and also
//! checks that the incremental paths agree with a full render.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderChunks, renderChunksIncremental } from "../src/preview-render.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sample = fs.readFileSync(path.join(root, "samples/markdown-extensions.md"), "utf8");

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
const html = (data) => data.chunks.join("");
const count = (text, pattern) => text.match(pattern)?.length ?? 0;
// One line anchor per block that renders an element.
const visible = (data) => data.blocks?.filter((block) => !block.silent).length ?? -1;

// ---------------------------------------------------------------------------
// Math fences
// ---------------------------------------------------------------------------

{
  const data = renderChunks("Before\n\n```math\nE = mc^2\n```\n\nAfter", { math: true, map: true });
  check("math fence: one display formula", data.maths.length === 1 && data.maths[0].display);
  check("math fence: body is the fence text", data.maths[0]?.body === "E = mc^2");
  check("math fence: KaTeX rendered it", (data.maths[0]?.html ?? "").includes("katex"));
  check("math fence: no code block left", !html(data).includes("language-math"));
  check("math fence: the block keeps a line anchor", data.lines !== null);

  const tilde = renderChunks("~~~ math\n\\frac{a}{b}\n~~~", { math: true });
  check("math fence: tildes and a spaced info string", tilde.maths[0]?.body === "\\frac{a}{b}");

  const crlf = renderChunks("```math\r\nx^2\r\n```\r\n", { math: true });
  check("math fence: CRLF body", crlf.maths[0]?.body === "x^2");

  const off = renderChunks("```math\nx^2\n```", { math: false });
  check("math fence: math off keeps the code block", html(off).includes("language-math"));

  const quoted = renderChunks("> ```math\n> x^2\n> ```", { math: true });
  check(
    "math fence: inside a quote stays code rather than TeX with `>`",
    quoted.maths.length === 0 && html(quoted).includes("language-math"),
  );

  const listed = renderChunks("- item\n\n  ```math\n  x^2\n  ```", { math: true });
  check("math fence: inside a list item", listed.maths[0]?.body === "x^2");

  const other = renderChunks("```mathematica\nx\n```", { math: true });
  check("math fence: another language is code", other.maths.length === 0);

  const indented = renderChunks("    ```math\n    x\n    ```", { math: true });
  check("math fence: an indented code block is not a fence", indented.maths.length === 0);

  const dollars = renderChunks("```math\n$x$\n```\n\nInline $a^2$.", { math: true });
  check(
    "math fence: dollars inside are TeX, inline math still found",
    dollars.maths.length === 2 && dollars.maths[0].body === "$x$",
  );
}

// ---------------------------------------------------------------------------
// Highlight, subscript, superscript
// ---------------------------------------------------------------------------

const inlineOn = { math: true, highlight: true, subscript: true, superscript: true };
{
  const data = renderChunks("The ==key result== is H~2~O at 10^3^ pascals.", inlineOn);
  const out = html(data);
  check("mark: ==x== is <mark>", out.includes("<mark>key result</mark>"), out);
  check("sub: H~2~O", out.includes("H<sub>2</sub>O"));
  check("sup: 10^3^", out.includes("10<sup>3</sup>"));

  const strike = html(renderChunks("~~Struck~~ and ~~two words~~", inlineOn));
  check("del: ~~x~~ still strikes", strike.includes("<del>Struck</del>"));
  check("del: with a space", strike.includes("<del>two words</del>"));

  const literal = html(renderChunks("2^10 and ~a b~ and ^a b^ and == x ==", inlineOn));
  check("sup: an unclosed caret stays literal", literal.includes("2^10"));
  check("sub: a space inside stays literal", literal.includes("~a b~"));
  check("sup: a space inside stays literal", literal.includes("^a b^"));
  check("mark: space-padded stays literal", literal.includes("== x =="));

  const escaped = html(renderChunks("H\\~2\\~O and \\==x==", inlineOn));
  check("sub: escaped tildes stay literal", !escaped.includes("<sub>"));
  check("mark: an escaped opener stays literal", !escaped.includes("<mark>"));

  const code = renderChunks("`==x== H~2~O`", inlineOn);
  check(
    "inline code keeps its markers",
    code.codes[0]?.text === "==x== H~2~O" && !html(code).includes("<mark>"),
  );

  const nested = html(renderChunks("==**bold** and x^2^==", inlineOn));
  check(
    "mark: holds other inline markup",
    nested.includes("<mark><strong>bold</strong> and x<sup>2</sup></mark>"),
  );

  const heading = html(renderChunks("# H~2~O", inlineOn));
  check("sub: in a heading", heading.includes("H<sub>2</sub>O"));

  const off = html(renderChunks("==a== H~2~O x^2^ ~~d~~", { math: true }));
  check("off: ==a== stays literal", off.includes("==a==") && !off.includes("<mark>"));
  check("off: ~2~ is GitHub strikethrough again", off.includes("<del>2</del>"));
  check("off: ^2^ stays literal", off.includes("x^2^"));
  check("off: ~~d~~ still strikes", off.includes("<del>d</del>"));

  const subOnly = html(renderChunks("H~2~O ==a== x^2^", { subscript: true }));
  check(
    "each preference is independent",
    subOnly.includes("<sub>2</sub>") && !subOnly.includes("<mark>") && !subOnly.includes("<sup>"),
  );

  const mapped = renderChunks("H~2~O is ==water==.", { ...inlineOn, map: true });
  const text = html(mapped);
  check(
    "map: word fragments survive the new tags",
    /<sub><span data-f="\d+">2<\/span><\/sub>/.test(text),
    text,
  );
}

// ---------------------------------------------------------------------------
// Footnotes
// ---------------------------------------------------------------------------

{
  const source =
    "A[^a] b[^b] again[^a] none[^none].\n\n[^a]: First.\n[^b]: Second.\n[^z]: Unused.\n";
  const data = renderChunks(source, { map: true });
  const out = html(data);
  check(
    "footnote: reference is a numbered link",
    /<sup class="footnote-ref"[^>]*><a href="#fn-a" id="fnref-a"[^>]*>1<\/a><\/sup>/.test(out),
    out,
  );
  check("footnote: second label numbered 2", /<a href="#fn-b" id="fnref-b"[^>]*>2<\/a>/.test(out));
  check(
    "footnote: repeated cite keeps its number",
    /<a href="#fn-a" id="fnref-a-2"[^>]*>1<\/a>/.test(out),
  );
  check("footnote: undefined label stays literal", out.includes("[^none]"));
  check("footnote: definitions render nothing in place", !/<p>\[\^a\]/.test(out));
  check("footnote: one section at the end", count(out, /<section class="footnotes"/g) === 1);
  check(
    "footnote: section is the final block",
    /<section class="footnotes"[\s\S]*<\/section>\s*$/.test(out),
  );
  const section = out.slice(out.indexOf('<section class="footnotes"'));
  check(
    "footnote: items in citation order",
    section.indexOf('id="fn-a"') < section.indexOf('id="fn-b"'),
  );
  check("footnote: unused definition is not listed", !section.includes("Unused"));
  check(
    "footnote: back-reference to each cite",
    section.includes('href="#fnref-a"') && section.includes('href="#fnref-a-2"'),
  );
  check(
    "footnote: every block is anchored",
    data.lines !== null && data.lines.length === visible(data),
    `${data.lines?.length}/${data.chunks.length}`,
  );
  check(
    "footnote: definition text is mapped to its source",
    /<li id="fn-a"[^>]*>[\s\S]*<span data-f="\d+">First/.test(section),
    section,
  );

  const reordered = html(renderChunks("[^x]: Defined first.\n\nCite[^x].\n", {}));
  check(
    "footnote: definition before its citation",
    reordered.includes('href="#fn-x"') && reordered.includes("Defined first."),
  );

  const long = html(renderChunks("A[^l]\n\n[^l]: One.\n\n    Two.\n\nAfter.\n", {}));
  const longSection = long.slice(long.indexOf("<section"));
  check(
    "footnote: an indented paragraph joins the note",
    longSection.includes("One.") && longSection.includes("Two."),
  );
  check("footnote: text after the note stays in the body", !longSection.includes("After."));

  const inCode = html(renderChunks("`x[^a]`\n\n```\n[^a]: no\n```\n", {}));
  check(
    "footnote: code is never a footnote",
    !inCode.includes("footnote") && inCode.includes("[^a]: no"),
  );

  // A label holds no whitespace, but quotes and angle brackets are allowed; the
  // id derived from it must keep them out of every attribute.
  const hostile = html(renderChunks('A[^"><b>x</b>]\n\n[^"><b>x</b>]: note\n', {}));
  const attributes = [...hostile.matchAll(/\s(?:id|href)="([^"]*)"/g)].map((m) => m[1]);
  check(
    "footnote: a hostile label cannot break out of an attribute",
    hostile.includes('class="footnote-ref"') &&
      attributes.length >= 4 &&
      attributes.every((value) => /^#?[\w-]+$/.test(value)),
    attributes.join(" "),
  );
  const twins = html(
    renderChunks("A[^a b] and [^a-b] and [^a.b]\n\n[^a-b]: one\n[^a.b]: two\n", {}),
  );
  check(
    "footnote: labels that slug alike get distinct ids",
    new Set([...twins.matchAll(/<li id="([^"]+)"/g)].map((m) => m[1])).size === 2,
  );

  const caseLabel = html(renderChunks("A[^Note].\n\n[^note]: Case-insensitive.\n", {}));
  check("footnote: labels match case-insensitively", caseLabel.includes("Case-insensitive."));

  const math = renderChunks("A[^m]\n\n[^m]: Has $x^2$ and `c`.\n", { math: true });
  const mathOut = html(math);
  check(
    "footnote: math and code placeholders in the note resolve",
    count(mathOut, /@@MATH/g) === math.maths.length &&
      count(mathOut, /@@CODE/g) === math.codes.length,
    `${count(mathOut, /@@MATH/g)}/${math.maths.length}, ${count(mathOut, /@@CODE/g)}/${math.codes.length}`,
  );
}

// ---------------------------------------------------------------------------
// The fixture and the incremental paths
// ---------------------------------------------------------------------------

{
  const options = { ...inlineOn, map: true };
  const full = renderChunks(sample, options);
  const out = html(full);
  check(
    "fixture: every block anchored",
    full.lines !== null && full.lines.length === visible(full),
  );
  check("fixture: footnote section present", out.includes('<section class="footnotes"'));
  check(
    "fixture: math fence rendered",
    full.maths.some((m) => m.display && m.body === "E = mc^2"),
  );
  check("fixture: highlight rendered", out.includes("<mark>"));

  // An edit inside a footnote definition must renumber nothing and update the
  // section; an edit adding a citation must renumber. Both through the
  // incremental entry point, compared with a full render.
  const edits = [
    ["edit note text", sample.replace("one standard atmosphere", "one atmosphere")],
    ["cite a new note first", sample.replace("Water boils", "Note[^alt] water boils")],
    [
      "remove a definition",
      sample.replace("[^alt]: Roughly one degree for every 300 metres.\n", ""),
    ],
    ["edit prose only", sample.replace("Altitude lowers", "Height lowers")],
  ];
  for (const [label, next] of edits) {
    const prev = renderChunks(sample, options);
    const incremental = renderChunksIncremental(sample, prev, next, options);
    const fresh = renderChunks(next, options);
    check(
      `incremental: ${label}`,
      html(incremental) === html(fresh),
      incremental.incremental?.mode ?? "",
    );
  }
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
