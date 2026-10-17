//! The intermediate representation shared by every paste source and destination.
//!
//! A clipboard fragment is parsed once into these plain objects, then rendered
//! into Markdown, Typst or HTML. Nothing here knows about the DOM, CodeMirror or
//! Tauri, which is what lets the whole conversion matrix run under Node.

export type Align = "left" | "center" | "right" | null;

export type Inline =
  | { kind: "text"; value: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "code"; value: string }
  | { kind: "link"; href: string; title?: string; children: Inline[] }
  | {
      kind: "image";
      src: string;
      alt: string;
      title?: string;
      width?: number;
      height?: number;
    }
  | { kind: "math"; tex: string; display?: boolean }
  | { kind: "break" }
  | { kind: "sup"; children: Inline[] }
  | { kind: "sub"; children: Inline[] };

export interface ListItem {
  blocks: Block[];
  /** GFM task state, when the source carried one. */
  task?: "done" | "todo";
}

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "list"; ordered: boolean; start?: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; language: string | null; text: string }
  | {
      kind: "table";
      align: Align[];
      header: Inline[][] | null;
      rows: Inline[][][];
    }
  | { kind: "rule" }
  | { kind: "math"; tex: string };

export interface Fragment {
  blocks: Block[];
}

/** Plain text of an inline sequence, for titles, table cells and tests. */
export function inlineText(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
      case "code":
        out += node.value;
        break;
      case "math":
        out += node.tex;
        break;
      case "break":
        out += " ";
        break;
      case "image":
        out += node.alt;
        break;
      default:
        out += inlineText(node.children);
    }
  }
  return out;
}

/** True when the fragment has to be separated from surrounding text. */
export function isBlockFragment(blocks: readonly Block[]): boolean {
  if (blocks.length !== 1) return true;
  const only = blocks[0];
  if (only.kind !== "paragraph") return true;
  // A paragraph with a hard break still reads as a paragraph, but a lone image
  // is content that should stand on its own line.
  return only.children.some((node) => node.kind === "image");
}

export function trimBlocks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.kind === "paragraph" && inlineText(block.children).trim() === "") {
      if (block.children.some((node) => node.kind === "image")) out.push(block);
      continue;
    }
    out.push(block);
  }
  return out;
}
