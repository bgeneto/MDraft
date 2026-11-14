//! Scroll correspondence between the source and the TeXpresso frame.
//!
//! The frame scrolls inside itself (`#pages`), so MDraft's preview pane never
//! moves and `alignPagesScroll` does not apply. Both directions meet at one
//! reference line, MDraft's usual sync margin below the panes' common top, and
//! cross as a fractional 1-based source line: the frame turns it into a page
//! position through the engine's source map (mdraft-bridge.js), and the editor
//! turns it into a scroll offset here.

export interface EditorScrollGeometry {
  /** Document offset at a viewport y. */
  offsetAtScreenY(y: number): number;
  lineOfOffset(offset: number): number;
  lineCount(): number;
  /** The scroll offset that puts `line`'s top at the scroller's top. */
  lineScrollTop(line: number): number;
  scrollTop(): number;
  /** The scroller's top edge, in viewport coordinates. */
  scrollerTop(): number;
}

/** The fractional source line at viewport y `reference`. */
export function editorLineAt(editor: EditorScrollGeometry, reference: number): number {
  const line = editor.lineOfOffset(editor.offsetAtScreenY(reference));
  const top = editor.lineScrollTop(line);
  const next = line < editor.lineCount() ? editor.lineScrollTop(line + 1) : top;
  const at = editor.scrollTop() + (reference - editor.scrollerTop());
  if (next <= top) return line;
  return line + Math.max(0, Math.min(0.999, (at - top) / (next - top)));
}

/** The editor scroll offset that puts fractional `line` at viewport y `reference`. */
export function editorScrollFor(
  editor: EditorScrollGeometry,
  line: number,
  reference: number,
): number {
  const lines = editor.lineCount();
  const base = Math.max(1, Math.min(lines, Math.floor(line)));
  const top = editor.lineScrollTop(base);
  const next = base < lines ? editor.lineScrollTop(base + 1) : top;
  const y = top + (line - base) * (next - top);
  return Math.max(0, y - (reference - editor.scrollerTop()));
}
