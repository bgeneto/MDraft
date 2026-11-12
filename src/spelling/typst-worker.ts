//! Keep Typst's full structural parse away from the editor's input thread.
import { typstTextRanges } from "./typst-ranges.ts";

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; source: string }>) => void) | null;
  postMessage(value: unknown): void;
};

worker.onmessage = (event) => {
  const { id, source } = event.data;
  try {
    worker.postMessage({ id, ranges: typstTextRanges(source) });
  } catch {
    worker.postMessage({ id, error: "Could not parse Typst for spelling." });
  }
};
