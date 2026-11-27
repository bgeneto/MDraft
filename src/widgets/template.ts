/**
 * Parser for the markup of chat-assistant figures.
 *
 * The dialect is HTML/SVG-shaped tags with JSX attribute values (`x={b.x+54}`)
 * and Svelte blocks (`{#each}`, `{#if}`, `{@const}`, plus the `{@body …}`
 * declarations ChatGPT emits). The result is a syntax tree only; `render.ts`
 * decides what each tag means. In `svg` mode (a ```svg fence) braces are
 * ordinary text, because plain SVG has no template holes.
 */

import {
  WidgetError,
  findClosingBrace,
  parseDeclaration,
  parseExpression,
  parsePattern,
  type Declaration,
  type Expr,
  type Pattern,
} from "./expr.ts";

export type AttrValue = { k: "str"; v: string } | { k: "expr"; e: Expr } | { k: "bool" };

export interface Attr {
  name: string;
  value: AttrValue;
}

export type TNode =
  | { k: "el"; tag: string; attrs: Attr[]; children: TNode[]; line: number }
  | { k: "text"; parts: (string | Expr)[]; line: number }
  | {
      k: "each";
      list: Expr;
      pattern: Pattern;
      index: string | null;
      children: TNode[];
      otherwise: TNode[] | null;
      line: number;
    }
  | { k: "if"; branches: { test: Expr | null; children: TNode[] }[]; line: number }
  | { k: "decl"; decl: Declaration; line: number };

export type ParseMode = "template" | "svg";

const MAX_SOURCE = 200_000;

type Frame =
  | { kind: "root"; children: TNode[] }
  | { kind: "el"; node: Extract<TNode, { k: "el" }>; children: TNode[] }
  | { kind: "each"; node: Extract<TNode, { k: "each" }>; children: TNode[] }
  | { kind: "if"; node: Extract<TNode, { k: "if" }>; children: TNode[] };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  times: "×",
  middot: "·",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  le: "≤",
  ge: "≥",
  copy: "©",
};

/** Decode the character references assistants use in markup text. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z]+);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return "�";
      }
      return String.fromCodePoint(code);
    }
    return ENTITIES[ref] ?? whole;
  });
}

// Raw-text elements are refused outright: their content is not markup, so the
// parser could not even find where they end in the way a browser would.
const REFUSED_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "textarea",
  "template",
]);

export function parseTemplate(src: string, mode: ParseMode): TNode[] {
  if (src.length > MAX_SOURCE) throw new WidgetError("figure source is too long");
  const lineStarts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const fail = (message: string, pos: number): never => {
    throw new WidgetError(message, lineAt(pos));
  };
  // Errors raised inside an expression know nothing about the fence; give them
  // the line of the hole they came from.
  const at = <T>(pos: number, fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof WidgetError && error.line === undefined) error.line = lineAt(pos);
      throw error;
    }
  };

  const root: Frame = { kind: "root", children: [] };
  const stack: Frame[] = [root];
  const top = () => stack[stack.length - 1];
  const appendText = (part: string | Expr, pos: number) => {
    const children = top().children;
    const last = children[children.length - 1];
    if (last && last.k === "text") last.parts.push(part);
    else children.push({ k: "text", parts: [part], line: lineAt(pos) });
  };

  let pos = 0;
  while (pos < src.length) {
    const c = src[pos];
    if (c === "<") {
      if (src.startsWith("<!--", pos)) {
        const end = src.indexOf("-->", pos + 4);
        if (end < 0) fail("unterminated comment", pos);
        pos = end + 3;
        continue;
      }
      if (src.startsWith("<![CDATA[", pos)) fail("CDATA sections are not supported", pos);
      if (src.startsWith("<?", pos) || src.startsWith("<!", pos)) {
        const end = src.indexOf(">", pos);
        if (end < 0) fail("unterminated declaration", pos);
        pos = end + 1;
        continue;
      }
      if (src[pos + 1] === "/") {
        const m = /^<\/\s*([A-Za-z][\w:.-]*)\s*>/.exec(src.slice(pos, pos + 200));
        if (!m) fail("malformed closing tag", pos);
        const frame = top();
        if (frame.kind !== "el") fail(`unexpected </${m![1]}>`, pos);
        const el = (frame as Extract<Frame, { kind: "el" }>).node;
        if (el.tag !== m![1] && el.tag.toLowerCase() !== m![1].toLowerCase()) {
          fail(`</${m![1]}> does not close <${el.tag}> from line ${el.line}`, pos);
        }
        stack.pop();
        pos += m![0].length;
        continue;
      }
      if (/[A-Za-z]/.test(src[pos + 1] ?? "")) {
        pos = openTag(pos);
        continue;
      }
      // A lone `<` is text, as in "a < b".
    }
    if (c === "{" && mode === "template") {
      pos = block(pos);
      continue;
    }
    // Plain text up to the next tag or hole.
    let end = pos + 1;
    while (end < src.length) {
      const ch = src[end];
      if (ch === "<" && /[A-Za-z/!?]/.test(src[end + 1] ?? "")) break;
      if (ch === "{" && mode === "template") break;
      end += 1;
    }
    appendText(decodeEntities(src.slice(pos, end)), pos);
    pos = end;
  }

  if (stack.length > 1) {
    const open = top();
    const line = open.kind === "root" ? 1 : open.node.line;
    const what =
      open.kind === "el" ? `<${open.node.tag}>` : open.kind === "each" ? "{#each}" : "{#if}";
    throw new WidgetError(`${what} is never closed`, line);
  }
  return root.children;

  function openTag(start: number): number {
    const nameMatch = /^<([A-Za-z][\w:.-]*)/.exec(src.slice(start, start + 200));
    if (!nameMatch) fail("malformed tag", start);
    const tag = nameMatch![1];
    if (REFUSED_TAGS.has(tag.toLowerCase())) fail(`<${tag}> is not allowed`, start);
    const node: Extract<TNode, { k: "el" }> = {
      k: "el",
      tag,
      attrs: [],
      children: [],
      line: lineAt(start),
    };
    let i = start + nameMatch![0].length;
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i += 1;
      if (i >= src.length) fail(`<${tag}> is never finished`, start);
      if (src.startsWith("/>", i)) {
        top().children.push(node);
        return i + 2;
      }
      if (src[i] === ">") {
        top().children.push(node);
        stack.push({ kind: "el", node, children: node.children });
        return i + 1;
      }
      if (src[i] === "{" && mode === "template") {
        const close = at(i, () => findClosingBrace(src, i));
        const inner = src.slice(i + 1, close).trim();
        if (inner.startsWith("...")) fail("spread attributes are not supported", i);
        if (!/^[A-Za-z_$][\w$]*$/.test(inner)) fail("malformed attribute", i);
        node.attrs.push({ name: inner, value: { k: "expr", e: { k: "id", name: inner } } });
        i = close + 1;
        continue;
      }
      const attrMatch = /^[A-Za-z_:@][\w:.-]*/.exec(src.slice(i, i + 200));
      if (!attrMatch) fail(`malformed attribute in <${tag}>`, i);
      const name = attrMatch![0];
      i += name.length;
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] !== "=") {
        node.attrs.push({ name, value: { k: "bool" } });
        continue;
      }
      j += 1;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      const q = src[j];
      if (q === '"' || q === "'") {
        const end = src.indexOf(q, j + 1);
        if (end < 0) fail(`unterminated value for ${name}`, j);
        const raw = src.slice(j + 1, end);
        node.attrs.push({ name, value: quotedValue(raw, j + 1) });
        i = end + 1;
      } else if (q === "{" && mode === "template") {
        const close = at(j, () => findClosingBrace(src, j));
        const exprSrc = src.slice(j + 1, close);
        node.attrs.push({ name, value: { k: "expr", e: at(j, () => parseExpression(exprSrc)) } });
        i = close + 1;
      } else {
        const m = /^[^\s>"'=`]+/.exec(src.slice(j));
        if (!m) fail(`missing value for ${name}`, j);
        let raw = m![0];
        // `<rect x=5/>` ends the tag; the slash is not part of the value.
        if (raw.endsWith("/") && src[j + raw.length] === ">") raw = raw.slice(0, -1);
        node.attrs.push({ name, value: { k: "str", v: decodeEntities(raw) } });
        i = j + raw.length;
      }
    }
  }

  /** A quoted attribute value; in template mode it may hold `{expr}` holes. */
  function quotedValue(raw: string, base: number): AttrValue {
    if (mode !== "template" || !raw.includes("{")) return { k: "str", v: decodeEntities(raw) };
    const parts: (string | Expr)[] = [];
    let i = 0;
    while (i < raw.length) {
      const open = raw.indexOf("{", i);
      if (open < 0) {
        parts.push(decodeEntities(raw.slice(i)));
        break;
      }
      if (open > i) parts.push(decodeEntities(raw.slice(i, open)));
      const close = at(base + open, () => findClosingBrace(raw, open));
      const exprSrc = raw.slice(open + 1, close);
      parts.push(at(base + open, () => parseExpression(exprSrc)));
      i = close + 1;
    }
    return { k: "expr", e: { k: "tpl", parts } };
  }

  /** `{…}` at `start`: a Svelte block tag, a declaration, or an expression hole. */
  function block(start: number): number {
    const close = at(start, () => findClosingBrace(src, start));
    const inner = src.slice(start + 1, close);
    const body = inner.trim();
    const line = lineAt(start);
    const next = close + 1;

    if (body.startsWith("#each")) {
      const node = at(start, () => eachHeader(body.slice(5), line));
      top().children.push(node);
      stack.push({ kind: "each", node, children: node.children });
      return next;
    }
    if (body.startsWith("#if")) {
      const test = at(start, () => parseExpression(body.slice(3)));
      const node: Extract<TNode, { k: "if" }> = {
        k: "if",
        branches: [{ test, children: [] }],
        line,
      };
      top().children.push(node);
      stack.push({ kind: "if", node, children: node.branches[0].children });
      return next;
    }
    if (body.startsWith(":else")) {
      const frame = top();
      const rest = body.slice(5).trim();
      if (frame.kind === "if") {
        const branches = frame.node.branches;
        if (branches[branches.length - 1].test === null) fail("{:else} after {:else}", start);
        let test: Expr | null = null;
        if (rest.startsWith("if")) test = at(start, () => parseExpression(rest.slice(2)));
        else if (rest) fail(`malformed {:else ${rest}}`, start);
        const branch = { test, children: [] as TNode[] };
        branches.push(branch);
        frame.children = branch.children;
        return next;
      }
      if (frame.kind === "each" && !rest) {
        if (frame.node.otherwise) fail("{:else} after {:else}", start);
        frame.node.otherwise = [];
        frame.children = frame.node.otherwise;
        return next;
      }
      fail("{:else} outside {#if} or {#each}", start);
    }
    if (body === "/each" || body === "/if") {
      const frame = top();
      const want = body === "/each" ? "each" : "if";
      if (frame.kind !== want) fail(`unexpected {${body}}`, start);
      stack.pop();
      return next;
    }
    if (body.startsWith("@body") || body.startsWith("@const")) {
      const declSrc = body.startsWith("@body") ? body.slice(5) : `const ${body.slice(6)}`;
      const decl = at(start, () => parseDeclaration(declSrc));
      top().children.push({ k: "decl", decl, line });
      return next;
    }
    if (/^[#:@/]/.test(body)) {
      fail(`{${body.split(/\s/)[0]}} is not supported`, start);
    }
    if (!body) {
      appendText("", start);
      return next;
    }
    appendText(
      at(start, () => parseExpression(inner)),
      start,
    );
    return next;
  }
}

/** `list as item, index (key)` */
function eachHeader(header: string, line: number): Extract<TNode, { k: "each" }> {
  const matches = Array.from(header.matchAll(/\sas\s/g));
  if (matches.length === 0) throw new WidgetError("{#each} needs “as”", line);
  // The last top-level ` as ` splits list from pattern; an earlier one can only
  // be inside a string, which the expression parser rejects or accepts itself.
  let listSrc = "";
  let rest = "";
  for (let m = matches.length - 1; m >= 0; m -= 1) {
    const at = matches[m].index!;
    listSrc = header.slice(0, at);
    rest = header.slice(at + matches[m][0].length).trim();
    try {
      parseExpression(listSrc);
      break;
    } catch (error) {
      if (m === 0) throw error;
    }
  }
  const list = parseExpression(listSrc);
  // Drop a keyed-each `(key)`; order is all a static figure needs.
  if (rest.endsWith(")")) {
    let depth = 0;
    for (let i = rest.length - 1; i >= 0; i -= 1) {
      if (rest[i] === ")") depth += 1;
      else if (rest[i] === "(") {
        depth -= 1;
        if (depth === 0) {
          rest = rest.slice(0, i).trim();
          break;
        }
      }
    }
  }
  let patternSrc = rest;
  let index: string | null = null;
  const opener = rest[0];
  if (opener === "[" || opener === "{") {
    const closer = opener === "[" ? "]" : "}";
    let depth = 0;
    let end = -1;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === opener) depth += 1;
      else if (rest[i] === closer) {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) throw new WidgetError("malformed {#each} pattern", line);
    patternSrc = rest.slice(0, end + 1);
    const tail = rest.slice(end + 1).trim();
    if (tail) {
      if (!tail.startsWith(",")) throw new WidgetError("malformed {#each} pattern", line);
      index = tail.slice(1).trim();
    }
  } else {
    const comma = rest.indexOf(",");
    if (comma >= 0) {
      patternSrc = rest.slice(0, comma);
      index = rest.slice(comma + 1).trim();
    }
  }
  if (index !== null && !/^[A-Za-z_$][\w$]*$/.test(index)) {
    throw new WidgetError("malformed {#each} index", line);
  }
  return {
    k: "each",
    list,
    pattern: parsePattern(patternSrc.trim()),
    index,
    children: [],
    otherwise: null,
    line,
  };
}
