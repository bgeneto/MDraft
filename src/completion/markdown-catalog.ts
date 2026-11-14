//! The Markdown completion catalog: data only.
//!
//! The second consumer of the completion layer, and the one that proves the layer
//! is language-neutral rather than a LaTeX special case. Nothing here imports
//! CodeMirror, so the catalog is testable without an editor.
//!
//! The list is deliberately small. Markdown has no long command names to
//! remember — its constructs are punctuation — so the popup's job is different:
//! it offers the *structure* a reader reaches for (a table skeleton, a fenced
//! block with a language slot, a task item) rather than a vocabulary. A catalog
//! that mirrored every Markdown feature would be a menu, not a completion.
//!
//! Snippets use CodeMirror's `${…}` tab-stop syntax and **real newlines**;
//! `Snippet.parse` splits on them, so a `\n` written as two characters would be
//! inserted literally.

import type { CatalogEntry } from "./latex-catalog.ts";

const SECTION = {
  snippet: "Snippets",
  inline: "Inline",
  block: "Blocks",
  link: "Links and images",
} as const;

/**
 * The Markdown rows.
 *
 * Each snippet is the smallest complete construct: a reader who accepts it gets
 * something that renders, with the caret where they have to type next.
 */
export function markdownCatalog(): CatalogEntry[] {
  return [
    // Blocks.
    {
      label: "```\n${1:language}\n${2:code}\n```",
      detail: "fenced code block",
      section: SECTION.snippet,
      snippet: true,
    },
    {
      label: "| ${1:Column} | ${2:Column} |\n| --- | --- |\n| ${3:Cell} | ${4:Cell} |",
      detail: "table",
      section: SECTION.snippet,
      snippet: true,
    },
    {
      label: "> ${1:quote}",
      detail: "block quote",
      section: SECTION.snippet,
      snippet: true,
    },
    {
      label: "- [ ] ${1:task}",
      detail: "task item",
      section: SECTION.snippet,
      snippet: true,
    },
    {
      label: "$$\n${1}\n$$",
      detail: "display mathematics",
      section: SECTION.snippet,
      snippet: true,
    },
    {
      label: "---",
      detail: "thematic break",
      section: SECTION.block,
    },
    {
      label: "[^${1:note}]",
      detail: "footnote reference",
      section: SECTION.block,
      snippet: true,
    },
    {
      label: "[TOC]",
      detail: "table of contents",
      section: SECTION.block,
    },

    // Inline.
    {
      label: "**${1:strong}**",
      detail: "strong",
      section: SECTION.snippet,
      snippet: true,
    },
    {
      label: "*${1:emphasis}*",
      detail: "emphasis",
      section: SECTION.snippet,
      snippet: true,
    },
    {
      label: "~~${1:strikethrough}~~",
      detail: "strikethrough",
      section: SECTION.snippet,
      snippet: true,
    },
    {
      label: "`${1:code}`",
      detail: "inline code",
      section: SECTION.snippet,
      snippet: true,
    },
    {
      label: "$${1:e^{i\\pi}+1=0}$",
      detail: "inline mathematics",
      section: SECTION.snippet,
      snippet: true,
    },

    // Links and images.
    {
      label: "[${1:text}](https://)",
      detail: "link",
      section: SECTION.snippet,
      snippet: true,
    },
    {
      label: "![${1:alt}](./image.png)",
      detail: "image",
      section: SECTION.snippet,
      snippet: true,
    },
    {
      label: "[${1:text}][${2:ref}]",
      detail: "reference link",
      section: SECTION.link,
      snippet: true,
    },
  ];
}

/**
 * The block markers, for the context table.
 *
 * A line that begins with one of these is already a block; offering to start
 * another there would nest a list inside a list by accident.
 */
export const MARKDOWN_BLOCK_MARKERS: readonly string[] = [
  "- ",
  "* ",
  "+ ",
  "1. ",
  "> ",
  "#",
  "```",
  "|",
];
