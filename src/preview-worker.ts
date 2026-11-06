//! The Markdown preview worker. Pure string work only; see `preview-render.ts`.

import { renderChunks, type ChunkOptions, type PreviewChunks } from "./preview-render";

interface Request {
  id: number;
  source: string;
  options: ChunkOptions;
}

interface Reply {
  id: number;
  ok: boolean;
  data?: PreviewChunks;
  error?: string;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Reply) => void;
};

scope.onmessage = (event) => {
  const { id, source, options } = event.data;
  try {
    scope.postMessage({ id, ok: true, data: renderChunks(source, options) });
  } catch (error) {
    scope.postMessage({ id, ok: false, error: String(error) });
  }
};
