//! The live-preview client for the render workers.
//!
//! One worker per engine — Markdown and AsciiDoc — so a Markdown session never
//! downloads or parses Asciidoctor. Each worker keeps one render in flight and
//! one pending; a newer render supersedes the active one, so stale work cannot
//! hold up the latest buffer. A superseded caller stops without falling back;
//! only a worker that cannot run uses the synchronous pipeline.

import type { AsciidocChunks, AsciidocWorkerOptions } from "./asciidoc-render";
import type { ChunkOptions, PreviewChunks } from "./preview-render";

export type AsyncRender<T> =
  { kind: "ok"; data: T } | { kind: "fallback" } | { kind: "superseded" };

interface Reply {
  id: number;
  ok: boolean;
  data?: unknown;
}

interface Pending {
  source: string;
  options: unknown;
  resolve: (result: AsyncRender<unknown>) => void;
}

export class PreviewWorkerChannel {
  private worker: Worker | null = null;
  private broken = false;
  private running = false;
  private current: Pending | null = null;
  private currentId = 0;
  private nextId = 1;
  private pending: Pending | null = null;

  private readonly create: () => Worker;
  private readonly validData: (data: unknown) => boolean;

  constructor(
    create: () => Worker,
    validData: (data: unknown) => boolean = (data) => data != null,
  ) {
    this.create = create;
    this.validData = validData;
  }

  request(source: string, options: unknown): Promise<AsyncRender<unknown>> {
    if (this.broken) return Promise.resolve({ kind: "fallback" });
    return new Promise((resolve) => {
      // Only the newest pending job matters. The replaced caller stops without
      // running a stale render on the main thread; only a worker failure falls
      // back.
      if (this.pending) this.pending.resolve({ kind: "superseded" });
      this.pending = { source, options, resolve };
      this.cancelCurrent();
      this.pump();
    });
  }

  /** Drop work owned by an older edit, document, or view mode. */
  cancel(): void {
    this.cancelCurrent();
    this.pending?.resolve({ kind: "superseded" });
    this.pending = null;
  }

  private cancelCurrent(): void {
    if (!this.current) return;
    this.current.resolve({ kind: "superseded" });
    this.current = null;
    this.running = false;
    this.worker?.terminate();
    this.worker = null;
  }

  private failAll(): void {
    this.broken = true;
    this.current?.resolve({ kind: "fallback" });
    this.pending?.resolve({ kind: "fallback" });
    this.current = null;
    this.pending = null;
    this.running = false;
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    try {
      const instance = this.create();
      this.worker = instance;
      instance.onmessage = (event: MessageEvent<Reply>) => {
        if (this.worker !== instance) return;
        const reply = event.data;
        if (!reply || typeof reply.id !== "number" || typeof reply.ok !== "boolean") {
          this.failAll();
          return;
        }
        if (reply.id < this.currentId) return;
        if (reply.id !== this.currentId) {
          this.failAll();
          return;
        }
        if (reply.ok && !this.validData(reply.data)) {
          this.failAll();
          return;
        }
        const job = this.current;
        this.current = null;
        this.running = false;
        if (reply.ok && reply.data !== undefined) {
          job?.resolve({ kind: "ok", data: reply.data });
        } else {
          // A render error is not a broken worker: fall back for this request
          // and keep the worker for the next one. The synchronous path reports
          // the same failure with a stack in the console.
          job?.resolve({ kind: "fallback" });
        }
        this.pump();
      };
      instance.onerror = () => {
        if (this.worker === instance) this.failAll();
      };
      instance.onmessageerror = () => {
        if (this.worker === instance) this.failAll();
      };
    } catch {
      this.broken = true;
      this.worker = null;
    }
    return this.worker;
  }

  private pump(): void {
    if (this.running) return;
    const job = this.pending;
    if (!job) return;
    this.pending = null;
    const instance = this.ensureWorker();
    if (!instance) {
      job.resolve({ kind: "fallback" });
      this.failAll();
      return;
    }
    this.running = true;
    this.current = job;
    this.currentId = this.nextId++;
    try {
      instance.postMessage({ id: this.currentId, source: job.source, options: job.options });
    } catch {
      this.failAll();
    }
  }
}

// Validate the envelope without walking every fragment of a large document on
// the UI thread. Invalid replies must not reach the DOM code or wedge the queue.
function validMarkdownData(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<PreviewChunks>;
  return (
    Array.isArray(data.chunks) &&
    typeof data.hasRawHtml === "boolean" &&
    Array.isArray(data.codes) &&
    Array.isArray(data.maths) &&
    (data.legacyImages === undefined ||
      (data.legacyImages !== null &&
        typeof data.legacyImages === "object" &&
        !Array.isArray(data.legacyImages))) &&
    (data.fragments === undefined || Array.isArray(data.fragments)) &&
    (data.lines === null || Array.isArray(data.lines)) &&
    (data.elementLines === undefined ||
      data.elementLines === null ||
      Array.isArray(data.elementLines))
  );
}

function validAsciidocData(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<AsciidocChunks>;
  return (
    Array.isArray(data.chunks) &&
    Array.isArray(data.marks) &&
    typeof data.hasHeader === "boolean" &&
    typeof data.notitle === "boolean"
  );
}

const markdown = new PreviewWorkerChannel(
  () => new Worker(new URL("./preview-worker.ts", import.meta.url), { type: "module" }),
  validMarkdownData,
);
const asciidoc = new PreviewWorkerChannel(
  () => new Worker(new URL("./asciidoc-worker.ts", import.meta.url), { type: "module" }),
  validAsciidocData,
);

/** Render Markdown off the main thread, or report that the caller must fall back. */
export function renderChunksAsync(
  source: string,
  options: ChunkOptions,
): Promise<AsyncRender<PreviewChunks>> {
  return markdown.request(source, options) as Promise<AsyncRender<PreviewChunks>>;
}

/** Render AsciiDoc off the main thread, or report that the caller must fall back. */
export function renderAsciidocChunksAsync(
  source: string,
  options: AsciidocWorkerOptions,
): Promise<AsyncRender<AsciidocChunks>> {
  return asciidoc.request(source, options) as Promise<AsyncRender<AsciidocChunks>>;
}

/** Stop hidden or superseded previews without invoking the synchronous fallback. */
export function cancelPreviewWorkers(): void {
  markdown.cancel();
  asciidoc.cancel();
}
