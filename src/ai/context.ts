//! Pure context capture and edit planning for the AI Assistant.
//!
//! This module never imports CodeMirror or Tauri: `scripts/ai-unit.mjs` runs it
//! under Node to prove the paragraph expansion, the continuation spacing, the
//! block separation, the stale-target guard and the floating-button geometry.
//! `src/main.ts` supplies the text, the selection offsets and the caret.

import type { AiActionId, AiRequest, AiTurn, DocumentLanguage } from "../api";

export interface CaptureInput {
  text: string;
  from: number;
  to: number;
  caret: number;
  language: DocumentLanguage;
}

export interface Capture {
  language: DocumentLanguage;
  /** The whole document, kept for the block and continuation rules. */
  text: string;
  hasSelection: boolean;
  /** The selected passage, trimmed. Empty when nothing is selected. */
  selection: string;
  /** The trimmed selection offsets, or the caret twice. */
  selectionFrom: number;
  selectionTo: number;
  /**
   * The passage an action works on: the selection, or the current paragraph.
   *
   * `passageFrom`/`passageTo` are what a rewrite replaces when the reader made
   * no selection, which is why they exist separately from the selection.
   */
  passage: string;
  passageFrom: number;
  passageTo: number;
  /**
   * The current paragraph, trimmed.
   *
   * Used as the fallback passage and as the anchor for Insert below.
   */
  paragraph: string;
  paragraphFrom: number;
  paragraphTo: number;
  /** Everything before the passage (or before the caret when nothing is selected). */
  preceding: string;
  caret: number;
}

export interface Target {
  sessionId: string;
  revision: number;
  from: number;
  to: number;
  /** The exact text at `from..to` when the answer was requested. */
  text: string;
}

export interface ApplyPlan {
  kind: "replace" | "insert";
  from: number;
  to: number;
  text: string;
}

function clampOffset(text: string, value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(text.length, Math.max(0, Math.trunc(value)));
}

function lineStart(text: string, position: number): number {
  return text.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
}

function lineEnd(text: string, position: number): number {
  const index = text.indexOf("\n", position);
  return index === -1 ? text.length : index;
}

/**
 * The paragraph around a position, or the block a selection spans.
 *
 * A paragraph is a run of non-blank lines, which is what a reader means by
 * "this paragraph" in all four markup languages. The offsets are trimmed so a
 * replacement leaves the surrounding indentation and blank lines alone.
 */
export function paragraphRange(
  text: string,
  from: number,
  to = from,
): { from: number; to: number } {
  let start = clampOffset(text, from);
  let end = clampOffset(text, Math.max(from, to));
  // A selection ending at the start of the next line belongs to the line above.
  if (end > start && end > 0 && text[end - 1] === "\n") end -= 1;
  start = lineStart(text, start);
  end = lineEnd(text, end);

  while (start > 0) {
    const previousEnd = start - 1;
    const previousStart = lineStart(text, previousEnd);
    if (text.slice(previousStart, previousEnd).trim() === "") break;
    start = previousStart;
  }
  while (end < text.length) {
    const nextStart = end + 1;
    const nextEnd = lineEnd(text, nextStart);
    if (text.slice(nextStart, nextEnd).trim() === "") break;
    end = nextEnd;
  }

  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { from: start, to: end };
}

/** Capture everything one request needs, in one synchronous step. */
export function captureContext(input: CaptureInput): Capture {
  const text = input.text;
  const from = clampOffset(text, input.from);
  const to = clampOffset(text, input.to);
  const caret = clampOffset(text, input.caret);
  const hasSelection = to > from;

  let selectionFrom = from;
  let selectionTo = to;
  if (hasSelection) {
    while (selectionFrom < selectionTo && /\s/.test(text[selectionFrom])) selectionFrom++;
    while (selectionTo > selectionFrom && /\s/.test(text[selectionTo - 1])) selectionTo--;
  }
  const selection = hasSelection ? text.slice(selectionFrom, selectionTo) : "";

  const paragraph = paragraphRange(
    text,
    hasSelection ? selectionFrom : caret,
    hasSelection ? selectionTo : caret,
  );
  const anchor = hasSelection ? selectionFrom : caret;
  const preceding = text.slice(0, anchor);

  return {
    language: input.language,
    text,
    hasSelection,
    selection,
    selectionFrom: hasSelection ? selectionFrom : caret,
    selectionTo: hasSelection ? selectionTo : caret,
    passage: hasSelection ? selection : text.slice(paragraph.from, paragraph.to),
    passageFrom: hasSelection ? selectionFrom : paragraph.from,
    passageTo: hasSelection ? selectionTo : paragraph.to,
    paragraph: text.slice(paragraph.from, paragraph.to),
    paragraphFrom: paragraph.from,
    paragraphTo: paragraph.to,
    preceding,
    caret,
  };
}

/**
 * Trim text before the caret the same way Rust does for Continue: the last
 * `limit` characters, dropped forward to a paragraph boundary.
 */
export function trimPreceding(text: string, limit = 12_000): { text: string; truncated: boolean } {
  const characters = Array.from(text);
  if (characters.length <= limit) return { text, truncated: false };
  let tail = characters.slice(characters.length - limit).join("");
  const boundary = tail.indexOf("\n\n");
  if (boundary >= 0) tail = tail.slice(boundary + 2);
  return { text: tail, truncated: true };
}

/** The passage an action sends, and the preceding text Continue needs. */
export function requestParts(
  capture: Capture,
  action: AiActionId,
): { selection: string; preceding: string } {
  if (action === "ask") {
    return { selection: capture.hasSelection ? capture.selection : "", preceding: "" };
  }
  if (action === "continue") {
    return {
      selection: capture.hasSelection ? capture.selection : "",
      preceding: capture.preceding,
    };
  }
  return {
    selection: capture.hasSelection ? capture.selection : capture.paragraph,
    preceding: "",
  };
}

/** Build the request payload. The backend validates and caps it again. */
export function buildRequest(
  id: string,
  capture: Capture,
  action: AiActionId,
  parameter: string | null,
  instruction: string,
  history: AiTurn[],
): AiRequest {
  const parts = requestParts(capture, action);
  return {
    id,
    action,
    parameter:
      action === "tone" || action === "translate" || action === "convert" ? parameter : null,
    language: capture.language,
    selection: parts.selection,
    preceding: parts.preceding,
    instruction: action === "ask" ? instruction.trim() : "",
    history: action === "ask" ? history : [],
  };
}

function isCjk(code: number | undefined): boolean {
  if (code === undefined) return false;
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * The text to insert after `preceding` for Continue.
 *
 * The rule has to handle prose (one space), punctuation (none), an existing
 * newline (none) and CJK, where a space between words would be wrong. Returning
 * only the insertion keeps the caller from rebuilding the document.
 */
export function joinContinuation(preceding: string, answer: string): string {
  const right = answer.trim();
  if (!right) return "";
  if (!preceding) return right;
  const last = preceding[preceding.length - 1];
  if (/\s/.test(last)) return right;
  if (/^[.,;:!?)\]}>%…—–]/.test(right)) return right;
  if (/[([{"'“‘/—–]$/.test(last)) return right;
  if (isCjk(preceding.codePointAt(preceding.length - 1)) || isCjk(right.codePointAt(0))) {
    return right;
  }
  return ` ${right}`;
}

/**
 * The text to insert at `at` to place `answer` as a new block.
 *
 * One blank line separates it from the block above; the document's final
 * newline convention is preserved.
 */
export function blockInsertion(doc: string, at: number, answer: string): string {
  const offset = clampOffset(doc, at);
  const before = doc.slice(0, offset);
  const after = doc.slice(offset);
  const body = answer.trim();
  if (!body) return "";
  let lead = "";
  if (before.length > 0 && !before.endsWith("\n\n")) {
    lead = before.endsWith("\n") ? "\n" : "\n\n";
  }
  let tail = "";
  if (after.length === 0) {
    tail = doc.endsWith("\n") ? "" : "\n";
  } else if (!after.startsWith("\n\n")) {
    tail = after.startsWith("\n") ? "\n" : "\n\n";
  }
  return `${lead}${body}${tail}`;
}

/** Where Continue inserts, and what it inserts. */
export function continuationPlan(capture: Capture, answer: string): ApplyPlan {
  const at = capture.hasSelection ? capture.selectionTo : capture.caret;
  return {
    kind: "insert",
    from: at,
    to: at,
    text: joinContinuation(capture.text.slice(0, at), answer),
  };
}

/**
 * What an apply button writes.
 *
 * The action decides the shape; the answer is always trimmed at the edges,
 * because the model's response is wrapped in a tag and usually starts on its
 * own line.
 */
export function applyPlan(capture: Capture, action: AiActionId, answer: string): ApplyPlan | null {
  const body = answer.trim();
  if (!body) return null;
  switch (action) {
    case "continue":
      return continuationPlan(capture, body);
    case "summarize":
    case "explain":
    case "keyPoints":
    case "critique":
    case "ask":
      return {
        kind: "insert",
        from: capture.paragraphTo,
        to: capture.paragraphTo,
        text: blockInsertion(capture.text, capture.paragraphTo, body),
      };
    default:
      return {
        kind: "replace",
        from: capture.passageFrom,
        to: capture.passageTo,
        text: body,
      };
  }
}

/**
 * Whether an answer may still be applied to the range it was requested for.
 *
 * Fail closed: a changed tab, revision or range text disables Replace and
 * leaves Insert below as the safe alternative.
 */
export function targetIsCurrent(
  target: Target,
  sessionId: string,
  revision: number,
  text: string,
): boolean {
  if (target.sessionId !== sessionId || target.revision !== revision) return false;
  if (target.from < 0 || target.to > text.length || target.from > target.to) return false;
  return text.slice(target.from, target.to) === target.text;
}

/**
 * Keep the last complete history pairs that fit the caps.
 *
 * Dropping a lone user or assistant turn would break Anthropic's alternation,
 * so pairs leave from the front.
 */
export function trimHistory(
  history: AiTurn[],
  maxTurns = 12,
  maxChars = 24_000,
): { history: AiTurn[]; dropped: boolean } {
  const kept = history.filter(
    (turn) => (turn.role === "user" || turn.role === "assistant") && turn.content.trim().length > 0,
  );
  let dropped = kept.length !== history.length;
  while (kept.length > maxTurns) {
    kept.splice(0, 2);
    dropped = true;
  }
  let total = kept.reduce((sum, turn) => sum + turn.content.length, 0);
  while (total > maxChars && kept.length >= 2) {
    const removed = kept.splice(0, 2);
    total -= removed.reduce((sum, turn) => sum + turn.content.length, 0);
    dropped = true;
  }
  return { history: kept, dropped };
}

export interface Point {
  x: number;
  y: number;
}

/** Bottom-right anchor, 20 px from the pane's edges, on every launch. */
export function defaultButtonPosition(
  paneWidth: number,
  paneHeight: number,
  size: number,
  margin = 20,
): Point {
  return clampButtonPosition(
    { x: paneWidth - size - margin, y: paneHeight - size - margin },
    paneWidth,
    paneHeight,
    size,
    margin,
  );
}

/** Keep the whole button inside the pane, with a small margin. */
export function clampButtonPosition(
  point: Point,
  paneWidth: number,
  paneHeight: number,
  size: number,
  margin = 8,
): Point {
  const maxX = Math.max(margin, paneWidth - size - margin);
  const maxY = Math.max(margin, paneHeight - size - margin);
  return {
    x: Math.min(Math.max(margin, point.x), maxX),
    y: Math.min(Math.max(margin, point.y), maxY),
  };
}

/** A pointer gesture becomes a drag only after this much movement. */
export function movedEnough(start: Point, current: Point, threshold = 4): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}
