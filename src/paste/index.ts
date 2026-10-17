//! Paste orchestration.
//!
//! The caller resolves the destination and reads the clipboard synchronously;
//! this module chooses a representation, parses it, resolves images, renders the
//! destination's syntax and reports what it did. A conversion failure returns the
//! plain text, never nothing.

import type { DocumentLanguage } from "../api.ts";
import { chooseSource, type ClipboardPayload, type SourceFormat } from "./detect.ts";
import type { Block, Inline } from "./ir.ts";
import { inlineText, isBlockFragment, trimBlocks } from "./ir.ts";
import { readHtml, htmlToText } from "./read-html.ts";
import { readMarkdown } from "./read-markdown.ts";
import { readTypst } from "./read-typst.ts";
import { readAsciidoc } from "./read-asciidoc.ts";
import { renderMarkdown } from "./render-markdown.ts";
import { renderTypst } from "./render-typst.ts";
import { renderAsciidoc } from "./render-asciidoc.ts";
import { renderHtmlFragment } from "./render-html.ts";
import { sanitizeHtmlFragment } from "./html-fragment.ts";

export interface ImageRequest {
  src: string;
  alt: string;
}

export interface ResolvedImage {
  src: string;
  alt: string;
}

export type ImageResolver = (image: ImageRequest) => Promise<ResolvedImage | null>;

export interface PasteOptions {
  /** Resolve a data/local/remote image to a document-relative path. */
  resolveImage?: ImageResolver;
  /** Remote images resolved per paste. */
  maxRemote?: number;
  /** Total images resolved per paste. */
  maxImages?: number;
}

export interface PasteResult {
  text: string;
  /** True when the fragment must be separated from the surrounding paragraph. */
  block: boolean;
  source: SourceFormat;
  converted: boolean;
  notices: string[];
}

const MAX_HTML = 2_000_000;
const MAX_TEXT = 1_000_000;
const MAX_NODES = 20_000;

function isRemote(src: string): boolean {
  return /^https?:/i.test(src);
}

function collectImages(blocks: readonly Block[], out: Inline[] = []): Inline[] {
  const inline = (nodes: readonly Inline[]) => {
    for (const node of nodes) {
      if (node.kind === "image") out.push(node);
      else if ("children" in node) inline(node.children);
    }
  };
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph":
      case "heading":
        inline(block.children);
        break;
      case "list":
        for (const item of block.items) collectImages(item.blocks, out);
        break;
      case "quote":
        collectImages(block.blocks, out);
        break;
      case "table":
        if (block.header) for (const cell of block.header) inline(cell);
        for (const row of block.rows) for (const cell of row) inline(cell);
        break;
      default:
        break;
    }
  }
  return out;
}

function countNodes(blocks: readonly Block[]): number {
  let count = blocks.length;
  for (const block of blocks) {
    if (block.kind === "paragraph" || block.kind === "heading") count += block.children.length;
    else if (block.kind === "quote") count += countNodes(block.blocks);
    else if (block.kind === "list") for (const item of block.items) count += countNodes(item.blocks);
  }
  return count;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolveImages(
  blocks: Block[],
  options: PasteOptions,
  notices: string[],
): Promise<void> {
  if (!options.resolveImage) return;
  const images = collectImages(blocks);
  if (images.length === 0) return;
  const resolver = options.resolveImage;
  const maxImages = options.maxImages ?? 20;
  const maxRemote = options.maxRemote ?? 8;
  let remote = 0;
  let skipped = 0;
  const candidates: Inline[] = [];
  for (const image of images) {
    if (image.kind !== "image") continue;
    if (isRemote(image.src)) {
      remote += 1;
      if (remote > maxRemote) {
        skipped += 1;
        continue;
      }
    }
    if (candidates.length >= maxImages) {
      skipped += 1;
      continue;
    }
    candidates.push(image);
  }
  if (skipped > 0) notices.push(`${skipped} image${skipped === 1 ? "" : "s"} kept the original address.`);
  await mapLimit(candidates, 4, async (image) => {
    if (image.kind !== "image") return;
    try {
      const resolved = await resolver({ src: image.src, alt: image.alt });
      if (resolved) {
        image.src = resolved.src;
        image.alt = resolved.alt;
      }
    } catch (error) {
      console.warn(`[paste] image ${image.src} could not be saved: ${String(error)}`);
    }
  });
}

function plainBlock(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    trimmed.includes("\n\n") ||
    /^(?:#{1,6}\s|={1,6}\s|```|~~~|>\s|[-+]\s|\d+[.)]\s|\|)/m.test(trimmed) ||
    /^(?:image::|include::|:[\w-]+:|\[.*\]$|\|===)/m.test(trimmed)
  );
}

function fallbackText(payload: ClipboardPayload): string {
  if (payload.text) return payload.text;
  if (payload.html) return htmlToText(payload.html);
  return payload.markdown ?? "";
}

function sourceText(payload: ClipboardPayload, source: SourceFormat): string {
  if (source === "html") return payload.html ?? "";
  if (source === "markdown") return payload.markdown ?? payload.text ?? "";
  return payload.text ?? "";
}
/**
 * Convert a clipboard payload for `destination`.
 *
 * Returns null only when the clipboard has no text at all. Any other failure is
 * reported as a plain-text result, so a paste never loses the user's content.
 */
export async function planPaste(
  payload: ClipboardPayload,
  destination: DocumentLanguage,
  options: PasteOptions = {},
): Promise<PasteResult | null> {
  const choice = chooseSource(payload, destination);
  const source = choice.source;
  const notices: string[] = [];
  const original = sourceText(payload, source);
  if (!payload.html && !payload.markdown && !payload.text) return null;

  // The clipboard already carries the destination syntax. Do not round-trip it.
  if (source === destination && source !== "html") {
    return {
      text: original,
      block: plainBlock(original),
      source,
      converted: false,
      notices,
    };
  }

  if (source === "plain") {
    return {
      text: payload.text ?? "",
      block: plainBlock(payload.text ?? ""),
      source,
      converted: false,
      notices,
    };
  }

  const raw = original;
  const tooLarge =
    source === "html" ? raw.length > MAX_HTML : raw.length > MAX_TEXT;
  if (tooLarge) {
    notices.push("The clipboard was too large to convert; pasted it as plain text.");
    return {
      text: fallbackText(payload),
      block: false,
      source,
      converted: false,
      notices,
    };
  }

  try {
    if (source === "html" && destination === "html") {
      const html = await sanitizeHtmlFragment(raw);
      return {
        text: html,
        block: /<(?:p|div|h[1-6]|ul|ol|li|table|thead|tbody|tr|blockquote|pre|hr|figure)\b/i.test(html),
        source,
        converted: true,
        notices,
      };
    }

    let blocks: Block[];
    if (source === "html") blocks = await readHtml(raw);
    else if (source === "markdown") blocks = await readMarkdown(raw);
    else if (source === "asciidoc") blocks = await readAsciidoc(raw);
    else blocks = await readTypst(raw);

    if (countNodes(blocks) > MAX_NODES) {
      notices.push("The pasted fragment was too complex to convert; pasted it as plain text.");
      return {
        text: fallbackText(payload),
        block: false,
        source,
        converted: false,
        notices,
      };
    }

    await resolveImages(blocks, options, notices);
    blocks = trimBlocks(blocks);

    let text: string;
    if (destination === "markdown") text = renderMarkdown(blocks);
    else if (destination === "typst") text = renderTypst(blocks);
    else if (destination === "asciidoc") text = renderAsciidoc(blocks);
    else text = renderHtmlFragment(blocks);

    if (!text.trim()) {
      const fallback = fallbackText(payload);
      if (!fallback.trim()) return null;
      return { text: fallback, block: plainBlock(fallback), source, converted: false, notices };
    }
    return {
      text,
      block: isBlockFragment(blocks),
      source,
      converted: true,
      notices,
    };
  } catch (error) {
    console.warn(`[paste] conversion failed: ${String(error)}`);
    notices.push("The clipboard could not be converted; pasted it as plain text.");
    return {
      text: fallbackText(payload),
      block: false,
      source,
      converted: false,
      notices,
    };
  }
}

/** Used by the fallback path and by tests that need the visible text. */
export function visibleText(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "paragraph" || block.kind === "heading") return inlineText(block.children);
      if (block.kind === "quote") return visibleText(block.blocks);
      if (block.kind === "list") return block.items.map((item) => visibleText(item.blocks)).join("\n");
      if (block.kind === "code") return block.text;
      if (block.kind === "table") {
        const rows = [...(block.header ? [block.header] : []), ...block.rows];
        return rows.map((row) => row.map((cell) => inlineText(cell)).join(" ")).join("\n");
      }
      return "";
    })
    .join("\n");
}
