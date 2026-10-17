//! Which markup is on the clipboard, and which markup the active buffer is.
//!
//! Two classifiers share one signal table but answer different questions:
//!
//! - `chooseSource()` decides which representation of a paste to use for the
//!   destination that was already resolved;
//! - `detectDocumentLanguage()` decides the destination for an *unsaved* buffer.
//!
//! Both are synchronous and dependency-free. They deliberately require a
//! two-point lead, so a shared construct — a bullet list, inline code, `$…$` —
//! can never decide on its own.

import type { DocumentLanguage } from "../api.ts";

export type SourceFormat = "html" | "markdown" | "typst" | "plain";

export interface ClipboardPayload {
  html: string | null;
  markdown: string | null;
  text: string | null;
}

export interface ClipboardChoice {
  source: SourceFormat;
  /** True when CodeMirror's own paste already does the right thing. */
  native: boolean;
}

export interface Detection {
  language: DocumentLanguage;
  score: number;
  runnerUp: number;
}

/** Remove code and comments, which must not classify prose. */
export function stripNoise(input: string): string {
  return input
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function count(text: string, pattern: RegExp): number {
  let n = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text) !== null) {
    n += 1;
    if (n > 20) break;
  }
  return n;
}

export function scoreMarkdown(raw: string): number {
  const text = stripNoise(raw);
  let score = 0;
  const headings = count(text, /^ {0,3}#{1,6}\s+\S/gm);
  if (headings > 0) score += 4 + Math.min(headings - 1, 1);
  if (/\*\*[^*\n]+\*\*/.test(text)) score += 4;
  if (/!\[[^\]\n]*\]\([^)\n]+\)/.test(text)) score += 4;
  if (/\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\)/.test(text)) score += 4;
  if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(text)) score += 4;
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/m.test(text)) score += 4;
  if (/^---\r?\n(?:[A-Za-z][\w-]*:\s*.*\r?\n)+---\s*$/m.test(text)) score += 5;
  if (/^ {0,3}>\s+\S/m.test(text)) score += 2;
  if (count(text, /^ {0,3}(?:[-*+]|\d+[.)])\s+\S/gm) >= 2) score += 1;
  if (count(text, /^ {0,3}(`{3,}|~{3,})/gm) > 0) score += 1;
  return score;
}

const TYPST_COMMANDS =
  /^ {0,3}#(?:let|set|show|import|include|figure|table|link|image|text|strong|emph|raw|heading|quote|align|grid|stack|box|place|line|rect|circle|ellipse|polygon|path|outline|bibliography|citation|footnote|ref|label)\b/gm;

export function scoreTypst(raw: string): number {
  const text = stripNoise(raw);
  let score = 0;
  if (/^ {0,3}={1,6}\s+\S/m.test(text)) score += 4;
  if (count(text, TYPST_COMMANDS) > 0) score += 5;
  if (/#(?:table|figure)\s*\(/.test(text)) score += 5;
  if (count(text, /^\s*\+\s+\S/gm) >= 2) score += 3;
  if (/@[A-Za-z][\w:-]*/.test(text)) score += 1;
  if (/<[a-z][\w:-]*>/.test(text)) score += 1;
  if (/^\s*\/\/.*$/m.test(text)) score += 1;
  if (/\$[^$\n]+\$/.test(text)) score += 1;
  if (count(text, /^ {0,3}[-*+]\s+\S/gm) >= 2) score += 1;
  return score;
}

const BLOCK_TAG =
  /^<(?:\!doctype\s+html|html|body|main|article|section|header|footer|div|p|h[1-6]|ul|ol|li|table|blockquote|pre|figure|details)\b/i;

/** HTML is conservative for a clipboard fragment and looser for a whole buffer. */
export function scoreHtml(raw: string, mode: "clipboard" | "document"): number {
  const text = raw.trimStart();
  if (/^<!doctype\s+html\b/i.test(text) || /^<html\b/i.test(text) || /^<body\b/i.test(text)) {
    return 6;
  }
  if (!BLOCK_TAG.test(text)) return 0;
  const first = /^<([a-z][\w-]*)\b/i.exec(text)?.[1]?.toLowerCase();
  if (mode === "clipboard") {
    // A plain-text clipboard is only trusted as HTML when it is a whole document:
    // a code snippet starting with <div> must not be eaten by the parser.
    return 0;
  }
  if (first && new RegExp(`</${first}\\s*>`, "i").test(text)) return 4;
  if (count(text, /<[a-z][\w-]*\b[^>]*>/gi) >= 2) return 4;
  return 0;
}

/** The confident syntax of a text, or null when the evidence is too thin. */
export function detectTextSyntax(
  raw: string,
  mode: "clipboard" | "document" = "clipboard",
): Detection | null {
  if (raw.trim() === "") return null;
  const html = scoreHtml(raw, mode);
  const markdown = scoreMarkdown(raw);
  const typst = scoreTypst(raw);
  const scores: Array<[DocumentLanguage, number]> = [
    ["html", html],
    ["markdown", markdown],
    ["typst", typst],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [language, score] = scores[0];
  const runnerUp = scores[1][1];
  if (score < 4 || score - runnerUp < 2) return null;
  return { language, score, runnerUp };
}

function listLines(text: string): number {
  return count(stripNoise(text), /^ {0,3}(?:[-*+]|\d+[.)])\s+\S/gm);
}

/**
 * Which clipboard representation to use for `destination`.
 *
 * The plain-text representation wins when it is already in the destination's
 * syntax; otherwise HTML wins over a different text syntax; otherwise text is
 * pasted natively.
 */
export function chooseSource(
  payload: ClipboardPayload,
  destination: DocumentLanguage,
): ClipboardChoice {
  const text = payload.text ?? "";
  const confident = detectTextSyntax(text, "clipboard");

  // A typed syntax that already matches the destination should not be converted.
  if (destination === "markdown" && text && confident?.language === "markdown") {
    return { source: "markdown", native: true };
  }
  if (destination === "typst" && text && confident?.language === "typst") {
    return { source: "typst", native: true };
  }
  if (destination === "html" && text && confident?.language === "html") {
    // The destination is HTML, but the fragment still needs sanitising.
    return { source: "html", native: false };
  }

  if (payload.html && payload.html.trim() !== "") {
    return { source: "html", native: false };
  }
  if (payload.markdown && payload.markdown.trim() !== "") {
    return {
      source: "markdown",
      native: destination === "markdown" && payload.text !== null,
    };
  }
  if (!text) return { source: "plain", native: true };

  if (destination === "html" && listLines(text) >= 2) {
    return { source: "markdown", native: false };
  }
  if (confident) {
    const native =
      confident.language === destination &&
      (confident.language === "markdown" || confident.language === "typst") &&
      payload.text !== null;
    return { source: confident.language === "html" ? "html" : confident.language, native };
  }
  return { source: "plain", native: true };
}
