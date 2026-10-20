//! A pasted HTML fragment, cleaned for an HTML document.
//!
//! The source page's stylesheets, scripts and layout are not imported. What
//! survives is semantic markup, safe classes and inline style declarations, and
//! only URLs that cannot execute.

type AnyNode = any;

const DROP = new Set([
  "script",
  "style",
  "link",
  "meta",
  "base",
  "title",
  "template",
  "noscript",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "canvas",
  "svg",
  "video",
  "audio",
  "source",
]);

const KEEP_ATTRS = new Set([
  "href",
  "src",
  "alt",
  "title",
  "colspan",
  "rowspan",
  "align",
  "class",
  "style",
  "start",
  "type",
  "datetime",
  "lang",
  "dir",
  "width",
  "height",
]);

function name(node: AnyNode): string {
  return typeof node?.nodeName === "string" ? node.nodeName.toLowerCase() : "";
}

function safeUrl(value: string, tag: string, attr: string): string | null {
  const url = value.trim();
  if (/^(?:javascript|vbscript):/i.test(url)) return null;
  if (/^data:/i.test(url) && !(tag === "img" && attr === "src")) return null;
  return url;
}

function cleanStyle(value: string): string {
  return value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      if (!declaration) return false;
      const property = declaration.split(":")[0]?.trim().toLowerCase() ?? "";
      if (property.startsWith("mso-")) return false;
      if (
        [
          "position",
          "top",
          "left",
          "right",
          "bottom",
          "z-index",
          "float",
          "display",
          "visibility",
        ].includes(property)
      ) {
        return false;
      }
      return true;
    })
    .join("; ");
}

function cleanAttrs(node: AnyNode): void {
  const tag = name(node);
  const next: AnyNode[] = [];
  for (const entry of node.attrs ?? []) {
    const attr = String(entry.name).toLowerCase();
    if (!KEEP_ATTRS.has(attr)) continue;
    if (attr === "href" || attr === "src") {
      const safe = safeUrl(String(entry.value ?? ""), tag, attr);
      if (safe === null) continue;
      next.push({ name: attr, value: safe });
      continue;
    }
    if (attr === "style") {
      const style = cleanStyle(String(entry.value ?? ""));
      if (style) next.push({ name: attr, value: style });
      continue;
    }
    if (attr === "class") {
      const classes = String(entry.value ?? "")
        .split(/\s+/)
        .filter((value) => value && !/^Mso/i.test(value));
      if (classes.length) next.push({ name: attr, value: classes.join(" ") });
      continue;
    }
    next.push({ name: attr, value: String(entry.value ?? "") });
  }
  node.attrs = next;
}

function unwrapDocsWrapper(node: AnyNode): boolean {
  return (
    /^(b|strong)$/.test(name(node)) &&
    /^docs-internal-guid/.test(
      (node.attrs ?? []).find((entry: AnyNode) => String(entry.name).toLowerCase() === "id")
        ?.value ?? "",
    )
  );
}

function hiddenByStyle(node: AnyNode): boolean {
  const style = String(
    (node.attrs ?? []).find((entry: AnyNode) => String(entry.name).toLowerCase() === "style")
      ?.value ?? "",
  ).toLowerCase();
  return /display\s*:\s*none/.test(style) || /visibility\s*:\s*hidden/.test(style);
}

function cleanChildren(parent: AnyNode): void {
  const next: AnyNode[] = [];
  for (const child of parent.childNodes ?? []) {
    if (name(child) === "#comment") continue;
    if (DROP.has(name(child))) continue;
    if (hiddenByStyle(child)) continue;
    if (unwrapDocsWrapper(child)) {
      cleanChildren(child);
      next.push(...(child.childNodes ?? []));
      continue;
    }
    if (name(child) !== "#text") {
      cleanChildren(child);
      cleanAttrs(child);
    }
    next.push(child);
  }
  parent.childNodes = next;
}

export async function sanitizeHtmlFragment(raw: string): Promise<string> {
  const { parse, parseFragment, serialize } = await import("parse5");
  let root: AnyNode;
  let bodyOnly = false;
  if (/^\s*(?:<!doctype\b|<html\b|<head\b|<body\b)/i.test(raw)) {
    const document = parse(raw) as AnyNode;
    const html = (document.childNodes ?? []).find((node: AnyNode) => name(node) === "html");
    const body = html
      ? (html.childNodes ?? []).find((node: AnyNode) => name(node) === "body")
      : null;
    root = body ?? document;
    bodyOnly = body !== null;
  } else {
    root = parseFragment(raw) as AnyNode;
  }
  cleanChildren(root);
  let serialized = serialize(root) as string;
  if (bodyOnly) {
    serialized = serialized.replace(/^<body\b[^>]*>/i, "").replace(/<\/body>\s*$/i, "");
  }
  return serialized.trim();
}
