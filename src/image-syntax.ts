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

/** Preserve literal backslashes through Markdown's punctuation escapes. */
export function escapeMarkdownImagePath(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

/**
 * Escape a value for a LaTeX argument.
 *
 * LaTeX paths are read by the compiler's file lookup, not by a string parser, so
 * only the characters that would end the argument or start a command need
 * escaping. `#`, `%`, `&`, `_` and `$` are active in text mode and are escaped;
 * backslashes become forward slashes because a Windows separator is a command
 * character to TeX.
 */
export function latexPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/([#%&_$])/g, "\\$1")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
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
  if (language === "latex") {
    // `\includegraphics` has no alt text of its own; the caption belongs to the
    // `figure` environment around it, and inventing one here would put a
    // caption inside a paragraph. The alt text is therefore dropped rather than
    // written somewhere it would not be read.
    return `\\includegraphics{${latexPath(src)}}`;
  }
  // A single backslash before punctuation is a Markdown escape, not a path
  // separator. Escape it so Windows and UNC paths reach the parser intact.
  return `![${alt}](${escapeMarkdownImagePath(src)})`;
}

/** True when the path needs to stay relative for the preview/compiler to reach it. */
export function needsRelativePath(language: DocumentLanguage): boolean {
  // The HTML guest is served from the document's folder, Typst compiles with
  // `--root` there, the AsciiDoc preview resolves image targets there, and
  // LuaLaTeX runs with the project root as its working directory.
  return (
    language === "html" || language === "typst" || language === "asciidoc" || language === "latex"
  );
}
