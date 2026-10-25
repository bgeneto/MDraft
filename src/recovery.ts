//! Crash-recovery scheduling.
//!
//! The Rust store owns the files; this module owns the timing and the order.
//! Two rules matter:
//!
//! - one timer per session, so typing in one tab never rewrites another tab's
//!   journal;
//! - one writer per session, so a slow write cannot land after a newer one and
//!   a remove cannot be undone by an older save. The queue is keyed by the
//!   session, not the recovery id: a forget replaces the id, and two ids for
//!   the same buffer must still serialise.
//!
//! The module is deliberately free of Tauri and DOM globals (apart from
//! `crypto.randomUUID` when it exists), which is what lets `p0-unit` test it in
//! Node.

import type { RecoveryEntry } from "./api";
import type { Session } from "./sessions";

export const RECOVERY_DEBOUNCE_MS = 700;

export function newRecoveryId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build the entry for a session's current text.
 *
 * `updatedMs` is left at zero because Rust stamps it; keeping the field in the
 * type is what makes the IPC shape explicit. The id is created lazily on the
 * first dirty write and then reused, so a recovered session updates the file
 * it came from instead of creating a second one.
 */
export function buildRecoveryEntry(
  session: Session,
  content: string,
  updatedMs = 0,
): RecoveryEntry {
  const id = session.recoveryId ?? newRecoveryId();
  session.recoveryId = id;
  return {
    id,
    path: session.path,
    name: session.name,
    language: session.language,
    content,
    lineEnding: session.lineEnding,
    hadBom: session.hadBom,
    lossy: session.lossy,
    readOnly: session.readOnly,
    baseModifiedMs: session.modifiedMs,
    baseSize: session.size,
    updatedMs,
  };
}

export interface RecoverySchedulerDeps {
  save: (entry: RecoveryEntry) => Promise<void>;
  remove: (id: string) => Promise<void>;
  notify: (message: string) => void;
  debounceMs?: number;
}

export interface RecoveryScheduler {
  /** Queue a dirty session's text; repeated calls replace the pending text. */
  schedule(session: Session, content: string): void;
  /** Write now, bypassing the timer. Returns when the write has settled. */
  flush(session: Session, content?: string): Promise<void>;
  /** Drop the pending write and remove the journal entry. */
  forget(session: Session): Promise<void>;
  /** Write every supplied dirty session now; used by a future close hook. */
  flushAll(sessions: Iterable<Session>): Promise<void>;
  /** Cancel timers without writing; for tests and window teardown. */
  dispose(): void;
}

export function createRecoveryScheduler(deps: RecoverySchedulerDeps): RecoveryScheduler {
  const debounceMs = deps.debounceMs ?? RECOVERY_DEBOUNCE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, string>();
  const chains = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();
  const reported = new Set<string>();

  const generation = (key: string): number => generations.get(key) ?? 0;

  const queue = (key: string, task: () => Promise<void>): Promise<void> => {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    chains.set(key, next);
    void next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
    return next;
  };

  const report = (session: Session, id: string, error: unknown): void => {
    if (reported.has(id)) return;
    reported.add(id);
    deps.notify(`Could not journal "${session.name}": ${String(error)}`);
  };

  const clearTimer = (key: string): void => {
    const timer = timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(key);
    }
  };

  const flush = async (session: Session, content?: string): Promise<void> => {
    const key = session.id;
    clearTimer(key);
    const text = content ?? pending.get(key);
    pending.delete(key);
    if (text === undefined) return;
    if (text === session.savedContent) {
      await forget(session);
      return;
    }

    const entry = buildRecoveryEntry(session, text, 0);
    const id = entry.id;
    const gen = generation(session.id);
    await queue(session.id, async () => {
      // A forget after this flush was queued wins: the buffer was saved or
      // discarded, and an older text must not recreate its journal.
      if (generation(session.id) !== gen) return;
      try {
        await deps.save(entry);
        reported.delete(id);
      } catch (error) {
        report(session, id, error);
      }
    });
  };

  const forget = async (session: Session): Promise<void> => {
    const key = session.id;
    clearTimer(key);
    pending.delete(key);
    // Invalidate a flush that is already queued before reading the id: from
    // this point on the buffer is either clean or being closed.
    generations.set(key, generation(key) + 1);
    const id = session.recoveryId;
    session.recoveryId = null;
    if (!id) return;
    await queue(session.id, async () => {
      try {
        await deps.remove(id);
        reported.delete(id);
      } catch (error) {
        deps.notify(`Could not clear the recovery entry for "${session.name}": ${String(error)}`);
      }
    });
  };

  return {
    schedule(session, content) {
      if (content === session.savedContent) {
        void forget(session);
        return;
      }
      const key = session.id;
      pending.set(key, content);
      clearTimer(key);
      const timer = setTimeout(() => {
        timers.delete(key);
        void flush(session);
      }, debounceMs);
      timers.set(key, timer);
    },

    flush,

    forget,

    async flushAll(sessions) {
      await Promise.all(Array.from(sessions, (session) => flush(session)));
    },

    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pending.clear();
      generations.clear();
    },
  };
}
