//! Which `\input`/`\include`/`\includegraphics`/`\bibliography` references a
//! project actually makes.
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

/** The environments whose bodies are literal text, not markup. */
const VERBATIM_ENVIRONMENTS = "verbatim\\*?|Verbatim\\*?|lstlisting|minted|alltt";

/** One reference a project makes. */
export interface LatexReference {
  /** The command that made it: `input`, `include`, `includegraphics`, … */
  kind: string;
  /** The literal path or key, as written. */
  name: string;
  /** The source file the reference appears in. */
  source: string;
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
  for (const line of masked.split(/\r?\n/)) {
    const withoutComment = line.replace(/(^|[^\\])%.*/, "$1");
    for (const match of withoutComment.matchAll(REFERENCE_COMMAND)) {
      const kind = match[1];
      const names = kind === "bibliography" ? match[2].split(",") : [match[2]];
      for (const raw of names) {
        const name = raw.trim().replace(/^\.\//, "");
        if (name) out.push({ kind, name, source });
      }
    }
  }
  return out;
}

/**
 * Whether a line still mentions a reference command the scan could not parse.
 *
 * Only a command **with an argument** counts. A bare mention — `The
 * \includegraphics command takes a path` — is prose about the command, not a call,
 * and flagging it was one of the false positives that rejected the shipped
 * reference. A real non-literal call always has braces, so requiring them keeps
 * the genuine `\input{\mypath}` rejection while letting the prose through.
 */
export function hasUnparsedReference(masked: string): boolean {
  for (const line of masked.split(/\r?\n/)) {
    const withoutComment = line.replace(/(^|[^\\])%.*/, "$1");
    const unmatched = withoutComment.replace(REFERENCE_COMMAND, "");
    if (
      /\\(?:input|include|includegraphics|bibliography|addbibresource)\b[^\n]*\{/.test(unmatched)
    ) {
      return true;
    }
  }
  return false;
}
