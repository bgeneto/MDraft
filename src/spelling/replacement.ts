//! Encode a dictionary suggestion for its original source context.

import type { WebPassage } from "./web-passages.ts";

export function encodeReplacement(value: string, passage: WebPassage): string | null {
  if (passage.kind === "identifier" || !value || value.includes("\0") || /[\r\n]/u.test(value))
    return null;
  if (
    passage.encoding === "json" ||
    passage.encoding === "javascript" ||
    passage.encoding === "template"
  ) {
    const encoded = JSON.stringify(value).slice(1, -1);
    if (passage.encoding === "template")
      return encoded
        .split(String.fromCharCode(96))
        .join("\\" + String.fromCharCode(96))
        .replace(/\$\{/g, "\\${");
    return passage.encoding === "javascript" && passage.quote === "'"
      ? encoded.replace(/'/g, "\\'")
      : encoded;
  }
  if (passage.encoding === "html-text" || passage.encoding === "html-attribute") {
    let encoded = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    if (passage.encoding === "html-attribute") {
      if (!passage.quote && /[\s"'=><\x60]/u.test(value)) return null;
      if (passage.quote === '"') encoded = encoded.replace(/"/g, "&quot;");
      if (passage.quote === "'") encoded = encoded.replace(/'/g, "&#39;");
    }
    return encoded;
  }
  // Plain comments and CSS strings cannot safely accept their own delimiter.
  if (
    (passage.kind === "comment" && value.includes("*/")) ||
    (passage.quote && (value.includes(passage.quote) || value.includes("\\")))
  )
    return null;
  return value;
}
