//! The TeXpresso iframe: its origin, its messages, its lifetime.
//!
//! The frame is served by `src-tauri/src/latex_texpresso.rs` on MDraft's own
//! `mdraft-tex` scheme, so it has an origin of its own, its own storage, and a
//! CSP that cannot reach the network. It gets no `allow` attribute.

import {
  parseFrameMessage,
  PROTOCOL_VERSION,
  type FrameMessage,
  type HostMessage,
  type TexpressoEngine,
} from "./protocol";

/** `mdraft-tex` on this platform, as src/latex.ts builds it for the SDK. */
export function texpressoOrigin(): string {
  return navigator.userAgent.includes("Windows")
    ? `${location.protocol}//mdraft-tex.localhost`
    : "mdraft-tex://localhost";
}

export interface ReadyInfo {
  engine: TexpressoEngine;
  jspi: boolean;
  missing: string[];
}

type Reply = Extract<FrameMessage, { seq: number }>;

export class TexpressoFrame {
  readonly element: HTMLIFrameElement;
  readonly ready: Promise<ReadyInfo>;
  private readonly origin = texpressoOrigin();
  private seq = 0;
  private waiting = new Map<number, (reply: Reply | null) => void>();
  private disposed = false;
  private readonly listener = (event: MessageEvent): void => this.receive(event);

  constructor(
    host: HTMLElement,
    readonly engine: TexpressoEngine,
    private readonly onMessage: (message: FrameMessage) => void,
    bootTimeoutMs = 45_000,
  ) {
    const frame = document.createElement("iframe");
    frame.className = "texpresso-frame";
    frame.title = "LaTeX preview";
    frame.referrerPolicy = "no-referrer";
    const query = new URLSearchParams({ engine, host: location.origin });
    frame.src = `${this.origin}/texpresso/index.html?${query}`;
    this.element = frame;
    let resolveReady: (info: ReadyInfo) => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    this.ready = new Promise<ReadyInfo>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // A frame that never reports is a frame that failed; the caller falls back.
    const timer = window.setTimeout(
      () => rejectReady(new Error("The TeXpresso preview did not start.")),
      bootTimeoutMs,
    );
    this.readyHooks = {
      resolve: (info) => {
        window.clearTimeout(timer);
        resolveReady(info);
      },
      reject: (error) => {
        window.clearTimeout(timer);
        rejectReady(error);
      },
    };
    // Unhandled until someone awaits it; a rejection here is reported there.
    this.ready.catch(() => {});
    window.addEventListener("message", this.listener);
    host.append(frame);
  }

  private readyHooks: { resolve(info: ReadyInfo): void; reject(error: Error): void };

  /** Post a message; returns its sequence number. */
  post(message: HostMessage, transfer: Transferable[] = []): number {
    const seq = ++this.seq;
    if (this.disposed) return seq;
    this.element.contentWindow?.postMessage(
      { v: PROTOCOL_VERSION, seq, ...message },
      this.origin,
      transfer,
    );
    return seq;
  }

  /** Post and wait for the reply that names this message, or null after `ms`. */
  request(message: HostMessage, ms: number, transfer: Transferable[] = []): Promise<Reply | null> {
    const seq = this.post(message, transfer);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.waiting.delete(seq);
        resolve(null);
      }, ms);
      this.waiting.set(seq, (reply) => {
        window.clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  private receive(event: MessageEvent): void {
    if (this.disposed) return;
    // Both checks: another frame of the same origin must not speak for this one.
    if (event.source !== this.element.contentWindow || event.origin !== this.origin) {
      // Evidence, not noise: a message from the frame that fails these checks is
      // exactly what a broken bridge looks like from here, and the CDP layer
      // reads `data-texpresso-drop` instead of guessing.
      this.drop(
        event.source === this.element.contentWindow ? `origin ${event.origin}` : "other source",
        event.data,
      );
      return;
    }
    const message = parseFrameMessage(event.data);
    if (!message) {
      this.drop("unparsed", event.data);
      return;
    }
    if (message.type === "ready") {
      this.readyHooks.resolve(message);
      return;
    }
    if ("seq" in message && typeof message.seq === "number") {
      const waiter = this.waiting.get(message.seq);
      if (waiter) {
        this.waiting.delete(message.seq);
        waiter(message as Reply);
      }
    }
    this.onMessage(message);
  }

  /** Record why a frame message was dropped, bounded and without its content. */
  private drop(reason: string, data: unknown): void {
    const type =
      typeof data === "object" && data !== null && "type" in data
        ? String((data as { type: unknown }).type)
        : "?";
    document.documentElement.dataset.texpressoDrop = `${reason}:${type}`;
    console.warn(`[texpresso] dropped a frame message (${reason}:${type})`);
  }

  /**
   * Empty the frame's project, then remove the frame. The bridge removes the
   * copies of the reader's files at once; the next frame's start deletes the
   * whole project database.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.request({ type: "dispose" }, 400);
    this.disposed = true;
    window.removeEventListener("message", this.listener);
    for (const waiter of this.waiting.values()) waiter(null);
    this.waiting.clear();
    this.readyHooks.reject(new Error("disposed"));
    this.element.remove();
  }
}
