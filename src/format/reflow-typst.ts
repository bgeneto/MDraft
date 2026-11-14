//! Typst rules for paragraph reflow.
//!
//! Markup is prose; code is not. A scanner follows Typst's modes — markup,
//! `[…]` content, `(…)`/`{…}` code, strings, raw, math and comments — and any
//! line that starts or ends inside something other than markup is protected.
//! Content blocks are markup again, so the prose inside `#quote[…]` reflows.

import { backtickSpans, delimitedSpans, escaped, indentOf, linesOf, type Dialect, type LineInfo } from "./reflow.ts";

/** Functions that read as running text at the start of a line. */
const INLINE_FUNCTIONS = new Set([
  "emph", "strong", "link", "ref", "cite", "footnote", "text", "raw", "underline", "strike",
  "highlight", "smallcaps", "sub", "super", "overline", "lorem", "h", "box", "sym", "emoji",
]);

/** A list, enum or term marker at a line start; groups: indent, marker. */
const ITEM = /^([ \t]*)(-|\+|\d+\.)(?:[ \t]+)(?=\S)/;
const TERM = /^([ \t]*)\/[ \t]+[^:\n]*:[ \t]*/;

function isStructural(line: string): boolean {
  const trimmed = line.trimStart();
  if (/^(?:=+(?:[ \t]|$)|[-+](?:[ \t]|$)|\d+\.(?:[ \t]|$)|\/(?:[ \t]|$)|\/\/|\/\*|```|\]|\$(?:[ \t]|$)|<[\w:.-]+>)/.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("#")) {
    const name = /^#([A-Za-z_][\w-]*)/.exec(trimmed)?.[1];
    return !name || !INLINE_FUNCTIONS.has(name);
  }
  return false;
}

/** The start of a `//` line comment outside raw, strings and URLs, or -1. */
function lineCommentStart(line: string): number {
  const raw = backtickSpans(line);
  for (let at = line.indexOf("//"); at >= 0; at = line.indexOf("//", at + 2)) {
    if (escaped(line, at)) continue;
    if (line[at - 1] === ":") continue; // `https://` is a link, not a comment
    if (raw.some(([from, to]) => at > from && at < to)) continue;
    return at;
  }
  return -1;
}

function endsWithBreak(line: string): boolean {
  if (lineCommentStart(line) >= 0) return true;
  const trimmed = line.trimEnd();
  return trimmed.endsWith("\\") && !escaped(trimmed, trimmed.length - 1);
}

type Mode = "markup" | "content" | "code";

/** Lines that begin or end inside code, raw, math, strings or comments. */
function deepLines(text: string): Set<number> {
  const deep = new Set<number>();
  let line = 0;
  const stack: Mode[] = ["markup"];
  const inCode = () => stack.includes("code");
  // Advance over `text[from, to)`, recording every newline crossed while in a
  // construct that is not markup.
  const cross = (from: number, to: number, always: boolean) => {
    for (let at = from; at < to; at += 1) {
      if (text[at] !== "\n") continue;
      if (always || inCode()) {
        deep.add(line);
        deep.add(line + 1);
      }
      line += 1;
    }
  };
  const closeOf = (from: number, closer: string): number => {
    const end = text.indexOf(closer, from);
    return end < 0 ? text.length : end + closer.length;
  };

  let at = 0;
  while (at < text.length) {
    const ch = text[at];
    const mode = stack[stack.length - 1];
    let next = at + 1;
    if (ch === "\\" && mode !== "code") {
      next = at + 2;
      cross(at, Math.min(next, text.length), false);
      at = next;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(text.slice(at))![0];
      let end = text.indexOf(run, at + run.length);
      end = end < 0 ? text.length : end + run.length;
      cross(at, end, true);
      at = end;
      continue;
    }
    if (text.startsWith("/*", at)) {
      next = closeOf(at + 2, "*/");
      cross(at, next, true);
      at = next;
      continue;
    }
    if (text.startsWith("//", at) && text[at - 1] !== ":") {
      next = text.indexOf("\n", at);
      at = next < 0 ? text.length : next;
      continue;
    }
    if (ch === "$") {
      let end = at + 1;
      while (end < text.length && (text[end] !== "$" || escaped(text, end))) end += 1;
      cross(at, end, true);
      at = end + 1;
      continue;
    }
    if (mode === "code") {
      if (ch === '"') {
        let end = at + 1;
        while (end < text.length && (text[end] !== '"' || escaped(text, end))) end += 1;
        cross(at, end, true);
        at = end + 1;
        continue;
      }
      if (ch === "(" || ch === "{") stack.push("code");
      else if (ch === "[") stack.push("content");
      else if (ch === ")" || ch === "}") stack.pop();
      cross(at, next, false);
      at = next;
      continue;
    }
    // Markup or content.
    if (ch === "]" && mode === "content") {
      stack.pop();
      at = next;
      continue;
    }
    if (ch === "[" && mode === "content") {
      stack.push("content");
      at = next;
      continue;
    }
    if (ch === "#") {
      // A code expression: name, field access, then call arguments.
      const head = /^#[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*/.exec(text.slice(at));
      if (head) {
        at += head[0].length;
        const keyword = /^#(?:let|set|show|import|include|if|else|for|while|return|context)\b/.test(head[0]);
        if (keyword) {
          // A statement runs to the end of its line, plus any group it opens.
          stack.push("code");
          let depth = 0;
          while (at < text.length) {
            const c = text[at];
            if (c === "\n" && depth === 0) break;
            if (c === '"') {
              let end = at + 1;
              while (end < text.length && (text[end] !== '"' || escaped(text, end))) end += 1;
              cross(at, end, true);
              at = end + 1;
              continue;
            }
            if (c === "(" || c === "[" || c === "{") depth += 1;
            else if (c === ")" || c === "]" || c === "}") depth -= 1;
            cross(at, at + 1, false);
            at += 1;
          }
          stack.pop();
          continue;
        }
        if (text[at] === "(" || text[at] === "[" || text[at] === "{") {
          stack.push(text[at] === "[" ? "content" : "code");
          at += 1;
        }
        continue;
      }
    }
    if (ch === "\n") line += 1;
    at = next;
  }
  return deep;
}

function classify(text: string): LineInfo[] {
  const lines = linesOf(text);
  const deep = deepLines(text);
  const infos: LineInfo[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return void infos.push({ kind: "blank" });
    if (deep.has(index)) {
      return void infos.push({ kind: "protected", note: "code, raw text or math spans this line" });
    }
    const breakAfter = endsWithBreak(line);
    const item = ITEM.exec(line) ?? TERM.exec(line);
    if (item) {
      return void infos.push({
        kind: "text",
        start: true,
        prefixLen: item[0].length,
        contPrefix: `${item[1]}  `,
        breakAfter,
      });
    }
    if (isStructural(line)) return void infos.push({ kind: "protected" });
    const previous = infos[index - 1];
    infos.push({
      kind: "text",
      prefixLen: indentOf(line).length,
      contPrefix: previous?.kind === "text" ? undefined : indentOf(line),
      breakAfter,
    });
  });
  return infos;
}

/** `[from, to)` of a `#name(...)` call's code part, starting at `from`. */
function codeCallEnd(segment: string, from: number): number {
  const head = /^#[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*/.exec(segment.slice(from));
  if (!head) return from;
  let at = from + head[0].length;
  if (segment[at] !== "(") return at;
  let depth = 0;
  for (; at < segment.length; at += 1) {
    if (segment[at] === '"') {
      at += 1;
      while (at < segment.length && (segment[at] !== '"' || escaped(segment, at))) at += 1;
      continue;
    }
    if (segment[at] === "(") depth += 1;
    else if (segment[at] === ")" && --depth === 0) return at + 1;
  }
  return segment.length;
}

function unbreakable(segment: string): Array<[number, number]> {
  const ranges = backtickSpans(segment);
  ranges.push(...delimitedSpans(segment, "$"));
  for (const match of segment.matchAll(/#[A-Za-z_]/g)) {
    if (escaped(segment, match.index)) continue;
    ranges.push([match.index, codeCallEnd(segment, match.index)]);
  }
  for (const match of segment.matchAll(/<[\w:.-]+>|\/\*[\s\S]*?\*\//g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  const comment = lineCommentStart(segment);
  if (comment >= 0) ranges.push([comment - 1, segment.length + 1]);
  for (let at = 1; at < segment.length; at += 1) {
    if (segment[at] === " " && segment[at - 1] === "\\" && !escaped(segment, at - 1)) {
      ranges.push([at - 2, at + 1]);
    }
  }
  return ranges;
}

export const typstDialect: Dialect = { classify, isStructural, endsWithBreak, unbreakable };
