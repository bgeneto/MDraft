//! The live-preview client for the render workers.
//!
//! One worker per engine — Markdown and AsciiDoc — so a Markdown session never
//! downloads or parses Asciidoctor. Each worker keeps one render in flight and
//! one pending; a newer edit replaces the pending job, so a burst of keystrokes
//! cannot queue a dozen full renders. A superseded caller stops without doing
//! work; only a worker that cannot run falls back to the synchronous pipeline.

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

class Channel {
  private worker: Worker | null = null;
  private broken = false;
  private running = false;
  private current: Pending | null = null;
  private currentId = 0;
  private nextId = 1;
  private pending: Pending | null = null;

  constructor(private readonly create: () => Worker) {}

  request(source: string, options: unknown): Promise<AsyncRender<unknown>> {
    if (this.broken) return Promise.resolve({ kind: "fallback" });
    return new Promise((resolve) => {
      // Only the newest pending job matters. The replaced caller stops without
      // running a stale render on the main thread; only a worker failure falls
      // back.
      if (this.pending) this.pending.resolve({ kind: "superseded" });
      this.pending = { source, options, resolve };
      this.pump();
    });
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
      this.worker = this.create();
      this.worker.onmessage = (event: MessageEvent<Reply>) => {
        const reply = event.data;
        if (!reply || reply.id !== this.currentId) return;
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
      this.worker.onerror = () => this.failAll();
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
    instance.postMessage({ id: this.currentId, source: job.source, options: job.options });
  }
}

const markdown = new Channel(
  () => new Worker(new URL("./preview-worker.ts", import.meta.url), { type: "module" }),
);
const asciidoc = new Channel(
  () => new Worker(new URL("./asciidoc-worker.ts", import.meta.url), { type: "module" }),
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
