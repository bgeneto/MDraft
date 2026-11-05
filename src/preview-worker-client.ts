//! The live-preview client for the render worker.
//!
//! One worker per application, one render in flight and one pending. A newer
//! edit replaces the pending job, so a burst of keystrokes cannot queue a dozen
//! full renders; the worker finishes the job it has and starts the newest one.
//! A superseded caller stops without doing work; only a worker that cannot run
//! falls back to the synchronous pipeline.

import type { ChunkOptions, PreviewChunks } from "./preview-render";

export type AsyncRender =
  { kind: "ok"; data: PreviewChunks } | { kind: "fallback" } | { kind: "superseded" };

interface Job {
  source: string;
  options: ChunkOptions;
  resolve: (result: AsyncRender) => void;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  data?: PreviewChunks;
}

let worker: Worker | null = null;
let broken = false;
let running = false;
let current: Job | null = null;
let pending: Job | null = null;
let nextId = 1;
let currentId = 0;

function settle(job: Job | null, result: AsyncRender): void {
  if (job) job.resolve(result);
}

function failAll(): void {
  broken = true;
  settle(current, { kind: "fallback" });
  settle(pending, { kind: "fallback" });
  current = null;
  pending = null;
  running = false;
  worker?.terminate();
  worker = null;
}

function ensureWorker(): Worker | null {
  if (worker || broken) return worker;
  try {
    worker = new Worker(new URL("./preview-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (!reply || reply.id !== currentId) return;
      const job = current;
      current = null;
      running = false;
      if (reply.ok && reply.data) {
        settle(job, { kind: "ok", data: reply.data });
      } else {
        // A render error is not a broken worker: fall back for this request and
        // keep the worker for the next one. The synchronous path will report the
        // same failure with a stack in the console.
        settle(job, { kind: "fallback" });
      }
      pump();
    };
    worker.onerror = () => failAll();
  } catch {
    broken = true;
    worker = null;
  }
  return worker;
}

function pump(): void {
  if (running) return;
  const job = pending;
  if (!job) return;
  pending = null;
  const instance = ensureWorker();
  if (!instance) {
    settle(job, { kind: "fallback" });
    failAll();
    return;
  }
  running = true;
  current = job;
  currentId = nextId++;
  instance.postMessage({
    id: currentId,
    source: job.source,
    options: { math: job.options.math ?? true, map: job.options.map ?? false },
  });
}

/** Render off the main thread, or report that the caller must fall back. */
export function renderChunksAsync(source: string, options: ChunkOptions): Promise<AsyncRender> {
  if (broken) return Promise.resolve({ kind: "fallback" });
  return new Promise((resolve) => {
    // Only the newest pending job matters. The replaced caller stops without
    // running a stale render on the main thread; only a worker failure falls
    // back.
    settle(pending, { kind: "superseded" });
    pending = { source, options, resolve };
    pump();
  });
}
