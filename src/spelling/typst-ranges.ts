//! Literal Typst text ranges from the structural parser, not the placeholder
//! tree installed by the editor's separate WASM highlighter.

import { typstParser } from "codemirror-lang-typst/lezer";

const SKIP = new Set([
  "Error",
  "LetBinding",
  "SetRule",
  "ShowRule",
  "LineComment",
  "BlockComment",
  "Equation",
  "Raw",
  "ModuleImport",
  "ModuleInclude",
  "Import",
  "Include",
]);

export function typstTextRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  typstParser.parse(source).iterate({
    enter(node) {
      if (SKIP.has(node.name) || node.type.isError) return false;
      if (node.name === "Text") {
        ranges.push([node.from, node.to]);
        return false;
      }
    },
  });
  return ranges;
}
