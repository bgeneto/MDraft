//! The live-preview client for the render workers.
//!
//! One worker per engine — Markdown and AsciiDoc — so a Markdown session never
//! downloads or parses Asciidoctor. Each worker keeps one render in flight and
//! one pending; a newer render supersedes the active one, so stale work cannot
//! hold up the latest buffer. A superseded caller stops without falling back;
//! only a worker that cannot run uses the synchronous pipeline.

import type { AsciidocChunks, AsciidocWorkerOptions } from "./asciidoc-render";
import type { PrimeKatexEntry } from "./katex-cache";
import type { ChunkOptions, PreviewChunks } from "./preview-render";

export type AsyncRender<T> =
  { kind: "ok"; data: T } | { kind: "fallback" } | { kind: "superseded" };

export interface PreviewWorkerChannelOptions {
  /** Idle delay (ms) after a successful render before pre-warming a spare standby worker. */
  standbyWarmupMs?: number;
  /** Idle timeout (ms) after which an unused standby worker is terminated cleanly. */
  standbyIdleReapMs?: number;
}

export interface PreviewWorkerChannelStats {
  requests: number;
  preemptions: number;
  standbyWarmups: number;
  standbyPromotions: number;
  warmedKatexEntries: number;
  hasStandby: boolean;
}

interface Reply {
  id: number;
  ok: boolean;
  kind?: "warmed";
  data?: unknown;
}

interface Pending {
  source: string;
  options: unknown;
  resolve: (result: AsyncRender<unknown>) => void;
}

const MAX_RETAINED_KATEX = 2000;
const DEFAULT_STANDBY_WARMUP_MS = 24;
const DEFAULT_STANDBY_IDLE_REAP_MS = 30_000;

function unrefTimer(handle: ReturnType<typeof setTimeout>): void {
  (handle as unknown as { unref?: () => void }).unref?.();
}

export class PreviewWorkerChannel {
  private worker: Worker | null = null;
  private standby: Worker | null = null;
  private broken = false;
  private running = false;
  private current: Pending | null = null;
  private currentId = 0;
  private nextId = 1;
  private pending: Pending | null = null;

  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private idleReapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly warmupMs: number;
  private readonly idleReapMs: number;
  private readonly retainedKatex = new Map<string, PrimeKatexEntry>();
  private katexGeneration = 0;
  private standbyKatexGeneration = -1;

  private requestsCount = 0;
  private preemptionsCount = 0;
  private standbyWarmupsCount = 0;
  private standbyPromotionsCount = 0;

  private readonly create: () => Worker;
  private readonly validData: (data: unknown) => boolean;

  constructor(
    create: () => Worker,
    validData: (data: unknown) => boolean = (data) => data != null,
    options: PreviewWorkerChannelOptions = {},
  ) {
    this.create = create;
    this.validData = validData;
    this.warmupMs = options.standbyWarmupMs ?? DEFAULT_STANDBY_WARMUP_MS;
    this.idleReapMs = options.standbyIdleReapMs ?? DEFAULT_STANDBY_IDLE_REAP_MS;
  }

  request(source: string, options: unknown): Promise<AsyncRender<unknown>> {
    if (this.broken) return Promise.resolve({ kind: "fallback" });
    this.requestsCount += 1;
    this.clearWarmupTimer();
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
    this.clearWarmupTimer();
    this.cancelCurrent();
    this.clearStandby();
    this.pending?.resolve({ kind: "superseded" });
    this.pending = null;
  }

  /** Telemetry snapshot for benchmarks and diagnostics. */
  stats(): PreviewWorkerChannelStats {
    return {
      requests: this.requestsCount,
      preemptions: this.preemptionsCount,
      standbyWarmups: this.standbyWarmupsCount,
      standbyPromotions: this.standbyPromotionsCount,
      warmedKatexEntries: this.retainedKatex.size,
      hasStandby: this.standby !== null,
    };
  }

  private cancelCurrent(): void {
    if (!this.current) return;
    this.preemptionsCount += 1;
    this.current.resolve({ kind: "superseded" });
    this.current = null;
    this.running = false;
    // Terminate only the in-flight worker so stale synchronous parses (e.g.
    // Asciidoctor .convert()) cannot burn UI-concurrent CPU (audit F06). The
    // next pump() promotes the pre-warmed, cache-hydrated standby worker in ~0 ms.
    this.worker?.terminate();
    this.worker = null;
  }

  private failAll(): void {
    this.broken = true;
    this.clearWarmupTimer();
    this.clearStandby();
    this.current?.resolve({ kind: "fallback" });
    this.pending?.resolve({ kind: "fallback" });
    this.current = null;
    this.pending = null;
    this.running = false;
    this.worker?.terminate();
    this.worker = null;
  }

  private clearWarmupTimer(): void {
    if (this.warmupTimer !== null) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
  }

  private clearIdleReapTimer(): void {
    if (this.idleReapTimer !== null) {
      clearTimeout(this.idleReapTimer);
      this.idleReapTimer = null;
    }
  }

  private clearStandby(): void {
    this.clearIdleReapTimer();
    if (this.standby) {
      this.standby.terminate();
      this.standby = null;
    }
    this.standbyKatexGeneration = -1;
  }

  private resetIdleReap(): void {
    this.clearIdleReapTimer();
    if (!this.standby || !Number.isFinite(this.idleReapMs) || this.idleReapMs <= 0) return;
    this.idleReapTimer = setTimeout(() => {
      this.idleReapTimer = null;
      this.clearStandby();
    }, this.idleReapMs);
    unrefTimer(this.idleReapTimer);
  }

  private retainMathsFrom(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const maths = (data as { maths?: unknown }).maths;
    if (!Array.isArray(maths) || maths.length === 0) return;
    let added = false;
    for (const rawEntry of maths) {
      if (!rawEntry || typeof rawEntry !== "object") continue;
      const entry = rawEntry as Partial<PrimeKatexEntry>;
      if (
        typeof entry.body !== "string" ||
        typeof entry.display !== "boolean" ||
        (entry.html == null && entry.error == null)
      ) {
        continue;
      }
      const key = `${entry.display ? "D" : "I"}\u0000${entry.body}`;
      if (this.retainedKatex.has(key)) {
        this.retainedKatex.delete(key);
      } else {
        added = true;
        if (this.retainedKatex.size >= MAX_RETAINED_KATEX) {
          const oldest = this.retainedKatex.keys().next().value;
          if (oldest !== undefined) this.retainedKatex.delete(oldest);
        }
      }
      this.retainedKatex.set(key, {
        body: entry.body,
        display: entry.display,
        html: entry.html ?? null,
        error: entry.error ?? null,
      });
    }
    if (added) this.katexGeneration += 1;
  }

  private scheduleStandbyWarmup(): void {
    this.clearWarmupTimer();
    if (this.broken || !Number.isFinite(this.warmupMs) || this.warmupMs < 0) return;
    if (this.standby && this.standbyKatexGeneration === this.katexGeneration) {
      this.resetIdleReap();
      return;
    }
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;
      this.warmStandbyNow();
    }, this.warmupMs);
    unrefTimer(this.warmupTimer);
  }

  private warmStandbyNow(): void {
    if (this.broken) return;
    if (!this.standby) {
      try {
        const spare = this.create();
        this.standby = spare;
        this.standbyWarmupsCount += 1;
        this.standbyKatexGeneration = -1;
        spare.onmessage = () => {
          // Warmup ack arrives asynchronously; keep standby ready.
        };
        spare.onerror = () => {
          if (this.standby === spare) this.clearStandby();
        };
        spare.onmessageerror = () => {
          if (this.standby === spare) this.clearStandby();
        };
      } catch {
        // Standby warmup failure never disables the primary channel.
        this.standby = null;
        return;
      }
    }
    if (this.standbyKatexGeneration !== this.katexGeneration || this.standbyKatexGeneration < 0) {
      try {
        const primeKatex =
          this.retainedKatex.size > 0 ? Array.from(this.retainedKatex.values()) : undefined;
        this.standby.postMessage({ id: 0, kind: "warmup", primeKatex });
        this.standbyKatexGeneration = this.katexGeneration;
      } catch {
        this.clearStandby();
        return;
      }
    }
    this.resetIdleReap();
  }

  private attachActiveHandlers(instance: Worker): void {
    instance.onmessage = (event: MessageEvent<Reply>) => {
      if (this.worker !== instance) return;
      const reply = event.data;
      if (!reply || typeof reply.id !== "number" || typeof reply.ok !== "boolean") {
        this.failAll();
        return;
      }
      // Ignore late warmup acknowledgements from a newly promoted standby worker.
      if (reply.kind === "warmed") return;
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
        this.retainMathsFrom(reply.data);
        job?.resolve({ kind: "ok", data: reply.data });
        this.scheduleStandbyWarmup();
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
  }

  private ensureWorker(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    if (this.standby) {
      const promoted = this.standby;
      this.standby = null;
      this.clearIdleReapTimer();
      this.standbyKatexGeneration = -1;
      this.standbyPromotionsCount += 1;
      this.worker = promoted;
      this.attachActiveHandlers(promoted);
      // Warm another spare after the promoted job finishes cleanly.
      return this.worker;
    }
    try {
      const instance = this.create();
      this.worker = instance;
      this.attachActiveHandlers(instance);
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
    typeof data.notitle === "boolean" &&
    (data.maths === undefined || Array.isArray(data.maths)) &&
    (data.mathRendered === undefined || typeof data.mathRendered === "boolean")
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

/** Snapshot warm standby and preemption statistics for Markdown and AsciiDoc workers. */
export function previewWorkerStats(): {
  markdown: PreviewWorkerChannelStats;
  asciidoc: PreviewWorkerChannelStats;
} {
  return {
    markdown: markdown.stats(),
    asciidoc: asciidoc.stats(),
  };
}
