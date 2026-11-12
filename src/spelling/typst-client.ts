//! One in-flight Typst parse and at most one newer request per editor plugin.

type Ranges = Array<[number, number]>;
interface WorkerLike {
  onmessage:
    ((event: MessageEvent<{ id: number; ranges?: Ranges; error?: string }>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(value: unknown): void;
  terminate(): void;
}
interface Request {
  id: number;
  source: string;
  resolve(value: Ranges | null): void;
  reject(error: Error): void;
}

export class TypstRangeClient {
  private worker: WorkerLike | null = null;
  private active: Request | null = null;
  private queued: Request | null = null;
  private nextId = 0;
  private closed = false;
  private readonly createWorker: () => WorkerLike;

  constructor(
    createWorker: () => WorkerLike = () =>
      new Worker(new URL("./typst-worker.ts", import.meta.url), { type: "module" }),
  ) {
    this.createWorker = createWorker;
  }

  request(source: string): Promise<Ranges | null> {
    if (this.closed) return Promise.reject(new Error("Typst spelling is unavailable."));
    return new Promise((resolve, reject) => {
      this.queued?.resolve(null);
      this.queued = { id: ++this.nextId, source, resolve, reject };
      this.start();
    });
  }

  private start(): void {
    if (this.active || !this.queued || this.closed) return;
    try {
      if (!this.worker) {
        this.worker = this.createWorker();
        this.worker.onmessage = (event) => {
          const active = this.active;
          if (!active || event.data.id !== active.id) return;
          this.active = null;
          if (event.data.error) active.reject(new Error(event.data.error));
          else if (
            Array.isArray(event.data.ranges) &&
            event.data.ranges.every(
              (range, index, ranges) =>
                Array.isArray(range) &&
                range.length === 2 &&
                Number.isInteger(range[0]) &&
                Number.isInteger(range[1]) &&
                range[0] >= 0 &&
                range[0] < range[1] &&
                range[1] <= active.source.length &&
                (index === 0 || ranges[index - 1][1] <= range[0]),
            )
          )
            active.resolve(event.data.ranges);
          else active.reject(new Error("Invalid Typst spelling result."));
          this.start();
        };
        this.worker.onerror = () => this.fail();
      }
      this.active = this.queued;
      this.queued = null;
      this.worker.postMessage({ id: this.active.id, source: this.active.source });
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    const error = new Error("Typst spelling is unavailable.");
    this.active?.reject(error);
    this.queued?.reject(error);
    this.active = null;
    this.queued = null;
    this.worker?.terminate();
    this.worker = null;
    this.closed = true;
  }

  destroy(): void {
    this.closed = true;
    this.active?.resolve(null);
    this.queued?.resolve(null);
    this.active = null;
    this.queued = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
