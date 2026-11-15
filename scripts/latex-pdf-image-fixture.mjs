// Write the PDF figure the `latex-pdf-image` layer includes.
//
//   node scripts/latex-pdf-image-fixture.mjs
//
// The repository refuses committed PDFs (scripts/repo-hygiene.mjs), so the
// figure is generated before the layer runs, into the git-ignored
// samples/latex-pdf-image/figures/swatch.pdf. It is one 100 pt page: a magenta
// square, which the layer finds on the preview's canvas, and the word "PDF" in
// Helvetica without an embedded font, which pdf.js draws from its standard
// fonts and which the exported PDF's text must contain.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const target = join(
  fileURLToPath(new URL("..", import.meta.url)),
  "samples",
  "latex-pdf-image",
  "figures",
  "swatch.pdf",
);

const content = "1 0 1 rg 0 0 100 100 re f\nBT /F1 24 Tf 0 0 0 rg 22 40 Td (PDF) Tj ET\n";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];

let pdf = "%PDF-1.4\n";
const offsets = objects.map((object, index) => {
  const offset = pdf.length;
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  return offset;
});
const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, pdf, "latin1");
console.log(`wrote ${target} (${pdf.length} bytes)`);
