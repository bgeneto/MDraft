//! Whether a position sits inside code-like content.
//!
//! Three features need the same answer — spelling, paste conversion and the tag
//! closer — and each language names its code differently. Markdown has
//! `FencedCode`/`InlineCode`; AsciiDoc's stream parser names listings and
//! passthroughs `monospace`/`listing`/`literal`; HTML nests `<pre>`, `<code>`,
//! `<script>`, `<style>` and `<textarea>` as normal elements with text children.
//!
//! Keeping the list in one place is what stops the three from disagreeing about
//! whether a pipe inside a fence is prose.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

/** Node names that carry code in the grammars this editor installs. */
const CODE_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "Raw",
  "Code",
  "CodeText",
  "ScriptText",
  "StyleText",
  "monospace",
  "listing",
  "literal",
  "passthrough",
]);

/** Elements whose text content is code rather than markup. */
const CODE_ELEMENTS = new Set(["pre", "code", "script", "style", "textarea"]);

export function isCodeContext(state: EditorState, pos: number): boolean {  let node: any = syntaxTree(state).resolveInner(pos, -1);
  for (; node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true;
    if (node.name === "Element") {
      const open = node.getChild?.("OpenTag");
      const tag = open?.getChild?.("TagName");
      if (tag) {
        const text = state.sliceDoc(tag.from, tag.to).toLowerCase();
        if (CODE_ELEMENTS.has(text)) return true;
      }
    }
  }
  return false;
}
