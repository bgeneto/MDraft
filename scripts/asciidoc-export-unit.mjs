// AsciiDoc -> HTML for pandoc, without the application.
//
//   node scripts/asciidoc-export-unit.mjs
//
// The export renderer is the part of the pandoc path that fixes the reported
// PDF: pandoc's own AsciiDoc reader prints `:toc!:` and every attribute below
// it as prose, while Asciidoctor resolves the document first. Node 24 strips
// the TypeScript types, and the renderer has no DOM dependency, so this suite
// can pin that contract without a window.
//
// What it reads: the same include jail the preview uses, the PDF backend's
// conditionals, attribute substitution, LaTeX and AsciiMath. The one thing it
// cannot measure is DOMPurify, which wraps the renderer inside the webview; the
// preview suite covers the shared sanitiser profile.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderAsciidocForPandoc } from "../src/asciidoc-render.ts";

let passed = 0;
let total = 0;
function check(ok, label, detail = "") {
  total += 1;
  if (ok) passed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const workDir = mkdtempSync(join(process.cwd(), ".tmp-asciidoc-export-"));
const document = `= Física 1 - Lista extra
:doctype: article
:lang: pt-BR
:encoding: utf-8
:toc!:
:sectnums!:
:icons!:
:pdf-page-size: A4
:pdf-theme: {docdir}/fisica-theme.yml
:instituicao: Universidade de Brasília
:unidade: Faculdade UnB Planaltina
:valor-total: 10,0
:instrucoes: Use caneta azul ou preta.

ifdef::backend-pdf[]
:notitle:
endif::[]
ifndef::backend-pdf[]
:nofooter:
endif::[]
ifdef::backend-html5[]
HTML-ONLY-MARKER
endif::[]

{instituicao} / {valor-total}

include::part.adoc[]

Inline latexmath:[x^2] and inline asciimath:[sqrt(9) = 3].

[latexmath]
++++
\\int_0^1 x^2\\,dx = \\frac{1}{3}
++++

[asciimath]
++++
sqrt(4) = 2
x + y
++++
`;

try {
  writeFileSync(join(workDir, "part.adoc"), "Included *text* for {instituicao}.\n", "utf8");
  // The parent is inside the workspace but outside the document directory, so
  // the include processor must refuse it before calling readFile.
  const outside = join(workDir, "..", "outside-asciidoc-export.adoc");
  writeFileSync(outside, "OUTSIDE-MARKER\n", "utf8");

  const reads = [];
  const html = await renderAsciidocForPandoc(document, {
    baseDir: workDir,
    readFile: async (path) => {
      reads.push(path);
      return readFileSync(path, "utf8");
    },
  });

  console.log("=== document attributes ===");
  check(
    html.includes("<h1>Física 1 - Lista extra</h1>"),
    "the document title is rendered",
    html.includes("<h1>") ? "title found" : "no <h1>",
  );
  check(
    !/:toc!|:sectnums!|:icons!|:pdf-page-size|:pdf-theme/.test(html),
    "unset and PDF-only attributes do not leak into prose",
    html.slice(0, 120),
  );
  check(
    html.includes("Universidade de Brasília / 10,0"),
    "document attributes are substituted",
    html.includes("Universidade de Brasília") ? "value present" : "value missing",
  );
  check(
    !html.includes("HTML-ONLY-MARKER"),
    "backend-html5 conditionals are excluded from the PDF render",
  );
  check(
    !html.includes(":notitle:") && !html.includes(":nofooter:"),
    "attribute entries inside PDF conditionals are consumed",
  );

  console.log("\n=== includes ===");
  check(
    html.includes("Included <strong>text</strong> for Universidade de Brasília."),
    "an include is expanded and its attributes are resolved",
    reads[0] ?? "readFile was not called",
  );
  check(reads.length === 1, "only the include is read through readFile", `${reads.length} read(s)`);

  const outsideReads = [];
  const refused = await renderAsciidocForPandoc("= Refused\n\ninclude::../outside-asciidoc-export.adoc[]\n", {
    baseDir: workDir,
    readFile: async (path) => {
      outsideReads.push(path);
      return "OUTSIDE-MARKER";
    },
  });
  check(
    outsideReads.length === 0 && !refused.includes("OUTSIDE-MARKER"),
    "an include outside the document directory is not read",
    `${outsideReads.length} read(s)`,
  );
  check(
    refused.includes("outside the document directory"),
    "the refused include is explained in the output",
  );

  console.log("\n=== mathematics ===");
  check(
    html.includes("\\(x^2\\)"),
    "inline latexmath keeps the delimiters pandoc's HTML reader understands",
  );
  check(
    html.includes("\\[") && html.includes("\\frac{1}{3}"),
    "display latexmath is preserved",
    (html.match(/\\\[[^\]]*\\\]/) ?? ["not found"])[0],
  );
  check(
    html.includes("\\(\\sqrt{9} = 3\\)"),
    "inline AsciiMath is converted to TeX",
    html.includes("\\sqrt{9}") ? "sqrt converted" : "still AsciiMath",
  );
  check(
    /\\\[[^\]]*\\sqrt\{4\}[^\]]*\\\\[^\]]*x \+ y[^\]]*\\\]/.test(html),
    "a multi-line AsciiMath block becomes display TeX",
  );
  check(
    !html.includes("asciimath-raw"),
    "no AsciiMath body fell back to raw text",
  );

  console.log("\n=== preview decoration ===");
  check(!html.includes("data-line"), "the export has no source-line anchors");
  check(!html.includes("katex"), "the export has no KaTeX spans; pandoc needs the delimiters");
  check(
    (await renderAsciidocForPandoc("   \n\n", { baseDir: null, readFile: async () => "" })) === "",
    "an empty document renders nothing",
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(join(process.cwd(), "outside-asciidoc-export.adoc"), { force: true });
}

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
