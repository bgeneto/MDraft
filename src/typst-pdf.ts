//! The Typst Pages view: the compiler's PDF drawn by PDF.js.
//!
//! The PDF is the same layout Typst produces for export. PDF.js supplies two
//! things the old SVG page view could not: a canvas we can draw at the pane's
//! resolution, and a text layer whose spans can be selected, copied and
//! hit-tested. The page is laid out once at 96 dpi and fitted to the pane with a
//! CSS transform, so resizing the pane never re-flows the text layer.
//!
//! The text layer is the only source of selection/click data. This module never
//! touches the editor; it reports the selected text and lets `main.ts` decide
//! whether it maps to a source range.

import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
  TextLayer,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** A4 at 96 dpi, the width the old SVG page view capped at. */
const MAX_PAGE_WIDTH = 794;
/** Space kept for the pane's padding and a scrollbar. */
const PANE_GUTTER = 24;
/** Render pages this far outside the viewport, then free their canvas again. */
const PRELOAD_MARGIN = "600px 0px";
/** A selected phrase longer than this is not a word sync request. */
const MAX_SELECTION = 120;

interface PdfPage {
  page: PDFPageProxy;
  shell: HTMLDivElement;
  pageEl: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textLayer: HTMLDivElement;
  viewport: PageViewport;
  rendered: boolean;
  rendering: boolean;
  /** Incremented by every paint/unpaint so a cancelled task cannot win a race. */
  renderVersion: number;
  task: RenderTask | null;
}

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist")
      .then((module) => {
        module.GlobalWorkerOptions.workerSrc = workerUrl;
        return module;
      })
      .catch((error: unknown) => {
        // A failed dynamic import should be retryable after the underlying
        // problem (a missing asset, a bad build) is fixed.
        pdfjsPromise = null;
        throw error;
      });
  }
  return pdfjsPromise;
}

export class TypstPdfPreview {
  private readonly host: HTMLElement;
  private readonly pane: HTMLElement;
  private readonly onSelection: (text: string, reveal: boolean) => void;

  private loadingTask: PDFDocumentLoadingTask | null = null;
  private pages: PdfPage[] = [];
  private observer: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private fit = 1;
  private maxPageWidth = MAX_PAGE_WIDTH;
  private disposed = false;
  private selectionTimer = 0;

  private readonly selectionChange = (): void => {
    if (this.disposed) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    if (!this.selectionInside(selection)) return;
    window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => this.emitSelection(false), 120);
  };

  private readonly doubleClick = (event: MouseEvent): void => {
    if (this.disposed) return;
    if (!this.host.contains(event.target as Node)) return;
    // The browser has selected the word by the time dblclick fires.
    window.clearTimeout(this.selectionTimer);
    this.emitSelection(true);
  };

  constructor(
    host: HTMLElement,
    pane: HTMLElement,
    onSelection: (text: string, reveal: boolean) => void,
  ) {
    this.host = host;
    this.pane = pane;
    this.onSelection = onSelection;
    this.host.style.setProperty("--typst-fit", "1");
    this.host.addEventListener("dblclick", this.doubleClick);
    document.addEventListener("selectionchange", this.selectionChange);
    this.resizeObserver = new ResizeObserver(() => this.applyFit());
    this.resizeObserver.observe(this.pane);
  }

  async render(pdf: Uint8Array): Promise<void> {
    const pdfjs = await loadPdfjs();
    if (this.disposed) return;

    const loadingTask = pdfjs.getDocument({ data: pdf });
    this.loadingTask = loadingTask;
    let pdfDocument: PDFDocumentProxy;
    try {
      pdfDocument = await loadingTask.promise;
    } catch (error) {
      this.dispose();
      throw error;
    }
    if (this.disposed) {
      void loadingTask.destroy();
      return;
    }

    try {
      for (let number = 1; number <= pdfDocument.numPages; number += 1) {
        if (this.disposed) {
          void loadingTask.destroy();
          return;
        }
        const page = await pdfDocument.getPage(number);
        if (this.disposed) {
          void loadingTask.destroy();
          return;
        }
        this.pages.push(await this.buildPage(pdfjs, page, number));
      }
    } catch (error) {
      this.dispose();
      throw error;
    }

    if (this.disposed) return;
    this.maxPageWidth = Math.max(
      1,
      this.pages.reduce((max, page) => Math.max(max, page.viewport.width), 0),
    );
    this.applyFit();
    this.observePages();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.selectionTimer);
    this.selectionTimer = 0;
    this.host.removeEventListener("dblclick", this.doubleClick);
    document.removeEventListener("selectionchange", this.selectionChange);
    this.observer?.disconnect();
    this.observer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const page of this.pages) {
      page.task?.cancel();
      page.task = null;
    }
    this.pages = [];
    if (this.loadingTask) {
      const loadingTask = this.loadingTask;
      this.loadingTask = null;
      void loadingTask.destroy();
    }
    this.host.replaceChildren();
  }

  private async buildPage(
    pdfjs: typeof import("pdfjs-dist"),
    page: PDFPageProxy,
    number: number,
  ): Promise<PdfPage> {
    const widthPt = page.view[2] - page.view[0];
    const baseWidth = Math.min(
      MAX_PAGE_WIDTH,
      Math.max(200, Math.round((widthPt * 96) / 72)),
    );
    const scale = baseWidth / widthPt;
    const viewport = page.getViewport({ scale });
    const height = Math.round(viewport.height);

    const shell = document.createElement("div");
    shell.className = "typst-page-shell";
    shell.style.setProperty("--typst-page-width", String(baseWidth));
    shell.style.setProperty("--typst-page-height", String(height));
    shell.setAttribute("role", "group");
    shell.setAttribute("aria-label", `Page ${number}`);

    const pageEl = document.createElement("div");
    pageEl.className = "typst-page";
    pageEl.dataset.pageNumber = String(number);
    // PDF.js's text layer uses these to place spans at the same scale as the
    // viewport. They must be set before the TextLayer is constructed.
    pageEl.style.setProperty("--total-scale-factor", String(scale));
    pageEl.style.setProperty("--scale-round-x", "1px");
    pageEl.style.setProperty("--scale-round-y", "1px");

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");

    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";

    pageEl.append(canvas, textLayer);
    shell.append(pageEl);
    this.host.append(shell);

    const layer: TextLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      }),
      container: textLayer,
      viewport,
    });
    await layer.render();
    // Rounding in PDF.js's CSS can leave the layer a fraction off the canvas;
    // the explicit pixel size keeps the spans over the glyphs.
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;

    return {
      page,
      shell,
      pageEl,
      canvas,
      textLayer,
      viewport,
      rendered: false,
      rendering: false,
      renderVersion: 0,
      task: null,
    };
  }

  private applyFit(): void {
    if (this.disposed || this.pages.length === 0) return;
    const available = Math.max(160, this.pane.clientWidth - PANE_GUTTER);
    this.fit = Math.min(1, available / this.maxPageWidth);
    this.host.style.setProperty("--typst-fit", this.fit.toFixed(4));
  }

  private observePages(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = this.pages.find((item) => item.shell === entry.target);
          if (!page) continue;
          if (entry.isIntersecting) void this.paint(page);
          else this.unpaint(page);
        }
      },
      { root: this.pane, rootMargin: PRELOAD_MARGIN },
    );
    for (const page of this.pages) this.observer.observe(page.shell);
  }

  private async paint(page: PdfPage): Promise<void> {
    if (this.disposed || page.rendered || page.rendering) return;
    const version = ++page.renderVersion;
    page.rendering = true;
    try {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      page.canvas.width = Math.max(1, Math.floor(page.viewport.width * ratio));
      page.canvas.height = Math.max(1, Math.floor(page.viewport.height * ratio));
      const task = page.page.render({
        canvas: page.canvas,
        viewport: page.viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      page.task = task;
      await task.promise;
      if (!this.disposed && page.renderVersion === version) page.rendered = true;
    } catch (error) {
      // A cancelled render is the normal result of scrolling a page out while
      // it is being painted. Leaving the shell blank is correct; a real failure
      // is surfaced by the next render or by the page never appearing.
      if (!this.disposed && page.renderVersion === version) {
        console.warn("Typst page render failed", error);
      }
    } finally {
      if (page.renderVersion === version) {
        page.rendering = false;
        page.task = null;
      }
    }
  }

  private unpaint(page: PdfPage): void {
    if (!page.rendered && !page.rendering) return;
    page.renderVersion += 1;
    page.task?.cancel();
    page.task = null;
    page.rendering = false;
    page.rendered = false;
    // Releasing the backing store is the point of lazy painting: the text layer
    // stays, so selection across a freed page still works.
    page.canvas.width = 0;
    page.canvas.height = 0;
  }

  private selectionInside(selection: Selection): boolean {
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    return (
      anchor !== null &&
      focus !== null &&
      this.host.contains(anchor) &&
      this.host.contains(focus)
    );
  }

  private emitSelection(reveal: boolean): void {
    if (this.disposed) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !this.selectionInside(selection)) return;
    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_SELECTION || /[\r\n]/.test(text)) return;
    this.onSelection(text, reveal);
  }
}
