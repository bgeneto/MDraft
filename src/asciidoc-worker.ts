//! The AsciiDoc preview worker. Asciidoctor is bundled here only, so a Markdown
//! session never downloads or parses it.

import {
  renderAsciidocChunks,
  type AsciidocChunks,
  type AsciidocWorkerOptions,
} from "./asciidoc-render";

interface Request {
  id: number;
  source: string;
  options: AsciidocWorkerOptions;
}

interface Reply {
  id: number;
  ok: boolean;
  data?: AsciidocChunks;
  error?: string;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Reply) => void;
};

scope.onmessage = async (event) => {
  const { id, source, options } = event.data;
  try {
    scope.postMessage({ id, ok: true, data: await renderAsciidocChunks(source, options) });
  } catch (error) {
    scope.postMessage({ id, ok: false, error: String(error) });
  }
};
