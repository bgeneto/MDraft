//! The AI Assistant's session history.
//!
//! Only completed answers are remembered, and only in memory: the list is
//! capped at ten entries and disappears when MDraft closes. Nothing here
//! touches settings, the recovery journal or any other file. The module is
//! deliberately free of Tauri and DOM imports so `scripts/ai-unit.mjs` can
//! exercise the insertion, replacement and formatting rules under Node.

import type { AiActionId, DocumentLanguage } from "../api";
import { MARKUPS, actionById } from "./actions.ts";

export const MAX_AI_HISTORY = 10;

export interface AiHistoryEntry {
  /** Stable for the life of the request; Regenerate replaces this entry. */
  id: string;
  action: AiActionId;
  /** The tone, target language or markup chosen for a parameterised action. */
  parameter: string | null;
  /** The Ask question, or an empty string for the other actions. */
  question: string;
  /** A human summary of the captured passage, such as "Selection · 240 characters". */
  contextSummary: string;
  /** The exact context the request carried, for reading it back. */
  context: string;
  /** The tag-free answer as the panel received it. */
  answer: string;
  /** Improve's optional "what changed" notes. */
  notes: string;
  model: string;
  host: string;
  documentName: string;
  language: DocumentLanguage;
  createdAt: number;
  truncated: boolean;
}

/**
 * Insert a new entry at the front, or replace one with the same id in place.
 *
 * Regenerate keeps its id, so replacing must not increase the count or move the
 * row: it is the same request asked again, not a new one. A new request is the
 * only thing that can push the oldest entry past the cap.
 */
export function rememberRequest(
  entries: readonly AiHistoryEntry[],
  entry: AiHistoryEntry,
  limit = MAX_AI_HISTORY,
): AiHistoryEntry[] {
  const cap = Math.max(0, Math.trunc(limit));
  if (cap === 0) return [];
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index < 0) return [entry, ...entries].slice(0, cap);
  const next = entries.slice();
  next[index] = entry;
  return next.slice(0, cap);
}

/** The action label plus the chosen parameter, for a history row's title. */
export function historyTitle(action: AiActionId, parameter: string | null): string {
  const spec = actionById(action);
  const label = spec?.label ?? action;
  if (!parameter) return label;
  const base = label.replace(/…$/, "");
  if (action === "convert") {
    const markup = MARKUPS.find((candidate) => candidate.id === parameter);
    return `${base} · ${markup?.label ?? parameter}`;
  }
  return `${base} · ${parameter}`;
}

/** Collapse whitespace and cut a value to one readable line. */
export function previewText(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const limit = Math.max(1, Math.trunc(max));
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

/** A compact age for a history row; the exact time remains in its tooltip. */
export function formatHistoryAge(createdAt: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - createdAt);
  if (elapsed < 45_000) return "Just now";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
