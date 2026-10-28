//! The action catalog behind the palette.
//!
//! Pure data plus small pure helpers, so `scripts/ai-unit.mjs` can check the
//! cross-language contract with `src-tauri/src/ai/prompt.rs` without starting
//! the application. The labels, groups, descriptions and icons live here; the
//! prompts live in Rust.

import type { AiActionId, DocumentLanguage } from "../api";

export type AiGroup = "mostUsed" | "write" | "refine" | "understand" | "transform";

export type AiParameter = "none" | "tone" | "language" | "markup";

/**
 * How an answer returns to the document.
 *
 * - `replace`: the captured range can be replaced, with Insert below as the
 *   alternative (every rewrite).
 * - `block`: the answer is a new block after the current paragraph (summary,
 *   explanation, key points, critique).
 * - `continue`: the answer is inserted at the selection end or the caret.
 * - `answer`: Copy is primary; Insert below is available (Ask).
 */
export type AiApply = "replace" | "block" | "continue" | "answer";

export interface AiActionSpec {
  id: AiActionId;
  label: string;
  group: AiGroup;
  description: string;
  keywords: string[];
  /** Inner SVG markup for a 24x24 line-art icon. */
  icon: string;
  parameter: AiParameter;
  apply: AiApply;
}

export const GROUP_ORDER: AiGroup[] = ["mostUsed", "write", "refine", "understand", "transform"];

export const GROUP_LABELS: Record<AiGroup, string> = {
  mostUsed: "Most used",
  write: "Write",
  refine: "Refine",
  understand: "Understand",
  transform: "Transform",
};

export const TONES = ["Professional", "Formal", "Casual", "Confident", "Friendly", "Persuasive"];

export const LANGUAGES = [
  "English",
  "Portuguese",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Japanese",
  "Chinese",
  "Arabic",
  "Russian",
];

export const MARKUPS: { id: DocumentLanguage; label: string }[] = [
  { id: "markdown", label: "Markdown" },
  { id: "typst", label: "Typst" },
  { id: "html", label: "HTML" },
  { id: "asciidoc", label: "AsciiDoc" },
];

export const ACTIONS: AiActionSpec[] = [
  {
    id: "continue",
    label: "Continue writing",
    group: "mostUsed",
    description: "Write the next passage in your voice",
    keywords: ["continue", "next", "complete", "carry on", "escrever"],
    icon: '<path d="M4 20l6.5-6.5"/><path d="M13.5 4.5l6 6L9 21H3v-6z"/><path d="M14.5 3.5l6 6"/>',
    parameter: "none",
    apply: "continue",
  },
  {
    id: "improve",
    label: "Improve writing",
    group: "mostUsed",
    description: "Proofread and polish the selected passage",
    keywords: ["improve", "proofread", "grammar", "spelling", "revise", "revisar"],
    icon: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    parameter: "none",
    apply: "replace",
  },
  {
    id: "ask",
    label: "Ask AI…",
    group: "mostUsed",
    description: "Ask about the selection, or ask anything",
    keywords: ["ask", "question", "chat", "custom", "perguntar"],
    icon: '<path d="M21 12a8.5 8.5 0 0 1-8.5 8.5H4l3-3A8.5 8.5 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14.5h4.5"/>',
    parameter: "none",
    apply: "answer",
  },
  {
    id: "expand",
    label: "Expand",
    group: "write",
    description: "Develop the passage with more detail",
    keywords: ["expand", "longer", "develop", "elaborate", "expandir"],
    icon: '<path d="M9 4H4v5M15 20h5v-5M4 4l6 6M20 20l-6-6"/>',
    parameter: "none",
    apply: "replace",
  },
  {
    id: "shorten",
    label: "Shorten",
    group: "write",
    description: "Condense the passage without losing meaning",
    keywords: ["shorten", "condense", "trim", "concise", "encurtar"],
    icon: '<path d="M10 4H4v6M14 20h6v-6M4 4l6 6M20 20l-6-6"/>',
    parameter: "none",
    apply: "replace",
  },
  {
    id: "simplify",
    label: "Simplify",
    group: "refine",
    description: "Rewrite in plainer language",
    keywords: ["simplify", "plain", "clear", "simple", "simplificar"],
    icon: '<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/><circle cx="12" cy="12" r="4"/>',
    parameter: "none",
    apply: "replace",
  },
  {
    id: "tone",
    label: "Change tone…",
    group: "refine",
    description: "Rewrite in a chosen tone",
    keywords: ["tone", "formal", "casual", "friendly", "professional", "tom"],
    icon: '<path d="M3 12h3l2-6 3 12 3-9 2 3h5"/>',
    parameter: "tone",
    apply: "replace",
  },
  {
    id: "translate",
    label: "Translate…",
    group: "transform",
    description: "Translate the passage, keeping its markup",
    keywords: ["translate", "language", "portuguese", "english", "traduzir"],
    icon: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5S14.4 18.2 12 20.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5z"/>',
    parameter: "language",
    apply: "replace",
  },
  {
    id: "summarize",
    label: "Summarize",
    group: "understand",
    description: "A faithful summary of the passage",
    keywords: ["summarize", "summary", "abstract", "resumo", "resumir"],
    icon: '<path d="M4 6h16M4 10h16M4 14h12M4 18h7"/>',
    parameter: "none",
    apply: "block",
  },
  {
    id: "explain",
    label: "Explain",
    group: "understand",
    description: "Explain the passage and its terms",
    keywords: ["explain", "meaning", "clarify", "explicar"],
    icon: '<path d="M9 18h6M10 21h4"/><path d="M8.5 14.5a6 6 0 1 1 7 0c-.9.7-1.5 1.5-1.5 2.5h-4c0-1-.6-1.8-1.5-2.5z"/>',
    parameter: "none",
    apply: "block",
  },
  {
    id: "keyPoints",
    label: "Key points",
    group: "understand",
    description: "The essential points as a short list",
    keywords: ["points", "bullets", "list", "takeaways", "tópicos"],
    icon: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    parameter: "none",
    apply: "block",
  },
  {
    id: "critique",
    label: "Critique",
    group: "understand",
    description: "Constructive editorial feedback",
    keywords: ["critique", "review", "feedback", "criticar", "revisão"],
    icon: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/><path d="M8 9.5h5M8 12h3"/>',
    parameter: "none",
    apply: "block",
  },
  {
    id: "table",
    label: "Convert to table",
    group: "transform",
    description: "Turn structured prose or a list into a table",
    keywords: ["table", "columns", "rows", "tabela", "tabular"],
    icon: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M9.5 9.5v10M15 9.5v10"/>',
    parameter: "none",
    apply: "replace",
  },
  {
    id: "convert",
    label: "Convert markup…",
    group: "transform",
    description: "Convert the passage to another markup",
    keywords: ["convert", "markup", "markdown", "typst", "html", "asciidoc", "converter"],
    icon: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    parameter: "markup",
    apply: "replace",
  },
];

/** Case- and accent-insensitive normalisation for the palette search. */
export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Filter the catalog by label, group, description, keywords or id.
 *
 * An empty query returns the whole catalog in group order, so the palette can
 * render one list and let a group heading own the grouping.
 */
export function searchActions(
  query: string,
  actions: readonly AiActionSpec[] = ACTIONS,
): AiActionSpec[] {
  const needle = normalizeSearch(query);
  if (!needle) return [...actions];
  return actions.filter((action) => {
    const haystack = normalizeSearch(
      [
        action.id,
        action.label,
        GROUP_LABELS[action.group],
        action.description,
        ...action.keywords,
      ].join(" "),
    );
    return needle.split(/\s+/).every((word) => haystack.includes(word));
  });
}

/** Group a filtered list while keeping the catalog's group order. */
export function groupedActions(
  actions: readonly AiActionSpec[],
): { group: AiGroup; label: string; actions: AiActionSpec[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    actions: actions.filter((action) => action.group === group),
  })).filter((entry) => entry.actions.length > 0);
}

export function actionById(id: AiActionId): AiActionSpec | undefined {
  return ACTIONS.find((action) => action.id === id);
}

/** Whether the parameterised action can be sent with this value. */
export function parameterIsValid(
  action: AiActionId,
  value: string,
  language: DocumentLanguage,
): boolean {
  switch (action) {
    case "tone":
      return TONES.includes(value);
    case "translate":
      return value.trim().length > 0 && value.trim().length <= 60;
    case "convert":
      return MARKUPS.some((markup) => markup.id === value) && value !== language;
    default:
      return true;
  }
}

/** The three markup choices a document can be converted to. */
export function convertTargets(
  language: DocumentLanguage,
): { id: DocumentLanguage; label: string }[] {
  return MARKUPS.filter((markup) => markup.id !== language);
}

/** The default parameter for a parameterised action. */
export function defaultParameter(action: AiActionId, language: DocumentLanguage): string {
  switch (action) {
    case "tone":
      return "Professional";
    case "translate":
      return "";
    case "convert":
      return convertTargets(language)[0]?.id ?? "html";
    default:
      return "";
  }
}
