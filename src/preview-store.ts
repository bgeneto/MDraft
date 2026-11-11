//! A byte-bounded, least-recently-used store of compiled preview output.
//!
//! Keys are freshness keys (`src/preview-freshness.ts`), so an entry can only be
//! returned for exactly the inputs it was built from: a LaTeX PDF for the same
//! project digest and engine, a Typst result for the same text, revision and
//! view. Returning to an unchanged tab then costs drawing the output, not
//! building it. The store lives in memory only and dies with the window.
//!
//! Eviction is by bytes, not entries: one large thesis PDF and twenty small
//! notes have very different costs. An entry larger than half the budget is not
//! stored at all — it would evict everything else to make room for itself, and
//! the next large build would evict it in turn. No DOM, so Node can test it.

/** The default budget: room for a handful of book-length PDFs. */
export const DEFAULT_STORE_BYTES = 96 * 1024 * 1024;

export interface PreviewStore<T> {
  /** The entry for `key`, marked most recently used, or undefined. */
  get(key: string): T | undefined;
  /** Store `value` (`bytes` long) under `key`; false when it is too large. */
  set(key: string, value: T, bytes: number): boolean;
  /** Remove every entry whose key satisfies `test`; returns how many went. */
  drop(test: (key: string) => boolean): number;
  clear(): void;
  /** Bytes currently held. */
  readonly bytes: number;
  /** Entries currently held. */
  readonly size: number;
}

export function createPreviewStore<T>(budget = DEFAULT_STORE_BYTES): PreviewStore<T> {
  // A Map iterates in insertion order; re-inserting on use makes the first key
  // the least recently used one.
  const entries = new Map<string, { value: T; bytes: number }>();
  let held = 0;

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    held -= entry.bytes;
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, bytes) {
      remove(key);
      if (!Number.isFinite(bytes) || bytes < 0 || bytes > budget / 2) return false;
      while (held + bytes > budget && entries.size > 0) {
        remove(entries.keys().next().value as string);
      }
      entries.set(key, { value, bytes });
      held += bytes;
      return true;
    },
    drop(test) {
      let dropped = 0;
      for (const key of [...entries.keys()]) {
        if (!test(key)) continue;
        remove(key);
        dropped += 1;
      }
      return dropped;
    },
    clear() {
      entries.clear();
      held = 0;
    },
    get bytes() {
      return held;
    },
    get size() {
      return entries.size;
    },
  };
}
