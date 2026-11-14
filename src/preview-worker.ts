//! The Markdown preview worker. Pure string work only; see `preview-render.ts`.

import { primeKatexCache, type PrimeKatexEntry } from "./katex-cache";
import {
  renderChunks,
  renderChunksIncremental,
  type ChunkOptions,
  type PreviewChunks,
} from "./preview-render";

interface RenderRequest {
  id: number;
  kind?: "render";
  source: string;
  options: ChunkOptions;
}

interface WarmupRequest {
  id: number;
  kind: "warmup";
  primeKatex?: PrimeKatexEntry[];
}

type Request = RenderRequest | WarmupRequest;

interface Reply {
  id: number;
  ok: boolean;
  kind?: "warmed";
  data?: PreviewChunks;
  error?: string;
}

interface CachedWorkerRender {
  source: string;
  optionsKey: string;
  chunks: PreviewChunks;
}

let lastRender: CachedWorkerRender | null = null;

function chunkOptionsKey(options: ChunkOptions): string {
  return JSON.stringify([options.math ?? true, options.map ?? false]);
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Reply) => void;
};

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.kind === "warmup") {
    if (Array.isArray(msg.primeKatex)) primeKatexCache(msg.primeKatex);
    scope.postMessage({ id: msg.id, ok: true, kind: "warmed" });
    return;
  }
  const { id, source, options } = msg;
  const optionsKey = chunkOptionsKey(options);
  try {
    let data: PreviewChunks;
    if (lastRender && lastRender.optionsKey === optionsKey) {
      data =
        lastRender.source === source
          ? lastRender.chunks
          : renderChunksIncremental(lastRender.source, lastRender.chunks, source, options);
    } else {
      data = renderChunks(source, options);
    }
    lastRender = { source, optionsKey, chunks: data };
    scope.postMessage({ id, ok: true, data });
  } catch (error) {
    lastRender = null;
    scope.postMessage({ id, ok: false, error: String(error) });
  }
};
