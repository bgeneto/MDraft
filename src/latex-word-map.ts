//! Conservative literal prose candidates for PDF correspondence.
//!
//! `visibleProse` is a syntax description, not proof that TeX executed a
//! branch. Conditional bodies are excluded independently, including nested
//! conditionals, so a rendered macro cannot claim text in a false branch.

import { createLatexSyntaxService } from "wasmtex/syntax";
import { tokenizeWords, type SourceWord } from "./typst-page-map.ts";

interface Span {
  from: number;
  to: number;
}

export interface LatexMathExpression {
  from: number;
  to: number;
  tokens: string[];
  /** A superscript/subscript may be separated by visual spacing in PDF.js. */
  scripted?: true;
  scriptedTokens?: string[];
}

export interface LatexSourceContent {
  words: SourceWord[];
  math: LatexMathExpression[];
}

const VERBATIM_ENV = /^verbatim\*?$/;
const MATH_TOKENS = /[\p{L}\p{M}]+|[\p{N}]+/gu;
const MATH_COMMANDS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  varpi: "π",
  rho: "ρ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};
const MATH_STYLE_COMMANDS = new Set([
  "mathrm",
  "mathbf",
  "mathit",
  "mathsf",
  "mathtt",
  "mathcal",
  "mathbb",
  "mathfrak",
  "operatorname",
  "text",
]);
const MATH_IGNORED_COMMANDS = new Set([
  "left",
  "right",
  "displaystyle",
  "textstyle",
  "scriptstyle",
  "scriptscriptstyle",
  ",",
  ";",
  ":",
  "!",
  "quad",
  "qquad",
  "enspace",
  "thinspace",
  "cdot",
  "times",
  "pm",
  "mp",
  "le",
  "leq",
  "ge",
  "geq",
  "neq",
  "ne",
  "equiv",
  "approx",
  "in",
  "notin",
  "to",
  "rightarrow",
  "gets",
  "mapsto",
  "mid",
  "parallel",
  "perp",
  "forall",
  "exists",
  "infty",
  "partial",
  "nabla",
  "sum",
  "prod",
  "int",
  "oint",
  "cup",
  "cap",
  "subset",
  "subseteq",
  "land",
  "lor",
  "neg",
  "emptyset",
  "varnothing",
  "setminus",
  "frac",
  "dfrac",
  "tfrac",
  "sqrt",
]);
const MATH_METADATA_COMMANDS = new Set(["label", "nonumber", "notag", "tag"]);

/** Skip a balanced argument; an incomplete one conservatively consumes the rest. */
function groupEnd(source: string, at: number, open: string, close: string): number {
  if (source[at] !== open) return at;
  let depth = 0;
  for (; at < source.length; at += 1) {
    if (source[at] === "\\") {
      at += 1;
      continue;
    }
    if (source[at] === open) depth += 1;
    if (source[at] === close && --depth === 0) return at + 1;
  }
  return source.length;
}

function conditionalSpans(source: string): Span[] {
  const spans: Span[] = [];
  const stack: number[] = [];
  for (let at = 0; at < source.length;) {
    if (source[at] === "%") {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end;
      continue;
    }
    if (source[at] !== "\\") {
      at += 1;
      continue;
    }
    const start = at++;
    if (!/[A-Za-z@]/.test(source[at] ?? "")) {
      at += 1;
      continue;
    }
    while (/[A-Za-z@]/.test(source[at] ?? "")) at += 1;
    const command = source.slice(start + 1, at);
    if (command === "verb" || command === "lstinline" || command === "mintinline") {
      if (source[at] === "*") at += 1;
      if (command !== "verb") {
        while (/\s/.test(source[at] ?? "")) at += 1;
        at = groupEnd(source, at, "[", "]");
        while (/\s/.test(source[at] ?? "")) at += 1;
        if (command === "mintinline") {
          if (source[at] !== "{") {
            at = source.length;
            continue;
          }
          at = groupEnd(source, at, "{", "}");
          while (/\s/.test(source[at] ?? "")) at += 1;
        }
        if (source[at] === "{") {
          at = groupEnd(source, at, "{", "}");
          continue;
        }
      }
      const delimiter = source[at++];
      const end = delimiter ? source.indexOf(delimiter, at) : -1;
      const newline = source.indexOf("\n", at);
      at =
        end < 0 || (newline >= 0 && newline < end)
          ? newline < 0
            ? source.length
            : newline
          : end + 1;
      continue;
    }
    if (command === "begin") {
      const match = /^\s*\{(verbatim\*?|Verbatim\*?|lstlisting|minted|alltt)\}/.exec(
        source.slice(at),
      );
      if (match) {
        const end = source.indexOf(`\\end{${match[1]}}`, at + match[0].length);
        at = end < 0 ? source.length : end + `\\end{${match[1]}}`.length;
        continue;
      }
    }
    if (command.startsWith("if")) stack.push(start);
    else if (command === "fi" && stack.length) {
      const from = stack.pop()!;
      if (!stack.length) spans.push({ from, to: at });
    }
  }
  if (stack.length) spans.push({ from: stack[0], to: source.length });
  return spans;
}

/** Find literal text spans without interpreting commands inside those spans. */
function latexVerbatimSpans(source: string): Span[] {
  const spans: Span[] = [];
  for (let at = 0; at < source.length;) {
    if (source[at] === "%") {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end;
      continue;
    }
    if (source[at] !== "\\") {
      at += 1;
      continue;
    }
    const start = at++;
    if (!/[A-Za-z@]/.test(source[at] ?? "")) {
      at += 1;
      continue;
    }
    while (/[A-Za-z@]/.test(source[at] ?? "")) at += 1;
    const command = source.slice(start + 1, at);
    if (command === "verb" || command === "lstinline" || command === "mintinline") {
      if (source[at] === "*") at += 1;
      if (command !== "verb") {
        while (/\s/.test(source[at] ?? "")) at += 1;
        at = groupEnd(source, at, "[", "]");
        while (/\s/.test(source[at] ?? "")) at += 1;
        if (command === "mintinline") {
          if (source[at] !== "{") {
            at = source.length;
            continue;
          }
          at = groupEnd(source, at, "{", "}");
          while (/\s/.test(source[at] ?? "")) at += 1;
        }
        if (source[at] === "{") {
          at = groupEnd(source, at, "{", "}");
          continue;
        }
      }
      const delimiter = source[at++];
      const end = delimiter ? source.indexOf(delimiter, at) : -1;
      const newline = source.indexOf("\n", at);
      if (end < 0 || (newline >= 0 && newline < end)) {
        at = newline < 0 ? source.length : newline;
      } else {
        at = end + 1;
      }
      continue;
    }
    if (command !== "begin") continue;
    const match = /^\s*\{(verbatim\*?|Verbatim\*?|lstlisting|minted|alltt)\}/.exec(
      source.slice(at),
    );
    if (!match) continue;
    const bodyStart = at + match[0].length;
    const endMarker = `\\end{${match[1]}}`;
    const bodyEnd = source.indexOf(endMarker, bodyStart);
    if (bodyEnd < 0) {
      if (VERBATIM_ENV.test(match[1])) spans.push({ from: bodyStart, to: source.length });
      at = source.length;
    } else {
      if (VERBATIM_ENV.test(match[1])) spans.push({ from: bodyStart, to: bodyEnd });
      at = bodyEnd + endMarker.length;
    }
  }
  return spans;
}

function overlaps(spans: readonly Span[], from: number, to: number): boolean {
  let lo = 0,
    hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid].to <= from) lo = mid + 1;
    else hi = mid;
  }
  return !!spans[lo] && spans[lo].from < to;
}

/**
 * A deliberately small math surface reader. It does not expand TeX. Unknown
 * commands and structural constructs make the whole expression ineligible.
 */
function safeMathTokens(source: string): string[] | null {
  let surface = "";
  for (let at = 0; at < source.length;) {
    if (source[at] !== "\\") {
      if (source[at] === "&" || source[at] === "$") return null;
      surface += source[at++];
      continue;
    }
    at += 1;
    if (!/[A-Za-z@]/.test(source[at] ?? "")) {
      const escaped = source[at++];
      if (["{", "}", "_", "^", " ", ",", ";", ":", "!"].includes(escaped)) {
        surface += " ";
        continue;
      }
      return null;
    }
    const start = at;
    while (/[A-Za-z@]/.test(source[at] ?? "")) at += 1;
    const command = source.slice(start, at);
    if (MATH_METADATA_COMMANDS.has(command)) {
      while (/\s/.test(source[at] ?? "")) at += 1;
      if (command === "label" || command === "tag") {
        if (source[at] !== "{") return null;
        at = groupEnd(source, at, "{", "}");
      }
    } else if (MATH_COMMANDS[command]) surface += MATH_COMMANDS[command];
    else if (MATH_STYLE_COMMANDS.has(command) || MATH_IGNORED_COMMANDS.has(command)) {
      // Braces are removed below; these commands do not change the literal
      // alphanumeric reading order when their argument is plain math text.
    } else return null;
  }
  const tokens = [...surface.matchAll(MATH_TOKENS)].map((match) => match[0].normalize("NFC"));
  return tokens.length ? tokens : null;
}

/** Mask conditional branches before resolving literal project includes. */
export function maskLatexConditionals(source: string): string {
  const spans = conditionalSpans(source);
  let result = "",
    at = 0;
  for (const span of spans) {
    result += source.slice(at, span.from);
    result += source.slice(span.from, span.to).replace(/[^\n]/g, " ");
    at = span.to;
  }
  return result + source.slice(at);
}

/** Run off the UI thread: the syntax service parses synchronously. */
export function latexSourceContent(source: string, path = "main.tex"): LatexSourceContent {
  // Catcode changes invalidate even the lexical interpretation of the file.
  if (/\\catcode\b/.test(source)) return { words: [], math: [] };
  const syntax = createLatexSyntaxService().upsert({
    fileId: path,
    path,
    content: source,
    documentVersion: 1,
  });
  const excluded = conditionalSpans(source);
  const documentScope = syntax.scopes.find(
    (scope) => scope.kind === "environment" && scope.name === "document",
  );
  const bodyStart = documentScope?.source?.range.endOffset ?? 0;
  const words: SourceWord[] = [];
  const verbatim = latexVerbatimSpans(source);
  const prose = syntax.visibleProse.map(({ range }) => ({
    from: range.startOffset,
    to: range.endOffset,
  }));
  prose.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const span of prose) {
    const from = Math.max(bodyStart, span.from);
    const to = span.to;
    if (from >= to) continue;
    for (const word of tokenizeWords(source.slice(from, to))) {
      const absolute = { ...word, from: from + word.from, to: from + word.to };
      if (
        !overlaps(excluded, absolute.from, absolute.to) &&
        !overlaps(verbatim, absolute.from, absolute.to)
      )
        words.push(absolute);
    }
  }
  for (const span of verbatim) {
    const from = Math.max(bodyStart, span.from);
    if (from >= span.to) continue;
    for (const word of tokenizeWords(source.slice(from, span.to))) {
      const absolute = { ...word, from: from + word.from, to: from + word.to };
      if (!overlaps(excluded, absolute.from, absolute.to)) words.push(absolute);
    }
  }
  const math = syntax.mathRegions.flatMap((region) => {
    const from = region.fullRange.startOffset,
      to = region.fullRange.endOffset,
      contentFrom = region.contentRange.startOffset,
      contentTo = region.contentRange.endOffset;
    if (
      !region.closed ||
      from < bodyStart ||
      overlaps(excluded, from, to) ||
      overlaps(verbatim, from, to) ||
      contentFrom > contentTo
    )
      return [];
    const content = source.slice(contentFrom, contentTo);
    const tokens = safeMathTokens(content);
    if (!tokens) return [];
    const scriptedTokens = [...content.matchAll(/(?:\^|_)\s*(?:\{([0-9]+)\}|([0-9]+))/g)].map(
      (match) => match[1] ?? match[2],
    );
    return [
      {
        from,
        to,
        tokens,
        ...(scriptedTokens.length ? { scripted: true as const, scriptedTokens } : {}),
      },
    ];
  });
  return { words, math };
}

export function latexSourceWords(source: string, path = "main.tex"): SourceWord[] {
  return latexSourceContent(source, path).words;
}
