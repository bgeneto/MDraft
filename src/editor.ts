//! CodeMirror 6 editor: markdown language support, focus/typewriter modes and
//! the markdown formatting helpers used by the native menu.

import {
  Compartment,
  ChangeSet,
  EditorSelection,
  EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  copyLineDown,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  moveLineDown,
  moveLineUp,
  toggleComment,
} from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { html } from "@codemirror/lang-html";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import type { DocumentLanguage } from "./api";
import { blockInsertion } from "./ai/context";
import { asciidocLanguage } from "./asciidoc-language";
import { isCodeContext } from "./code-context";
import { markdownProseSelection } from "./math-delimiters";
import type { LinkTarget } from "./links";
import { DEFAULT_EDITOR_FONT_SIZE } from "./fonts";
import { htmlLanguage } from "./html-language";
import { autoCloseTag } from "./tag-close";
import { typstHeadingLine, typstShiftHeadingLine } from "./typst-commands";
import { typstLanguage } from "./typst-language";
import {
  bracketMatching,
  foldAll as foldAllCommand,
  foldCode,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  unfoldAll as unfoldAllCommand,
  unfoldCode,
} from "@codemirror/language";
import {
  closeSearchPanel,
  findNext as findNextCommand,
  findPrevious as findPreviousCommand,
  gotoLine as gotoLineCommand,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
  selectNextOccurrence as selectNextOccurrenceCommand,
  selectSelectionMatches,
} from "@codemirror/search";
import { buildChromeTheme, buildHighlightStyle, type SyntaxPalette } from "./syntax-themes";
import { resetSpellLanguage, spellExtension, type SpellOptions } from "./spellcheck";

export interface CursorInfo {
  line: number;
  column: number;
  /** Absolute document offsets of the selection, used by word-level sync. */
  from: number;
  to: number;
  selectionLength: number;
  selectionLines: number;
}

/** Counts for the buffer, maintained incrementally rather than rescanned. */
export interface DocMetrics {
  words: number;
  lines: number;
  chars: number;
}

export interface ScrollInfo {
  top: number;
  height: number;
  client: number;
}

export interface EditorHandle {
  view: EditorView;
  setDoc(text: string, resetHistory?: boolean): void;
  getDoc(): string;
  /** Word/line/character counts for the buffer, updated on every change. */
  metrics(): DocMetrics;
  focus(): void;
  /** Install a syntax palette: token colours plus the writing surface. */
  setSyntax(palette: SyntaxPalette): void;
  setFontSize(px: number): void;
  setLanguage(kind: DocumentLanguage): void;
  /**
   * The view's current state, including undo history and the caret.
   * Scroll position is not part of an EditorState; callers store it beside this.
   */
  captureState(): EditorState;
  /**
   * Show a state captured earlier. Cancels an in-flight grammar load so a tab
   * switch cannot paint the previous language over this buffer.
   */
  restoreState(state: EditorState, scrollTop: number): void;
  /**
   * Re-measure after something outside CodeMirror changed the metrics — a new
   * typeface, most of all. Line wrapping is computed from measured text.
   */
  requestMeasure(): void;
  setFocusMode(on: boolean): void;
  setTypewriter(on: boolean): void;
  /**
   * Underline misspellings, or clear the marks when spelling is off.
   * `force` reconfigures even when the options match the last call: a restored
   * EditorState can still be carrying the compartment from when its tab was hidden.
   */
  setSpellcheck(options: SpellOptions, force?: boolean): void;
  openSearch(replace?: boolean): void;
  closeSearch(): void;
  /** Move to the next/previous match of the current search query. */
  findNext(): void;
  findPrevious(): void;
  /** Add the next occurrence of the selection, or start one from the word. */
  selectNextOccurrence(): void;
  /** Select every occurrence of the current selection. */
  selectAllOccurrences(): void;
  /** Open CodeMirror's line prompt. */
  gotoLine(): void;
  toggleComment(): void;
  duplicateLine(): void;
  moveLineUp(): void;
  moveLineDown(): void;
  deleteSelection(): void;
  /** Replace the current selection with the result of `transform`. */
  transformSelection(transform: (text: string) => string): void;
  foldCurrent(): void;
  unfoldCurrent(): void;
  foldAll(): void;
  unfoldAll(): void;
  scrollToLine(line: number): void;
  /** Scroll `line` to the top of the editor; optionally move the caret. */
  revealLine(line: number, moveCaret?: boolean, focus?: boolean): void;
  /** Scroll a source position into view with the least movement; never moves the caret. */
  revealOffset(pos: number): void;
  /** Source line currently at the top of the visible editor area. */
  topVisibleLine(): number;
  /** Content offset of the top of `line`, in pixels. */
  lineTop(line: number): number;
  /** Scroll the source pane vertically without moving the caret or focusing it. */
  scrollToOffset(top: number): void;
  /** Largest vertical scroll offset the source pane can reach. */
  scrollMax(): number;
  cursorInfo(): CursorInfo;
  /** Paint the source range that corresponds to a preview selection. */
  setSyncRange(from: number, to: number): void;
  /** Remove that decoration, leaving the caret and the selection alone. */
  clearSyncRange(): void;
  /** Replay the pulse on the current decoration without changing its range. */
  pulseSyncRange(): void;
  setHeading(level: number): void;
  shiftHeading(delta: number): void;
  /** Typst headings are `=` markers, not `#`; level 0 removes the marker. */
  setTypstHeading(level: number): void;
  shiftTypstHeading(delta: number): void;
  /** The AsciiDoc heading commands; `=` is the title, `==` the first section. */
  setAsciiDocHeading(level: number): void;
  shiftAsciiDocHeading(delta: number): void;
  toggleLinePrefix(prefix: string): void;
  setTaskState(state: "done" | "todo" | "plain"): void;
  setAsciiDocTaskState(state: "done" | "todo" | "plain"): void;
  indentLines(delta: number): void;
  insertParagraphBefore(): void;
  insertParagraphAfter(): void;
  insertYamlFrontMatter(): void;
  insertAsciiDocAttributes(): void;
  insertToc(): void;
  insertAsciiDocToc(): void;
  insertBlock(text: string): void;
  insertBlockWithCaret(text: string, caretOffset: number): void;
  /** Replace a source range in one transaction; returns false if the range is invalid. */
  replaceRange(from: number, to: number, text: string): boolean;
  /** Insert at a source position, leaving the caret after the text. */
  insertText(pos: number, text: string): boolean;
  /** Insert a new block at a captured source position, with blank-line separation. */
  insertBlockAt(text: string, at: number): boolean;
  /**
   * Insert pasted text at the selection. A block fragment gets blank lines
   * around it and reuses the current indentation; inline text replaces the
   * selection as-is.
   */
  insertPasted(text: string, block: boolean): void;
  /** Arm a synchronous native paste transform; drops and later events bypass it. */
  prepareNativePaste(transform: (text: string) => string): void;
  /** Native text semantics for a Markdown-only MIME representation. */
  insertNativeText(text: string): void;
  /** True when the caret sits inside fenced/raw code or an HTML code element. */
  inCodeContext(): boolean;
  /**
   * Turn bracket/quote pairing and tag closing on or off at runtime.
   *
   * The two are separate so a reader can keep the pairs and refuse the tags;
   * both are reconfigured through compartments, never by rebuilding the state.
   */
  setAutoClose(options: { pairs: boolean; tags: boolean }): void;
  insertAtTop(text: string): void;
  wrapSelection(before: string, after: string, placeholder: string): void;
  onDocChanged(cb: (text: string) => void): void;
  onCursor(cb: (info: CursorInfo) => void): void;
  onScroll(cb: (info: ScrollInfo) => void): void;
}

const dimLine = Decoration.line({ class: "cm-dim-line" });

/**
 * The preview selection, mirrored into the source.
 *
 * This is a decoration and never the selection: taking the selection would make
 * the next keystroke replace text the reader only pointed at. It lives in the
 * state so it maps like any other decoration, and it is cleared on every document
 * change and whenever a tab is restored — an `EditorState` is captured per tab,
 * so a decoration that survived capture would come back in the wrong document.
 */
const syncRangeEffect = StateEffect.define<{ from: number; to: number } | null>();

const syncMark = Decoration.mark({ class: "cm-sync-word" });

const syncRangeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    let explicit = false;
    for (const effect of transaction.effects) {
      if (!effect.is(syncRangeEffect)) continue;
      explicit = true;
      const range = effect.value;
      next =
        range && range.to > range.from
          ? Decoration.set([syncMark.range(range.from, range.to)])
          : Decoration.none;
    }
    if (transaction.docChanged && !explicit) return Decoration.none;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function countWordsInLine(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function focusDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const active = view.state.doc.lineAt(view.state.selection.main.head).number;
  for (const range of view.visibleRanges) {
    let pos = range.from;
    while (pos <= range.to) {
      const line = view.state.doc.lineAt(pos);
      if (line.number !== active) builder.add(line.from, line.from, dimLine);
      if (line.to + 1 <= pos) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const focusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = focusDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = focusDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * Structure and layout only. Every colour belongs to the syntax palette so a
 * light palette stays readable while the rest of the app is dark.
 */
const baseTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": {
    // The family comes from a CSS variable rather than a hardcoded stack, so the
    // source pane follows the reader's typography setting. CodeMirror writes this
    // into a stylesheet, so the `var()` reaches the cascade intact — no
    // compartment and no reconfiguration is needed to change the face, only a
    // `requestMeasure()` afterwards so it re-measures its line wrapping.
    fontFamily: "var(--font-source)",
    // A variable for the same reason as the family: the reader's Line Height
    // preference is published by `applyLayout`, and CodeMirror's generated
    // stylesheet resolves it through the cascade. `applyTypography` then calls
    // `requestMeasure()` so every line box is measured again.
    lineHeight: "var(--editor-line-height)",
    padding: "22px 0 45vh",
  },
  ".cm-content": {
    // Same two decisions as the preview's code, applied to the source pane, so a
    // reader who turns ligatures on does not get them in one pane and not the
    // other.
    fontVariantLigatures: "var(--code-ligatures)",
    fontVariantNumeric: "var(--code-figures)",
  },
  // Horizontal padding belongs on the line, not on `.cm-content`. CodeMirror
  // measures the full-width rectangles of a multi-line selection from the
  // `.cm-line` padding (`RectangleMarker.forRange`), so padding on the content
  // box made a selection paint into the 28px margin as a strip left of the text.
  ".cm-line": { padding: "0 28px" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  // Padding on the line would otherwise widen every line-level background.
  // Keep the active-line tint inside the text column, as it was when the
  // horizontal padding sat on the content box.
  ".cm-activeLine": { backgroundClip: "content-box" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-dim-line": { opacity: "0.28" },
  "&.cm-editor.cm-focused": { outline: "none" },
});

export interface EditorOptions {
  autoClosePairs?: boolean;
  autoCloseTags?: boolean;
  /** Resolve the link or image at a document offset. */
  linkAt?: (pos: number) => LinkTarget | null;
  /** Follow the target a Ctrl/Cmd+click found. */
  linkClick?: (target: LinkTarget) => void;
}

/**
 * Ctrl/Cmd+click follows a link.
 *
 * CodeMirror registers its own handlers after the extension handlers
 * (`computeHandlers` in `@codemirror/view`), and returning `true` stops them —
 * necessary because `allowMultipleSelections` is on, so a plain Ctrl+click
 * would otherwise add a second cursor. The press is consumed and the release
 * opens the target only when the pointer barely moved, so a Ctrl+drag that
 * starts on a link does not launch anything by accident.
 */
function linkSupport(options: EditorOptions): Extension {
  let pressed: { x: number; y: number; target: LinkTarget } | null = null;
  let pointer: { x: number; y: number } | null = null;

  const targetAt = (view: EditorView, x: number, y: number): LinkTarget | null => {
    if (!options.linkAt) return null;
    const pos = view.posAtCoords({ x, y });
    return pos === null ? null : options.linkAt(pos);
  };

  const setCursor = (view: EditorView, modifier: boolean): void => {
    if (!modifier || !pointer || !options.linkAt) {
      view.contentDOM.style.cursor = "";
      return;
    }
    view.contentDOM.style.cursor = targetAt(view, pointer.x, pointer.y) ? "pointer" : "";
  };

  return ViewPlugin.fromClass(class {}, {
    eventHandlers: {
      mousedown(event: MouseEvent, view: EditorView) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
        if (!options.linkClick) return false;
        const found = targetAt(view, event.clientX, event.clientY);
        if (!found) return false;
        pressed = { x: event.clientX, y: event.clientY, target: found };
        event.preventDefault();
        return true;
      },
      mouseup(event: MouseEvent, _view: EditorView) {
        const pending = pressed;
        pressed = null;
        if (!pending) return false;
        const moved = Math.abs(event.clientX - pending.x) + Math.abs(event.clientY - pending.y);
        if (moved <= 5) options.linkClick?.(pending.target);
        event.preventDefault();
        return true;
      },
      mousemove(event: MouseEvent, view: EditorView) {
        pointer = { x: event.clientX, y: event.clientY };
        setCursor(view, event.ctrlKey || event.metaKey);
      },
      mouseleave(_event: MouseEvent, view: EditorView) {
        pointer = null;
        pressed = null;
        view.contentDOM.style.cursor = "";
      },
      keydown(event: KeyboardEvent, view: EditorView) {
        if (event.key !== "Control" && event.key !== "Meta") return false;
        if (!event.repeat) setCursor(view, true);
        return false;
      },
      keyup(event: KeyboardEvent, view: EditorView) {
        if (event.key !== "Control" && event.key !== "Meta") return false;
        setCursor(view, event.ctrlKey || event.metaKey);
        return false;
      },
    },
  });
}

export function createEditor(host: HTMLElement, options: EditorOptions = {}): EditorHandle {
  let nativeTransform: ((text: string) => string) | null = null;
  let nativeInput: { before: string; after: string } | null = null;
  const fontSizeCompartment = new Compartment();
  const focusCompartment = new Compartment();
  const historyCompartment = new Compartment();
  const syntaxCompartment = new Compartment();
  const spellCompartment = new Compartment();
  const pairCompartment = new Compartment();
  const tagCompartment = new Compartment();
  let spellKey = "";
  let autoPairs = options.autoClosePairs ?? true;
  let autoTags = options.autoCloseTags ?? true;
  let currentLanguage: DocumentLanguage = "markdown";
  /// Which language the buffer is parsed as. A markdown editor that also edits
  /// Typst needs this to be switchable at runtime; a static extension could not be.
  const languageCompartment = new Compartment();
  /// The markdown parser and its keymap. Kept as a value because switching back
  /// from Typst has to reinstall exactly what start-up installed.
  const markdownSupport = markdown({
    base: markdownLanguage,
    codeLanguages: languages,
    addKeymap: true,
    // Markdown parses line-start HTML blocks with this nested grammar, and its
    // own `autoCloseTags` would fire regardless of the preference. The editor
    // owns tag closing for Markdown (see tag-close.ts), so the nested one is off.
    htmlTagLanguage: html({ matchClosingTags: false, autoCloseTags: false }),
  });

  const buildHistory = () => history({ minDepth: 400 });

  /**
   * Bracket and quote pairing.
   *
   * The Backspace command travels with the input handler on purpose: with
   * pairing off, a manually typed `()` must lose one character per Backspace,
   * not both. The language data is what adds the backtick — the library's
   * default list is `(`, `[`, `{`, `'`, `"` and nothing more.
   */
  const pairSupport = (): Extension[] => [
    Prec.highest(keymap.of(closeBracketsKeymap)),
    EditorState.languageData.of(() => [
      { closeBrackets: { brackets: ["(", "[", "{", "'", '"', "`"] } },
    ]),
    // `don't` must not become `don't'`. The library pairs a quote whenever the
    // next character is not a word character, and at the end of `don` that is
    // true; an apostrophe after a word is far more likely than an opening
    // single quote, so it wins.
    Prec.highest(
      EditorView.inputHandler.of((view, from, to, text) => {
        if (text !== "'" || from !== to || view.composing || view.state.readOnly) return false;
        const before = from > 0 ? view.state.sliceDoc(from - 1, from) : "";
        if (!/[\p{L}\p{N}]/u.test(before)) return false;
        view.dispatch({
          changes: { from, to, insert: "'" },
          selection: { anchor: from + 1 },
          userEvent: "input.type",
        });
        return true;
      }),
    ),
    closeBrackets(),
  ];

  /** The tag closer, but only in the document types that pass HTML through. */
  const tagSupport = (kind: DocumentLanguage): Extension =>
    autoTags && (kind === "markdown" || kind === "asciidoc") ? autoCloseTag() : [];

  /**
   * Install the HTML grammar with the tag preference that is current when the
   * import resolves. The module is cached per flag; the generation counter keeps
   * a tab switch from landing the wrong support.
   */
  const loadHtml = (): void => {
    const generation = ++languageGeneration;
    void htmlLanguage(autoTags)
      .then((language) => {
        if (generation !== languageGeneration) return;
        view.dispatch({ effects: languageCompartment.reconfigure(language) });
      })
      .catch((error) => {
        console.warn(`[editor] the HTML grammar could not be loaded: ${error}`);
      });
  };

  let onDocChanged: (text: string) => void = () => {};
  let onCursor: (info: CursorInfo) => void = () => {};
  let onScroll: (info: ScrollInfo) => void = () => {};
  let typewriter = false;
  const typewriterPlugin = ViewPlugin.fromClass(
    class {
      enabled = typewriter;
      disposed = false;
      frame = 0;
      resize: ResizeObserver;
      constructor(readonly view: EditorView) {
        this.resize = new ResizeObserver(() => {
          if (this.enabled) this.center();
        });
        this.resize.observe(view.scrollDOM);
        if (this.enabled) this.pad();
      }
      pad() {
        const padding = Math.max(
          0,
          (this.view.scrollDOM.clientHeight - this.view.defaultLineHeight) / 2,
        );
        this.view.contentDOM.style.paddingTop = `${padding}px`;
        this.view.contentDOM.style.paddingBottom = `${padding}px`;
      }
      center() {
        cancelAnimationFrame(this.frame);
        if (!this.enabled) return;
        const { doc, selection } = this.view.state;
        const head = selection.main.head;
        const current = () =>
          this.enabled &&
          !this.disposed &&
          this.view.state.doc === doc &&
          this.view.state.selection.main.head === head &&
          !this.view.composing;
        this.frame = requestAnimationFrame(() => {
          if (!current()) return;
          this.pad();
          this.view.requestMeasure();
          // Let the changed padding be measured before the centering effect.
          this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            if (current())
              this.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
          });
        });
      }
      setEnabled(on: boolean) {
        if (this.enabled === on) return;
        this.enabled = on;
        if (on) this.center();
        else {
          cancelAnimationFrame(this.frame);
          this.frame = 0;
          this.view.contentDOM.style.removeProperty("padding-top");
          this.view.contentDOM.style.removeProperty("padding-bottom");
          this.view.requestMeasure();
        }
      }
      update(update: { docChanged: boolean; selectionSet: boolean }) {
        if (this.enabled && (update.docChanged || update.selectionSet)) this.center();
      }
      destroy() {
        this.disposed = true;
        cancelAnimationFrame(this.frame);
        this.resize.disconnect();
      }
    },
    {
      eventHandlers: {
        compositionend() {
          this.center();
        },
      },
    },
  );
  // The HTML and Typst grammars arrive in a promise. A tab switch that lands
  // before that promise resolves must not install the grammar into the new buffer.
  let languageGeneration = 0;

  // One word count per line. A change only touches the lines it spans, so the
  // total is adjusted by the difference instead of rescanning the document.
  // Text is never joined across a newline, which is what makes the per-line
  // sum exactly equal to trimming and splitting the whole buffer.
  let lineWordCounts: number[] = [0];
  let totalWords = 0;

  function rebuildWordCache(doc: Text): void {
    lineWordCounts = [];
    totalWords = 0;
    for (const line of doc.iterLines()) {
      const words = countWordsInLine(line);
      lineWordCounts.push(words);
      totalWords += words;
    }
  }

  function applyWordChanges(update: ViewUpdate): void {
    const before = update.startState.doc;
    const after = update.state.doc;

    // Fail safe: if an update ever bypasses this listener, or a document was
    // installed without one, discard the cache rather than report a wrong count.
    if (lineWordCounts.length !== before.lines) {
      rebuildWordCache(after);
      return;
    }

    const ranges: Array<[number, number, number, number]> = [];
    update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      ranges.push([fromA, toA, fromB, toB]);
    });
    if (ranges.length === 0) return;

    let minOldStart = Infinity;
    let maxOldEnd = -1;
    let minNewStart = Infinity;
    let maxNewEnd = -1;
    for (const [fromA, toA, fromB, toB] of ranges) {
      minOldStart = Math.min(minOldStart, before.lineAt(fromA).number - 1);
      maxOldEnd = Math.max(maxOldEnd, before.lineAt(toA).number - 1);
      minNewStart = Math.min(minNewStart, after.lineAt(fromB).number - 1);
      maxNewEnd = Math.max(maxNewEnd, after.lineAt(toB).number - 1);
    }

    // A whole-buffer replacement (open, reload, format) is cheaper to rebuild
    // than to splice, and avoids spreading a huge line array into splice().
    if (
      minOldStart === 0 &&
      maxOldEnd === before.lines - 1 &&
      minNewStart === 0 &&
      maxNewEnd === after.lines - 1
    ) {
      rebuildWordCache(after);
      return;
    }

    // The first changed line has the same index in both documents because all
    // content before it is unchanged. Anything else means the line mapping is
    // not what this cache assumes; rebuild rather than guess.
    if (minNewStart !== minOldStart) {
      rebuildWordCache(after);
      return;
    }

    let removed = 0;
    for (let line = minOldStart; line <= maxOldEnd; line++) {
      removed += lineWordCounts[line] ?? 0;
    }

    // Multiple change ranges are replaced as one span. That rescans unchanged
    // lines between two multi-cursor edits, but keeps the mapping exact; a
    // single edit — every keystroke — still touches only its own lines.
    const next: number[] = [];
    let added = 0;
    for (let line = minNewStart; line <= maxNewEnd; line++) {
      const words = countWordsInLine(after.line(line + 1).text);
      next.push(words);
      added += words;
    }

    if (next.length > 20_000) {
      rebuildWordCache(after);
      return;
    }

    lineWordCounts.splice(minNewStart, maxOldEnd - minOldStart + 1, ...next);
    totalWords += added - removed;
    if (lineWordCounts.length !== after.lines) rebuildWordCache(after);
  }

  const extensions: Extension[] = [
    // Return the ORIGINAL clipboard text so CodeMirror can retain its own
    // linewise-copy metadata and distribute lines over selections first.
    EditorView.clipboardInputFilter.of((text, state) => {
      if (nativeTransform) {
        const transform = nativeTransform;
        nativeTransform = null;
        nativeInput = {
          before: state.toText(text).toString(),
          after: state.toText(transform(text)).toString(),
        };
      }
      return text;
    }),
    EditorState.transactionFilter.of((transaction) => {
      if (!nativeInput || !transaction.isUserEvent("input.paste")) return transaction;
      const { before, after } = nativeInput;
      nativeInput = null;
      if (before === after) return transaction;
      const oldLines = before.split("\n"),
        newLines = after.split("\n");
      const byLine = oldLines.length === transaction.startState.selection.ranges.length;
      const corrections: { from: number; insert: string }[] = [];
      let line = 0;
      transaction.changes.iterChanges((_from, _to, from, _end, inserted) => {
        const original = byLine ? oldLines[line] : before;
        const normalized = byLine ? newLines[line++] : after;
        const actual = inserted.toString();
        // A linewise native copy appends the document's line break. Leave that
        // suffix and the native selection/caret decision exactly as inserted.
        if (actual !== original && actual !== original + "\n") return;
        for (let old = 0, next = 0; old < original.length; old++, next++) {
          if (normalized[next] === "\\" && original[old] === "$") {
            corrections.push({ from: from + old, insert: "\\" });
            next++;
          }
        }
      });
      if (!corrections.length) return transaction;
      const changes = ChangeSet.of(corrections, transaction.newDoc.length);
      return [
        transaction,
        { changes, selection: transaction.newSelection.map(changes), sequential: true },
      ];
    }),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    historyCompartment.of(buildHistory()),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of("  "),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    syncRangeField,
    search({ top: true }),
    EditorView.lineWrapping,
    languageCompartment.of(markdownSupport),
    pairCompartment.of(autoPairs ? pairSupport() : []),
    tagCompartment.of(tagSupport("markdown")),
    linkSupport(options),
    keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    fontSizeCompartment.of(
      EditorView.theme({ "&": { fontSize: `${DEFAULT_EDITOR_FONT_SIZE}px` } }),
    ),
    focusCompartment.of([]),
    syntaxCompartment.of([]),
    spellCompartment.of([]),
    baseTheme,
    typewriterPlugin,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        applyWordChanges(update);
        onDocChanged(update.state.doc.toString());
      }
      if (update.selectionSet || update.docChanged) onCursor(readCursor(update.view));
    }),
  ];

  const view = new EditorView({
    state: EditorState.create({ doc: "", extensions }),
    parent: host,
  });

  view.scrollDOM.addEventListener("scroll", () => {
    const el = view.scrollDOM;
    onScroll({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight });
  });

  function readCursor(target: EditorView): CursorInfo {
    const range = target.state.selection.main;
    const line = target.state.doc.lineAt(range.head);
    return {
      line: line.number,
      column: range.head - line.from + 1,
      from: range.from,
      to: range.to,
      selectionLength: range.to - range.from,
      selectionLines: target.state.doc.lineAt(range.to).number - line.number + 1,
    };
  }

  function transformSelectedLines(transform: (line: string) => string): void {
    const { state } = view;
    const range = state.selection.main;
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      const next = transform(line.text);
      if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
    }
    if (changes.length > 0) view.dispatch({ changes, scrollIntoView: true });
    view.focus();
  }

  /** Append a block after the current line, separated by a blank line if needed. */
  function insertBlockText(text: string): void {
    const range = view.state.selection.main;
    const line = view.state.doc.lineAt(range.to);
    const needsLead = line.text.trim().length > 0;
    const insert = `${needsLead ? "\n\n" : ""}${text}\n`;
    const at = needsLead ? line.to : range.to;
    view.dispatch({
      changes: { from: at, insert },
      selection: { anchor: at + insert.length },
      scrollIntoView: true,
    });
    view.focus();
  }

  /**
   * Replace one range as a single undoable transaction.
   *
   * The AI panel checks the session, revision and exact range text before it
   * calls this; the bounds check here is the last line of defence against a
   * range from a document that is no longer on screen.
   */
  function replaceTextRange(from: number, to: number, text: string): boolean {
    const length = view.state.doc.length;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    if (from < 0 || to < from || to > length) return false;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
      userEvent: "input.ai",
    });
    view.focus();
    return true;
  }

  function insertTextAt(pos: number, text: string): boolean {
    return replaceTextRange(pos, pos, text);
  }

  function insertBlockAtPosition(text: string, at: number): boolean {
    const doc = view.state.doc.toString();
    const offset = Math.max(0, Math.min(at, doc.length));
    const insert = blockInsertion(doc, offset, text);
    if (!insert) return false;
    view.dispatch({
      changes: { from: offset, insert },
      selection: { anchor: offset + insert.length },
      scrollIntoView: true,
      userEvent: "input.ai",
    });
    view.focus();
    return true;
  }

  /**
   * Replay the word-sync pulse on the marks already in the DOM.
   *
   * A second gesture on the same range never dispatches, so CodeMirror reuses
   * the element and the CSS animation does not run again. Clearing the inline
   * animation and forcing a style flush restarts it without touching the
   * decoration or the buffer. Reduced motion keeps the resting colour.
   */
  function pulseSyncRange(): void {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    for (const mark of view.dom.querySelectorAll<HTMLElement>(".cm-sync-word")) {
      mark.style.animation = "none";
      void mark.offsetWidth;
      mark.style.animation = "";
    }
  }

  return {
    view,

    /**
     * Re-measure after something outside CodeMirror changed the metrics — a new
     * typeface, most of all. Line wrapping is computed from measured text, so a
     * face swapped in without this leaves the wrapping of the previous one.
     */
    requestMeasure() {
      view.requestMeasure();
    },

    setDoc(text, resetHistory = false) {
      resetSpellLanguage();
      // The parse state in this state was built for the text being replaced. If
      // it was carried over from another document, its ranges lie outside this
      // change and CodeMirror's language field throws while mapping them
      // ("Position N is out of range for changeset of length M"); the command
      // that was loading the document dies as a toast and the new tab never
      // appears. Drop the grammar first — an effects-only transaction maps
      // nothing — and let setLanguage install one for the new text.
      view.dispatch({ effects: languageCompartment.reconfigure([]) });
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        scrollIntoView: true,
      });
      if (resetHistory) {
        // Replacing the history extension with nothing and back is the
        // documented way to drop undo steps without rebuilding the view.
        view.dispatch({ effects: historyCompartment.reconfigure([]) });
        view.dispatch({ effects: historyCompartment.reconfigure(buildHistory()) });
      }
    },

    getDoc() {
      return view.state.doc.toString();
    },

    metrics() {
      const doc = view.state.doc;
      return {
        words: totalWords,
        lines: doc.length === 0 ? 0 : doc.lines,
        chars: doc.length,
      };
    },

    focus() {
      view.focus();
    },

    setSyntax(palette: SyntaxPalette) {
      view.dispatch({
        effects: syntaxCompartment.reconfigure([
          syntaxHighlighting(buildHighlightStyle(palette)),
          buildChromeTheme(palette),
        ]),
      });
    },

    setFontSize(px) {
      view.dispatch({
        effects: fontSizeCompartment.reconfigure(
          EditorView.theme({ "&": { fontSize: `${px}px` } }),
        ),
      });
    },

    setLanguage(kind) {
      currentLanguage = kind;
      const generation = ++languageGeneration;
      const install = (language: Extension) => {
        if (generation !== languageGeneration) return;
        view.dispatch({ effects: languageCompartment.reconfigure(language) });
      };
      // The tag closer follows the document type, not the grammar's promise:
      // switching to Typst must drop a handler that would insert `</a>`.
      view.dispatch({ effects: tagCompartment.reconfigure(tagSupport(kind)) });
      if (kind === "markdown") {
        install(markdownSupport);
        return;
      }
      if (kind === "html") {
        // The HTML branch must be explicit: the fallback below is Typst.
        loadHtml();
        return;
      }
      if (kind === "asciidoc") {
        install(asciidocLanguage());
        return;
      }
      // The grammar arrives asynchronously; until it does the buffer keeps the
      // parser it had, which is a moment of wrong colouring rather than a blank
      // editor.
      void typstLanguage()
        .then(install)
        .catch((error) => {
          console.warn(`[editor] the Typst grammar could not be loaded: ${error}`);
        });
    },

    setAutoClose(next) {
      if (next.pairs !== autoPairs) {
        autoPairs = next.pairs;
        view.dispatch({
          effects: pairCompartment.reconfigure(autoPairs ? pairSupport() : []),
        });
      }
      if (next.tags !== autoTags) {
        autoTags = next.tags;
        if (currentLanguage === "html") loadHtml();
        else {
          view.dispatch({
            effects: tagCompartment.reconfigure(tagSupport(currentLanguage)),
          });
        }
      }
    },

    captureState() {
      return view.state;
    },

    restoreState(state, scrollTop) {
      // Drop a grammar promise that belongs to the buffer we just left.
      languageGeneration += 1;
      resetSpellLanguage();
      // setState does not run the update listener, so the word cache — which
      // lives beside the view, not in the state — would otherwise keep counting
      // the previous document.
      view.setState(state);
      // The restored state carries the parse context it was captured with. A
      // document that has since been replaced by another one leaves ranges that
      // lie outside this buffer, and the next text change throws while mapping
      // them. Discard it here; displayDoc installs the session's own grammar
      // afterwards, which parses the document that is actually on screen.
      view.dispatch({ effects: languageCompartment.reconfigure([]) });
      // `setState` does not run field updates, so the restored state can still
      // carry the previous tab's preview highlight.
      view.dispatch({ effects: syncRangeEffect.of(null) });
      rebuildWordCache(view.state.doc);
      const applyScroll = () => {
        view.scrollDOM.scrollTop = scrollTop;
      };
      applyScroll();
      // A restored document has only its first screen rendered, so a larger
      // offset is clamped to the scroll height CodeMirror knows at that moment —
      // a saved 340 px came back as 298 px, which a test measured. Each frame
      // renders one more screen, so keep re-applying until the scroller reaches
      // the saved offset (or stops moving), and once more from the measure's
      // write phase, because `setState` can queue a measure that resets it.
      // Keep asserting it for the next few frames. There are two reasons the
      // assignment does not stick on its own: a restored document renders one
      // screen at a time, so a larger offset is clamped to the height known so
      // far (340 px came back as 298 px), and CodeMirror reveals the restored
      // caret once it measures, which scrolls that offset away again (340 px
      // came back as 846 px, the caret's line).
      let frames = 0;
      const settleScroll = () => {
        applyScroll();
        if (++frames < 8) requestAnimationFrame(settleScroll);
      };
      settleScroll();
      view.requestMeasure({ read: () => null, write: applyScroll });
    },

    setFocusMode(on) {
      view.dispatch({
        effects: focusCompartment.reconfigure(on ? focusPlugin : []),
      });
    },

    setTypewriter(on) {
      typewriter = on;
      view.plugin(typewriterPlugin)?.setEnabled(on);
    },

    /**
     * Turn spelling on or off. The same options are a no-op: reconfiguring the
     * compartment drops the underlines until the next pass, and layout updates
     * call this on every sidebar toggle.
     */
    setSpellcheck(options: SpellOptions, force = false) {
      const key = `${options.enabled}\0${options.language}\0${options.words.join("\n")}`;
      if (!force && key === spellKey) return;
      spellKey = key;
      view.dispatch({
        effects: spellCompartment.reconfigure(options.enabled ? spellExtension(options) : []),
      });
    },

    openSearch(replace = false) {
      openSearchPanel(view);
      if (replace) {
        // The panel renders in "search" mode first; focusing the replace field is
        // left implicit so behaviour stays consistent across @codemirror/search.
        searchPanelFocusReplace(view);
      }
    },

    closeSearch() {
      closeSearchPanel(view);
    },

    findNext() {
      // Opening the panel is the command's own fallback when no query exists;
      // focusing the editor here would take the caret out of that input.
      findNextCommand(view);
    },

    findPrevious() {
      findPreviousCommand(view);
    },

    selectNextOccurrence() {
      selectNextOccurrenceCommand(view);
      view.focus();
    },

    selectAllOccurrences() {
      selectSelectionMatches(view);
      view.focus();
    },

    gotoLine() {
      gotoLineCommand(view);
    },

    toggleComment() {
      toggleComment(view);
      view.focus();
    },

    duplicateLine() {
      copyLineDown(view);
      view.focus();
    },

    moveLineUp() {
      moveLineUp(view);
      view.focus();
    },

    moveLineDown() {
      moveLineDown(view);
      view.focus();
    },

    deleteSelection() {
      const selection = view.state.selection.main;
      if (selection.empty) return;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: "" },
        selection: { anchor: selection.from },
        scrollIntoView: false,
        userEvent: "delete",
      });
      view.focus();
    },

    transformSelection(transform) {
      const selection = view.state.selection.main;
      if (selection.empty) return;
      const before = view.state.sliceDoc(selection.from, selection.to);
      const after = transform(before);
      if (after === before) {
        view.focus();
        return;
      }
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: after },
        selection: { anchor: selection.from, head: selection.from + after.length },
        scrollIntoView: false,
        userEvent: "input.transform",
      });
      view.focus();
    },

    foldCurrent() {
      foldCode(view);
      view.focus();
    },

    unfoldCurrent() {
      unfoldCode(view);
      view.focus();
    },

    foldAll() {
      foldAllCommand(view);
      view.focus();
    },

    unfoldAll() {
      unfoldAllCommand(view);
      view.focus();
    },

    scrollToLine(line) {
      const total = view.state.doc.lines;
      const target = Math.min(Math.max(line, 1), total);
      const pos = view.state.doc.line(target).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 40 }),
      });
      view.focus();
    },

    revealLine(line, moveCaret = false, focus = false) {
      const target = Math.min(Math.max(Math.round(line), 1), view.state.doc.lines);
      const pos = view.state.doc.line(target).from;
      const block = view.lineBlockAt(pos);
      view.scrollDOM.scrollTop = Math.max(0, block.top - view.scrollDOM.clientHeight * 0.12);
      if (moveCaret) view.dispatch({ selection: { anchor: pos } });
      if (focus) view.focus();
    },

    revealOffset(pos) {
      const target = Math.max(0, Math.min(pos, view.state.doc.length));
      // "nearest" moves only when the position is outside the viewport, which is
      // the reveal-not-follow rule the block sync already follows.
      view.dispatch({ effects: EditorView.scrollIntoView(target, { y: "nearest", yMargin: 80 }) });
    },

    topVisibleLine() {
      const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
      return view.state.doc.lineAt(block.from).number;
    },

    lineTop(line) {
      const target = Math.min(Math.max(Math.round(line), 1), view.state.doc.lines);
      return view.lineBlockAt(view.state.doc.line(target).from).top;
    },

    scrollToOffset(top) {
      view.scrollDOM.scrollTop = Math.max(0, top);
    },

    scrollMax() {
      return Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
    },

    cursorInfo() {
      return readCursor(view);
    },

    setSyncRange(from, to) {
      // The range belongs to the other pane. A focused editor writes its own
      // selection back into the DOM on its next update, which collapses the
      // preview selection the reader just made — measured at about 100 ms. A
      // real mousedown in the preview blurs the editor anyway; do the same for a
      // selection that arrives by script or by keyboard.
      if (view.hasFocus) view.contentDOM.blur();
      const max = view.state.doc.length;
      const start = Math.max(0, Math.min(from, max));
      const end = Math.max(start, Math.min(to, max));
      view.dispatch({ effects: syncRangeEffect.of(end > start ? { from: start, to: end } : null) });
      pulseSyncRange();
    },

    clearSyncRange() {
      if (view.state.field(syncRangeField).size === 0) return;
      view.dispatch({ effects: syncRangeEffect.of(null) });
    },

    pulseSyncRange,

    setHeading(level) {
      transformSelectedLines((line) => {
        const stripped = line.replace(/^\s{0,3}#{1,6}\s+/, "");
        if (level <= 0) return stripped;
        const indent = /^\s*/.exec(line)?.[0] ?? "";
        return `${indent}${"#".repeat(level)} ${stripped.trimStart()}`;
      });
    },

    /** Move the selection one heading level up (-1) or down (+1). */
    shiftHeading(delta) {
      transformSelectedLines((line) => {
        const indent = /^\s*/.exec(line)?.[0] ?? "";
        const body = line.slice(indent.length);
        const match = /^(#{1,6})\s+(.*)$/.exec(body);
        if (!match) {
          // A plain paragraph becomes the deepest heading when pushed up.
          return delta < 0 ? `${indent}# ${body}` : line;
        }
        const next = Math.min(6, Math.max(1, match[1].length + delta));
        return `${indent}${"#".repeat(next)} ${match[2]}`;
      });
    },

    setTypstHeading(level) {
      transformSelectedLines((line) => typstHeadingLine(line, level));
    },

    shiftTypstHeading(delta) {
      transformSelectedLines((line) => typstShiftHeadingLine(line, delta));
    },

    setAsciiDocHeading(level) {
      transformSelectedLines((line) => {
        const indent = /^\s*/.exec(line)?.[0] ?? "";
        const stripped = line.slice(indent.length).replace(/^={1,6}\s+/, "");
        if (level <= 0) return `${indent}${stripped}`;
        // `=` is the document title, so Heading 1 is the first section: `==`.
        const markers = "=".repeat(Math.min(6, Math.max(2, level + 1)));
        return `${indent}${markers} ${stripped.trimStart()}`;
      });
    },

    shiftAsciiDocHeading(delta) {
      transformSelectedLines((line) => {
        const indent = /^\s*/.exec(line)?.[0] ?? "";
        const body = line.slice(indent.length);
        const match = /^(={1,6})\s+(.*)$/.exec(body);
        if (!match) return delta < 0 ? `${indent}== ${body}` : line;
        const next = Math.min(6, Math.max(2, match[1].length + delta));
        return `${indent}${"=".repeat(next)} ${match[2]}`;
      });
    },

    toggleLinePrefix(prefix) {
      transformSelectedLines((line) => {
        const indent = /^\s*/.exec(line)?.[0] ?? "";
        const body = line.slice(indent.length);
        if (body.startsWith(prefix)) return indent + body.slice(prefix.length);
        return `${indent}${prefix}${body}`;
      });
    },

    /** Rewrite `- [ ]` / `- [x]` markers on the selected lines. */
    setTaskState(state) {
      transformSelectedLines((line) => {
        const indent = /^\s*/.exec(line)?.[0] ?? "";
        const body = line.slice(indent.length);
        const bare = body.replace(/^([-*+])\s+\[[ xX]\]\s*/, "$1 ").replace(/^([-*+])\s+/, "");
        if (state === "plain") return `${indent}${bare}`;
        const marker = state === "done" ? "[x]" : "[ ]";
        return `${indent}- ${marker} ${bare}`;
      });
    },

    /** Rewrite AsciiDoc `* [ ]` / `* [x]` task markers. */
    setAsciiDocTaskState(state) {
      transformSelectedLines((line) => {
        const indent = /^\s*/.exec(line)?.[0] ?? "";
        const body = line.slice(indent.length);
        const bare = body.replace(/^\*\s+\[[ xX]\]\s*/, "").replace(/^\*\s+/, "");
        if (state === "plain") return `${indent}${bare}`;
        const marker = state === "done" ? "[x]" : "[ ]";
        return `${indent}* ${marker} ${bare}`;
      });
    },

    indentLines(delta) {
      const step = "  ".repeat(Math.abs(delta));
      transformSelectedLines((line) => {
        if (delta > 0) return line.length === 0 ? line : step + line;
        return line.replace(new RegExp(`^(?:\\t| {1,${step.length}})`), "");
      });
    },

    insertParagraphBefore() {
      const range = view.state.selection.main;
      const line = view.state.doc.lineAt(range.from);
      const at = line.from;
      view.dispatch({
        changes: { from: at, insert: "\n" },
        selection: { anchor: at },
        scrollIntoView: true,
      });
      view.focus();
    },

    insertParagraphAfter() {
      const range = view.state.selection.main;
      const line = view.state.doc.lineAt(range.to);
      const at = line.to;
      view.dispatch({
        changes: { from: at, insert: "\n" },
        selection: { anchor: at + 1 },
        scrollIntoView: true,
      });
      view.focus();
    },

    insertYamlFrontMatter() {
      const doc = view.state.doc;
      if (/^---\r?\n/.test(doc.toString())) {
        view.dispatch({
          selection: { anchor: Math.min(4, doc.length) },
          scrollIntoView: true,
        });
        view.focus();
        return;
      }
      const block = "---\ntitle: \ndate: \n---\n\n";
      view.dispatch({
        changes: { from: 0, to: 0, insert: block },
        selection: { anchor: block.indexOf("title: ") + "title: ".length },
        scrollIntoView: true,
      });
      view.focus();
    },

    insertAsciiDocAttributes() {
      const text = view.state.doc.toString();
      const existing = text.search(/^:title:/m);
      if (existing >= 0) {
        view.dispatch({
          selection: { anchor: existing + ":title:".length },
          scrollIntoView: true,
        });
        view.focus();
        return;
      }
      const block = ":title: \n:author: \n\n";
      view.dispatch({
        changes: { from: 0, to: 0, insert: block },
        selection: { anchor: block.indexOf(":title: ") + ":title: ".length },
        scrollIntoView: true,
      });
      view.focus();
    },

    insertToc() {
      insertBlockText("[TOC]");
    },

    insertAsciiDocToc() {
      const text = view.state.doc.toString();
      const existing = text.search(/^:toc:\s*$/m);
      if (existing >= 0) {
        view.dispatch({
          selection: { anchor: existing + ":toc:".length },
          scrollIntoView: true,
        });
        view.focus();
        return;
      }
      const block = ":toc:\n\n";
      view.dispatch({
        changes: { from: 0, to: 0, insert: block },
        selection: { anchor: block.length },
        scrollIntoView: true,
      });
      view.focus();
    },

    insertBlock(text) {
      insertBlockText(text);
    },

    replaceRange(from, to, text) {
      return replaceTextRange(from, to, text);
    },

    insertText(pos, text) {
      return insertTextAt(pos, text);
    },

    insertBlockAt(text, at) {
      return insertBlockAtPosition(text, at);
    },

    /** Insert `text` and leave the caret `caretOffset` characters into it. */
    insertBlockWithCaret(text, caretOffset) {
      const range = view.state.selection.main;
      const line = view.state.doc.lineAt(range.to);
      const needsLead = line.text.trim().length > 0;
      const lead = needsLead ? "\n\n" : "";
      const at = needsLead ? line.to : range.to;
      view.dispatch({
        changes: { from: at, insert: `${lead}${text}` },
        selection: { anchor: at + lead.length + caretOffset },
        scrollIntoView: true,
      });
      view.focus();
    },

    prepareNativePaste(transform) {
      if (!markdownProseSelection(view.state.doc.toString(), view.state.selection.ranges)) return;
      nativeTransform = transform;
      queueMicrotask(() => {
        nativeTransform = null;
        nativeInput = null;
      });
    },

    insertNativeText(text) {
      const state = view.state;
      const input = state.toText(text);
      let line = 1;
      const changes =
        input.lines === state.selection.ranges.length
          ? state.changeByRange((range) => {
              const insert = input.line(line++).text;
              return {
                changes: { from: range.from, to: range.to, insert },
                range: EditorSelection.cursor(range.from + insert.length),
              };
            })
          : state.replaceSelection(input);
      view.dispatch(changes, { userEvent: "input.paste", scrollIntoView: true });
      view.focus();
    },

    insertPasted(text, block) {
      const normalized = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!normalized) return;

      const state = view.state;
      const range = state.selection.main;
      const doc = state.doc;
      if (!block) {
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: normalized },
          selection: { anchor: range.from + normalized.length },
          scrollIntoView: true,
          userEvent: "input.paste",
        });
        view.focus();
        return;
      }

      const startLine = doc.lineAt(range.from);
      const endLine = doc.lineAt(range.to);
      const before = doc.sliceString(startLine.from, range.from);
      const after = doc.sliceString(range.to, endLine.to);
      const indent = /^\s*$/.test(before) ? before : "";
      let insertion = normalized;
      if (indent) {
        insertion = insertion
          .split("\n")
          .map((line, index) => (index === 0 ? line : `${indent}${line}`))
          .join("\n");
      }

      let prefix = "";
      if (before.trim() !== "") prefix = "\n\n";
      else if (startLine.from > 0) {
        const previous = doc.line(startLine.number - 1);
        if (previous.text.trim() !== "") prefix = "\n";
      }

      // A block must not swallow the rest of the line. When there is content
      // after the paste it starts a fresh paragraph; when there is only
      // whitespace it is discarded.
      let suffix = "";
      let to = range.to;
      if (after.trim() !== "") suffix = "\n\n";
      else to = endLine.to;

      const insert = `${prefix}${insertion}${suffix}`;
      view.dispatch({
        changes: { from: range.from, to, insert },
        selection: { anchor: range.from + prefix.length + insertion.length },
        scrollIntoView: true,
        userEvent: "input.paste",
      });
      view.focus();
    },

    inCodeContext() {
      return isCodeContext(view.state, view.state.selection.main.head);
    },

    insertAtTop(text) {
      view.dispatch({
        changes: { from: 0, to: 0, insert: text },
        selection: { anchor: text.length },
        scrollIntoView: true,
      });
      view.focus();
    },

    wrapSelection(before, after, placeholder) {
      const range = view.state.selection.main;
      const selected = view.state.sliceDoc(range.from, range.to);
      const body = selected.length > 0 ? selected : placeholder;
      const insert = `${before}${body}${after}`;
      const anchor = range.from + before.length;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert },
        selection: { anchor, head: anchor + body.length },
      });
      view.focus();
    },

    onDocChanged(cb) {
      onDocChanged = cb;
    },
    onCursor(cb) {
      onCursor = cb;
    },
    onScroll(cb) {
      onScroll = cb;
    },
  };
}

/** Expand the replace row when the search panel is open. */
function searchPanelFocusReplace(view: EditorView): void {
  const panel = view.dom.querySelector(".cm-search");
  const replace = panel?.querySelector<HTMLInputElement>('input[name="replace"]');
  replace?.focus();
}
