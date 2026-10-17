//! The destination for a paste: the saved extension, or the active buffer.
//!
//! `doc.language` is only a suggestion while a document has no path: Save As can
//! choose any extension, and the user may type another markup before saving.
//! This module resolves the paste destination without touching the editor's
//! parser; the caller shows a notice when detection disagrees with it.

import type { DocumentLanguage } from "../api.ts";
import {
  detectTextSyntax,
  stripNoise,
  scoreAsciidoc,
  scoreMarkdown,
  scoreTypst,
} from "./detect.ts";

export interface DestinationInput {
  saved: boolean;
  /** The language the editor is currently parsed as. */
  language: DocumentLanguage;
  buffer: string;
}

export interface PasteDestination {
  language: DocumentLanguage;
  /** True when the buffer's content overrode `input.language`. */
  detected: boolean;
  /** True when detection found nothing and the editor language was used. */
  fallback: boolean;
  score: number;
  runnerUp: number;
}

/** A buffer larger than this is classified from its beginning only. */
export const DETECTION_SAMPLE = 256 * 1024;

/**
 * The document classifier, with the saved/unsaved/fallback rule.
 *
 * A saved file is never scanned: its extension is authoritative. An unsaved
 * buffer is scanned, and a null result falls back to the editor's language,
 * which is the default-extension language the next Save As will suggest.
 */
export function resolvePasteDestination(input: DestinationInput): PasteDestination {
  if (input.saved) {
    return {
      language: input.language,
      detected: false,
      fallback: false,
      score: 0,
      runnerUp: 0,
    };
  }
  const sample = input.buffer.slice(0, DETECTION_SAMPLE);
  const found = detectTextSyntax(sample, "document");
  if (found) {
    return {
      language: found.language,
      detected: found.language !== input.language,
      fallback: false,
      score: found.score,
      runnerUp: found.runnerUp,
    };
  }
  return {
    language: input.language,
    detected: false,
    fallback: true,
    score: Math.max(
      scoreMarkdown(stripNoise(sample)),
      scoreTypst(stripNoise(sample)),
      scoreAsciidoc(stripNoise(sample)),
    ),
    runnerUp: 0,
  };
}
