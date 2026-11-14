//! Pure PDF text alignment; terminated when its render is superseded.
import { buildPdfWordAnchors } from "./pdf-page-build.ts";
import type { TypstSpanAnchor } from "./api";
import type { PageMapLine } from "./typst-page-map";
import type { PdfSourceFile, PdfWordAnchor } from "./pdf-page-map";

let result: PdfWordAnchor[] = [];
let offset = 0;
function sendChunk(): void {
  const end = Math.min(offset + 512, result.length);
  const anchors = result.slice(offset, end);
  offset = end;
  const done = offset === result.length;
  self.postMessage({ anchors, done });
  if (done) result = [];
}

self.onmessage = async (
  event: MessageEvent<
    | {
        language: "typst" | "latex";
        files: PdfSourceFile[];
        lines: PageMapLine[];
        spanMap?: TypstSpanAnchor[];
      }
    | { next: true }
  >,
) => {
  try {
    if ("next" in event.data) {
      sendChunk();
      return;
    }
    const { language, files, lines, spanMap } = event.data;
    result = await buildPdfWordAnchors(language, files, lines, spanMap);
    offset = 0;
    sendChunk();
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
