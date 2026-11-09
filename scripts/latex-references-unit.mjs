// Unit checks for the LaTeX reference validator.
//
//   node scripts/latex-references-unit.mjs
//
// The validator decides whether a project's `\input`/`\include`/
// `\includegraphics`/`\bibliography` references are literal paths the snapshot
// can resolve. Its rule is right; its tokenizer was not, and it rejected the
// shipped LaTeX Reference — a document the application itself offers under Help.
// These checks pin every false-positive class that caused it, and the real
// rejections that must survive.
//
// No application: the validator is pure over a source map and a file set.

import { readFileSync } from "node:fs";
import { collectLatexReferences, validateLatexReferences } from "../src/latex.ts";
import {
  hasUnparsedReference,
  isLiteralReference,
  maskLiteralRegions,
  referencesIn,
} from "../src/latex-references.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Run the validator and report the message, or null when it accepts. */
function validate(text, files = ["main.tex"]) {
  try {
    validateLatexReferences(new Map([["main.tex", text]]), new Set(files), "main.tex");
    return null;
  } catch (error) {
    return error.message;
  }
}

console.log("=== the shipped LaTeX Reference must compile ===");
{
  const text = "\\graphicspath{{missing/}{./figures/}}\n\\begin{document}\n\\includegraphics{plot}";
  check(
    validate(text, ["main.tex", "figures/plot.png"]) === null,
    "literal preamble graphics paths resolve",
  );
  const missing = collectLatexReferences(
    new Map([["main.tex", text]]),
    new Set(["main.tex"]),
    "main.tex",
  );
  check(
    missing.diagnostics[0]?.searched.includes("figures/plot.png"),
    "missing image lists graphics paths",
  );
  check(
    validate("% \\graphicspath{{figures/}}\n\\includegraphics{plot}", [
      "main.tex",
      "figures/plot.png",
    ]) !== null,
    "commented graphics paths are ignored",
  );
  check(
    validate("\\graphicspath{{../figures/}}\n\\includegraphics{plot}", [
      "main.tex",
      "../figures/plot.png",
    ]) !== null,
    "unsafe graphics paths are ignored",
  );
  check(
    validate("\\graphicspath{{old/}}\\graphicspath{{new/}}\\includegraphics{plot}", [
      "main.tex",
      "old/plot.png",
    ]) !== null,
    "a later graphics path replaces the earlier list",
  );
}
{
  // The regression this file exists for. Help › LaTeX Reference opens a document
  // whose examples *show* `\input` and `\bibliography` as source; saving a copy is
  // normal, and the copy must compile.
  const text = readFileSync("samples/latex-reference.tex", "utf8");
  const error = validate(text, ["main.tex"]);
  check(error === null, "the built-in reference validates", error ?? "accepted");
}

console.log("\n=== literal regions are not references ===");
{
  // `\verb` is literal text by definition, whatever it contains.
  const cases = [
    ["\\verb|\\input{chapters/intro}|", "\\verb with \\input"],
    ["\\verb*|\\includegraphics{figures/plot}|", "\\verb* with \\includegraphics"],
    ["\\verb|\\bibliography{refs}|", "\\verb with \\bibliography"],
    ["\\verb|\\include{chapter}|", "\\verb with \\include"],
    ["\\verb|\\addbibresource{refs.bib}|", "\\verb with \\addbibresource"],
    ["\\lstinline|\\input{chapters/intro}|", "\\lstinline with \\input"],
    ["\\lstinline[language=TeX]|\\includegraphics{x}|", "\\lstinline with options"],
    ["\\mintinline{tex}|\\input{chapters/intro}|", "\\mintinline with \\input"],
    // The brace forms are the same construct. They were documented as covered
    // but were not: a flat `[^{}]*` could not match a body that contains braces,
    // so `\lstinline{\input{x}}` was read as live markup and rejected.
    ["\\lstinline{\\input{chapters/intro}}", "\\lstinline brace form"],
    ["\\lstinline[language=TeX]{\\input{chapters/intro}}", "\\lstinline brace form with options"],
    ["\\mintinline{tex}{\\input{chapters/intro}}", "\\mintinline brace form"],
    ["\\lstinline{\\section{x}}", "a brace form whose body contains braces"],
  ];
  for (const [source, label] of cases) {
    check(validate(source) === null, `${label} is not a reference`, validate(source) ?? "accepted");
  }
}

console.log("\n=== verbatim environments are not references ===");
{
  for (const environment of [
    "verbatim",
    "verbatim*",
    "Verbatim",
    "lstlisting",
    "minted",
    "alltt",
  ]) {
    const source =
      environment === "minted"
        ? `\\begin{minted}{tex}\n\\input{chapters/intro}\n\\end{minted}`
        : `\\begin{${environment}}\n\\input{chapters/intro}\n\\end{${environment}}`;
    check(
      validate(source) === null,
      `a ${environment} body is not a reference`,
      validate(source) ?? "accepted",
    );
  }
}

console.log("\n=== prose that mentions a command is not a call ===");
{
  // `\texttt{\input}` names the command; it does not call it. The leftover check
  // used to reject this as a non-literal reference.
  check(
    validate("Write \\texttt{\\input} to include a file.") === null,
    "\\texttt{\\input} in prose is not a reference",
    validate("Write \\texttt{\\input} to include a file.") ?? "accepted",
  );
  check(
    validate("The \\includegraphics command takes a path.") === null,
    "a bare \\includegraphics mention is not a reference",
    validate("The \\includegraphics command takes a path.") ?? "accepted",
  );
}

console.log("\n=== dead code is not a reference ===");
{
  check(
    validate("\\iffalse\n\\input{chapters/intro}\n\\fi") === null,
    "an \\iffalse block is not a reference",
    validate("\\iffalse\n\\input{chapters/intro}\n\\fi") ?? "accepted",
  );
  check(
    validate("% \\input{chapters/intro}") === null,
    "a commented-out reference is not a reference",
    validate("% \\input{chapters/intro}") ?? "accepted",
  );
  check(
    validate("50\\% of \\input{chapter}") !== null,
    "a reference after an escaped percent is still real",
  );
  // The reported document had this exact shape: `%` immediately followed by
  // `\includegraphics`, two figures in one file. It must be accepted, or the
  // reader cannot tell a comment from a live reference.
  check(
    validate(
      "\\begin{figure}\n\\centering\n%\\includegraphics[width=\\textwidth]{arquitetura.png}\n\\caption{x}\n\\end{figure}",
    ) === null,
    "a line beginning with % and no space is a comment",
    validate(
      "\\begin{figure}\n\\centering\n%\\includegraphics[width=\\textwidth]{arquitetura.png}\n\\caption{x}\n\\end{figure}",
    ) ?? "accepted",
  );
  // `\\%` is a line break followed by a comment, not an escaped percent. The
  // odd/even backslash rule was the bug: a single-character test kept the whole
  // line and scanned the command after it.
  check(
    validate("a\\\\% \\input{chapters/intro}") === null,
    "a comment after a double backslash is a comment",
    validate("a\\\\% \\input{chapters/intro}") ?? "accepted",
  );
  check(
    validate("\\begin{comment}\n\\input{chapters/intro}\n\\end{comment}") === null,
    "the comment environment is not a reference",
    validate("\\begin{comment}\n\\input{chapters/intro}\n\\end{comment}") ?? "accepted",
  );
  check(
    validate("\\begin{filecontents}{x.bib}\n@book{a}\n\\end{filecontents}") === null,
    "a filecontents body is not a reference",
    validate("\\begin{filecontents}{x.bib}\n@book{a}\n\\end{filecontents}") ?? "accepted",
  );
}

console.log("\n=== real references still resolve, and still fail when missing ===");
{
  const withFile = validate("\\input{chapter}", ["main.tex", "chapter.tex"]);
  check(withFile === null, "an existing \\input resolves", withFile ?? "accepted");

  const missing = validate("\\input{chapter}");
  check(
    missing !== null && missing.includes("Missing project file"),
    "a missing \\input is reported",
    missing ?? "accepted",
  );

  const image = validate("\\includegraphics{figures/plot}", ["main.tex", "figures/plot.png"]);
  check(image === null, "an image resolves through its extension", image ?? "accepted");

  const bib = validate("\\bibliography{refs}", ["main.tex", "refs.bib"]);
  check(bib === null, "a bibliography resolves", bib ?? "accepted");

  const commaBib = validate("\\bibliography{one,two}", ["main.tex", "one.bib", "two.bib"]);
  check(commaBib === null, "a comma-separated bibliography resolves", commaBib ?? "accepted");
}

console.log("\n=== non-literal and unsafe references are still rejected ===");
{
  const macro = validate("\\input{\\mypath}");
  check(macro !== null, "a macro path is rejected", macro ?? "accepted");
  check(
    macro !== null && /non-literal|Unsupported/.test(macro),
    "the macro rejection names the reason",
    macro ?? "",
  );

  for (const [source, label] of [
    ["\\input{../escape}", "a parent-directory escape"],
    ["\\input{/absolute}", "an absolute path"],
    ["\\input{a//b}", "an empty path segment"],
    ["\\includegraphics{https://example.com/x.png}", "a URL"],
  ]) {
    check(validate(source) !== null, `${label} is rejected`);
  }
}

console.log("\n=== masking preserves offsets ===");
{
  // Line numbers computed from a masked text must match the original, or an error
  // message would point at the wrong line.
  const text = "\\verb|\\input{x}|\n\\input{real}\n\\begin{verbatim}\n\\input{y}\n\\end{verbatim}";
  const masked = maskLiteralRegions(text);
  check(
    masked.split("\n").length === text.split("\n").length,
    "masking keeps the line count",
    `${masked.split("\n").length} vs ${text.split("\n").length}`,
  );
  check(
    masked.split("\n").every((line, index) => line.length === text.split("\n")[index].length),
    "masking keeps each line's length",
  );
  check(!masked.includes("\\input{x}"), "the \\verb content is blanked");
  check(masked.includes("\\input{real}"), "the real reference survives");
}

console.log("\n=== the helpers behave on their own ===");
{
  check(isLiteralReference("figures/plot"), "a plain path is literal");
  check(!isLiteralReference(""), "an empty path is not literal");
  check(!isLiteralReference("\\macro"), "a macro is not literal");
  check(!isLiteralReference("a:b"), "a colon is not literal");
  check(!isLiteralReference("../up"), "a parent escape is not literal");

  const refs = referencesIn("\\input{a}\n\\includegraphics[width=1cm]{b.png}", "main.tex");
  check(refs.length === 2, "two references are found", String(refs.length));
  check(refs[0].kind === "input" && refs[0].name === "a", "the first is an input");
  check(refs[1].kind === "includegraphics" && refs[1].name === "b.png", "the second is an image");

  // `hasUnparsedReference` catches a command that has an argument the pattern
  // could not parse. A command with **no** argument is prose about the command,
  // not a call, so it is deliberately not flagged — that was one of the false
  // positives that rejected the shipped reference. A macro inside a well-formed
  // argument is caught by `isLiteralReference` instead, so the helpers cover
  // different failures.
  check(!hasUnparsedReference("\\input"), "a bare mention with no argument is not a call");
  check(hasUnparsedReference("\\input{a"), "an unbalanced reference is detected");
  check(!hasUnparsedReference("\\input{a}"), "a parsed reference is not flagged");
  check(
    !hasUnparsedReference("\\input{\\m}"),
    "a macro argument parses and is judged by isLiteralReference",
  );
  check(!isLiteralReference("\\m"), "a macro argument is not literal");
}

console.log("\n=== every occurrence is reported, with its line ===");
{
  // The reported document had two figures, both commented. If one line were
  // still live, the old validator threw the same message again and the reader
  // could not tell which figure it meant. The list must separate them.
  const source = [
    "first",
    "%\\includegraphics{gone.png}",
    "\\includegraphics{gone.png}",
    "second",
    "\\includegraphics{gone.png}",
  ].join("\n");
  const scan = collectLatexReferences(
    new Map([["main.tex", source]]),
    new Set(["main.tex"]),
    "main.tex",
  );
  check(
    scan.diagnostics.length === 2,
    "two live occurrences are two diagnostics",
    String(scan.diagnostics.length),
  );
  check(
    scan.diagnostics[0].line === 3 && scan.diagnostics[1].line === 5,
    "the commented line is skipped and the live lines are named",
    scan.diagnostics.map((entry) => entry.line).join(","),
  );
  check(
    scan.diagnostics[0].lineText === "\\includegraphics{gone.png}",
    "the compiled line is captured for the panel",
    scan.diagnostics[0].lineText,
  );
  check(
    scan.diagnostics[0].text === "\\includegraphics{gone.png}",
    "the command is captured for the mark",
    scan.diagnostics[0].text,
  );
  check(
    scan.diagnostics[0].column === 1 &&
      scan.diagnostics[0].endColumn === "\\includegraphics{gone.png}".length + 1,
    "the command span is 1-based and exact",
    `${scan.diagnostics[0].column}..${scan.diagnostics[0].endColumn}`,
  );
  check(
    scan.diagnostics[0].message.includes("gone.png"),
    "the message still names the missing file",
    scan.diagnostics[0].message,
  );
}

{
  const line = "\\verb|literal| \\includegraphics{gone.png}";
  const scan = collectLatexReferences(new Map([["main.tex", line]]), new Set(["main.tex"]));
  check(
    scan.diagnostics[0]?.lineText === line,
    "diagnostics retain the original line when literal regions are masked",
  );
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
