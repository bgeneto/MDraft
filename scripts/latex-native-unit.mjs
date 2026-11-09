// Unit checks for the native LaTeX result adapter.
//
//   node scripts/latex-native-unit.mjs
//
// The Rust runner owns the process and the log; this module only translates its
// facts into the preview's result/error shape. The checks here are the rules
// that must hold before either backend reaches the pane: warning-only output is
// current, a partial PDF is never a success, a cancelled job publishes nothing,
// and a diagnostic points at a line only when the snapshot holds that text.

import { LatexBuildError } from "../src/latex.ts";
import {
  nativeDiagnostics,
  nativeFailureMessage,
  nativeSources,
  nativeToLatex,
} from "../src/latex-native.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const encode = (text) => Buffer.from(text, "utf8").toString("base64");
const pdf = (marker = "PDF") => Buffer.from(`%PDF-1.7\n${marker}\n`).toString("base64");

function snapshot(files = {}) {
  const entries = Object.entries(files);
  return {
    mainFile: "main.tex",
    files: entries.map(([path, text]) => ({ path, data: encode(text) })),
    skipped: [],
    generation: "g",
  };
}

function result(over = {}) {
  return {
    pdf: null,
    partialPdf: null,
    success: false,
    cancelled: false,
    timedOut: false,
    engine: "lualatex",
    distribution: "TeX Live",
    passes: 1,
    log: "",
    logTruncated: false,
    diagnostics: [],
    warningsTruncated: false,
    error: null,
    elapsedMs: 1200,
    ...over,
  };
}

console.log("=== sources ===");
{
  const project = snapshot({
    "chapters/intro.tex": "\\chapter{One}\r\nText\n",
    "main.tex": "\uFEFF\\documentclass{article}",
    "figures/a.png": "not a source",
  });
  const sources = nativeSources(project);
  check(sources.length === 2, "only .tex files become sources", String(sources.length));
  check(sources[0].path === "main.tex", "the main file is first");
  check(!sources[0].source.startsWith("\uFEFF"), "the BOM is removed");
  check(!sources[1].source.includes("\r"), "line endings are normalised");
}

console.log("=== a warning-only build is current ===");
{
  const project = snapshot({ "main.tex": "line one\n\\bad\n" });
  const converted = nativeToLatex(
    result({
      pdf: pdf(),
      success: true,
      diagnostics: [
        { file: "main.tex", line: 2, severity: "warning", message: "Overfull box", code: "box" },
      ],
    }),
    project,
  );
  check(converted.pdf.length > 0, "the PDF bytes survive");
  check(converted.engine === "lualatex", "the engine is carried for Save/Export");
  check(converted.warnings.length === 1, "the warning is visible");
  check(
    converted.warnings[0].lineText === "\\bad",
    "the warning points at the line the compiler read",
    converted.warnings[0].lineText,
  );
}

console.log("=== errors with a partial PDF ===");
{
  const project = snapshot({ "main.tex": "\\begin{document}\n" });
  let thrown = null;
  try {
    nativeToLatex(
      result({
        success: false,
        partialPdf: pdf("partial"),
        diagnostics: [
          { file: "main.tex", line: 1, severity: "error", message: "Missing $", code: "compile" },
        ],
        log: "! Missing $",
        error: "Missing $",
      }),
      project,
    );
  } catch (error) {
    thrown = error;
  }
  check(thrown instanceof LatexBuildError, "a failed build throws LatexBuildError");
  check(thrown?.partialPdf?.length > 0, "the partial PDF is offered, not published");
  check(thrown?.diagnostics.length === 1, "the error is carried");
  check(thrown?.message === "Missing $", "the first error is the message", thrown?.message);
}

console.log("=== cancellation publishes nothing ===");
{
  const project = snapshot({ "main.tex": "x" });
  let thrown = null;
  try {
    nativeToLatex(result({ cancelled: true, partialPdf: pdf(), log: "cancelled" }), project);
  } catch (error) {
    thrown = error;
  }
  check(thrown instanceof LatexBuildError, "a cancelled job throws");
  check(thrown?.partialPdf === null, "a cancelled job never offers bytes");
  check(
    nativeFailureMessage(result({ cancelled: true })) === "Compilation cancelled.",
    "the message says cancelled",
  );
}

console.log("=== truncation and unknown files ===");
{
  const project = snapshot({ "main.tex": "text" });
  const diagnostics = nativeDiagnostics(
    result({
      diagnostics: [
        {
          file: "other.tex",
          line: 4,
          severity: "warning",
          message: "from a package",
          code: "warning",
        },
      ],
    }),
    project,
  );
  check(diagnostics.diagnostics.length === 1, "a diagnostic outside the snapshot is still shown");
  check(diagnostics.diagnostics[0].lineText === "", "it has no line text, so it cannot navigate");
}

console.log("=== failure messages ===");
{
  check(
    nativeFailureMessage(result({ timedOut: true })) === "Compilation timed out.",
    "timeout is named",
  );
  check(
    nativeFailureMessage(result({ error: "Engine missing" })) === "Engine missing",
    "the runner's explanation wins",
  );
  check(
    nativeFailureMessage(result({ success: false, pdf: null, partialPdf: null })) ===
      "The compiler produced no PDF.",
    "no PDF is stated plainly",
  );
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
