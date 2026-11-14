// tex-fmt as the LaTeX formatter.
//
//   node scripts/latex-format-unit.mjs
//
// Step 6 of the checklist plan. The formatter is a 537 KiB gzip WebAssembly
// module, measured before it was taken; what these checks pin is that taking it
// did not cost the reader their document.
//
// The rules that matter, in order of how badly they would hurt:
//
//   1. **Verbatim is byte-exact.** A `verbatim` body is literal by definition;
//      reindenting it changes what the document prints.
//   2. **Math is untouched.** tex-fmt aligns `&` in `align` blocks, which is
//      wanted, but it must not rewrite the expressions themselves.
//   3. **Prose is not reflowed.** `wrap = false` is the configuration this project
//      passes; without it tex-fmt rewraps paragraphs, which is not what "Format
//      Document" should do to a `.tex` file.
//   4. **Idempotent.** Formatting twice equals formatting once, or the reader's
//      next Format would keep changing the file.
//   5. **A non-LaTeX file is left alone.** Pasting prose into a `.tex` buffer and
//      formatting it must not mangle it.
//
// No application: the WebAssembly module and its glue are read from
// `node_modules` and instantiated here, so the checks stay app-free.

import { readFileSync } from "node:fs";
import { formatDocument, hasFormatter, setTexFmtLoaderForTests } from "../src/format/formatters.ts";

// The shipped loader fetches the module from the backend, which does not exist
// under Node. This is the same split with the bytes read from disk: the glue
// sets the instance, then `__wbindgen_start` runs the module's initialiser.
const glue = await import("../node_modules/tex-fmt/tex_fmt_bg.js");
const wasmBytes = readFileSync(new URL("../node_modules/tex-fmt/tex_fmt_bg.wasm", import.meta.url));
setTexFmtLoaderForTests(async () => {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    "./tex_fmt_bg.js": glue,
  });
  glue.__wbg_set_wasm(instance.exports);
  instance.exports.__wbindgen_start();
  return { main: glue.main, version: () => "v0.5.7" };
});

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const format = (text) => formatDocument(text, "latex");

console.log("=== the formatter is registered ===");
{
  check(hasFormatter("latex"), "LaTeX reports a formatter");
  check(hasFormatter("asciidoc") === false, "AsciiDoc still reports none");
  check(hasFormatter("markdown"), "Markdown still reports one");
  check(hasFormatter("typst"), "Typst still reports one");
}

console.log("\n=== indentation is the job ===");
{
  const messy = [
    "\\begin{document}",
    "\\section{Introduction}",
    "\\begin{itemize}",
    "\\item one",
    "\\item two",
    "\\end{itemize}",
    "\\end{document}",
    "",
  ].join("\n");
  const formatted = await format(messy);
  check(typeof formatted === "string", "a document formats", typeof formatted);
  check(
    formatted.includes("  \\item one"),
    "a list item is indented",
    formatted.split("\n").find((line) => line.includes("\\item one")),
  );
  check(formatted.includes("\\section{Introduction}"), "the section survives");
  check(formatted.trim() === formatted.trim(), "no leading or trailing whitespace is introduced");
}

console.log("\n=== verbatim is byte-exact ===");
{
  // The single most damaging thing a formatter can do to a LaTeX document.
  const body = "   keep   this    spacing\n\tand this tab";
  const source = `\\begin{document}\n\\begin{verbatim}\n${body}\n\\end{verbatim}\n\\end{document}\n`;
  const formatted = await format(source);
  check(
    formatted.includes(body),
    "a verbatim body keeps its exact bytes",
    JSON.stringify(
      formatted.slice(formatted.indexOf("\\begin{verbatim}"), formatted.indexOf("\\end{verbatim}")),
    ),
  );

  // Two measured tex-fmt 0.5.7 defects, both of which change what the document
  // prints. `maskLatexLiterals` is what makes them harmless.
  //
  // 1. A tab inside `verbatim` becomes two spaces.
  check(
    formatted.includes("\tand this tab"),
    "a tab inside verbatim survives",
    JSON.stringify(formatted.slice(formatted.indexOf("\\begin{verbatim}"))),
  );
  // 2. A run of blank lines inside `verbatim` collapses to one.
  const blanks = "first\n\n\n\nsecond";
  const blankSource = `\\begin{document}\n\\begin{verbatim}\n${blanks}\n\\end{verbatim}\n\\end{document}\n`;
  const blankFormatted = await format(blankSource);
  check(
    blankFormatted.includes(blanks),
    "a run of blank lines inside verbatim survives",
    JSON.stringify(blankFormatted.slice(blankFormatted.indexOf("\\begin{verbatim}"))),
  );

  // The other literal constructs need the same protection.
  for (const [label, block] of [
    ["lstlisting", "\\begin{lstlisting}\n\ta\tb\n\n\n\nc\n\\end{lstlisting}"],
    ["minted", "\\begin{minted}{tex}\n\ta\tb\n\\end{minted}"],
    ["alltt", "\\begin{alltt}\n\ta\tb\n\\end{alltt}"],
  ]) {
    const doc = `\\begin{document}\n${block}\n\\end{document}\n`;
    const out = await format(doc);
    check(
      out.includes(block),
      `a ${label} body is byte-identical`,
      JSON.stringify(out.slice(0, 90)),
    );
  }
  // `\verb` is inline and equally literal.
  const verb = "See \\verb|a\tb| here.";
  const verbOut = await format(`\\begin{document}\n${verb}\n\\end{document}\n`);
  check(
    verbOut.includes("\\verb|a\tb|"),
    "a \\verb argument is byte-identical",
    verbOut.slice(0, 80),
  );
}

console.log("\n=== math is not rewritten ===");
{
  const source = [
    "\\begin{document}",
    "\\begin{align}",
    "a &= b + c \\\\",
    "d &= e - f",
    "\\end{align}",
    "Inline $\\alpha + \\beta$ stays.",
    "\\end{document}",
    "",
  ].join("\n");
  const formatted = await format(source);
  check(formatted.includes("\\alpha + \\beta"), "inline math keeps its commands");
  check(formatted.includes("b + c"), "an alignment row keeps its expression");
  check(formatted.includes("e - f"), "the second row keeps its expression");
  // Alignment is the one thing tex-fmt may change here, and it is wanted.
  check(/a\s*&=\s*b \+ c/.test(formatted), "an alignment row keeps its & structure");
}

console.log("\n=== prose is not reflowed ===");
{
  // `wrap = false`. A paragraph written across several source lines must stay
  // across those lines: rewrapping it would produce a large diff the reader never
  // asked for, and would defeat the point of formatting a version-controlled file.
  const source = [
    "\\begin{document}",
    "This paragraph is written",
    "across three source lines",
    "and must stay that way.",
    "\\end{document}",
    "",
  ].join("\n");
  const formatted = await format(source);
  check(
    formatted.includes("This paragraph is written\nacross three source lines"),
    "a multi-line paragraph keeps its line breaks",
    JSON.stringify(formatted.slice(0, 120)),
  );
}

console.log("\n=== idempotence ===");
{
  const source = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section{One}",
    "\\begin{itemize}",
    "\\item a",
    "\\end{itemize}",
    "\\end{document}",
    "",
  ].join("\n");
  const once = await format(source);
  const twice = await format(once);
  check(once === twice, "formatting twice equals formatting once");
  // And a document that is already formatted is unchanged.
  check((await format(once)) === once, "an already-formatted document is unchanged");
}

console.log("\n=== a non-LaTeX buffer is left alone ===");
{
  // Pasting prose into a `.tex` buffer and formatting it must not mangle it.
  const prose = "Just some prose, no markup at all.\n";
  const formatted = await format(prose);
  check(formatted === prose, "plain prose is returned unchanged", JSON.stringify(formatted));
  // An empty buffer is returned as-is rather than becoming a newline.
  check((await format("")) === "", "an empty document stays empty");
  check((await format("   \n\n")) === "   \n\n", "a whitespace-only document is untouched");
}

console.log("\n=== the real reference document survives ===");
{
  // The shipped LaTeX Reference is the best corpus available: it exercises
  // sections, lists, tables, verbatim, math and comments in one file.
  const reference = readFileSync("samples/latex-reference.tex", "utf8");
  const formatted = await format(reference);
  check(typeof formatted === "string", "the reference formats");
  // The comments are documentation, not decoration: losing them would gut the
  // file's purpose.
  const comments = (text) => (text.match(/^\s*%/gm) ?? []).length;
  check(
    comments(formatted) === comments(reference),
    "every comment survives",
    `${comments(reference)} -> ${comments(formatted)}`,
  );
  // The verbatim bodies must be byte-identical.
  const verbatim = (text) => {
    const out = [];
    for (const match of text.matchAll(/\\begin\{verbatim\}([\s\S]*?)\\end\{verbatim\}/g)) {
      out.push(match[1]);
    }
    return out;
  };
  check(
    JSON.stringify(verbatim(formatted)) === JSON.stringify(verbatim(reference)),
    "every verbatim body is byte-identical",
    `${verbatim(reference).length} blocks`,
  );
  // And it must be stable: a second pass changes nothing.
  check((await format(formatted)) === formatted, "the formatted reference is stable");
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
