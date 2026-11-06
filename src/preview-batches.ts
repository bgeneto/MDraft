//! Batched insertion shared by the Markdown and AsciiDoc preview paths.
//!
//! A full document in one DOMPurify call is one long task. Top-level chunks are
//! grouped to a byte budget, inserted, and the loop yields when it has held the
//! main thread for long enough. The sanitizer and decorations stay with each
//! renderer; only the batching and the yield are shared.

export const PREVIEW_BATCH_BYTES = 64 * 1024;
const PREVIEW_YIELD_MS = 8;
/** Below this total, one batch is cheaper than several small ones. */
const SMALL_DOCUMENT_BYTES = 300 * 1024;

/** Group top-level chunks to a byte budget, preserving their order. */
export function batchesOf(chunks: readonly string[], maxBytes = PREVIEW_BATCH_BYTES): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = 0;
  for (const chunk of chunks) {
    if (batch.length > 0 && size + chunk.length > maxBytes) {
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
 * Batch a document for insertion. A small document is one sanitize call; a
 * larger one is split so each task stays short. The old fixed 64 KB budget made
 * a 223 KB file four DOMPurify/DOM passes for no benefit.
 */
export function batchesForChunks(chunks: readonly string[]): string[][] {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return batchesOf(chunks, total <= SMALL_DOCUMENT_BYTES ? total + 1 : PREVIEW_BATCH_BYTES);
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
