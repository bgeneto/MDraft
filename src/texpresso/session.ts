//! One TeXpresso preview for one LaTeX project and engine.
//!
//! MDraft's project, never TeXpresso's: the files come from the same snapshot
//! WasmTex compiles, the edits come from the editor's own change sets, and the
//! frame acknowledges each with the length and hash of the text it now holds.
//! A divergence resends the file; a frame that stops answering is resynced,
//! then restarted once, then given up for WasmTex, and each step is reported.

import { TexpressoFrame, type ReadyInfo } from "./frame";
import { textPrint, type Held, type PreparedProject } from "./project";
import {
  textHash,
  type EditChange,
  type FrameMessage,
  type HostMessage,
  type SyncFile,
  type TexpressoEngine,
  type TexpressoProblem,
  type TexpressoTheme,
} from "./protocol";

/** An edit or a project sync not acknowledged in this long starts the recovery. */
const ACK_BUDGET_MS = 4000;
const WATCHDOG_TICK_MS = 1000;

export interface TexpressoProjectKey {
  rootPath: string;
  engine: TexpressoEngine;
}

export interface TexpressoHandlers {
  onReady(session: TexpressoSession, info: ReadyInfo): void;
  onMessage(session: TexpressoSession, message: FrameMessage): void;
  /** The frame failed and its restart failed too: fall back to WasmTex. */
  onBroken(session: TexpressoSession, reason: string): void;
  /** A recovery step, for the status line and the measurements. */
  onRecovery(session: TexpressoSession, step: "resync" | "restart"): void;
  /** The live buffer of a project file, LF-normalised, or null when not open. */
  currentText(rootDirectory: string, path: string): string | null;
  theme(): TexpressoTheme;
  zoom(): number;
  reference(): number;
}

/** The project preparation stays importable without the frame (`texpresso-unit`). */
export { normaliseText, prepareProject } from "./project";
export type { PreparedProject } from "./project";

export class TexpressoSession {
  frame: TexpressoFrame;
  info: ReadyInfo | null = null;
  /** The engine is typesetting; false once the whole document is done. */
  busy = true;
  problems: TexpressoProblem[] = [];
  /** The edit sequence the last paint reflects, and when it was sent. */
  lastPainted = 0;
  readonly sentAt = new Map<number, number>();
  /** Edits held by manual compile mode, by file. */
  held = false;
  private dirty = new Set<string>();
  private files = new Map<string, Held>();
  private project: PreparedProject | null = null;
  private active: string | null = null;
  private outstanding = new Map<number, { at: number; file: string; expect: number }>();
  private recoveries = 0;
  private restarted = false;
  private watchdog = 0;
  private queued: Array<() => void> = [];
  broken = false;

  constructor(
    private readonly host: HTMLElement,
    readonly key: TexpressoProjectKey,
    readonly rootDirectory: string,
    private readonly handlers: TexpressoHandlers,
  ) {
    this.frame = this.start();
    this.watchdog = window.setInterval(() => this.check(), WATCHDOG_TICK_MS);
  }

  private start(): TexpressoFrame {
    const frame = new TexpressoFrame(this.host, this.key.engine, (message) =>
      this.receive(frame, message),
    );
    frame.ready.then(
      (info) => {
        if (frame !== this.frame) return;
        this.info = info;
        frame.post({
          type: "init",
          theme: this.handlers.theme(),
          zoom: this.handlers.zoom(),
          reference: this.handlers.reference(),
        });
        this.handlers.onReady(this, info);
        if (this.project) this.sendProject(this.project, true);
        for (const work of this.queued.splice(0)) work();
      },
      (error: unknown) => {
        if (frame !== this.frame || this.broken) return;
        this.fail(String(error instanceof Error ? error.message : error));
      },
    );
    return frame;
  }

  get ready(): boolean {
    return this.info !== null && !this.broken;
  }

  /** Run `work` now when the frame is up, else once it is; only the latest of a kind is kept. */
  private whenReady(work: () => void): void {
    if (this.ready) work();
    else this.queued.push(work);
  }

  /**
   * Bring the frame's project to `prepared`: only files whose fingerprint
   * changed are sent, binaries as transferred buffers, removals by name.
   */
  sync(prepared: PreparedProject, active: string | null): void {
    this.project = prepared;
    this.active = active;
    if (!this.ready) return;
    this.sendProject(prepared, false);
  }

  private sendProject(prepared: PreparedProject, replace: boolean): void {
    const files: SyncFile[] = [];
    const transfer: Transferable[] = [];
    for (const [path, file] of prepared.files) {
      // The freshest text: an open tab may have moved on since the snapshot.
      let text = file.text;
      let fingerprint = file.fingerprint;
      if (text !== undefined) {
        const live = this.handlers.currentText(this.rootDirectory, path);
        if (live !== null) {
          text = live;
          fingerprint = textPrint(live);
        }
      }
      if (!replace && this.files.get(path)?.fingerprint === fingerprint) continue;
      if (this.held && text !== undefined && this.files.has(path)) {
        // Manual mode: a changed text file waits for Compile like an edit does.
        this.dirty.add(path);
        continue;
      }
      if (file.bytes) {
        const copy = file.bytes.slice();
        files.push({ path, bytes: copy.buffer });
        transfer.push(copy.buffer);
      } else files.push({ path, text });
      this.files.set(path, { fingerprint });
      this.dirty.delete(path);
    }
    const remove = [...this.files.keys()].filter((path) => !prepared.files.has(path));
    for (const path of remove) this.files.delete(path);
    if (!replace && !files.length && !remove.length) {
      if (this.active) this.frame.post({ type: "open", file: this.active });
      return;
    }
    const seq = this.frame.post(
      {
        type: "project",
        main: prepared.main,
        files,
        remove,
        replace,
        active: this.active,
        compile: replace,
      },
      transfer,
    );
    this.outstanding.set(seq, {
      at: performance.now(),
      file: this.active ?? prepared.main,
      expect: -1,
    });
  }

  /** The file the reader is editing; the frame opens it for the source map. */
  open(path: string | null): void {
    this.active = path;
    if (path) this.whenReady(() => this.frame.post({ type: "open", file: path }));
  }

  /**
   * Forward one editor transaction. `base` is the document length before it,
   * `after` the text after it (the host already holds it). The answer is what
   * happened, for the status surface and the CDP layer: an edit the frame did
   * not receive is invisible in the DOM otherwise.
   */
  edit(
    path: string,
    base: number,
    changes: EditChange[],
    after: string,
  ): "sent" | "resent" | "held" | "unknown-file" | "not-ready" {
    if (!this.files.has(path)) return "unknown-file";
    if (!this.ready) return "not-ready";
    if (this.held) {
      this.dirty.add(path);
      return "held";
    }
    // The frame's copy is not the text these changes apply to (a tab swap, a
    // reload from disk): send the result instead of the changes.
    if (!this.files.get(path)?.fingerprint.startsWith(`t${base}:`)) {
      this.resend(path, after);
      return "resent";
    }
    const seq = this.frame.post({ type: "edit", file: path, base, changes });
    this.sentAt.set(seq, performance.now());
    this.outstanding.set(seq, { at: performance.now(), file: path, expect: textHash(after) });
    this.files.set(path, { fingerprint: textPrint(after) });
    this.busy = true;
    return "sent";
  }

  /** Manual mode: hold edits until Compile, or send what was held. */
  hold(on: boolean): void {
    this.held = on;
    if (!on) this.flush();
  }

  /** Send every held file in full. */
  flush(): void {
    if (!this.ready) return;
    for (const path of this.dirty) this.resend(path);
    this.dirty.clear();
  }

  private resend(path: string, known?: string): void {
    const text = known ?? this.handlers.currentText(this.rootDirectory, path);
    if (text === null) return;
    const seq = this.frame.post({ type: "text", file: path, text });
    this.sentAt.set(seq, performance.now());
    this.outstanding.set(seq, { at: performance.now(), file: path, expect: textHash(text) });
    this.files.set(path, { fingerprint: textPrint(text) });
  }

  post(message: HostMessage): number | null {
    if (!this.ready) return null;
    return this.frame.post(message);
  }

  request(message: HostMessage, ms: number) {
    return this.ready ? this.frame.request(message, ms) : Promise.resolve(null);
  }

  private receive(frame: TexpressoFrame, message: FrameMessage): void {
    if (frame !== this.frame || this.broken) return;
    switch (message.type) {
      case "ack": {
        const sent = this.outstanding.get(message.seq);
        this.outstanding.delete(message.seq);
        // Anything older than an acknowledged message was answered too.
        for (const seq of this.outstanding.keys())
          if (seq < message.seq) this.outstanding.delete(seq);
        this.recoveries = 0;
        if (!sent || message.length < 0) break;
        const current = this.handlers.currentText(this.rootDirectory, message.file);
        // Compare against what the host holds now: an ack for an older edit
        // is not a divergence while newer edits are still in flight.
        const newer = [...this.outstanding.values()].some((item) => item.file === message.file);
        if (!newer && current !== null && textHash(current) !== message.hash)
          this.resend(message.file);
        break;
      }
      case "status":
        this.busy = message.busy;
        if (message.problems) this.problems = message.problems;
        break;
      case "painted":
        this.lastPainted = Math.max(this.lastPainted, message.seq);
        break;
      default:
        break;
    }
    this.handlers.onMessage(this, message);
  }

  /** The watchdog: resync, then restart once, then give up for WasmTex. */
  private check(): void {
    if (this.broken || !this.ready) return;
    const now = performance.now();
    const late = [...this.outstanding.values()].some((item) => now - item.at > ACK_BUDGET_MS);
    if (!late) return;
    this.outstanding.clear();
    this.recoveries += 1;
    if (this.recoveries === 1 && this.project) {
      this.handlers.onRecovery(this, "resync");
      this.files.clear();
      this.sendProject(this.project, true);
      return;
    }
    if (!this.restarted) {
      this.restarted = true;
      this.handlers.onRecovery(this, "restart");
      this.restart();
      return;
    }
    this.fail("The TeXpresso preview stopped responding.");
  }

  private restart(): void {
    const old = this.frame;
    this.info = null;
    this.files.clear();
    this.recoveries = 0;
    void old.dispose();
    this.frame = this.start();
  }

  private fail(reason: string): void {
    if (this.broken) return;
    this.broken = true;
    this.handlers.onBroken(this, reason);
  }

  async dispose(): Promise<void> {
    window.clearInterval(this.watchdog);
    this.broken = true;
    this.queued = [];
    await this.frame.dispose();
  }
}
