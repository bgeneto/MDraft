//! CodeMirror 6 editor: markdown language support, focus/typewriter modes and
//! the markdown formatting helpers used by the native menu.

import {
  Compartment,
  EditorState,
  RangeSetBuilder,
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
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import type { DocumentLanguage } from "./api";
import { htmlLanguage } from "./html-language";
import { typstLanguage } from "./typst-language";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  closeSearchPanel,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { buildChromeTheme, buildHighlightStyle, type SyntaxPalette } from "./syntax-themes";
import { resetSpellLanguage, spellExtension, type SpellOptions } from "./spellcheck";

export interface CursorInfo {
  line: number;
  column: number;
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
   * Re-measure after something outside CodeMirror changed the metrics — a new
   * typeface, most of all. Line wrapping is computed from measured text.
   */
  requestMeasure(): void;
  setFocusMode(on: boolean): void;
  setTypewriter(on: boolean): void;
  /** Underline misspellings, or clear the marks when spelling is off. */
  setSpellcheck(options: SpellOptions): void;
  openSearch(replace?: boolean): void;
  closeSearch(): void;
  scrollToLine(line: number): void;
  /** Scroll `line` to the top of the editor; optionally move the caret. */
  revealLine(line: number, moveCaret?: boolean, focus?: boolean): void;
  /** Source line currently at the top of the visible editor area. */
  topVisibleLine(): number;
  /** Content offset of the top of `line`, in pixels. */
  lineTop(line: number): number;
  /** Scroll the source pane vertically without moving the caret or focusing it. */
  scrollToOffset(top: number): void;
  /** Largest vertical scroll offset the source pane can reach. */
  scrollMax(): number;
  cursorInfo(): CursorInfo;
  setHeading(level: number): void;
  shiftHeading(delta: number): void;
  toggleLinePrefix(prefix: string): void;
  setTaskState(state: "done" | "todo" | "plain"): void;
  indentLines(delta: number): void;
  insertParagraphBefore(): void;
  insertParagraphAfter(): void;
  insertYamlFrontMatter(): void;
  insertToc(): void;
  insertBlock(text: string): void;
  insertBlockWithCaret(text: string, caretOffset: number): void;
  insertAtTop(text: string): void;
  wrapSelection(before: string, after: string, placeholder: string): void;
  insertBlock(text: string): void;
  onDocChanged(cb: (text: string) => void): void;
  onCursor(cb: (info: CursorInfo) => void): void;
  onScroll(cb: (info: ScrollInfo) => void): void;
}

const dimLine = Decoration.line({ class: "cm-dim-line" });

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
    lineHeight: "1.75",
    padding: "22px 0 45vh",
  },
  ".cm-content": {
    padding: "0 28px",
    // Same two decisions as the preview's code, applied to the source pane, so a
    // reader who turns ligatures on does not get them in one pane and not the
    // other.
    fontVariantLigatures: "var(--code-ligatures)",
    fontVariantNumeric: "var(--code-figures)",
  },
  ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-dim-line": { opacity: "0.28" },
  "&.cm-editor.cm-focused": { outline: "none" },
});

export function createEditor(host: HTMLElement): EditorHandle {
  const fontSizeCompartment = new Compartment();
  const focusCompartment = new Compartment();
  const historyCompartment = new Compartment();
  const syntaxCompartment = new Compartment();
  const spellCompartment = new Compartment();
  let spellKey = "";
/// Which language the buffer is parsed as. A markdown editor that also edits
/// Typst needs this to be switchable at runtime; a static extension could not be.
const languageCompartment = new Compartment();
/// The markdown parser and its keymap. Kept as a value because switching back
/// from Typst has to reinstall exactly what start-up installed.
const markdownSupport = markdown({
  base: markdownLanguage,
  codeLanguages: languages,
  addKeymap: true,
});

  const buildHistory = () => history({ minDepth: 400 });

  let onDocChanged: (text: string) => void = () => {};
  let onCursor: (info: CursorInfo) => void = () => {};
  let onScroll: (info: ScrollInfo) => void = () => {};
  let typewriter = false;
  let view: EditorView;

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
    search({ top: true }),
    EditorView.lineWrapping,
    languageCompartment.of(markdownSupport),
    keymap.of([
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    fontSizeCompartment.of(EditorView.theme({ "&": { fontSize: "16px" } })),
    focusCompartment.of([]),
    syntaxCompartment.of([]),
    spellCompartment.of([]),
    baseTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        applyWordChanges(update);
        onDocChanged(update.state.doc.toString());
      }
      if (update.selectionSet || update.docChanged) onCursor(readCursor(update.view));
      if (typewriter && update.selectionSet && !update.docChanged) {
        const head = update.state.selection.main.head;
        const target = update.view;
        requestAnimationFrame(() => {
          target.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
        });
      }
    }),
  ];

  view = new EditorView({
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
      selectionLength: range.to - range.from,
      selectionLines:
        target.state.doc.lineAt(range.to).number - line.number + 1,
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
      if (kind === "markdown") {
        view.dispatch({ effects: languageCompartment.reconfigure(markdownSupport) });
        return;
      }
      if (kind === "html") {
        // The HTML branch must be explicit: the fallback below is Typst.
        void htmlLanguage()
          .then((language) => {
            view.dispatch({ effects: languageCompartment.reconfigure(language) });
          })
          .catch((error) => {
            console.warn(`[editor] the HTML grammar could not be loaded: ${error}`);
          });
        return;
      }
      // The grammar arrives asynchronously; until it does the buffer keeps the
      // parser it had, which is a moment of wrong colouring rather than a blank
      // editor.
      void typstLanguage()
        .then((language) => {
          view.dispatch({ effects: languageCompartment.reconfigure(language) });
        })
        .catch((error) => {
          console.warn(`[editor] the Typst grammar could not be loaded: ${error}`);
        });
    },

    setFocusMode(on) {
      view.dispatch({
        effects: focusCompartment.reconfigure(on ? focusPlugin : []),
      });
    },

    setTypewriter(on) {
      typewriter = on;
    },

    /**
     * Turn spelling on or off. The same options are a no-op: reconfiguring the
     * compartment drops the underlines until the next pass, and layout updates
     * call this on every sidebar toggle.
     */
    setSpellcheck(options: SpellOptions) {
      const key = `${options.enabled}\0${options.language}\0${options.words.join("\n")}`;
      if (key === spellKey) return;
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

    insertToc() {
      insertBlockText("[TOC]");
    },

    insertBlock(text) {
      insertBlockText(text);
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
