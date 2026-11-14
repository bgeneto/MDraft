//! The AsciiDoc preview worker. Asciidoctor is bundled here only, so a Markdown
//! session never downloads or parses it.

import {
  loadAsciidoctor,
  renderAsciidocChunks,
  type AsciidocChunks,
  type AsciidocWorkerOptions,
} from "./asciidoc-render";
import { primeKatexCache, type PrimeKatexEntry } from "./katex-cache";

interface RenderRequest {
  id: number;
  kind?: "render";
  source: string;
  options: AsciidocWorkerOptions;
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
  data?: AsciidocChunks;
  error?: string;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Reply) => void;
};

scope.onmessage = async (event) => {
  const msg = event.data;
  if (msg.kind === "warmup") {
    if (Array.isArray(msg.primeKatex)) primeKatexCache(msg.primeKatex);
    try {
      await loadAsciidoctor();
      scope.postMessage({ id: msg.id, ok: true, kind: "warmed" });
    } catch (error) {
      scope.postMessage({ id: msg.id, ok: false, kind: "warmed", error: String(error) });
    }
    return;
  }
  const { id, source, options } = msg;
  try {
    scope.postMessage({ id, ok: true, data: await renderAsciidocChunks(source, options) });
  } catch (error) {
    scope.postMessage({ id, ok: false, error: String(error) });
  }
};
