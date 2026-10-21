//! Whole-document formatting for Markdown, HTML and Typst.
//!
//! Every formatter is fetched on first use: Prettier's standalone build plus one
//! language plugin, or Typstyle's WebAssembly module. Nothing here is imported by
//! the entry chunk, so a reader who never formats pays nothing at launch.
//!
//! The module also owns the snapshot rule. A formatter runs asynchronously, and
//! the reader can keep typing — or switch tabs — while it does. The result is
//! applied only to the exact `Text` it was computed from, in one transaction, so
//! one undo restores the original bytes and a stale result can never overwrite a
//! newer edit.

import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Options, Plugin } from "prettier";
import type { TypstyleConfig } from "@typstyle/typstyle-wasm-bundler/typstyle_wasm_bg.js";
import type { DocumentLanguage } from "../api";

export type FormatOutcome = "changed" | "unchanged" | "stale";

/**
 * Prettier settings for this repository, not Prettier's defaults: width 100 and
 * LF come from `.prettierrc.json`, and `proseWrap: "preserve"` keeps the reader's
 * own line breaks instead of reflowing every paragraph.
 */
const PRETTIER_OPTIONS: Options = {
  printWidth: 100,
  endOfLine: "lf",
};

/** Typstyle: two-space indentation, width 100, no reflow of prose. */
const TYPSTYLE_OPTIONS: Partial<TypstyleConfig> = {
  tab_spaces: 2,
  max_width: 100,
  blank_lines_upper_bound: 2,
  collapse_markup_spaces: false,
  reorder_import_items: true,
  wrap_mode: "none",
};

let prettierModule: Promise<typeof import("prettier/standalone")> | null = null;
let markdownPlugin: Promise<typeof import("prettier/plugins/markdown")> | null = null;
let htmlPlugin: Promise<typeof import("prettier/plugins/html")> | null = null;

type TypstyleModule = typeof import("@typstyle/typstyle-wasm-bundler/typstyle_wasm_bg.js");
let typstyleModule: Promise<TypstyleModule> | null = null;

function loadPrettier(): Promise<typeof import("prettier/standalone")> {
  return (prettierModule ??= import("prettier/standalone"));
}

function loadMarkdownPlugin(): Promise<typeof import("prettier/plugins/markdown")> {
  return (markdownPlugin ??= import("prettier/plugins/markdown"));
}

function loadHtmlPlugin(): Promise<typeof import("prettier/plugins/html")> {
  return (htmlPlugin ??= import("prettier/plugins/html"));
}

/**
 * Instantiate Typstyle.
 *
 * The package entry point imports its `.wasm` file as an ES module, which Vite
 * treats as an asset URL, so the module would arrive as a string. Loading the
 * wasm-bindgen glue and the `?init` loader separately gives the bytes through
 * `WebAssembly.instantiate`, with Vite's array-buffer fallback for a webview that
 * will not stream a `.wasm` response. The import object's module name is what the
 * glue was compiled against, not the path it is loaded from.
 */
function loadTypstyle(): Promise<TypstyleModule> {
  typstyleModule ??= (async () => {
    const [glue, initWasm] = await Promise.all([
      import("@typstyle/typstyle-wasm-bundler/typstyle_wasm_bg.js"),
      import("@typstyle/typstyle-wasm-bundler/typstyle_wasm_bg.wasm?init"),
    ]);
    // TypeScript adds a synthetic `default` member to a dynamic import of a JS
    // module; it is not a WebAssembly import and the glue does not export one.
    const instance = await initWasm.default({
      "./typstyle_wasm_bg.js": glue,
    } as unknown as WebAssembly.Imports);
    const exports = instance.exports as WebAssembly.Exports & { __wbindgen_start?: () => void };
    glue.__wbg_set_wasm(exports);
    exports.__wbindgen_start?.();
    return glue;
  })();
  return typstyleModule;
}

async function formatWithPrettier(text: string, language: "markdown" | "html"): Promise<string> {
  const [prettier, plugin] = await Promise.all([
    loadPrettier(),
    language === "markdown" ? loadMarkdownPlugin() : loadHtmlPlugin(),
  ]);
  const options: Options = {
    ...PRETTIER_OPTIONS,
    parser: language,
    plugins: [plugin as Plugin],
  };
  if (language === "markdown") options.proseWrap = "preserve";
  return prettier.format(text, options);
}

/** Whether `language` has a formatter. AsciiDoc is deliberately excluded. */
export function hasFormatter(language: DocumentLanguage): boolean {
  return language === "markdown" || language === "html" || language === "typst";
}

/**
 * Format `text` as `language`. `null` means the language has no formatter, which
 * is how AsciiDoc is deliberately excluded.
 */
export async function formatDocument(
  text: string,
  language: DocumentLanguage,
): Promise<string | null> {
  // A blank buffer has nothing to format, and returning it untouched keeps an
  // empty document from being rewritten into a single newline.
  if (text.trim().length === 0) return text;
  if (language === "markdown" || language === "html") {
    return formatWithPrettier(text, language);
  }
  if (language === "typst") {
    const typstyle = await loadTypstyle();
    return typstyle.format(text, TYPSTYLE_OPTIONS);
  }
  return null;
}

/**
 * The one transaction that replaces `state`'s document with `formatted`.
 *
 * The caret keeps its line and column, clamped to the formatted text. This is
 * deliberately not a position map: formatting moves text between lines, and a
 * map would land the caret somewhere plausible but arbitrary. The transaction is
 * shared by the live editor and a background tab's stored `EditorState`.
 */
export function formattedTransaction(state: EditorState, formatted: string): TransactionSpec {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const column = head - line.from;
  const lines = formatted.split("\n");
  const target = Math.min(line.number - 1, lines.length - 1);
  let anchor = Math.min(column, lines[target].length);
  for (let index = 0; index < target; index++) anchor += lines[index].length + 1;

  return {
    changes: { from: 0, to: state.doc.length, insert: formatted },
    selection: { anchor },
    scrollIntoView: false,
    userEvent: "format",
  };
}

/**
 * Format the document shown in `view` in one undoable transaction.
 *
 * `stale` means the buffer changed while the formatter ran; nothing was applied.
 */
export async function formatEditor(
  view: EditorView,
  language: DocumentLanguage,
): Promise<FormatOutcome> {
  const state = view.state;
  const before = state.doc;
  const source = before.toString();

  const formatted = await formatDocument(source, language);
  if (formatted === null) return "unchanged";

  // Every edit — a keystroke, a reload, another tab installed by `setDoc` —
  // produces a new `Text` object. Identity is therefore the snapshot check.
  if (view.state.doc !== before) return "stale";
  if (formatted === source) return "unchanged";

  view.dispatch(formattedTransaction(state, formatted));
  return "changed";
}

/** The one line of a formatter error a toast can show. */
export function formatErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const first = raw.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "unknown error";
  const trimmed = first.trim();
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}…` : trimmed;
}
