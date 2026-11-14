// Unit tests for the encoding catalogue and encoding declarations.
//
//   node scripts/encoding-unit.mjs
//
// No application and no build: `src/encodings.ts` has no imports, and Node 24
// strips the types.
//
// What it is for: the encoding dialog offers exactly the encodings Rust can
// decode (`text_encoding::OFFERED`), names them for the status bar, and finds
// the `inputenc`, `<meta charset>` and XML declarations a conversion must keep
// consistent. A declaration found at the wrong offset would rewrite the wrong
// characters, so the offsets are checked against the text itself.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalDeclared,
  declarationReplacement,
  displayEncoding,
  ENCODING_GROUPS,
  findDeclarations,
} from "../src/encodings.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

// ---- Catalogue ------------------------------------------------------------
const rust = fs.readFileSync(path.join(root, "src-tauri/src/text_encoding.rs"), "utf8");
const offeredBlock = /pub const OFFERED: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? "";
const offered = [...offeredBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const catalogue = ENCODING_GROUPS.flatMap((group) => group.encodings.map((info) => info.label));
check(offered.length > 30, "the Rust OFFERED list is readable", `${offered.length} labels`);
check(
  JSON.stringify([...offered].sort()) === JSON.stringify([...catalogue].sort()),
  "the dialog catalogue lists exactly the encodings Rust offers",
  `missing: ${offered.filter((label) => !catalogue.includes(label)).join(", ") || "none"}; extra: ${
    catalogue.filter((label) => !offered.includes(label)).join(", ") || "none"
  }`,
);
check(new Set(catalogue).size === catalogue.length, "no encoding is listed twice");

check(displayEncoding("windows-1252") === "Windows-1252", "Windows-1252 keeps its status-bar name");
check(displayEncoding("UTF-16LE") === "UTF-16 LE", "UTF-16 LE keeps its status-bar name");
check(displayEncoding("macintosh") === "Mac Roman", "macintosh is shown as Mac Roman");
check(displayEncoding("x-unknown") === "x-unknown", "an unknown label is shown as is");

// ---- Aliases --------------------------------------------------------------
check(canonicalDeclared("latin1") === "windows-1252", "latin1 is Windows-1252 (WHATWG)");
check(canonicalDeclared("ISO-8859-1") === "windows-1252", "ISO-8859-1 is Windows-1252");
check(canonicalDeclared("utf8") === "UTF-8", "utf8 is UTF-8");
check(canonicalDeclared("Shift_JIS") === "Shift_JIS", "a canonical label maps to itself");
check(canonicalDeclared("ansinew") === "windows-1252", "ansinew is Windows-1252");

// ---- LaTeX ----------------------------------------------------------------
const slice = (text, declaration) => text.slice(declaration.from, declaration.to);
{
  const text =
    "\\documentclass{article}\n% \\usepackage[cp1251]{inputenc}\n\\usepackage[T1]{fontenc}\n" +
    "\\RequirePackage[ latin1 ]{inputenc}\n\\usepackage[utf8x, mathletters]{ucs}\n";
  const found = findDeclarations(text, "latex");
  check(found.length === 1, "a commented-out inputenc is ignored", JSON.stringify(found));
  check(
    found[0] && slice(text, found[0]) === "latin1" && found[0].declared === "latin1",
    "the inputenc option is located exactly",
  );
  check(
    found[0] && declarationReplacement(found[0], "UTF-8") === "utf8",
    "latin1 becomes utf8 for a UTF-8 target",
  );
  check(
    found[0] && declarationReplacement(found[0], "windows-1252") === null,
    "latin1 already agrees with Windows-1252",
  );
  check(
    found[0] && declarationReplacement(found[0], "Shift_JIS") === null,
    "a target without an inputenc name is not rewritten",
  );
}
{
  const text = "\\usepackage[escaped\\%, utf8]{inputenc}";
  const found = findDeclarations(text, "latex");
  check(
    found.length === 1 && slice(text, found[0]) === "utf8",
    "an escaped percent sign is not a comment",
  );
}
check(
  findDeclarations("\\usepackage[T1]{fontenc}", "latex").length === 0,
  "fontenc is not inputenc",
);
check(
  findDeclarations('<meta charset="utf-8">', "markdown").length === 0,
  "Markdown has no declarations to rewrite",
);

// ---- HTML -----------------------------------------------------------------
{
  const text =
    '<?xml version="1.0" encoding="ISO-8859-1"?>\n<html><head>\n<META CHARSET=WINDOWS-1252>\n' +
    '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">\n';
  const found = findDeclarations(text, "html");
  check(found.length === 3, "XML prolog, meta charset and http-equiv are all found");
  check(
    found.map((declaration) => slice(text, declaration)).join("|") ===
      "ISO-8859-1|WINDOWS-1252|iso-8859-1",
    "every HTML declaration is located exactly",
  );
  check(
    declarationReplacement(found[1], "UTF-8") === "UTF-8" &&
      declarationReplacement(found[2], "UTF-8") === "utf-8",
    "the replacement keeps the declaration's letter case",
  );
  check(
    declarationReplacement(found[0], "UTF-16LE") === null,
    "UTF-16 HTML is not declared by name",
  );
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
