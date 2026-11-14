//! The headings in a LaTeX document, for the Outline panel.
//!
//! LaTeX spells its sections as commands: `\part`, `\chapter`, `\section`,
//! `\subsection`, `\subsubsection`, `\paragraph` and `\subparagraph`, in that
//! order of nesting. The starred forms (`\section*`) are unnumbered but are still
//! headings to a reader, so they are kept. `\title{}` becomes level 0 so the
//! document title heads the outline the way a Markdown `#` does.
//!
//! A source scan, like the other extractors: the outline follows what the reader
//! typed. Comment lines are skipped, and so are the regions that are literal text
//! rather than markup — `\verb|…|`, `\lstinline`, `\mintinline`, the bodies of
//! `verbatim`, `lstlisting`, `minted` and `alltt`, and dead `\iffalse … \fi` code.
//! A `\section` shown as an example inside one of those is sample text, not
//! structure: the shipped LaTeX Reference demonstrates exactly that, and without
//! this the outline grew a heading for every command it mentions.
//!
//! The masking is `maskLiteralRegions` from `latex-references.ts`, the same pass
//! the reference validator and the spell checker use. There is one definition of
//! "this region is literal" in the codebase, and this module consumes it rather
//! than adding a fourth.
//!
//! The module is pure and imports only that helper, so the whole rule set is a
//! unit test with no editor, no DOM and no application.

import { maskLiteralRegions } from "./latex-references.ts";

/** One heading the Outline panel can jump to. */
export interface Heading {
  /** Nesting depth: 0 for `\title`, 1 for `\section`, 2 for `\subsection`, … */
  level: number;
  /** The text a reader sees, with the markup removed. */
  text: string;
  /** 1-based line number in the source. */
  line: number;
}

/** The nesting each sectioning command contributes. */
const LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

// `\chapter` only exists in the book and report classes; in an article a
// `\section` is the top level. The outline is flatter than the truth rather than
// wrong about it, so `chapter` and `section` share a level.

/** A sectioning command, with its optional short title, up to the opening brace. */
const SECTION =
  /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[([^\]]*)\])?\s*\{/g;

/** `\title[Short]{Long}` — the document title, which heads the outline. */
const TITLE = /\\title\s*(?:\[[^\]]*\])?\s*\{/;

/**
 * The headings in a LaTeX document, in source order.
 *
 * The scan runs over a masked copy of the source, so a sectioning command inside
 * a literal region cannot match. Masking preserves every newline and every line's
 * length, so the masked index is also the original index: `i + 1` still names the
 * line the reader typed, and the heading text is read from the original line so a
 * heading that *contains* a literal — `\section{Passing \verb|--flag|}` — keeps
 * its text even though the literal itself was blanked for the command scan.
 */
export function extractLatexHeadings(source: string): Heading[] {
  const headings: Heading[] = [];
  const masked = maskLiteralRegions(source).split("\n");
  const original = source.split("\n");

  for (let i = 0; i < masked.length; i += 1) {
    // A `%` starts a comment unless it is escaped as `\%`. The position is taken
    // from the masked line, where a `%` inside a literal region is already
    // blanked, so `\verb|50%|` does not cut the rest of the line off.
    const comment = /(?<!\\)%/.exec(masked[i]);
    const code = comment ? masked[i].slice(0, comment.index) : masked[i];
    if (!code.trim()) continue;
    const line = comment ? (original[i] ?? "").slice(0, comment.index) : (original[i] ?? "");

    const title = TITLE.exec(code);
    if (title) {
      const text = headingText(code, line, title.index + title[0].length);
      if (text) headings.push({ level: 0, text, line: i + 1 });
      continue;
    }

    SECTION.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SECTION.exec(code)) !== null) {
      // The short title is read from the original line, not the masked one, so
      // `\section[\verb|a|]{b}` shows the literal it contains.
      const short = match[2] === undefined ? "" : shortTitleAt(line, match.index);
      const text = short || headingText(code, line, match.index + match[0].length);
      if (text) headings.push({ level: LEVELS[match[1]], text, line: i + 1 });
    }
  }

  return headings;
}

/** The `[…]` short title of the sectioning command at `at`, cleaned, or "". */
function shortTitleAt(line: string, at: number): string {
  const open = line.indexOf("[", at);
  const brace = line.indexOf("{", at);
  if (open < 0 || (brace >= 0 && brace < open)) return "";
  const close = line.indexOf("]", open);
  return close < 0 ? "" : cleanHeadingText(line.slice(open + 1, close));
}

/**
 * Read a brace-balanced argument starting just after its `{`, and clean it.
 *
 * The **extent** is measured on the masked line, where a literal's contents are
 * blanked: `\section{Passing \verb|{|}` must not let the brace inside the literal
 * unbalance the argument. The **text** is then taken from the original line at
 * the same offsets, because masking preserves length.
 *
 * The cleaning has to understand literal commands too, because a heading is
 * allowed to contain one: `\section{Passing \verb|--flag|}` is a real heading
 * whose text is "Passing --flag". Blanking the literal would leave a hole in the
 * middle of the title, so the literal is unwrapped to the text it shows before
 * the ordinary command stripping runs.
 */
function headingText(maskedLine: string, line: string, from: number): string {
  let depth = 1;
  let end = from;
  for (; end < maskedLine.length; end += 1) {
    const ch = maskedLine[end];
    if (ch === "\\") {
      end += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const raw = line.slice(from, end);
  return cleanHeadingText(raw);
}

/**
 * Turn a heading argument into the text a reader sees.
 *
 * Literal commands are unwrapped to their contents first, then the remaining
 * markup — command names, braces — is removed and the whitespace collapsed. The
 * optional short title goes through the same cleaning, so the two forms of
 * `\section[Short]{Long}` read the same way.
 *
 * The literal contents are held aside while the markup is stripped, because a
 * literal may *contain* the very characters being removed: `\verb|{|` shows a
 * brace, and stripping braces without this would delete it.
 */
function cleanHeadingText(raw: string): string {
  const literals: string[] = [];
  const hold = (text: string): string => `\u0000${literals.push(text) - 1}\u0000`;

  const protectedText = raw
    .replace(/\\verb\*?([^a-zA-Z\s*])([\s\S]*?)\1/g, (_match, _delimiter, body: string) =>
      hold(body),
    )
    .replace(
      /\\lstinline\s*(?:\[[^\]]*\])?\s*([^a-zA-Z\s{])([\s\S]*?)\1/g,
      (_match, _delimiter, body: string) => hold(body),
    )
    .replace(
      /\\mintinline\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*([^a-zA-Z\s{])([\s\S]*?)\1/g,
      (_match, _delimiter, body: string) => hold(body),
    )
    .replace(
      /\\mintinline\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{([^{}]*)\}/g,
      (_match, body: string) => hold(body),
    )
    .replace(/\\[a-zA-Z@]+\*?\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return protectedText.replace(
    // NULs are deliberate sentinels inserted by hold() above.
    // eslint-disable-next-line no-control-regex
    /\u0000(\d+)\u0000/g,
    (_match, index: string) => literals[Number(index)] ?? "",
  );
}

/** A heading of a multi-file project, with the file it lives in. */
export interface ProjectHeading extends Heading {
  /** Project-relative path of the file, with `/` separators. */
  file: string;
}

const INCLUDE = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g;

/**
 * The headings of a whole LaTeX project in document order (Track W2).
 *
 * Starting at the main file, each file's headings are interleaved with the
 * files its `\input`/`\include`/`\subfile` lines pull in, at the line where
 * they do so, recursively. Names resolve as TeX does: against the main file's
 * folder, with `.tex` implied. Comments, verbatim and other literal regions
 * are ignored through the same masking the single-file outline uses. A file
 * that is missing from `sources`, or one already on the include path (a
 * cycle), contributes nothing.
 */
export function projectLatexOutline(
  mainFile: string,
  sources: ReadonlyMap<string, string>,
): ProjectHeading[] {
  const out: ProjectHeading[] = [];
  const normalize = (name: string): string => {
    const trimmed = name.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    return /\.[A-Za-z0-9]+$/.test(trimmed) ? trimmed : `${trimmed}.tex`;
  };
  const visit = (file: string, path: ReadonlySet<string>): void => {
    const source = sources.get(file);
    if (source === undefined || path.has(file)) return;
    const next = new Set(path).add(file);
    const headings = extractLatexHeadings(source);
    const lines = maskLiteralRegions(source).split("\n");
    let h = 0;
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      while (h < headings.length && headings[h].line <= lineNumber) {
        out.push({ ...headings[h], file });
        h += 1;
      }
      const code = line.replace(/(^|[^\\])%.*$/, "$1");
      for (const match of code.matchAll(INCLUDE)) visit(normalize(match[1]), next);
    });
    while (h < headings.length) out.push({ ...headings[h++], file });
  };
  visit(mainFile, new Set());
  return out;
}
