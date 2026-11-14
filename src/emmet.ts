//! Emmet abbreviations: Tab expands what ends at the caret in HTML and CSS.
//!
//! The `emmet` package supplies the two algorithms that matter — `extract` finds
//! the abbreviation before the caret and `expand` turns it into text — and is
//! loaded on demand by `emmet-language.ts`, so this module only holds its types.
//! What belongs to this project is the decision *where* an abbreviation may
//! expand, made from the Lezer syntax tree, and the Tab command that inserts the
//! result as a CodeMirror snippet, tab stops included.
//!
//! **Fail safe, not silent.** Every doubt returns `null`, and a Tab that finds
//! nothing to expand falls through to indentation. A tree that is not parsed up
//! to the caret, a caret in a tag, an attribute value, a comment, a script, a
//! selector or a declaration's value are all "no". A wrong expansion costs the
//! reader text they typed; a missed one costs a keystroke.
//!
//! **Indentation is not decided here.** The expansion indents with tabs and the
//! snippet machinery turns each leading tab into the editor's `indentUnit` and
//! adds the line's own indentation — which is why the output needs neither.
//!
//! **Tab order.** A running snippet binds Tab at `Prec.highest` to move between
//! its fields, so a word typed into a field is never re-read as an abbreviation.
//! This binding sits at `Prec.high` *after* the completion layer's, so an open
//! popup accepts first, and below it the base keymap still indents.

import { snippet } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";

type EmmetModule = typeof import("emmet");

/** The two functions of the `emmet` package this module uses. */
export interface EmmetEngine {
  expand: EmmetModule["default"];
  extract: EmmetModule["extract"];
}

/** Where an abbreviation may expand, and what kind it is there. */
export type EmmetContext =
  | {
      type: "markup";
      /** The enclosing element, lower case: `li` inside `ul` is what `.item` means. */
      parent?: string;
    }
  | {
      type: "stylesheet";
      /** A `style="…"` attribute: no line breaks in the output. */
      inline: boolean;
      /** Outside every rule block, where only `@` snippets belong. */
      topLevel: boolean;
    };

export interface EmmetExpansion {
  /** The range the abbreviation occupies, to be replaced by the snippet. */
  from: number;
  to: number;
  abbreviation: string;
  /** A CodeMirror snippet template: `${n:placeholder}` tab stops, tab-indented. */
  template: string;
}

/**
 * How much of the line `extract` sees.
 *
 * A one-megabyte minified line must not be copied on every Tab. An abbreviation
 * longer than the window is not one anybody typed.
 */
const WINDOW_BEFORE = 400;
const WINDOW_AFTER = 200;

/**
 * The largest repeat product an abbreviation may ask for.
 *
 * `div*1000>div*1000` is a million elements and would freeze the editor while
 * `expand` builds them. A refusal costs the reader a Tab that indents; the
 * product overestimates `li*50+li*50`, which nobody writes.
 */
const MAX_REPEAT_PRODUCT = 10_000;

/** Elements whose content is code or raw text, never markup. */
const RAW_ELEMENTS = new Set(["script", "style", "textarea"]);

/**
 * At-rules whose block holds declarations. The other blocks — `@media`,
 * `@supports`, `@layer`, `@container` — hold rules, so a word there is a
 * selector.
 */
const DECLARATION_AT_RULES = new Set(["font-face", "page", "property", "counter-style"]);

/** What a Lezer node offers, and all this module needs of it. */
interface TreeNode {
  name: string;
  from: number;
  to: number;
  parent: TreeNode | null;
  getChild(type: string): TreeNode | null;
}

/**
 * Nodes that, met before any text, mean the caret is not in markup text.
 *
 * `StyleText` is the host of a `<style>` body. Once its CSS is mounted the
 * caret resolves to a stylesheet node first and never reaches this one; met
 * here, the body has not been parsed as CSS, and calling it markup would turn
 * `@m` into a tag.
 */
const NOT_TEXT = new Set([
  "StyleText",
  "Script",
  "ScriptText",
  "TextareaText",
  "DoctypeDecl",
  "EntityReference",
  "Attribute",
  "OpenTag",
  "CloseTag",
  "SelfClosingTag",
  "MismatchedCloseTag",
  "ProcessingInst",
]);

function elementOf(node: TreeNode | null): TreeNode | null {
  while (node && node.name !== "Element") node = node.parent;
  return node;
}

function tagNameOf(state: EditorState, element: TreeNode | null): string | undefined {
  const tag = element?.getChild("OpenTag") ?? element?.getChild("SelfClosingTag");
  const name = tag?.getChild("TagName");
  return name ? state.sliceDoc(name.from, name.to).toLowerCase() : undefined;
}

/** Whether a `Block` holds declarations, judged from what encloses it. */
function holdsDeclarations(state: EditorState, block: TreeNode): boolean {
  const owner = block.parent;
  if (!owner) return false;
  if (owner.name === "RuleSet" || owner.name === "KeyframeList") return true;
  if (owner.name !== "AtRule") return false;
  const keyword = owner.getChild("AtKeyword");
  if (!keyword) return false;
  return DECLARATION_AT_RULES.has(state.sliceDoc(keyword.from + 1, keyword.to).toLowerCase());
}

/**
 * Where, if anywhere, an abbreviation may expand at `pos`.
 *
 * The tree decides: markup in the text between tags, a stylesheet abbreviation
 * where a declaration may begin. The caller never has to know which grammar the
 * document uses — `<style>` and `style=""` inside HTML are simply CSS nodes.
 */
export function emmetContext(state: EditorState, pos: number): EmmetContext | null {
  const tree = ensureSyntaxTree(state, pos, 100);
  if (!tree) return null;
  // Not `tree.resolveInner`: it starts from the node it returned last time, kept
  // per tree, so an earlier lookup at another position — completion, bracket
  // matching and spelling all make them — decides whether this one still enters
  // an overlay such as `style="…"`. `topNode.resolveInner` starts fresh.
  const inner = tree.topNode.resolveInner(pos, -1) as unknown as TreeNode;

  // A caret just after a tag's `>` is between tags, in text, although the node
  // that ends there is the tag's own.
  if ((inner.name === "EndTag" || inner.name === "SelfClosingEndTag") && inner.to === pos) {
    const tag = inner.parent;
    const element = elementOf(tag);
    // An opening tag's text belongs to its element; a closing or self-closing
    // tag ends its element, so the text that follows belongs to the next one out.
    const owner = tag?.name === "OpenTag" ? element : elementOf(element?.parent ?? null);
    const parent = tagNameOf(state, owner);
    if (parent && RAW_ELEMENTS.has(parent)) return null;
    return { type: "markup", parent };
  }

  for (let node: TreeNode | null = inner; node; node = node.parent) {
    const name = node.name;
    switch (name) {
      case "Comment":
      case "StringLiteral":
      case "Declaration":
        return null;
      case "RuleSet": {
        // A rule that already has its block, with the caret in front of it, is a
        // selector being edited. A rule without one is a word being typed.
        const block = node.getChild("Block");
        if (block && pos <= block.from) return null;
        break;
      }
      case "Block":
        return holdsDeclarations(state, node)
          ? { type: "stylesheet", inline: false, topLevel: false }
          : null;
      case "Styles":
        return { type: "stylesheet", inline: true, topLevel: false };
      case "StyleSheet":
        return { type: "stylesheet", inline: false, topLevel: true };
      case "Text":
      case "Element":
      case "Document":
        return { type: "markup", parent: tagNameOf(state, elementOf(node)) };
      default:
        if (NOT_TEXT.has(name)) return null;
    }
  }
  return null;
}

/** The product of every `*N` in an abbreviation: a cheap bound on its output. */
function repeatProduct(abbreviation: string): number {
  let product = 1;
  for (const match of abbreviation.matchAll(/\*(\d+)/g)) {
    product *= Math.max(1, Number(match[1]));
    if (product > MAX_REPEAT_PRODUCT) break;
  }
  return product;
}

/** A tab stop in CodeMirror's template syntax. */
function field(index: number, placeholder: string): string {
  return placeholder ? `\${${index}:${placeholder}}` : `\${${index}}`;
}

/**
 * Escape what a snippet template would read as syntax.
 *
 * Braces open and close fields, so a literal one in the output — the `{` of
 * `@media … {`, or `#{x}` typed as text — is escaped. Fields themselves bypass
 * this hook, which is how `field` stays unescaped.
 */
function escapeText(text: string): string {
  return text.replace(/[{}]/g, (brace) => `\\${brace}`);
}

/** Shared by every expansion; Emmet keeps its compiled snippets here. */
const cache: NonNullable<Parameters<EmmetEngine["expand"]>[1]>["cache"] = {};

/**
 * The abbreviation ending at `pos`, expanded, or null when there is none or it
 * may not expand there.
 *
 * Pure: it reads the state and the engine and changes nothing, so a test can
 * exercise every case without a view.
 */
export function expandAt(
  state: EditorState,
  pos: number,
  engine: EmmetEngine,
): EmmetExpansion | null {
  const context = emmetContext(state, pos);
  if (!context) return null;

  const line = state.doc.lineAt(pos);
  const from = Math.max(line.from, pos - WINDOW_BEFORE);
  const to = Math.min(line.to, pos + WINDOW_AFTER);
  const found = engine.extract(state.sliceDoc(from, to), pos - from, {
    type: context.type,
    // Auto-closed brackets sit right after the caret; markup reads past them.
    lookAhead: context.type === "markup",
  });
  if (!found) return null;

  const abbreviation = found.abbreviation;
  // Outside every rule a stylesheet word is a selector. `@media` and `@kf` are
  // the only abbreviations that belong there.
  if (context.type === "stylesheet" && context.topLevel && !abbreviation.startsWith("@")) {
    return null;
  }
  if (repeatProduct(abbreviation) > MAX_REPEAT_PRODUCT) return null;

  let template: string;
  try {
    template = engine.expand(abbreviation, {
      type: context.type,
      syntax: context.type === "markup" ? "html" : "css",
      context: context.type === "markup" && context.parent ? { name: context.parent } : undefined,
      cache,
      options: {
        "output.field": field,
        "output.text": escapeText,
        // Tabs, not spaces: the snippet turns each leading tab into `indentUnit`.
        "output.indent": "\t",
        "output.format": context.type === "markup" || !context.inline,
        "output.compactBoolean": true,
      },
    });
  } catch {
    return null;
  }
  if (!template) return null;
  // A CodeMirror snippet ends at its last field, so without a final stop Tab on
  // the last field goes nowhere. Emmet editors put the caret after the whole
  // expansion; `${0}` is CodeMirror's spelling of that.
  if (/\$\{\d/.test(template) && !template.includes("${0}")) template += "${0}";
  return { from: from + found.start, to: from + found.end, abbreviation, template };
}

/** Tab: expand the abbreviation at a single caret, or decline. */
function expandCommand(engine: EmmetEngine): (view: EditorView) => boolean {
  return (view) => {
    const { state } = view;
    const selection = state.selection;
    if (state.readOnly || selection.ranges.length !== 1 || !selection.main.empty) return false;
    const expansion = expandAt(state, selection.main.head, engine);
    if (!expansion) return false;
    // The label tags the transaction as a completion, which closes any popup and
    // makes the expansion its own undo step.
    snippet(expansion.template)(
      view,
      { label: expansion.abbreviation },
      expansion.from,
      expansion.to,
    );
    return true;
  };
}

/** The Tab binding, for the compartment `editor.ts` keeps for it. */
export function emmetSupport(engine: EmmetEngine): Extension {
  return Prec.high(keymap.of([{ key: "Tab", run: expandCommand(engine) }]));
}
