//! Mathematics carried through the paste pipeline.
//!
//! Markdown and HTML sources expose TeX; Typst has its own math syntax. The
//! translator here is deliberately bounded: it handles the structures a pasted
//! page actually contains and turns an unknown command into its bare name so the
//! formula still parses instead of breaking the whole document.

import type { Inline } from "./ir.ts";
import { analyzeMath } from "../math-delimiters.ts";

const GREEK: Record<string, string> = {
  alpha: "alpha",
  beta: "beta",
  gamma: "gamma",
  delta: "delta",
  epsilon: "epsilon",
  varepsilon: "epsilon",
  zeta: "zeta",
  eta: "eta",
  theta: "theta",
  vartheta: "theta",
  iota: "iota",
  kappa: "kappa",
  lambda: "lambda",
  mu: "mu",
  nu: "nu",
  xi: "xi",
  pi: "pi",
  rho: "rho",
  sigma: "sigma",
  tau: "tau",
  upsilon: "upsilon",
  phi: "phi",
  varphi: "phi",
  chi: "chi",
  psi: "psi",
  omega: "omega",
  Gamma: "Gamma",
  Delta: "Delta",
  Theta: "Theta",
  Lambda: "Lambda",
  Xi: "Xi",
  Pi: "Pi",
  Sigma: "Sigma",
  Phi: "Phi",
  Psi: "Psi",
  Omega: "Omega",
};

const OPERATORS: Record<string, string> = {
  cdot: "dot",
  times: "times",
  div: "div",
  pm: "plus.minus",
  mp: "minus.plus",
  le: "<=",
  leq: "<=",
  ge: ">=",
  geq: ">=",
  neq: "!=",
  ne: "!=",
  approx: "approx",
  equiv: "equiv",
  infty: "infinity",
  sum: "sum",
  prod: "product",
  int: "integral",
  to: "arrow.r",
  rightarrow: "arrow.r",
  leftarrow: "arrow.l",
  in: "in",
  notin: "in.not",
  forall: "forall",
  exists: "exists",
  partial: "diff",
  nabla: "nabla",
  sin: "sin",
  cos: "cos",
  tan: "tan",
  log: "log",
  ln: "ln",
  lim: "lim",
  max: "max",
  min: "min",
};

/** Read a balanced `{...}` group starting at `open`, or null. */
function group(tex: string, open: number): { body: string; end: number } | null {
  if (tex[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < tex.length; i += 1) {
    if (tex[i] === "\\") {
      i += 1;
      continue;
    }
    if (tex[i] === "{") depth += 1;
    else if (tex[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: tex.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Translate a TeX expression into Typst math, best-effort and bounded. */
export function texToTypstMath(tex: string): string {
  let out = tex.trim();

  // Structures first; each replacement recurses through the same translator.
  out = out.replace(/\\frac\s*/g, "\\frac");
  let guard = 0;
  while (guard < 50) {
    const at = out.indexOf("\\frac");
    if (at < 0) break;
    let i = at + 5;
    while (/\s/.test(out[i] ?? "")) i += 1;
    const a = group(out, i);
    if (!a) break;
    let j = a.end;
    while (/\s/.test(out[j] ?? "")) j += 1;
    const b = group(out, j);
    if (!b) break;
    out = `${out.slice(0, at)}frac(${texToTypstMath(a.body)}, ${texToTypstMath(b.body)})${out.slice(b.end)}`;
    guard += 1;
  }
  guard = 0;
  while (guard < 50) {
    const at = out.indexOf("\\sqrt");
    if (at < 0) break;
    let i = at + 5;
    while (/\s/.test(out[i] ?? "")) i += 1;
    const a = group(out, i);
    if (!a) break;
    out = `${out.slice(0, at)}sqrt(${texToTypstMath(a.body)})${out.slice(a.end)}`;
    guard += 1;
  }
  out = out.replace(/\\text\s*\{([^{}]*)\}/g, (_whole, body: string) => `"${body}"`);
  out = out.replace(/\\mathrm\s*\{([^{}]*)\}/g, "$1");
  out = out.replace(/\\mathbf\s*\{([^{}]*)\}/g, "$1");
  out = out.replace(/\\left|\\right/g, "");
  out = out.replace(/\\[,;:!]/g, " ");
  out = out.replace(/\\%/g, "%");
  out = out.replace(/\\\{/g, "\\{").replace(/\\\}/g, "\\}");
  out = out.replace(/\\[A-Za-z]+/g, (command) => {
    const name = command.slice(1);
    return GREEK[name] ?? OPERATORS[name] ?? name;
  });
  // Typst groups with parentheses, not braces. A single token may drop them.
  out = out.replace(/\{([^{}]*)\}/g, (_whole, body: string) => `(${body})`);
  out = out.replace(/\^\s*\(([^()]*)\)/g, "^($1)");
  out = out.replace(/_\s*\(([^()]*)\)/g, "_($1)");
  // TeX `\\` is a line break; Typst uses a backslash at the end of a line.
  out = out.replace(/\\\\/g, " \\ ");
  return out.replace(/\s+/g, " ").trim();
}

/** Split decoded HTML text; backslashes are visible characters, not Markdown escapes. */
export function splitMath(value: string): Inline[] {
  const out: Inline[] = [];
  let from = 0;
  for (const range of analyzeMath(value, false).math) {
    if (range.from > from) out.push({ kind: "text", value: value.slice(from, range.from) });
    out.push({ kind: "math", tex: range.body, display: range.display });
    from = range.to;
  }
  if (from < value.length) out.push({ kind: "text", value: value.slice(from) });
  return out;
}
