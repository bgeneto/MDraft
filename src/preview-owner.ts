//! Who owns the preview pane's content.
//!
//! Every renderer builds off-screen and swaps on success, which is the right
//! rule while one document is rebuilt: the reader keeps the last readable
//! output instead of watching it disappear. It is the wrong rule across a tab
//! switch, where the content describes a different file. This module answers the
//! one question that separates the two cases: may the active document see what
//! is on screen? It holds no DOM and no timing state, so Node can test it.

import type { DocumentLanguage } from "./api";
import { pathKey } from "./sessions.ts";

/** The active document, as the ownership test sees it. */
export interface OwnerProbe {
  id: string;
  incarnation: number;
  path: string | null;
  language: DocumentLanguage;
}

/**
 * What a piece of preview content was built from.
 *
 * A document owner is a session at one incarnation: opening another file into
 * the same tab keeps the id and changes the incarnation, and the old content is
 * no longer that document's. A LaTeX project owner is the root plus every file
 * the compile read, so moving between the project's chapters keeps the PDF.
 */
export type PreviewOwner =
  | { kind: "document"; sessionId: string; incarnation: number }
  | {
      kind: "latex-project";
      rootId: string;
      rootIncarnation: number;
      /** pathKey() of every file the compile contained, root included. */
      memberKeys: ReadonlySet<string>;
    };

export function documentOwner(s: { id: string; incarnation: number }): PreviewOwner {
  return { kind: "document", sessionId: s.id, incarnation: s.incarnation };
}

export function projectOwner(
  root: { id: string; incarnation: number },
  memberKeys: Iterable<string>,
): PreviewOwner {
  return {
    kind: "latex-project",
    rootId: root.id,
    rootIncarnation: root.incarnation,
    memberKeys: new Set(memberKeys),
  };
}

/**
 * True when `active` may see content stamped with `owner`.
 *
 * The language test in the project case is deliberate. A `.bib` or `.sty` tab
 * has its own non-LaTeX preview; treating its path as a member would let it
 * inherit the PDF that was built from the `.tex` files.
 */
export function covers(owner: PreviewOwner | null, active: OwnerProbe): boolean {
  if (!owner) return false;
  if (owner.kind === "document") {
    return active.id === owner.sessionId && active.incarnation === owner.incarnation;
  }
  if (active.id === owner.rootId && active.incarnation === owner.rootIncarnation) return true;
  return (
    active.language === "latex" &&
    active.path !== null &&
    owner.memberKeys.has(pathKey(active.path))
  );
}

/** How long a rebuild may take before the pane stops pretending it is current. */
export const PENDING_GRACE_MS = 150;
/** When the elapsed counter starts for a reader who has not asked for less motion. */
export const ELAPSED_AFTER_MS = 5000;
/** The same threshold under `prefers-reduced-motion: reduce`. */
export const ELAPSED_AFTER_REDUCED_MS = 1000;

/** `7000` -> `0:07`, `723000` -> `12:03`. Hours stay minutes on purpose. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The first phase line shown while a document of this language is rendered. */
export function pendingPhase(language: DocumentLanguage): string {
  if (language === "markdown") return "Rendering preview…";
  if (language === "asciidoc") return "Rendering AsciiDoc…";
  if (language === "typst") return "Compiling Typst…";
  if (language === "latex") return "Preparing LaTeX compilation…";
  return "";
}
