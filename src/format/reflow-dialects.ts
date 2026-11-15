//! The reflow dialect for each document language, or null where reflow does
//! not apply (HTML and the web source languages).

import type { DocumentLanguage } from "../api.ts";
import type { Dialect } from "./reflow.ts";
import { asciidocDialect } from "./reflow-asciidoc.ts";
import { latexDialect } from "./reflow-latex.ts";
import { markdownDialect } from "./reflow-markdown.ts";
import { typstDialect } from "./reflow-typst.ts";

export function reflowDialect(language: DocumentLanguage): Dialect | null {
  switch (language) {
    case "markdown":
      return markdownDialect;
    case "latex":
      return latexDialect;
    case "typst":
      return typstDialect;
    case "asciidoc":
      return asciidocDialect;
    default:
      return null;
  }
}
