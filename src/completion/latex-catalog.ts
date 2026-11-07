//! The LaTeX completion catalog: data only.
//!
//! Nothing here imports CodeMirror or touches the DOM, so the whole catalog is
//! testable without an editor and the completion layer stays a thin shell.
//!
//! **Snippets reuse `src/latex-commands.ts`.** The Format menu inserts
//! `LATEX_TABLE`, `LATEX_QUOTE`, `LATEX_CODE` and the rest; typing the same
//! construct and accepting the completion must produce the same bytes, or the
//! two routes disagree about what a table looks like. Importing the constants
//! rather than retyping them is what makes that true by construction.
//!
//! The list is **curated, not exhaustive**. A complete LaTeX command list is
//! several thousand entries, which makes the popup worse and the bundle bigger
//! for commands nobody types. What is here covers what people actually write;
//! extending it is a data change in one file.

import {
  LATEX_ALIGN,
  LATEX_CODE,
  LATEX_DISPLAY_MATH,
  LATEX_HEADINGS,
  LATEX_QUOTE,
  LATEX_RULE,
  LATEX_TABLE,
  LATEX_TOC,
  latexInline,
} from "../latex-commands.ts";

/** One completion row, before it becomes a CodeMirror `Completion`. */
export interface CatalogEntry {
  /** The text inserted, or the snippet template when `snippet` is true. */
  label: string;
  /** What the row says to the right of the label; usually the argument shape. */
  detail?: string;
  /** The section it appears under in the popup. */
  section: string;
  /** A snippet template with `${…}` tab stops, rather than literal text. */
  snippet?: boolean;
}

const SECTION = {
  snippet: "Snippets",
  environment: "Environments",
  structure: "Structure",
  text: "Text",
  math: "Mathematics",
  reference: "Cross-references",
  spacing: "Spacing",
  package: "Packages",
  class: "Document classes",
} as const;

/**
 * Commands, as `label` → `detail`.
 *
 * The detail is the argument shape a reader needs to finish the line, which is
 * the one thing a bare command name does not tell them.
 */
const COMMANDS: Array<[string, string]> = [
  // Document structure.
  ["\\documentclass", "{class}"],
  ["\\usepackage", "[options]{package}"],
  ["\\begin", "{environment}"],
  ["\\end", "{environment}"],
  ["\\title", "{title}"],
  ["\\author", "{author}"],
  ["\\date", "{date}"],
  ["\\maketitle", ""],
  ["\\tableofcontents", ""],
  ["\\appendix", ""],
  ["\\part", "{title}"],
  ["\\chapter", "{title}"],
  ["\\section", "{title}"],
  ["\\subsection", "{title}"],
  ["\\subsubsection", "{title}"],
  ["\\paragraph", "{title}"],
  ["\\subparagraph", "{title}"],
  ["\\label", "{key}"],
  ["\\input", "{file}"],
  ["\\include", "{file}"],
  ["\\includegraphics", "[options]{file}"],
  ["\\bibliography", "{file}"],
  ["\\bibliographystyle", "{style}"],
  ["\\addbibresource", "{file}"],
  ["\\printbibliography", ""],

  // Text and emphasis.
  ["\\textbf", "{text}"],
  ["\\emph", "{text}"],
  ["\\textit", "{text}"],
  ["\\texttt", "{text}"],
  ["\\textsc", "{text}"],
  ["\\underline", "{text}"],
  ["\\sout", "{text}"],
  ["\\textsuperscript", "{text}"],
  ["\\textsubscript", "{text}"],
  ["\\footnote", "{text}"],
  ["\\verb", "|text|"],
  ["\\newline", ""],
  ["\\linebreak", ""],
  ["\\noindent", ""],
  ["\\centering", ""],

  // Mathematics.
  ["\\frac", "{num}{den}"],
  ["\\sqrt", "[n]{x}"],
  ["\\sum", "_{i}^{n}"],
  ["\\prod", "_{i}^{n}"],
  ["\\int", "_{a}^{b}"],
  ["\\oint", ""],
  ["\\lim", "_{x \\to 0}"],
  ["\\infty", ""],
  ["\\partial", ""],
  ["\\nabla", ""],
  ["\\alpha", ""],
  ["\\beta", ""],
  ["\\gamma", ""],
  ["\\delta", ""],
  ["\\epsilon", ""],
  ["\\theta", ""],
  ["\\lambda", ""],
  ["\\mu", ""],
  ["\\pi", ""],
  ["\\sigma", ""],
  ["\\phi", ""],
  ["\\omega", ""],
  ["\\times", ""],
  ["\\cdot", ""],
  ["\\pm", ""],
  ["\\leq", ""],
  ["\\geq", ""],
  ["\\neq", ""],
  ["\\approx", ""],
  ["\\equiv", ""],
  ["\\in", ""],
  ["\\subset", ""],
  ["\\cup", ""],
  ["\\cap", ""],
  ["\\forall", ""],
  ["\\exists", ""],
  ["\\rightarrow", ""],
  ["\\Rightarrow", ""],
  ["\\left", ""],
  ["\\right", ""],
  ["\\text", "{text}"],

  // Cross-references and citations.
  ["\\ref", "{key}"],
  ["\\eqref", "{key}"],
  ["\\pageref", "{key}"],
  ["\\cite", "{key}"],
  ["\\citep", "{key}"],
  ["\\citet", "{key}"],
  ["\\nocite", "{key}"],
  ["\\href", "{url}{text}"],
  ["\\url", "{url}"],

  // Spacing.
  ["\\vspace", "{length}"],
  ["\\hspace", "{length}"],
  ["\\smallskip", ""],
  ["\\medskip", ""],
  ["\\bigskip", ""],
  ["\\newpage", ""],
  ["\\clearpage", ""],
  ["\\pagebreak", ""],
  ["\\hrule", ""],
  ["\\rule", "{width}{height}"],
];

/** Environments, with the argument they usually take. */
const ENVIRONMENTS: Array<[string, string]> = [
  ["document", ""],
  ["itemize", ""],
  ["enumerate", ""],
  ["description", ""],
  ["quote", ""],
  ["quotation", ""],
  ["verse", ""],
  ["verbatim", ""],
  ["lstlisting", "[language]"],
  ["minted", "{language}"],
  ["figure", "[htbp]"],
  ["table", "[htbp]"],
  ["tabular", "{ll}"],
  ["tabularx", "{\\linewidth}{l}"],
  ["center", ""],
  ["flushleft", ""],
  ["flushright", ""],
  ["abstract", ""],
  ["equation", ""],
  ["equation*", ""],
  ["align", ""],
  ["align*", ""],
  ["gather", ""],
  ["multline", ""],
  ["split", ""],
  ["cases", ""],
  ["matrix", ""],
  ["pmatrix", ""],
  ["bmatrix", ""],
  ["vmatrix", ""],
  ["theorem", ""],
  ["lemma", ""],
  ["proof", ""],
  ["definition", ""],
  ["minipage", "{width}"],
];

/**
 * Packages worth offering.
 *
 * A short list of the ones a document almost always wants, not a mirror of
 * CTAN. Every entry here is present in the pinned TeX Live snapshot the engine
 * downloads, so accepting one cannot produce a compile error on its own.
 */
const PACKAGES: string[] = [
  "amsmath",
  "amssymb",
  "amsthm",
  "graphicx",
  "hyperref",
  "xcolor",
  "geometry",
  "babel",
  "fontspec",
  "booktabs",
  "array",
  "multirow",
  "tabularx",
  "longtable",
  "float",
  "caption",
  "subcaption",
  "enumitem",
  "titlesec",
  "fancyhdr",
  "setspace",
  "microtype",
  "siunitx",
  "listings",
  "minted",
  "tikz",
  "pgfplots",
  "biblatex",
  "natbib",
  "ulem",
  "soul",
  "cleveref",
  "mathtools",
  "bm",
  "physics",
  "csquotes",
  "lipsum",
];

/** Document classes. */
const CLASSES: string[] = [
  "article",
  "report",
  "book",
  "scrartcl",
  "scrreprt",
  "scrbook",
  "beamer",
  "letter",
  "memoir",
  "standalone",
];

/**
 * The snippets: constructs the Format menu also inserts.
 *
 * Each template uses CodeMirror's `${…}` tab-stop syntax, so accepting one puts
 * the caret where the reader has to type next. The bodies come from
 * `latex-commands.ts` wherever that module already owns the string — that is
 * what keeps Format › Table and typing `table` from producing different bytes.
 *
 * Two details the parser forces (`Snippet.parse` in `@codemirror/autocomplete`):
 * a template is split on **real newlines**, so a multi-line construct carries
 * them literally rather than as `\n`; and `$` and `#` introduce fields, so a
 * LaTeX `$` inside a template must be written `\\$` unless it is a tab stop.
 */
function buildSnippets(): CatalogEntry[] {
  const rows: CatalogEntry[] = [];

  // A generic environment pair. `${1}` is reused in `\end`, so typing the name
  // once fills both halves.
  rows.push({
    label: "\\begin{${1:environment}}",
    detail: "environment pair",
    section: SECTION.snippet,
    snippet: true,
  });

  for (const heading of LATEX_HEADINGS) {
    rows.push({
      label: `\\${heading}{\${1:title}}`,
      detail: "sectioning",
      section: SECTION.snippet,
      snippet: true,
    });
  }

  for (const [kind, detail] of [
    ["bold", "strong text"],
    ["italic", "emphasis"],
    ["code", "inline code"],
    ["link", "link"],
  ] as const) {
    const inline = latexInline(kind);
    rows.push({
      label: `${inline.before}\${1:${inline.placeholder}}${inline.after}`,
      detail,
      section: SECTION.snippet,
      snippet: true,
    });
  }

  // The block constructs, taken verbatim from the Format menu's own constants so
  // the two routes cannot drift. `LATEX_TABLE.text` already contains real
  // newlines, which is exactly what the parser wants.
  rows.push({
    label: LATEX_TABLE.text.replace("Column", "${1:Column}"),
    detail: "table",
    section: SECTION.snippet,
    snippet: true,
  });
  rows.push({
    label: `${LATEX_QUOTE.text.split("\n")[0]}\n\${1}\n${LATEX_QUOTE.text.split("\n")[2]}`,
    detail: "quote",
    section: SECTION.snippet,
    snippet: true,
  });
  rows.push({
    label: `${LATEX_CODE.text.split("\n")[0]}\n\${1}\n${LATEX_CODE.text.split("\n")[2]}`,
    detail: "verbatim code",
    section: SECTION.snippet,
    snippet: true,
  });
  rows.push({
    label: `${LATEX_ALIGN.text.split("\n")[0]}\n\${1}\n${LATEX_ALIGN.text.split("\n")[2]}`,
    detail: "aligned equations",
    section: SECTION.snippet,
    snippet: true,
  });
  rows.push({
    label: `${LATEX_DISPLAY_MATH.split("\n")[0]}\n\${1}\n${LATEX_DISPLAY_MATH.split("\n")[2]}`,
    detail: "display mathematics",
    section: SECTION.snippet,
    snippet: true,
  });
  rows.push({
    label: LATEX_RULE,
    detail: "horizontal rule",
    section: SECTION.snippet,
  });
  rows.push({
    label: LATEX_TOC,
    detail: "table of contents",
    section: SECTION.snippet,
  });
  // Inline mathematics, whose delimiters are a single `$` on each side. Escaped
  // because `$` opens a field in a snippet template.
  rows.push({
    label: "\\$${1:e^{i\\pi}+1=0}\\$",
    detail: "inline mathematics",
    section: SECTION.snippet,
    snippet: true,
  });

  return rows;
}

/** Every row the LaTeX popup can offer, in the order the sections appear. */
export function latexCatalog(): CatalogEntry[] {
  const rows: CatalogEntry[] = [...buildSnippets()];
  // The same name can legitimately appear in two sections — `tabularx` is both
  // an environment and a package, and each is offered in its own context. What
  // must never happen is the same name twice *in one section*, which reads as a
  // rendering bug. The key is therefore section + label, not label alone.
  const seen = new Set(rows.map((row) => `${row.section}\u0000${row.label}`));

  const push = (row: CatalogEntry) => {
    const key = `${row.section}\u0000${row.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };

  for (const [label, detail] of COMMANDS) {
    push({ label, detail, section: sectionForCommand(label) });
  }
  for (const [name, detail] of ENVIRONMENTS) {
    push({ label: name, detail, section: SECTION.environment });
  }
  for (const name of PACKAGES) {
    push({ label: name, detail: "package", section: SECTION.package });
  }
  for (const name of CLASSES) {
    push({ label: name, detail: "class", section: SECTION.class });
  }

  return rows;
}

/** Which section a command belongs to, so the popup groups them usefully. */
function sectionForCommand(label: string): string {
  if (/^\\(ref|eqref|pageref|cite|citep|citet|nocite|href|url|label)$/.test(label)) {
    return SECTION.reference;
  }
  if (/^\\(frac|sqrt|sum|prod|int|oint|lim|infty|partial|nabla)$/.test(label)) {
    return SECTION.math;
  }
  if (/^\\(vspace|hspace|smallskip|medskip|bigskip|newpage|clearpage|pagebreak|hrule|rule)$/.test(label)) {
    return SECTION.spacing;
  }
  if (/^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)$/.test(label)) {
    return SECTION.structure;
  }
  if (/^\\(documentclass|usepackage|begin|end|title|author|date|maketitle|tableofcontents|appendix)$/.test(label)) {
    return SECTION.structure;
  }
  if (/^\\(input|include|includegraphics|bibliography|bibliographystyle|addbibresource|printbibliography)$/.test(label)) {
    return SECTION.structure;
  }
  // Greek letters and operators read as mathematics even though the name does
  // not match the list above.
  if (/^\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|sigma|phi|omega|times|cdot|pm|leq|geq|neq|approx|equiv|in|subset|cup|cap|forall|exists|rightarrow|Rightarrow|left|right|text)$/.test(label)) {
    return SECTION.math;
  }
  return SECTION.text;
}

/** The environment names, for the context table to filter against. */
export const LATEX_ENVIRONMENT_NAMES: readonly string[] = ENVIRONMENTS.map(([name]) => name);

/** The package names, for the context table to filter against. */
export const LATEX_PACKAGE_NAMES: readonly string[] = PACKAGES;

/** The class names, for the context table to filter against. */
export const LATEX_CLASS_NAMES: readonly string[] = CLASSES;
