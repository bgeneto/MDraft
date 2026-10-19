//! Remembering the open tabs across launches.
//!
//! Two pure functions, deliberately separate from the shell: what to store when
//! the tabs change, and what to do with the stored list at boot. Both are lists
//! of paths and nothing else — the content, the caret and the undo history stay
//! in memory, so "which documents were open" is cheap to persist and never
//! large.
//!
//! Path identity is [`pathKey`] from the session store, so a file cannot be
//! remembered twice under two spellings of its own name.

import { pathKey, type Session } from "./sessions.ts";

/**
 * Most documents remembered. The user's agreed ceiling; the Rust side
 * truncates to the same number when a hand-edited file carries more.
 */
export const MAX_LAST_TABS = 20;

export interface RememberedTabs {
  tabs: string[];
  active: string | null;
}

/**
 * The persistable list for the tabs that are open now.
 *
 * Takes the store's list and the active id because the store itself is stateful
 * and this is not. Untitled sessions are skipped; duplicates under the
 * platform's path identity are collapsed to their first occurrence; the list is
 * capped, and the active path is only recorded when it survived the cap.
 */
export function rememberTabs(
  sessions: readonly Session[],
  activeId: string,
): RememberedTabs {
  const tabs: string[] = [];
  const seen = new Set<string>();
  let active: string | null = null;

  for (const session of sessions) {
    if (!session.path) continue;
    const key = pathKey(session.path);
    // Record the active path before the duplicate check: a second spelling of
    // the same file is not stored twice, but the active document is still the
    // active document, and the restore plan resolves it by identity.
    if (session.id === activeId) active = session.path;
    if (seen.has(key)) continue;
    seen.add(key);
    if (tabs.length < MAX_LAST_TABS) tabs.push(session.path);
  }

  // The remembered active tab may lie beyond the cap; activating a tab that was
  // not restored would leave the first tab active with a stale path recorded.
  const rememberedActive = active;
  if (
    rememberedActive !== null &&
    !tabs.some((path) => pathKey(path) === pathKey(rememberedActive))
  ) {
    active = null;
  }

  return { tabs, active };
}

export interface RestorePlan {
  /** Something to open, in order; empty when nothing survived. */
  tabs: string[];
  /** A path from `tabs` to activate, or null to leave the first one active. */
  active: string | null;
  /** How many remembered documents no longer exist, for the boot toast. */
  missing: number;
}

/**
 * What to open at boot.
 *
 * `exists` is a callback rather than a filesystem call so the plan can be
 * checked without one — the shell passes `api.pathExists`. Order is preserved,
 * duplicates and missing files are dropped, and the remembered tab comes back
 * active when it survived; otherwise the first restored tab takes over, which is
 * also the fallback for an empty list.
 */
export function planRestore(
  saved: readonly string[],
  active: string | null,
  exists: (path: string) => boolean,
): RestorePlan {
  const tabs: string[] = [];
  const seen = new Set<string>();
  let missing = 0;

  for (const path of saved) {
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    if (tabs.length >= MAX_LAST_TABS) break;
    if (!exists(path)) {
      missing += 1;
      continue;
    }
    tabs.push(path);
  }

  const activeKey = active === null ? null : pathKey(active);
  const remembered =
    activeKey !== null ? tabs.find((path) => pathKey(path) === activeKey) ?? null : null;

  return { tabs, active: remembered ?? tabs[0] ?? null, missing };
}
