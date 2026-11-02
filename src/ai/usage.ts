//! The palette's derived *Most used* section.
//!
//! Each action keeps one decaying score: a completed use adds 1 after the old
//! score has been aged by a 30-day half-life. Ranking ages every entry to "now"
//! and sorts, so the section follows the reader's current habits instead of a
//! lifetime total that one busy week would dominate. Nothing here runs on a
//! timer and nothing reads a file: the caller supplies the entries and the
//! clock, which is also what lets `scripts/ai-unit.mjs` exercise the rules
//! without an application.
//!
//! This module is deliberately free of Tauri, DOM and CSS imports.

import type { AiActionId, AiUsageEntry } from "../api";
import {
  ACTIONS,
  DEFAULT_MOST_USED,
  MOST_USED_LIMIT,
  actionById,
  type AiActionSpec,
} from "./actions.ts";

/** A use loses half its weight every 30 days. */
export const USAGE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Storage guard, matching `MAX_AI_USAGE_ENTRIES` in
 * `src-tauri/src/settings.rs`. The visible section is `MOST_USED_LIMIT` rows;
 * this only bounds what `settings.json` may hold.
 */
export const MAX_USAGE_ENTRIES = 32;

/** Below this a weight is noise, not a habit, and is dropped on the next write. */
const PRUNE_SCORE = 0.02;

/** Nothing legitimate reaches this; it only catches a hand-edited file. */
const MAX_SCORE = 1_000_000;

/** A clock that is ahead must not pin an entry at the top for good. */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

/** Age one weight by `elapsedMs`. A clock that went backwards means no age. */
export function decay(score: number, elapsedMs: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  return score * Math.pow(0.5, elapsed / USAGE_HALF_LIFE_MS);
}

function catalogIndex(id: AiActionId): number {
  const index = ACTIONS.findIndex((action) => action.id === id);
  return index < 0 ? ACTIONS.length : index;
}

/** Strongest first, then newest, then catalog order: never chance. */
function sortUsage(entries: AiUsageEntry[]): AiUsageEntry[] {
  return entries
    .slice()
    .sort((a, b) => b.score - a.score || b.at - a.at || catalogIndex(a.id) - catalogIndex(b.id));
}

/**
 * Accept whatever `settings.json` held and return only usable entries.
 *
 * A settings file is user-editable and may predate this build or carry ids a
 * later one removed. Unknown ids, duplicates, negative or non-finite scores and
 * timestamps too far in the future are dropped rather than trusted; the list is
 * bounded and sorted so a load cannot reorder the file by accident.
 */
export function sanitizeUsage(value: unknown, now = Date.now()): AiUsageEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: AiUsageEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as { id?: unknown; score?: unknown; at?: unknown };
    if (typeof candidate.id !== "string") continue;
    const spec = actionById(candidate.id as AiActionId);
    if (!spec) continue;
    const score = candidate.score;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    if (score < 0 || score > MAX_SCORE) continue;
    const at = candidate.at;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) continue;
    if (at > now + MAX_FUTURE_MS) continue;
    const timestamp = Math.trunc(at);
    const existing = entries.find((entry) => entry.id === spec.id);
    if (existing) {
      if (score > existing.score) {
        existing.score = score;
        existing.at = timestamp;
      }
      continue;
    }
    entries.push({ id: spec.id, score, at: timestamp });
  }
  return sortUsage(entries).slice(0, MAX_USAGE_ENTRIES);
}

/**
 * Record one completed use of `id` at `now`.
 *
 * The stored score belongs to its timestamp, so the previous value is aged to
 * `now` before one is added. Entries that have decayed below `PRUNE_SCORE` are
 * dropped here — a write is the only moment that can forget anything, which is
 * why there is no cleanup pass anywhere else.
 */
export function recordUsage(
  entries: readonly AiUsageEntry[],
  id: AiActionId,
  now = Date.now(),
): AiUsageEntry[] {
  const current = sanitizeUsage(entries, now);
  if (!actionById(id)) return current;
  const previous = current.find((entry) => entry.id === id);
  const score = decay(previous?.score ?? 0, previous ? now - previous.at : 0) + 1;
  const next = current.filter((entry) => entry.id !== id);
  next.push({ id, score, at: now });
  const kept = next.filter(
    (entry) => entry.id === id || decay(entry.score, now - entry.at) >= PRUNE_SCORE,
  );
  return sortUsage(kept).slice(0, MAX_USAGE_ENTRIES);
}

/**
 * The rows the *Most used* section shows, strongest first.
 *
 * Ranked entries come first; the section is then padded from
 * `DEFAULT_MOST_USED` and the catalog, so a fresh profile shows the three
 * actions the palette used to pin there and the heading is never empty.
 */
export function rankMostUsed(
  entries: readonly AiUsageEntry[],
  now = Date.now(),
  limit = MOST_USED_LIMIT,
): AiActionSpec[] {
  const cap = Math.max(0, Math.trunc(limit));
  if (cap === 0) return [];
  const ranked = sanitizeUsage(entries, now)
    .map((entry) => ({ entry, weight: decay(entry.score, now - entry.at) }))
    .filter((candidate) => candidate.weight >= PRUNE_SCORE)
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        b.entry.at - a.entry.at ||
        catalogIndex(a.entry.id) - catalogIndex(b.entry.id),
    );

  const picked: AiActionSpec[] = [];
  const seen = new Set<AiActionId>();
  const take = (spec: AiActionSpec | undefined): void => {
    if (!spec || picked.length >= cap || seen.has(spec.id)) return;
    seen.add(spec.id);
    picked.push(spec);
  };
  for (const candidate of ranked) {
    take(actionById(candidate.entry.id));
    if (picked.length >= cap) return picked;
  }
  for (const id of DEFAULT_MOST_USED) {
    take(actionById(id));
    if (picked.length >= cap) return picked;
  }
  for (const action of ACTIONS) {
    take(action);
    if (picked.length >= cap) break;
  }
  return picked;
}
