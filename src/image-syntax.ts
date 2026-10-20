//! The one place that turns a saved image path into the destination's markup.
//!
//! The image pipeline (clipboard bitmaps, URLs, paths and drops) and the rich
//! paste renderers both call these builders, so Markdown, Typst and HTML cannot
//! disagree about how an image is written.

import type { DocumentLanguage } from "./api.ts";

/** Escape a value for a double-quoted Typst string. */
export function typstString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The image markup for a language. Paths are already document-relative. */
export function imageSyntaxFor(language: DocumentLanguage, alt: string, src: string): string {
  if (language === "typst") {
    const body = `#image("${typstString(src)}"`;
    return alt.trim() ? `${body}, alt: "${typstString(alt)}")` : `${body})`;
  }
  if (language === "html") {
    return `<img src="${htmlEscape(src)}" alt="${htmlEscape(alt)}">`;
  }
  if (language === "asciidoc") {
    // The standalone image macro; an inline image is `image:`, built by the
    // paste renderer where the surrounding sentence is known.
    return `image::${src}[${alt.replace(/\\/g, "\\\\").replace(/\]/g, "\\]").replace(/,/g, "\\,")}]`;
  }
  // Exactly the string the image pipeline produced before this feature: the
  // Markdown path must not change, including its historical lack of alt escaping.
  return `![${alt}](${src})`;
}

/** True when the path needs to stay relative for the preview/compiler to reach it. */
export function needsRelativePath(language: DocumentLanguage): boolean {
  // The HTML guest is served from the document's folder, Typst compiles with
  // `--root` there, and the AsciiDoc preview resolves image targets there.
  return language === "html" || language === "typst" || language === "asciidoc";
}
