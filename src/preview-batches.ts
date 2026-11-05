//! Batched insertion shared by the Markdown and AsciiDoc preview paths.
//!
//! A full document in one DOMPurify call is one long task. Top-level chunks are
//! grouped to a byte budget, inserted, and the loop yields when it has held the
//! main thread for long enough. The sanitizer and decorations stay with each
//! renderer; only the batching and the yield are shared.

export const PREVIEW_BATCH_BYTES = 64 * 1024;
const PREVIEW_YIELD_MS = 8;

/** Group top-level chunks to a byte budget, preserving their order. */
export function batchesOf(chunks: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = 0;
  for (const chunk of chunks) {
    if (batch.length > 0 && size + chunk.length > PREVIEW_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(chunk);
    size += chunk.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Let input events run when the current task has held the main thread long
 * enough. Returns the timestamp the next call should measure from.
 */
export async function settleMainThread(lastYield: number): Promise<number> {
  if (performance.now() - lastYield < PREVIEW_YIELD_MS) return lastYield;
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  return performance.now();
}
