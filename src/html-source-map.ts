//! Source positions for the HTML preview's text nodes.
//!
//! `html-preview.ts` walks the parse5 tree with `sourceCodeLocationInfo` and
//! records one `HtmlTextFragment` per text node. The guest cannot see those
//! offsets, so the bridge reports a text-node index and the text it selected.
//! This module is the pure rule that turns that report into a source range; it
//! imports nothing, so a unit test runs it without a browser.
//!
//! The sample check is deliberate. A document's own scripts can rewrite the
//! preview DOM, and a parser repair can split a text node differently from
//! parse5's tree. Either makes the index point at the wrong characters. A
//! mismatch returns null — no mark — rather than painting a plausible wrong
//! word. The line reveal remains.

/** One text node under a stamped block, with its source range. */
export interface HtmlTextFragment {
  /** The preview-only `data-mdraft-n` id of the nearest stamped ancestor. */
  n: number;
  /** Position among the text nodes under that stamp, in tree order. */
  index: number;
  /** Offset of the raw source slice in the document. */
  src0: number;
  src1: number;
  /** The raw source slice, entities and line endings included. */
  raw: string;
  /** The decoded text the browser will have in the text node. */
  text: string;
}

/** What the guest reports for a double-click or a settled drag. */
export interface HtmlSelection {
  n: number;
  index: number;
  start: number;
  end: number;
  sample: string;
  reveal: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** One decoded character, and how much raw text produced it. */
function decodeAt(raw: string, at: number): { text: string; next: number } {
  if (raw[at] === "\r" && raw[at + 1] === "\n") {
    return { text: "\n", next: at + 2 };
  }
  if (raw[at] !== "&") return { text: raw[at], next: at + 1 };

  const semicolon = raw.indexOf(";", at + 1);
  if (semicolon < 0 || semicolon - at > 12) return { text: "&", next: at + 1 };
  const body = raw.slice(at + 1, semicolon);
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const digits = hex ? body.slice(2) : body.slice(1);
    const code = Number.parseInt(digits, hex ? 16 : 10);
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
      return { text: String.fromCodePoint(code), next: semicolon + 1 };
    }
  }
  const named = NAMED_ENTITIES[body];
  if (named) return { text: named, next: semicolon + 1 };
  return { text: "&", next: at + 1 };
}

/**
 * The raw offset that produced a decoded offset inside one text node.
 *
 * The decoded and raw lengths differ wherever an entity or a CRLF appears.
 * `null` means the offset falls inside an entity's expansion or past the end,
 * which is not a character boundary and cannot be mapped safely.
 */
export function rawOffsetForDecoded(raw: string, offset: number): number | null {
  if (offset < 0) return null;
  let rawAt = 0;
  let decoded = 0;
  while (rawAt < raw.length) {
    if (decoded === offset) return rawAt;
    const step = decodeAt(raw, rawAt);
    decoded += step.text.length;
    if (decoded > offset) return null;
    rawAt = step.next;
  }
  return decoded === offset ? raw.length : null;
}

/**
 * The source range a guest selection names, or null when the DOM no longer
 * matches the table.
 */
export function htmlSourceRange(
  fragments: readonly HtmlTextFragment[],
  selection: HtmlSelection,
): { from: number; to: number } | null {
  if (
    !Number.isInteger(selection.n) ||
    !Number.isInteger(selection.index) ||
    !Number.isInteger(selection.start) ||
    !Number.isInteger(selection.end) ||
    selection.start < 0 ||
    selection.end <= selection.start
  ) {
    return null;
  }
  const fragment = fragments.find(
    (entry) => entry.n === selection.n && entry.index === selection.index,
  );
  if (!fragment) return null;
  if (selection.end > fragment.text.length) return null;
  if (fragment.text.slice(selection.start, selection.end) !== selection.sample) return null;

  const start = rawOffsetForDecoded(fragment.raw, selection.start);
  const end = rawOffsetForDecoded(fragment.raw, selection.end);
  if (start === null || end === null) return null;
  return { from: fragment.src0 + start, to: fragment.src0 + end };
}
