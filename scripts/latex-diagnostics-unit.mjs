// Unit checks for the LaTeX diagnostic mapper.
//
//   node scripts/latex-diagnostics-unit.mjs
//
// The mapper turns the scan's 1-based line and UTF-16 column into CodeMirror
// offsets. It must never paint a wrong range: when the buffer no longer contains
// the command the compile saw, the line is marked as stale instead of trusting
// the old column. No application and no LaTeX engine.

import { diagnosticPlace, diagnosticRange, diagnosticSignature } from "../src/latex-diagnostics.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** A diagnostic with the fields the mapper reads. */
function diagnostic(over = {}) {
  return {
    file: "main.tex",
    line: 1,
    column: 0,
    endColumn: 0,
    severity: "error",
    code: "missing-reference",
    message: "Missing project file",
    text: "",
    lineText: "",
    searched: [],
    ...over,
  };
}

console.log("=== an exact command range ===");
{
  const command = "\\includegraphics{gone.png}";
  const text = `first\n${command}\nlast`;
  const range = diagnosticRange(
    text,
    diagnostic({ line: 2, column: 1, endColumn: command.length + 1, text: command }),
  );
  check(range !== null, "a line inside the document maps", String(range));
  check(range.from === 6, "the start is the beginning of line 2", String(range.from));
  check(
    text.slice(range.from, range.to) === command,
    "the slice is exactly the compiled command",
    JSON.stringify(text.slice(range.from, range.to)),
  );
  check(range.stale === false, "an exact match is not stale");
}

console.log("\n=== a command that moved on the line ===");
{
  // The reader typed before the command, so the recorded column is now wrong.
  const command = "\\includegraphics{gone.png}";
  const text = `first\nprefix ${command}\nlast`;
  const range = diagnosticRange(
    text,
    diagnostic({ line: 2, column: 1, endColumn: command.length + 1, text: command }),
  );
  check(range !== null, "a moved command still maps", String(range));
  check(
    range.from === 13 && text.slice(range.from, range.to) === command,
    "the mapper searches the line for the compiled text",
    JSON.stringify(text.slice(range.from, range.to)),
  );
  check(range.stale === false, "finding it is not stale");
}

console.log("\n=== a line the reader rewrote ===");
{
  const command = "\\includegraphics{gone.png}";
  const text = `first\n% ${command}\nlast`;
  const range = diagnosticRange(
    text,
    diagnostic({ line: 2, column: 1, endColumn: command.length + 1, text: command }),
  );
  // The commented text still contains the command, so the mapper finds it. The
  // honest answer is "this is what the last compile saw", but the range itself
  // is exact; stale is reserved for text that is gone.
  check(
    range !== null && text.slice(range.from, range.to) === command,
    "a comment keeps the command findable",
  );
  const gone = diagnosticRange(
    "first\nnothing here\nlast",
    diagnostic({ line: 2, column: 1, endColumn: 4, text: command }),
  );
  check(gone !== null && gone.stale === true, "a vanished command marks the line as stale");
  check(
    gone.from === 6 && gone.to === 18,
    "the stale range covers the whole line",
    `${gone.from}..${gone.to}`,
  );
}

console.log("\n=== a line-only compiler diagnostic ===");
{
  const text = "first\n\\undefined\nlast";
  const range = diagnosticRange(
    text,
    diagnostic({ line: 2, column: 0, endColumn: 0, text: "", code: "compile:tex-error" }),
  );
  check(range !== null, "a compiler diagnostic maps", String(range));
  check(range.stale === false, "a whole-line diagnostic is not stale");
  check(
    range.from === 6 && range.to === 16,
    "the whole line is the range",
    `${range.from}..${range.to}`,
  );
}

console.log("\n=== the document edge ===");
{
  check(
    diagnosticRange("one\ntwo", diagnostic({ line: 3 })) === null,
    "a line past the end maps to nothing",
  );
  const empty = diagnosticRange("one\n\ntwo", diagnostic({ line: 2, column: 0, endColumn: 0 }));
  check(
    empty !== null && empty.from === empty.to && empty.lineFrom === 4,
    "an empty line still carries a line position",
    JSON.stringify(empty),
  );
}

console.log("\n=== Unicode counts the way CodeMirror does ===");
{
  const command = "\\includegraphics{x.png}";
  const text = `ção ${command}`;
  const range = diagnosticRange(
    text,
    diagnostic({ line: 1, column: 5, endColumn: 5 + command.length, text: command }),
  );
  check(
    range !== null && text.slice(range.from, range.to) === command,
    "a column after an accented prefix is UTF-16 exact",
    JSON.stringify(range && text.slice(range.from, range.to)),
  );
}

console.log("\n=== the panel strings ===");
{
  check(diagnosticPlace(diagnostic({ line: 42 })) === "main.tex:42", "file and line");
  check(diagnosticPlace(diagnostic({ line: 0 })) === "main.tex", "file without a line");
  check(diagnosticPlace(diagnostic({ file: "", line: 3 })) === "line 3", "a line without a file");
  const one = diagnosticSignature(diagnostic());
  const two = diagnosticSignature(diagnostic({ line: 2 }));
  check(one !== two, "the signature changes with the line");
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
