//! Which `\input`/`\include`/`\includegraphics`/`\bibliography` references a
//! project actually makes, and where each one is.
//!
//! The snapshot is a closed set of literal files: it cannot expand `\input{\mypath}`,
//! so a non-literal reference has to fail with a named message instead of
//! surfacing deep in the compiler log as `File 'x' not found`. That rule is right.
//!
//! What was wrong was the tokenizer that applied it. It scanned every line as if
//! it were live markup, so it also rejected:
//!
//! - `\verb|\input{...}|`, whose content is literal text by definition;
//! - the bodies of `verbatim`, `lstlisting`, `minted` and `alltt`, which are
//!   literal too;
//! - prose such as `\texttt{\input}`, which mentions a command without calling it;
//! - `\iffalse … \fi` and commented-out macro bodies that never run.
//!
//! The shipped LaTeX Reference tripped all of these, so **Help › LaTeX Reference
//! produced a document that could not compile** — and saving a copy of a built-in
//! document is a normal thing to do. This module therefore masks the literal
//! regions before scanning, the same way `src/spellcheck.ts` and `src/sidebar.ts`
//! already do for their own scans.
//!
//! A reference now carries its line and column, and the collector returns every
//! problem instead of throwing the first one. That is what lets the editor mark
//! the offending command and the preview pane list each occurrence: a document
//! that names the same missing image twice used to produce one message that never
//! changed when the reader fixed one of them.

/** The environments whose bodies are literal text, not markup. */
const VERBATIM_ENVIRONMENTS =
  "verbatim\\*?|Verbatim\\*?|lstlisting|minted|alltt|comment|filecontents\\*?";

/** The source line shown beside a diagnostic, trimmed and bounded. */
export function lineTextOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
}

/**
 * One problem the LaTeX project has, with everything the UI needs to point at it.
 *
 * `line`, `column` and `endColumn` are 1-based, and columns count UTF-16 code
 * units, because that is what CodeMirror positions count. Byte offsets would not
 * survive the CRLF normalisation `documents.rs` applies to an open buffer.
 */
export interface LatexDiagnostic {
  /** Project-relative source, `/` separated. */
  file: string;
  /** 1-based line, or 0 when the compiler supplied no location. */
  line: number;
  /** 1-based first column, or 0 when unknown. */
  column: number;
  /** 1-based exclusive end column, or 0 when unknown. */
  endColumn: number;
  severity: "error" | "warning";
  /** Stable kind for the UI: `missing-reference`, `compile`, … */
  code: string;
  message: string;
  /** The exact command as written, when the reference scan produced it. */
  text: string;
  /** The line as compiled, for the panel's "what the compiler read" row. */
  lineText: string;
  /** Candidate paths the resolver tried, for a missing reference. */
  searched: string[];
}

/** One reference a project makes. */
export interface LatexReference {
  /** The command that made it: `input`, `include`, `includegraphics`, … */
  kind: string;
  /** The literal path or key, as written. */
  name: string;
  /** The source file the reference appears in. */
  source: string;
  /** 1-based line. */
  line: number;
  /** 1-based first column of the argument. */
  column: number;
  /** 1-based exclusive end column of the argument. */
  endColumn: number;
  /** The whole command, including options and braces. */
  text: string;
  /** The source line, trimmed and bounded. */
  lineText: string;
}

/**
 * Blank out the regions that are literal text, preserving offsets.
 *
 * Every character of a masked region becomes a space except the newlines, so a
 * line number computed from the result still matches the original. That is the
 * same rule `extractHtmlHeadings` uses for `<script>` bodies.
 */
export function maskLiteralRegions(text: string): string {
  let masked = text;

  // `\verb` and `\verb*` take their delimiter as the next character and run to
  // the next occurrence of it, on the same line.
  masked = masked.replace(/\\verb\*?([^a-zA-Z\s*])[^\n]*?\1/g, (block) =>
    block.replace(/[^\n]/g, " "),
  );

  // `\lstinline|…|` and `\mintinline{lang}|…|` are the same construct with a
  // different name: a delimiter, then literal text to the matching delimiter.
  masked = masked.replace(/\\lstinline\s*(?:\[[^\]]*\])?\s*([^a-zA-Z\s{])([\s\S]*?)\1/g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
  masked = masked.replace(
    /\\mintinline\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*([^a-zA-Z\s{])([\s\S]*?)\1/g,
    (block) => block.replace(/[^\n]/g, " "),
  );

  // The verbatim-like environments, bodies included. This runs before the brace
  // forms below so their depth-aware scan only ever sees live markup: a
  // `\lstinline{` written inside a listing is already blanked and cannot open a
  // group that would swallow the rest of the document.
  masked = masked.replace(
    new RegExp(`\\\\begin\\{(${VERBATIM_ENVIRONMENTS})\\}[\\s\\S]*?\\\\end\\{\\1\\}`, "g"),
    (block) => block.replace(/[^\n]/g, " "),
  );

  // The brace forms — `\lstinline{…}` and `\mintinline{lang}{…}` — where the
  // argument is the literal text. These need a depth-aware scan rather than a
  // `[^{}]*` pattern, because the body is code and may contain braces of its
  // own: `\lstinline{\section{x}}` is one literal, not a literal followed by a
  // stray `}`. The Rust twin (`mask_literal_regions` in `src-tauri/src/latex.rs`)
  // already reads these with `brace_end`; this keeps the two in step.
  for (const [start, end] of braceLiteralRanges(masked)) {
    masked =
      masked.slice(0, start) + masked.slice(start, end).replace(/[^\n]/g, " ") + masked.slice(end);
  }

  // `\iffalse … \fi` never runs. Nested conditionals are not tracked: this is a
  // masking pass, not a TeX interpreter, and an unbalanced `\iffalse` inside a
  // document that compiles is already an error the compiler reports.
  masked = masked.replace(/\\iffalse\b[\s\S]*?\\fi\b/g, (block) => block.replace(/[^\n]/g, " "));

  // A command whose argument is *text*, not a path: `\texttt{\input}` names the
  // command inside a monospaced argument. The argument is masked so the leftover
  // check cannot mistake the mention for a call. Only the text-formatting
  // commands are listed — masking every brace argument would hide a real
  // `\input{…}` inside, say, a `\caption{}`.
  masked = masked.replace(
    /\\(?:texttt|textbf|textit|textrm|textsf|textsc|textsl|textup|textmd|emph|mbox|hbox|text)\s*\{([^{}]*)\}/g,
    (block) => block.replace(/[^\n]/g, " "),
  );

  return masked;
}

/**
 * The end of a brace-balanced group starting at `from`, which must be a `{`.
 *
 * An escaped brace (`\{`) is a character, not a delimiter, so a backslash skips
 * the character after it. An unterminated group runs to the end of the text,
 * which is what a masking pass should do: the document is already broken and the
 * compiler will say so.
 */
function braceGroupEnd(text: string, from: number): number {
  let depth = 0;
  for (let at = from; at < text.length; at += 1) {
    const ch = text[at];
    if (ch === "\\") {
      at += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return text.length;
}

/**
 * The `[start, end)` ranges of the brace-form inline literals.
 *
 * `\lstinline{…}` takes the body directly; `\mintinline{lang}{…}` takes a
 * language group first. Both accept an optional `[…]` before the body.
 */
function braceLiteralRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const command = /\\(lstinline|mintinline)\b/g;
  let match: RegExpExecArray | null;
  while ((match = command.exec(text)) !== null) {
    let at = match.index + match[0].length;
    const skipSpace = () => {
      while (at < text.length && /\s/.test(text[at])) at += 1;
    };
    skipSpace();
    if (text[at] === "[") {
      const close = text.indexOf("]", at);
      if (close < 0) continue;
      at = close + 1;
      skipSpace();
    }
    // `\mintinline` names its language in a group before the body.
    if (match[1] === "mintinline" && text[at] === "{") {
      at = braceGroupEnd(text, at);
      skipSpace();
    }
    if (text[at] !== "{") continue;
    const end = braceGroupEnd(text, at);
    ranges.push([match.index, end]);
    // Resume after the literal so a `\lstinline` inside it cannot open a second.
    command.lastIndex = end;
  }
  return ranges;
}

/**
 * Whether a brace argument names a literal path.
 *
 * A macro or a special character means the snapshot cannot resolve it, which is
 * the case the validator exists to report.
 */
export function isLiteralReference(name: string): boolean {
  return (
    name.length > 0 &&
    !/[\\{}#$~:]/.test(name) &&
    !name.startsWith("/") &&
    !name.split("/").some((part) => !part || part === ".." || part === ".")
  );
}

/**
 * The index of the `%` that starts a comment, or -1.
 *
 * TeX's rule is an **odd** number of backslashes: `\%` is a literal percent,
 * `\\%` is an escaped backslash followed by a comment, and `\\\%` is a literal
 * percent again. The previous single-character test treated `\\%` as escaped,
 * so a comment after a line break stayed live and its commands were scanned.
 */
export function commentStart(line: string): number {
  for (let at = 0; at < line.length; at += 1) {
    if (line[at] !== "%") continue;
    let slashes = 0;
    for (let before = at - 1; before >= 0 && line[before] === "\\"; before -= 1) slashes += 1;
    if (slashes % 2 === 0) return at;
  }
  return -1;
}

/** Blank a line's comment, preserving every offset. */
function maskComment(line: string): string {
  const start = commentStart(line);
  if (start < 0) return line;
  return line.slice(0, start) + " ".repeat(line.length - start);
}

/** The reference command pattern, shared by the scan and the leftover check. */
export const REFERENCE_COMMAND =
  /\\(input|include|includegraphics|bibliography|addbibresource)\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g;

/**
 * The references one source makes, in order.
 *
 * `text` must already have been masked by {@link maskLiteralRegions}; the caller
 * does that once per file so the scan and the leftover check agree.
 */
export function referencesIn(masked: string, source: string): LatexReference[] {
  const out: LatexReference[] = [];
  const lines = masked.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = maskComment(lines[index]);
    REFERENCE_COMMAND.lastIndex = 0;
    for (const match of line.matchAll(REFERENCE_COMMAND)) {
      const at = match.index ?? 0;
      const raw = match[2];
      const parts = match[1] === "bibliography" ? raw.split(",") : [raw];
      for (const part of parts) {
        const name = part.trim().replace(/^\.\//, "");
        if (!name) continue;
        out.push({
          kind: match[1],
          name,
          source,
          line: index + 1,
          // The mark covers the whole command, not only the argument: the
          // command is what the reader has to find, and the argument span would
          // leave the leading `\includegraphics` look like ordinary text.
          column: at + 1,
          endColumn: at + match[0].length + 1,
          text: match[0],
          lineText: lineTextOf(lines[index]),
        });
      }
    }
  }
  return out;
}

/**
 * The first reference command the scan could not parse, with its position.
 *
 * Only a command **with an argument** counts. A bare mention — `The
 * \includegraphics command takes a path` — is prose about the command, not a call,
 * and flagging it was one of the false positives that rejected the shipped
 * reference. A real non-literal call always has braces, so requiring them keeps
 * the genuine `\input{\mypath}` rejection while letting the prose through.
 */
function unparsedReferenceAt(
  masked: string,
): { line: number; column: number; lineText: string } | null {
  const lines = masked.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = maskComment(lines[index]);
    // Replace a parsed call with spaces, so the column of the leftover command
    // still counts in the original line.
    const leftover = line.replace(REFERENCE_COMMAND, (value) => " ".repeat(value.length));
    const match = /\\(?:input|include|includegraphics|bibliography|addbibresource)\b[^\n]*\{/.exec(
      leftover,
    );
    if (match) {
      return {
        line: index + 1,
        column: (match.index ?? 0) + 1,
        lineText: lineTextOf(lines[index]),
      };
    }
  }
  return null;
}

/** Whether a line still mentions a reference command the scan could not parse. */
export function hasUnparsedReference(masked: string): boolean {
  return unparsedReferenceAt(masked) !== null;
}

/** Everything a project's reference scan found. */
export interface LatexReferenceScan {
  /** The files the main document can reach through `\input`/`\include`. */
  reachable: ReadonlySet<string>;
  /** Every problem, in scan order. */
  diagnostics: LatexDiagnostic[];
  /** True when the list stopped at its cap. */
  truncated: boolean;
}

/** The default number of problems reported for one project. */
export const MAX_REFERENCE_DIAGNOSTICS = 50;

/**
 * Walk a project and report every reference problem, instead of the first.
 *
 * A project with the same missing image in three figures used to throw the same
 * message three times — one per compile — and the reader could not tell which
 * occurrence was still live. Collecting them all is what makes the problem list
 * and the editor marks possible.
 */
export function collectLatexReferences(
  sources: ReadonlyMap<string, string>,
  files: ReadonlySet<string>,
  mainFile = "main.tex",
  limit = MAX_REFERENCE_DIAGNOSTICS,
): LatexReferenceScan {
  const pending = [mainFile];
  const visited = new Set<string>();
  const diagnostics: LatexDiagnostic[] = [];
  let truncated = false;
  // Only literal paths declared in the main preamble can be captured safely.
  // Keep this in step with the Rust snapshot collector.
  const preamble = maskLiteralRegions(sources.get(mainFile) ?? "")
    .split("\n")
    .map(maskComment)
    .join("\n")
    .split(/\\begin\s*\{document\}/)[0];
  const graphicsPaths: string[] = [];
  for (const match of preamble.matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)*)\}/g)) {
    graphicsPaths.length = 0;
    for (const item of match[1].matchAll(/\{([^{}]*)\}/g)) {
      const path = item[1].trim().replace(/\/$/, "").replace(/^\.\//, "");
      if (isLiteralReference(path)) graphicsPaths.push(path);
    }
  }

  const add = (diagnostic: LatexDiagnostic): void => {
    if (diagnostics.length >= limit) {
      truncated = true;
      return;
    }
    diagnostics.push(diagnostic);
  };

  while (pending.length) {
    const sourceName = pending.pop()!;
    if (visited.has(sourceName)) continue;
    visited.add(sourceName);
    const text = sources.get(sourceName);
    if (text === undefined) throw new Error(`Missing project source: ${sourceName}`);

    // Mask once per file, so the reference scan and the leftover check agree
    // about which regions are literal.
    const masked = maskLiteralRegions(text);
    const originalLines = text.split(/\r?\n/);

    for (const reference of referencesIn(masked, sourceName)) {
      const { kind, name } = reference;
      if (!isLiteralReference(name)) {
        add({
          file: sourceName,
          line: reference.line,
          column: reference.column,
          endColumn: reference.endColumn,
          severity: "error",
          code: "unsafe-reference",
          message: `Unsupported non-literal or unsafe \\${kind} reference in ${sourceName}: ${name}`,
          text: reference.text,
          lineText: lineTextOf(originalLines[reference.line - 1] ?? ""),
          searched: [],
        });
        continue;
      }
      const hasExtension = /\.[^/]+$/.test(name);
      const suffixes = hasExtension
        ? [""]
        : kind === "includegraphics"
          ? [".pdf", ".png", ".jpg", ".jpeg"]
          : kind === "bibliography" || kind === "addbibresource"
            ? [".bib"]
            : [".tex"];
      const prefixes =
        kind === "includegraphics" ? ["", ...graphicsPaths.map((path) => `${path}/`)] : [""];
      const candidates = prefixes.flatMap((prefix) =>
        suffixes.map((suffix) => prefix + name + suffix),
      );
      const resolved = candidates.find((path) => files.has(path));
      if (!resolved) {
        add({
          file: sourceName,
          line: reference.line,
          column: reference.column,
          endColumn: reference.endColumn,
          severity: "error",
          code: "missing-reference",
          message: `Missing project file for \\${kind} in ${sourceName}: ${name}`,
          text: reference.text,
          lineText: lineTextOf(originalLines[reference.line - 1] ?? ""),
          searched: candidates,
        });
        continue;
      }
      if ((kind === "input" || kind === "include") && sources.has(resolved)) {
        pending.push(resolved);
      }
    }

    const unparsed = unparsedReferenceAt(masked);
    if (unparsed) {
      add({
        file: sourceName,
        line: unparsed.line,
        column: unparsed.column,
        endColumn: 0,
        severity: "error",
        code: "unparsed-reference",
        message: `Unsupported non-literal project reference in ${sourceName}.`,
        text: "",
        lineText: lineTextOf(originalLines[unparsed.line - 1] ?? ""),
        searched: [],
      });
    }
  }

  return { reachable: visited, diagnostics, truncated };
}

/**
 * The error the throwing wrapper raises, carrying every diagnostic for the UI.
 *
 * `message` stays the first problem's text so the existing suites, which read
 * `error.message`, keep measuring the same thing.
 */
export class LatexReferenceError extends Error {
  readonly diagnostics: readonly LatexDiagnostic[];
  readonly reachable: ReadonlySet<string>;

  constructor(scan: LatexReferenceScan) {
    super(scan.diagnostics[0]?.message ?? "Unsupported LaTeX project reference.");
    this.name = "LatexReferenceError";
    this.diagnostics = scan.diagnostics;
    this.reachable = scan.reachable;
  }
}

/**
 * The old throwing contract, kept for the suites and for `latex-sync-unit`.
 *
 * `compileLatex` calls {@link collectLatexReferences} directly, so the UI gets
 * every problem and their positions.
 */
export function validateLatexReferences(
  sources: ReadonlyMap<string, string>,
  files: ReadonlySet<string>,
  mainFile = "main.tex",
): ReadonlySet<string> {
  const scan = collectLatexReferences(sources, files, mainFile);
  if (scan.diagnostics.length) throw new LatexReferenceError(scan);
  return scan.reachable;
}
