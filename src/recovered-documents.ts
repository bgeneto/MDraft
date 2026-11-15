//! Keep restored copies in their inbox until saved or explicitly discarded.

import type { BackupBuffer, RecoveredItem } from "./api";
import { captureBackupDocuments, textFromString } from "./backup.ts";
import type { RecoveryScheduler } from "./recovery";
import type { Session } from "./sessions";

export interface RecoveredRevisionApi {
  begin(inbox: string, document: string, transfer: string): Promise<void>;
  append(transfer: string, sequence: number, bytes: Uint8Array): Promise<number>;
  finish(transfer: string, sequences: number, bytes: number): Promise<void>;
  cancel(transfer: string): Promise<void>;
  forget(inbox: string, document: string, token: string): Promise<void>;
}

export interface RecoveredScheduler extends RecoveryScheduler {
  attach(session: Session, item: RecoveredItem): void;
  has(session: Session): boolean;
  contains(item: RecoveredItem): boolean;
}

export function createRecoveredScheduler(
  ordinary: RecoveryScheduler,
  api: RecoveredRevisionApi,
  notify: (message: string) => void,
  newId: () => string,
): RecoveredScheduler {
  const attached = new Map<string, RecoveredItem>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, string>();
  const queues = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();

  function cancelTimer(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
  }

  function enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    queues.set(id, next);
    void next.then(
      () => {
        if (queues.get(id) === next) queues.delete(id);
      },
      () => {
        if (queues.get(id) === next) queues.delete(id);
      },
    );
    return next;
  }

  async function write(session: Session, item: RecoveredItem, text: string): Promise<void> {
    const transfer = newId();
    const metadata: BackupBuffer = {
      id: item.document.id,
      name: session.name,
      language: session.language,
      path: null,
      lineEnding: session.lineEnding,
      hadBom: session.hadBom,
      encoding: session.encoding,
      lossy: session.lossy,
      readOnly: session.readOnly,
      baseModifiedMs: 0,
      baseSize: 0,
      baseSha256: null,
    };
    let begun = false;
    try {
      await captureBackupDocuments(
        transfer,
        [{ metadata, text: textFromString(text) }],
        {
          begin: async () => {
            await api.begin(item.inboxId, item.document.id, transfer);
            begun = true;
          },
          append: (_job, _id, sequence, bytes) => api.append(transfer, sequence, bytes),
          finish: (_job, _id, sequences, bytes) => api.finish(transfer, sequences, bytes),
        },
        () => false,
      );
      begun = false;
    } finally {
      if (begun) await api.cancel(transfer).catch(() => undefined);
    }
  }

  async function flush(session: Session, content?: string): Promise<void> {
    const item = attached.get(session.id);
    if (!item) return ordinary.flush(session, content);
    cancelTimer(session.id);
    const text = content ?? pending.get(session.id);
    pending.delete(session.id);
    if (text === undefined) return;
    const generation = generations.get(session.id) ?? 0;
    try {
      await enqueue(session.id, async () => {
        if ((generations.get(session.id) ?? 0) !== generation) return;
        await write(session, item, text);
      });
    } catch (error) {
      notify(
        `Could not update the recovered copy of “${session.name}”. Its last verified revision was kept: ${String(error)}`,
      );
    }
  }

  async function forget(session: Session): Promise<void> {
    const item = attached.get(session.id);
    if (!item) return ordinary.forget(session);
    cancelTimer(session.id);
    pending.delete(session.id);
    generations.set(session.id, (generations.get(session.id) ?? 0) + 1);
    try {
      await enqueue(session.id, () => api.forget(item.inboxId, item.document.id, newId()));
      attached.delete(session.id);
    } catch (error) {
      notify(`Could not clear the recovered copy of “${session.name}”: ${String(error)}`);
    }
  }

  return {
    attach(session, item) {
      attached.set(session.id, item);
    },
    has(session) {
      return attached.has(session.id);
    },
    contains(item) {
      return Array.from(attached.values()).some(
        (value) => value.inboxId === item.inboxId && value.document.id === item.document.id,
      );
    },
    schedule(session, text) {
      if (!attached.has(session.id)) return ordinary.schedule(session, text);
      pending.set(session.id, text);
      cancelTimer(session.id);
      timers.set(
        session.id,
        setTimeout(() => {
          void flush(session);
        }, 700),
      );
    },
    flush,
    forget,
    async flushAll(sessions) {
      await Promise.all(Array.from(sessions, (session) => flush(session)));
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      ordinary.dispose();
    },
  };
}
