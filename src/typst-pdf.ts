//! The Typst Pages view: the compiler's PDF drawn by PDF.js.
//!
//! The PDF is the same layout Typst produces for export. PDF.js supplies two
//! things the old SVG page view could not: a canvas we can draw at the pane's
//! resolution, and a text layer whose spans can be selected, copied and
//! hit-tested. The page is laid out once at 96 dpi and fitted to the pane with a
//! CSS transform, so resizing the pane never re-flows the text layer; only the
//! canvas is re-rastered when the fit changes. The fit may exceed 1 so the page
//! reaches both sides of the pane, with a few pixels of bleed clipped away.
//!
//! The text layer is the only source of selection/click data. This module never
//! touches the editor; its immutable correspondence index resolves literal
//! prose and `main.ts` owns editor decoration and selection lifetime.

import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
  TextLayer,
} from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { selectionEndpoints } from "./source-map";
import { createTypstPageMap, lineTokenAt, type TypstPageMap } from "./typst-page-map";

/** A4 at 96 dpi, the width the old SVG page view capped at. */
const MAX_PAGE_WIDTH = 794;
/** The fitted page runs this far past the pane, half clipped on each side. */
const PAGE_BLEED = 4;
/** A page canvas above this many device pixels is downscaled to bound memory. */
const MAX_CANVAS_PIXELS = 12_000_000;
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

/** A visual line in the PDF text layer, with its spans joined in reading order. */
interface TextLine {
  id: number;
  region: string;
  page: number;
  text: string;
  top: number;
  left: number;
  right: number;
  /** Column cluster; -1 when the page did not resolve to columns. */
  column: number;
  spans: Array<{ span: HTMLSpanElement; start: number }>;
}

/**
 * What the reader pointed at in Pages.
 *
 * `sourceRange` is verified by the snapshot's correspondence index. Line text
 * and neighbouring lines describe the gesture; they are not source offsets.
 */
export interface TypstPageContext {
  sourceRange: { from: number; to: number } | null;
  page: number;
  lineText: string;
  /** The neighbouring visual lines in the same column, for a one-word line. */
  before: string;
  after: string;
  start: number;
  end: number;
  text: string;
  /** A collapsed click: map the line/paragraph rather than a word. */
  paragraph: boolean;
  /** The selection crossed a line boundary. */
  multiLine: boolean;
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
  private readonly onContext: (context: TypstPageContext | null, reveal: boolean) => void;

  private loadingTask: PDFDocumentLoadingTask | null = null;
  private pages: PdfPage[] = [];
  private readonly linesByPage = new Map<number, TextLine[]>();
  private observer: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private fit = 1;
  /** View zoom factor; 1 is 100%. */
  private zoom = 1;
  private fitTimer = 0;
  private maxPageWidth = MAX_PAGE_WIDTH;
  private disposed = false;
  private selectionTimer = 0;
  private clickTimer = 0;
  private readonly spanLines = new WeakMap<HTMLSpanElement, { line: TextLine; start: number }>();
  private sourceMap: TypstPageMap | null = null;
  private allLines: TextLine[] = [];

  private readonly dismiss = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      window.clearTimeout(this.selectionTimer);
      window.clearTimeout(this.clickTimer);
    }
  };

  private readonly selectionChange = (): void => {
    if (this.disposed) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    if (!this.selectionInside(selection)) return;
    window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => this.emitSelection(false), 120);
  };

  private readonly click = (event: MouseEvent): void => {
    if (this.disposed) return;
    if (!this.host.contains(event.target as Node)) return;
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed) return;
    const x = event.clientX;
    const y = event.clientY;
    window.clearTimeout(this.clickTimer);
    // Give dblclick a chance to cancel this. A double-click's first click is a
    // paragraph gesture too, but the word mapping is the better answer.
    this.clickTimer = window.setTimeout(() => this.emitParagraph(x, y), 240);
  };

  private readonly doubleClick = (event: MouseEvent): void => {
    if (this.disposed) return;
    if (!this.host.contains(event.target as Node)) return;
    // The browser has selected the word by the time dblclick fires.
    window.clearTimeout(this.clickTimer);
    this.clickTimer = 0;
    window.clearTimeout(this.selectionTimer);
    this.emitSelection(true);
  };

  private readonly mouseUp = (event: MouseEvent): void => {
    if (this.disposed || !this.host.contains(event.target as Node)) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !this.selectionInside(selection)) return;
    // A drag has settled. Reveal the source once, at the end, instead of
    // scrolling it on every intermediate selectionchange.
    window.clearTimeout(this.selectionTimer);
    this.selectionTimer = 0;
    this.emitSelection(true);
  };

  constructor(
    host: HTMLElement,
    pane: HTMLElement,
    onContext: (context: TypstPageContext | null, reveal: boolean) => void,
    readonly source: string,
  ) {
    this.host = host;
    this.pane = pane;
    this.onContext = onContext;
    this.host.style.setProperty("--typst-fit", "1");
    this.pane.classList.remove("preview-zoomed");
    this.host.addEventListener("click", this.click);
    this.host.addEventListener("dblclick", this.doubleClick);
    this.host.addEventListener("mouseup", this.mouseUp);
    document.addEventListener("selectionchange", this.selectionChange);
    document.addEventListener("keydown", this.dismiss);
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
    this.allLines = [...this.linesByPage.values()].flat();
    this.allLines.forEach((line, id) => {
      line.id = id;
    });
    const sourceMap = await createTypstPageMap(this.source, this.allLines);
    if (this.disposed) return;
    this.sourceMap = sourceMap;
    this.maxPageWidth = Math.max(
      1,
      this.pages.reduce((max, page) => Math.max(max, page.viewport.width), 0),
    );
    this.applyFit();
    this.observePages();
  }

  /**
   * Change the view zoom without rebuilding the PDF.
   *
   * The fit feeds both the page shell's CSS size and the canvas raster scale;
   * preserving scroll by the fit ratio keeps the reader at roughly the same
   * place in the document instead of jumping to the top.
   */
  setZoom(zoom: number): void {
    const next = Math.max(0.5, Math.min(3, zoom));
    if (Math.abs(next - this.zoom) < 0.001) return;
    const before = this.fit;
    const scroll = this.pane.scrollTop;
    this.zoom = next;
    this.pane.classList.toggle("preview-zoomed", next > 1);
    this.applyFit();
    if (before > 0 && Math.abs(this.fit - before) > 0.0001) {
      const ratio = this.fit / before;
      requestAnimationFrame(() => {
        if (!this.disposed) this.pane.scrollTop = scroll * ratio;
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pane.classList.remove("preview-zoomed");
    window.clearTimeout(this.selectionTimer);
    this.selectionTimer = 0;
    window.clearTimeout(this.clickTimer);
    this.clickTimer = 0;
    window.clearTimeout(this.fitTimer);
    this.fitTimer = 0;
    this.host.removeEventListener("click", this.click);
    this.host.removeEventListener("dblclick", this.doubleClick);
    this.host.removeEventListener("mouseup", this.mouseUp);
    document.removeEventListener("selectionchange", this.selectionChange);
    document.removeEventListener("keydown", this.dismiss);
    this.observer?.disconnect();
    this.observer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const page of this.pages) {
      page.task?.cancel();
      page.task = null;
    }
    this.pages = [];
    this.linesByPage.clear();
    this.allLines = [];
    this.sourceMap = null;
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
    const baseWidth = Math.min(MAX_PAGE_WIDTH, Math.max(200, Math.round((widthPt * 96) / 72)));
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

    const text = await page.getTextContent({
      includeMarkedContent: true,
      disableNormalization: true,
    });
    const layer: TextLayer = new pdfjs.TextLayer({
      textContentSource: text,
      container: textLayer,
      viewport,
    });
    await layer.render();
    // Rounding in PDF.js's CSS can leave the layer a fraction off the canvas;
    // the explicit pixel size keeps the spans over the glyphs.
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    this.indexLines(
      number,
      text.items.filter((item): item is TextItem => "str" in item),
      layer.textDivs,
      viewport,
    );

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
    // Fit to the pane, allowing a scale above 1. The bleed makes the page a few
    // pixels wider than the pane; the pane clips it, so no side gutter can show
    // and a resize cannot leave a one-pixel seam. The view zoom multiplies the
    // fit, so a 150% page is larger than the pane and scrolls horizontally.
    const available = Math.max(160, this.pane.clientWidth + PAGE_BLEED);
    const fit = (available / this.maxPageWidth) * this.zoom;
    if (Math.abs(fit - this.fit) < 0.001) return;
    this.fit = fit;
    this.host.style.setProperty("--typst-fit", this.fit.toFixed(4));

    // CSS scales the live canvas while the window is being dragged; the raster
    // itself has to be redrawn at the final size or its glyphs stay soft. A page
    // that has not been painted yet will use the new fit on its first paint.
    window.clearTimeout(this.fitTimer);
    if (this.pages.some((page) => page.rendered || page.rendering)) {
      this.fitTimer = window.setTimeout(() => {
        this.fitTimer = 0;
        this.repaintRendered();
      }, 140);
    }
  }

  /** Redraw the pages that are already on screen at the fit's pixel scale. */
  private repaintRendered(): void {
    if (this.disposed) return;
    for (const page of this.pages) {
      if (!page.rendered && !page.rendering) continue;
      page.renderVersion += 1;
      page.task?.cancel();
      page.task = null;
      page.rendering = false;
      page.rendered = false;
      void this.paint(page, true);
    }
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

  private async paint(page: PdfPage, keepVisible = false): Promise<void> {
    if (this.disposed || page.rendered || page.rendering) return;
    const version = ++page.renderVersion;
    page.rendering = true;
    // A repaint at a new fit renders off-screen first. The page stays visible
    // (scaled, therefore briefly soft) until the new bitmap is ready, instead of
    // blanking while the render runs.
    const target =
      keepVisible && page.canvas.width > 0 ? document.createElement("canvas") : page.canvas;
    try {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      // Below a fit of 1 the bitmap is downscaled, which is sharp. Above it, the
      // canvas is stretched by the page transform, so render at the displayed
      // size instead of letting the browser enlarge a 96 dpi image.
      const wanted = ratio * Math.max(1, this.fit);
      const area = page.viewport.width * page.viewport.height;
      const scale = Math.min(wanted, Math.sqrt(MAX_CANVAS_PIXELS / area));
      target.width = Math.max(1, Math.floor(page.viewport.width * scale));
      target.height = Math.max(1, Math.floor(page.viewport.height * scale));
      const task = page.page.render({
        canvas: target,
        viewport: page.viewport,
        transform: scale === 1 ? undefined : [scale, 0, 0, scale, 0, 0],
      });
      page.task = task;
      await task.promise;
      if (!this.disposed && page.renderVersion === version) {
        if (target !== page.canvas) {
          page.canvas.width = target.width;
          page.canvas.height = target.height;
          page.canvas.getContext("2d")?.drawImage(target, 0, 0);
          target.width = 0;
          target.height = 0;
        }
        page.rendered = true;
      }
    } catch (error) {
      // A cancelled render is the normal result of scrolling a page out while
      // it is being painted. Leaving the shell blank is correct; a real failure
      // is surfaced by the next render or by the page never appearing.
      if (!this.disposed && page.renderVersion === version) {
        // A failed repaint kept the old bitmap: leave the page marked as drawn
        // so the next fit change can try again.
        if (target !== page.canvas && page.canvas.width > 0) page.rendered = true;
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

  /**
   * Group the text-layer spans into visual lines.
   *
   * PDF.js emits one span per text item, and a justified line can be split into
   * several items (`tion` + `time error…`). A line is the useful unit for source
   * mapping: it is long enough to identify the occurrence, short enough that a
   * two-column page does not confuse columns. Spans are grouped by vertical
   * position within a tolerance and split when the horizontal gap is large
   * enough to be the gutter between columns.
   */
  private indexLines(
    page: number,
    items: TextItem[],
    spans: HTMLElement[],
    viewport: PageViewport,
  ): void {
    // PDF coordinates are independent of CSS fit, zoom, scroll and font ascent.
    // TextLayer.textDivs follows the text items, including whitespace items.
    const records = items
      .map((item, index) => {
        const [left, top] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        return {
          span: spans[index] as HTMLSpanElement,
          text: item.str,
          rect: {
            left,
            top,
            right: left + Math.abs(item.width * viewport.scale),
            height: Math.max(1, item.height * viewport.scale),
          },
        };
      })
      .filter((record) => record.span && record.text.trim())
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const prose = records.filter((record) => record.text.trim().length >= 12);
    const columns = this.columnStarts(prose.length >= 6 ? prose : records, viewport.width);
    const columnOf = (left: number): number => {
      if (columns.length < 2) return -1;
      let best = 0;
      for (let i = 1; i < columns.length; i += 1) {
        // A column extends up to the next column's start, not the midpoint
        // between left edges. Right-hand fragments still belong to the left.
        if (left >= columns[i] - 2) best = i;
      }
      return best;
    };
    const lines: TextLine[] = [];
    const grouped = new Map<TextLine, typeof records>();
    for (const record of records) {
      const column =
        columns.length > 1 &&
        record.rect.left < columns[1] - 2 &&
        record.rect.right > columns[1] + 8
          ? -1
          : columnOf(record.rect.left);
      let line: TextLine | null = null;
      for (const candidate of lines) {
        if (
          candidate.column === column &&
          Math.abs(candidate.top - record.rect.top) <= Math.max(0.8, record.rect.height * 0.12)
        ) {
          line = candidate;
          break;
        }
      }
      if (!line) {
        line = {
          id: -1,
          region: "",
          page,
          text: "",
          top: record.rect.top,
          left: record.rect.left,
          right: record.rect.right,
          column,
          spans: [],
        };
        lines.push(line);
        grouped.set(line, []);
      }
      grouped.get(line)!.push(record);
      line.left = Math.min(line.left, record.rect.left);
      line.right = Math.max(line.right, record.rect.right);
    }
    for (const line of lines) {
      let right = -Infinity;
      for (const record of grouped.get(line)!.sort((a, b) => a.rect.left - b.rect.left)) {
        const gap = record.rect.left - right;
        const separator =
          line.text.length &&
          !/\s$/.test(line.text) &&
          !/^\s/.test(record.text) &&
          gap > Math.max(0.5, record.rect.height * 0.12)
            ? " "
            : "";
        const start = line.text.length + separator.length;
        line.text += separator + record.text;
        line.spans.push({ span: record.span, start });
        right = Math.max(right, record.rect.right);
      }
      for (const entry of line.spans) {
        this.spanLines.set(entry.span, { line, start: entry.start });
      }
    }
    const wide =
      columns.length > 1
        ? lines.filter((line) => line.column < 0).sort((a, b) => a.top - b.top)
        : [];
    const band = (line: TextLine) => wide.filter((other) => other.top < line.top - 1).length;
    for (const line of lines) line.region = `${page}:${band(line)}:${line.column}`;
    lines.sort((a, b) => band(a) - band(b) || a.column - b.column || a.top - b.top);
    this.linesByPage.set(page, lines);
  }

  /** The previous and next visual line in the same column. */
  private neighbours(line: TextLine): { before: string; after: string } {
    const lines = this.linesByPage.get(line.page) ?? [];
    const sameColumn = lines.filter(
      (candidate) => line.column < 0 || candidate.column === line.column,
    );
    const at = sameColumn.indexOf(line);
    return {
      before: at > 0 ? sameColumn[at - 1].text : "",
      after: at >= 0 && at + 1 < sameColumn.length ? sameColumn[at + 1].text : "",
    };
  }

  /**
   * Repeated left edges across a page are columns.
   *
   * A two-column paper gives two clusters with many spans; a one-column page
   * gives one. Centered headings and authors form small clusters and are merged
   * into the nearest real column, so they do not become a phantom column.
   */
  private columnStarts(records: Array<{ rect: { left: number } }>, pageWidth: number): number[] {
    const tolerance = pageWidth * 0.02;
    const clusters: Array<{ at: number; count: number }> = [];
    for (const record of [...records].sort((a, b) => a.rect.left - b.rect.left)) {
      const last = clusters[clusters.length - 1];
      if (last && record.rect.left - last.at <= tolerance) {
        last.count += 1;
      } else {
        clusters.push({ at: record.rect.left, count: 1 });
      }
    }

    const strong = clusters
      .filter((cluster) => cluster.count >= Math.max(3, Math.floor(records.length * 0.08)))
      .map((cluster) => cluster.at)
      .sort((a, b) => a - b);
    const merged: number[] = [];
    for (const at of strong) {
      const last = merged[merged.length - 1];
      if (last !== undefined && at - last <= pageWidth * 0.08) {
        // Keep the leftmost start. Averaging paragraph indents drifts the
        // origin into a column and misclassifies its first words as full width.
      } else {
        merged.push(at);
      }
    }
    const separated = merged.filter(
      (at, index) => index === 0 || at - merged[index - 1] > pageWidth * 0.22,
    );
    return separated.length >= 2 ? separated : [];
  }

  /** Locate a DOM point in the indexed text lines. */
  private locate(node: Node | null, offset: number): { line: TextLine; offset: number } | null {
    if (!node) return null;
    const element =
      node.nodeType === Node.TEXT_NODE
        ? node.parentElement
        : node instanceof HTMLElement
          ? node
          : null;
    const span = element?.closest<HTMLSpanElement>('span[role="presentation"]');
    if (!span || !this.host.contains(span)) return null;
    const entry = this.spanLines.get(span);
    if (!entry) return null;
    const inSpan = node.nodeType === Node.TEXT_NODE ? offset : 0;
    return { line: entry.line, offset: entry.start + inSpan };
  }

  private contextForRange(range: Range): TypstPageContext | null {
    const endpoints = selectionEndpoints(range);
    if (!endpoints) return null;
    const start = this.locate(endpoints.start.node, endpoints.start.offset);
    if (!start) return null;
    const end = this.locate(endpoints.end.node, endpoints.end.offset);
    const multiLine = end === null || end.line !== start.line;
    const text = range.toString();
    if (!text.trim()) return null;
    const neighbours = this.neighbours(start.line);
    return {
      sourceRange: end
        ? (this.sourceMap?.sourceRange(start.line.id, start.offset, end.line.id, end.offset) ??
          null)
        : null,
      page: start.line.page,
      lineText: start.line.text,
      before: neighbours.before,
      after: neighbours.after,
      start: start.offset,
      end: multiLine ? start.offset : end.offset,
      text,
      paragraph: false,
      multiLine,
    };
  }

  private selectionInside(selection: Selection): boolean {
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    return (
      anchor !== null && focus !== null && this.host.contains(anchor) && this.host.contains(focus)
    );
  }

  private emitSelection(reveal: boolean): void {
    if (this.disposed) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !this.selectionInside(selection)) return;
    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_SELECTION) {
      this.onContext(null, reveal);
      return;
    }
    const range = selection.getRangeAt(0);
    const context = this.contextForRange(range);
    this.onContext(context, reveal);
  }

  private emitParagraph(clientX: number, clientY: number): void {
    if (this.disposed) return;
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed) return;

    const doc = document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const point = doc.caretPositionFromPoint?.(clientX, clientY);
    let node: Node | null = point?.offsetNode ?? null;
    let offset = point?.offset ?? 0;
    if (!node && doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(clientX, clientY);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    }
    const start = this.locate(node, offset);
    if (!start) return;
    const neighbours = this.neighbours(start.line);
    this.onContext(
      {
        sourceRange: (() => {
          const token = lineTokenAt(start.line.text, start.offset);
          const word = token ? this.sourceMap?.wordAt(start.line.id, token.token.from) : null;
          return word ? { from: word.from, to: word.to } : null;
        })(),
        page: start.line.page,
        lineText: start.line.text,
        before: neighbours.before,
        after: neighbours.after,
        start: start.offset,
        end: start.offset,
        text: "",
        paragraph: true,
        multiLine: false,
      },
      true,
    );
  }

  /** Source and preview gestures share precisely the same accepted links. */
  rangesForSource(source: string, from: number, to: number): Range[] {
    if (this.disposed || source !== this.source || !this.sourceMap) return [];
    const ranges: Range[] = [];
    for (const part of this.sourceMap.partsForSource(from, to)) {
      const line = this.allLines[part.line];
      for (const entry of line.spans) {
        const lo = Math.max(part.from, entry.start),
          hi = Math.min(part.to, entry.start + (entry.span.textContent?.length ?? 0));
        if (hi <= lo || !entry.span.firstChild) continue;
        const range = document.createRange();
        range.setStart(entry.span.firstChild, lo - entry.start);
        range.setEnd(entry.span.firstChild, hi - entry.start);
        ranges.push(range);
      }
    }
    return ranges;
  }
}
