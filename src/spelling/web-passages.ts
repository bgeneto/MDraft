//! Conservative source ranges for web documents. Escaped strings are deferred
//! until their decoded-to-source mapping is available.

import { ensureSyntaxTree, language as activeLanguage, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { parseFragment } from "parse5";
import { decodeEscapedText } from "./escaped-text.ts";
import { htmlDecodedOffsets } from "../html-source-map.ts";

type Node = ReturnType<ReturnType<typeof syntaxTree>["resolve"]>;
export type WebLanguage = "html" | "javascript" | "json" | "css";
export type StringMode = "human" | "all" | "off";

export interface WebPassage {
  from: number;
  to: number;
  kind: "text" | "comment" | "string" | "identifier";
  language: string | null;
  text: string;
  offsets: Array<number | null>;
  encoding: "plain" | "json" | "javascript" | "template" | "html-text" | "html-attribute";
  quote: string;
}

const PROSE_FIELDS = new Set([
  "title",
  "description",
  "label",
  "message",
  "placeholder",
  "alt",
  "caption",
  "text",
  "tooltip",
  "help",
  "messages",
  "labels",
  "strings",
  "translations",
]);
const MACHINE_FIELDS = new Set([
  "id",
  "key",
  "url",
  "uri",
  "href",
  "src",
  "path",
  "file",
  "format",
  "pattern",
  "regex",
  "token",
  "hash",
  "color",
  "class",
]);
const HTML_ATTRIBUTES = new Set(["title", "alt", "placeholder", "aria-label"]);
const HTML_CODE = new Set(["code", "pre", "kbd", "samp"]);

function fieldName(raw: string): string {
  return raw
    .replace(/^["']|["']$/g, "")
    .replace(/[-_]/g, "")
    .toLowerCase();
}

function namesFor(state: EditorState, node: Node): string[] {
  const names: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "Property") {
      const name = parent.getChild("PropertyName") ?? parent.getChild("PropertyDefinition");
      if (name) names.push(fieldName(state.sliceDoc(name.from, name.to)));
    }
    if (parent.name === "VariableDeclaration") {
      // Only the adjacent declaration is safe when a declaration has commas.
      const equals = node.prevSibling;
      const name = equals?.name === "Equals" ? equals.prevSibling : null;
      if (name?.name === "VariableDefinition")
        names.push(fieldName(state.sliceDoc(name.from, name.to)));
    }
  }
  return names;
}

function machineValue(value: string): boolean {
  return (
    /(?:https?:\/\/|www\.|data:|[\\/]|\b[\w.+-]+@[\w.-]+\b)/i.test(value) ||
    /^[a-f0-9]{16,}$/i.test(value)
  );
}

function decodeHtml(
  raw: string,
  quote: string | null,
): { text: string; offsets: Array<number | null> } | null {
  if (!raw.includes("&"))
    return { text: raw, offsets: Array.from({ length: raw.length + 1 }, (_, index) => index) };
  const fragment = parseFragment(
    quote === null ? raw : "<span data-spell=" + quote + raw + quote + "></span>",
  );
  let text: string;
  if (quote === null) {
    if (fragment.childNodes.some((node) => node.nodeName !== "#text")) return null;
    text = fragment.childNodes.map((node) => ("value" in node ? node.value : "")).join("");
  } else {
    const node = fragment.childNodes[0];
    if (!node || !("attrs" in node)) return null;
    const attr = node.attrs.find((entry) => entry.name === "data-spell");
    if (!attr) return null;
    text = attr.value;
  }
  const offsets = htmlDecodedOffsets(raw, text);
  return offsets ? { text, offsets } : null;
}

function stringEligible(value: string, names: readonly string[], mode: StringMode): boolean {
  if (mode === "off" || names.some((name) => MACHINE_FIELDS.has(name)) || machineValue(value))
    return false;
  return (
    mode === "all" ||
    names.some((name) => PROSE_FIELDS.has(name)) ||
    (value.match(/\p{L}+/gu)?.length ?? 0) >= 2
  );
}

function htmlContext(
  state: EditorState,
  node: Node,
): { allowed: boolean; language: string | null } {
  let explicit: boolean | null = null;
  let language: string | null = null;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name !== "Element") continue;
    const open = parent.getChild("OpenTag");
    const tag = open?.getChild("TagName");
    if (tag && HTML_CODE.has(state.sliceDoc(tag.from, tag.to).toLowerCase()))
      return { allowed: false, language };
    for (let attr = open?.getChild("Attribute"); attr; attr = attr.nextSibling) {
      if (attr.name !== "Attribute") continue;
      const name = attr.getChild("AttributeName");
      const value = attr.getChild("AttributeValue");
      if (!name) continue;
      const attribute = state.sliceDoc(name.from, name.to).toLowerCase();
      const raw = value ? state.sliceDoc(value.from, value.to).replace(/^["']|["']$/g, "") : "";
      if (attribute === "lang" && language === null) language = raw;
      if (attribute === "spellcheck" && explicit === null && /^(?:true|false|)$/i.test(raw))
        explicit = raw.toLowerCase() !== "false";
    }
  }
  return { allowed: explicit !== false, language };
}

function hasAncestor(node: Node, names: ReadonlySet<string>): boolean {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (names.has(parent.name)) return true;
  return false;
}

const CSS_CONTEXT = new Set(["StyleSheet", "Styles"]);
const JS_CONTEXT = new Set(["Script"]);
const IDENTIFIER_SKIP = new Set([
  "ImportDeclaration",
  "ExportDeclaration",
  "Interpolation",
  "TaggedTemplateExpression",
]);

/** Extract ranges only after the requested document grammar has loaded. */
export function webSpellingPassages(
  state: EditorState,
  language: WebLanguage,
  from = 0,
  to = state.doc.length,
  mode: StringMode = "human",
  identifiers = false,
): WebPassage[] {
  if (state.facet(activeLanguage)?.name !== language) return [];
  const tree = ensureSyntaxTree(state, to, 20);
  if (!tree || tree.length < to) return [];
  const passages: WebPassage[] = [];
  const visitedTextGroups = new Set<number>();
  function add(
    start: number,
    end: number,
    kind: WebPassage["kind"],
    locale: string | null,
    encoding: WebPassage["encoding"] = "plain",
    quote = "",
  ): void {
    // Clip long passages at unescaped whitespace, never inside an entity,
    // escape, or word. Keep a margin so viewport boundaries retain whole words.
    let lo = encoding === "plain" ? Math.max(start, from) : start;
    let hi = encoding === "plain" ? Math.min(end, to) : end;
    if (encoding !== "plain" && end - start > 16_384) {
      const lower = Math.max(start, from - 1024);
      const upper = Math.min(end, to + 1024);
      const fragment = state.sliceDoc(lower, upper);
      const spaces = [...fragment.matchAll(/\s/gu)]
        .map((match) => match.index)
        .filter((index) => {
          if (encoding === "html-text" || encoding === "html-attribute") return true;
          let cursor = lower + index - 1;
          while (cursor >= start && state.sliceDoc(cursor, cursor + 1) === "\\") cursor -= 1;
          return (lower + index - cursor - 1) % 2 === 0;
        });
      const firstSpace = spaces[0] ?? -1;
      const lastSpace = spaces[spaces.length - 1] ?? -1;
      if (lower > start && firstSpace < 0) return;
      if (upper < end && lastSpace < 0) return;
      lo = lower === start ? start : lower + firstSpace + 1;
      hi = upper === end ? end : lower + lastSpace;
    }
    if (lo >= hi || hi <= from || lo >= to) return;
    const raw = state.sliceDoc(lo, hi);
    const decoded =
      encoding === "plain"
        ? { text: raw, offsets: Array.from({ length: raw.length + 1 }, (_, index) => index) }
        : encoding === "html-text" || encoding === "html-attribute"
          ? decodeHtml(raw, encoding === "html-text" ? null : quote || '"')
          : decodeEscapedText(
              raw,
              encoding === "template" ? "javascript" : encoding,
              encoding === "template",
            );
    if (decoded)
      passages.push({ from: lo, to: hi, kind, language: locale, encoding, quote, ...decoded });
  }
  function addInlineStyles(value: Node, locale: string | null): void {
    // Attribute CSS is an overlay, which ordinary tree iteration does not enter.
    // Starting at topNode avoids Tree.resolveInner's order-dependent cache.
    let inner: Node | null = tree!.topNode.resolveInner(value.from + 1, 1);
    while (inner && inner.name !== "Styles") inner = inner.parent;
    if (!inner) return;
    const pending: Node[] = [inner];
    while (pending.length) {
      const current = pending.pop()!;
      if (current.type.isError) continue;
      if (current.name === "Comment") {
        const raw = state.sliceDoc(current.from, current.to);
        if (raw.startsWith("/*") && raw.endsWith("*/"))
          add(current.from + 2, current.to - 2, "comment", locale);
      } else if (current.name === "StringLiteral") {
        const property =
          current.parent?.name === "Declaration" ? current.parent.getChild("PropertyName") : null;
        const raw = state.sliceDoc(current.from, current.to);
        const quote = raw[0];
        if (
          property &&
          state.sliceDoc(property.from, property.to).toLowerCase() === "content" &&
          (quote === '"' || quote === "'") &&
          raw.endsWith(quote) &&
          !raw.includes("\\")
        )
          add(current.from + 1, current.to - 1, "string", locale, "plain", quote);
      }
      for (let child = current.lastChild; child; child = child.prevSibling) pending.push(child);
    }
  }
  tree.iterate({
    from,
    to,
    enter(ref) {
      const node = ref.node;
      if (node.type.isError) return false;
      const context =
        language === "html" ? htmlContext(state, node) : { allowed: true, language: null };
      // Do not prune a disabled subtree: a descendant may explicitly re-enable it.
      if (!context.allowed) return;
      const css = language === "css" || (language === "html" && hasAncestor(node, CSS_CONTEXT));
      const javascript =
        language === "javascript" || (language === "html" && hasAncestor(node, JS_CONTEXT));
      if (language === "html" && node.name === "TextareaText") {
        add(node.from, node.to, "text", context.language, "html-text");
      } else if (
        identifiers &&
        ((javascript &&
          ["VariableDefinition", "VariableName", "PropertyDefinition"].includes(node.name)) ||
          (language === "json" && node.name === "PropertyName")) &&
        !hasAncestor(node, IDENTIFIER_SKIP)
      ) {
        const raw = state.sliceDoc(node.from, node.to);
        const quoted = raw.startsWith('"') && raw.endsWith('"');
        if (!raw.includes("\\"))
          add(
            node.from + (quoted ? 1 : 0),
            node.to - (quoted ? 1 : 0),
            "identifier",
            context.language,
          );
      } else if (
        language === "html" &&
        node.parent?.name === "Element" &&
        (node.name === "Text" || node.name === "CharacterReference")
      ) {
        let first = node;
        while (
          first.prevSibling &&
          (first.prevSibling.name === "Text" || first.prevSibling.name === "CharacterReference")
        )
          first = first.prevSibling;
        if (visitedTextGroups.has(first.from)) return;
        visitedTextGroups.add(first.from);
        let last = first;
        while (
          last.nextSibling &&
          (last.nextSibling.name === "Text" || last.nextSibling.name === "CharacterReference")
        )
          last = last.nextSibling;
        add(first.from, last.to, "text", context.language, "html-text");
      } else if (language === "html" && node.name === "AttributeValue") {
        const attr = node.parent?.getChild("AttributeName");
        if (attr && state.sliceDoc(attr.from, attr.to).toLowerCase() === "style")
          addInlineStyles(node, context.language);
        if (attr && HTML_ATTRIBUTES.has(state.sliceDoc(attr.from, attr.to).toLowerCase())) {
          const raw = state.sliceDoc(node.from, node.to);
          const quoted = raw.startsWith('"') || raw.startsWith("'");
          if ((!quoted || raw.endsWith(raw[0])) && (quoted || !/["'<=\x60]/.test(raw)))
            add(
              node.from + (quoted ? 1 : 0),
              node.to - (quoted ? 1 : 0),
              "string",
              context.language,
              "html-attribute",
              quoted ? raw[0] : "",
            );
        }
      } else if (
        (javascript && (node.name === "LineComment" || node.name === "BlockComment")) ||
        (css && node.name === "Comment")
      ) {
        const raw = state.sliceDoc(node.from, node.to);
        if (raw.startsWith("//")) add(node.from + 2, node.to, "comment", context.language);
        else if (raw.startsWith("/*") && raw.endsWith("*/")) {
          if (raw.startsWith("/**")) {
            let cursor = node.from + 3;
            const body = state.sliceDoc(cursor, node.to - 2);
            for (const match of body.matchAll(/@[A-Za-z][\w-]*|\{[^{}\n]*\}/g)) {
              const start = node.from + 3 + match.index;
              add(cursor, start, "comment", context.language);
              cursor = start + match[0].length;
            }
            add(cursor, node.to - 2, "comment", context.language);
          } else add(node.from + 2, node.to - 2, "comment", context.language);
        }
      } else if (javascript && node.name === "TemplateString") {
        const raw = state.sliceDoc(node.from, node.to);
        if (
          node.parent?.name === "TaggedTemplateExpression" ||
          raw.charCodeAt(0) !== 96 ||
          raw.charCodeAt(raw.length - 1) !== 96
        )
          return;
        const spans: Array<[number, number]> = [];
        let start = node.from + 1;
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name !== "Interpolation") continue;
          spans.push([start, child.from]);
          start = child.to;
        }
        spans.push([start, node.to - 1]);
        const values = spans.map(([lo, hi]) =>
          decodeEscapedText(state.sliceDoc(lo, hi), "javascript", true),
        );
        if (values.some((value) => !value)) return;
        const combined = values.map((value) => value?.text ?? "").join(" ");
        if (!stringEligible(combined, namesFor(state, node), mode)) return;
        for (const [lo, hi] of spans)
          add(lo, hi, "string", context.language, "template", String.fromCharCode(96));
      } else if (
        ((javascript || language === "json") && node.name === "String") ||
        (css && node.name === "StringLiteral")
      ) {
        const raw = state.sliceDoc(node.from, node.to);
        const quote = raw[0];
        if (
          (quote !== '"' && quote !== "'") ||
          !raw.endsWith(quote) ||
          (language === "json" && quote !== '"')
        )
          return;
        const encoding = css ? "plain" : language === "json" ? "json" : "javascript";
        if (css && raw.includes("\\")) return;
        const decoded =
          encoding === "plain"
            ? { text: raw.slice(1, -1) }
            : decodeEscapedText(raw.slice(1, -1), encoding);
        if (!decoded) return;
        if (css) {
          const declaration = node.parent;
          const property =
            declaration?.name === "Declaration" ? declaration.getChild("PropertyName") : null;
          if (!property || state.sliceDoc(property.from, property.to).toLowerCase() !== "content")
            return;
        } else {
          if (node.parent?.name === "ImportDeclaration") return;
          if (!stringEligible(decoded.text, namesFor(state, node), mode)) return;
        }
        add(node.from + 1, node.to - 1, "string", context.language, encoding, quote);
      }
    },
  });
  return passages;
}
