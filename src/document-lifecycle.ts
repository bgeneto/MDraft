//! Document operations own a session and a revision, never the current tab.

import type { CheckedWrite, DocumentPayload, FileStat } from "./api";
import type { RecoveryScheduler } from "./recovery";
import type { Session, SessionStore } from "./sessions";
import { pathKey } from "./sessions.ts";
import { classifyDiskChange } from "./disk-change.ts";

export type UnsavedDecision = "save" | "discard" | "cancel";

export interface DocumentLifecycleDeps {
  sessions: SessionStore;
  text(session: Session): string;
  read(path: string): Promise<DocumentPayload>;
  stat(path: string): Promise<FileStat>;
  write(
    path: string,
    text: string,
    eol: string,
    bom: boolean,
    expected: string | null,
  ): Promise<CheckedWrite>;
  recovery: Pick<RecoveryScheduler, "schedule" | "forget" | "flush">;
  choosePath(session: Session, suggested?: string): Promise<string | null>;
  decide(session: Session, count: number): Promise<UnsavedDecision>;
  replace(session: Session, payload: DocumentPayload): void;
  adoptPath(session: Session, path: string): void;
  changed(session: Session, pathChanged?: boolean): void;
  conflict(session: Session, kind: "modified" | "deleted" | null): void;
  notify(message: string): void;
  committing(active: boolean): void;
}

export function createDocumentLifecycle(deps: DocumentLifecycleDeps) {
  const chains = new Map<string, Promise<unknown>>();
  const busy = new Map<string, number>();
  const generations = new Map<string, number>();
  const warned = new Set<string>();
  let polling = false;
  let closing = false;
  let committing = false;

  const exists = (s: Session) => deps.sessions.byId(s.id) === s;
  const generation = (s: Session) => generations.get(s.id) ?? 0;
  const snapshot = (s: Session) => ({
    session: s,
    path: s.path,
    revision: s.revision,
    text: deps.text(s),
    baseline: s.savedContent,
    modifiedMs: s.modifiedMs,
    size: s.size,
    sha256: s.sha256,
    generation: generation(s),
  });
  type Snapshot = ReturnType<typeof snapshot>;
  const current = (before: Snapshot) => {
    const s = before.session;
    return (
      exists(s) &&
      s.path === before.path &&
      s.revision === before.revision &&
      s.savedContent === before.baseline &&
      s.modifiedMs === before.modifiedMs &&
      s.size === before.size &&
      s.sha256 === before.sha256 &&
      generation(s) === before.generation &&
      deps.text(s) === before.text
    );
  };
  const isBusy = (s: Session) => (busy.get(s.id) ?? 0) > 0;

  async function queue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    chains.set(key, result);
    try {
      return await result;
    } finally {
      if (chains.get(key) === result) chains.delete(key);
    }
  }

  function run(s: Session, task: () => Promise<boolean>): Promise<boolean> {
    if (!exists(s) || committing) return Promise.resolve(false);
    generations.set(s.id, generation(s) + 1);
    busy.set(s.id, (busy.get(s.id) ?? 0) + 1);
    return queue(`session:${s.id}`, async () => (exists(s) ? task() : false)).finally(() => {
      const left = (busy.get(s.id) ?? 1) - 1;
      if (left) busy.set(s.id, left);
      else busy.delete(s.id);
    });
  }

  async function idle(s: Session): Promise<void> {
    while (chains.has(`session:${s.id}`)) {
      await chains.get(`session:${s.id}`)?.catch(() => undefined);
    }
  }

  async function journal(s: Session): Promise<void> {
    s.dirty = deps.text(s) !== s.savedContent;
    if (s.dirty) await deps.recovery.flush(s, deps.text(s));
    else await deps.recovery.forget(s);
    // Editing can continue while recovery IPC settles.
    if (exists(s) && deps.text(s) !== s.savedContent) {
      s.dirty = true;
      deps.recovery.schedule(s, deps.text(s));
    }
  }

  async function saveJob(s: Session, as: boolean, automatic: boolean, suggested?: string) {
    if (s.lossy && automatic) {
      if (!warned.has(s.id)) {
        warned.add(s.id);
        deps.notify(`Auto Save paused for "${s.name}": save its recovered text as a UTF-8 copy.`);
      }
      return false;
    }
    const copy = as || !s.path || s.lossy;
    const sourcePath = s.path;
    const target = copy ? await deps.choosePath(s, suggested) : sourcePath;
    if (!target || !exists(s) || s.path !== sourcePath) return false;
    const samePath = s.path !== null && pathKey(s.path) === pathKey(target);
    if (s.lossy && samePath) {
      deps.notify("Choose a different filename for the UTF-8 copy; the original is protected.");
      return false;
    }

    return queue(`path:${pathKey(target)}`, async () => {
      if (!exists(s) || s.path !== sourcePath) return false;
      // An open target can become dirty during the write. Refusing the collision
      // avoids deleting another tab on the strength of an earlier confirmation.
      const other = deps.sessions.findByPath(target);
      if (other && other !== s) {
        deps.notify(
          `"${other.name}" is already open. Choose another filename or close that tab first.`,
        );
        return false;
      }
      if (samePath) {
        const before = snapshot(s);
        const stat = await deps.stat(target);
        if (
          !exists(s) ||
          s.path !== before.path ||
          s.savedContent !== before.baseline ||
          s.modifiedMs !== before.modifiedMs ||
          s.size !== before.size ||
          s.sha256 !== before.sha256
        )
          return false;
        const change =
          !stat.exists && s.modifiedMs === 0 ? "unchanged" : classifyDiskChange(s, stat);
        if (change !== "unchanged") {
          deps.conflict(s, change);
          return false;
        }
        if (stat.readOnly) {
          deps.notify(`"${s.name}" is read-only. Use Save As to keep a copy.`);
          return false;
        }
      }
      // Capture after the preflight: typing during stat is included; typing
      // during write remains newer than this exact disk snapshot. The expected
      // hash belongs to the same-path revision; Save As has no baseline.
      const text = deps.text(s);
      const info = await deps.write(
        target,
        text,
        s.lineEnding || "\n",
        s.hadBom,
        samePath ? s.sha256 : null,
      );
      if (!exists(s) || s.path !== sourcePath) return false;
      if (!info.written) {
        deps.conflict(s, info.change === "deleted" ? "deleted" : "modified");
        return false;
      }
      const collision = deps.sessions.findByPath(target);
      if (collision && collision !== s) {
        deps.conflict(collision, "modified");
        deps.notify(
          "The copy was written, but its target was opened meanwhile. Both buffers were kept.",
        );
        return false;
      }
      if (!samePath) {
        deps.adoptPath(s, target);
        s.revision += 1;
        s.lossy = false;
        s.readOnly = false;
      }
      s.savedContent = text;
      s.modifiedMs = info.modifiedMs;
      s.size = info.size;
      s.sha256 = info.sha256;
      s.conflict = null;
      await journal(s);
      deps.changed(s, !samePath);
      return true;
    });
  }

  const save = (s: Session, automatic = false) => run(s, () => saveJob(s, false, automatic));
  const saveAs = (s: Session, suggested?: string) =>
    run(s, () => saveJob(s, true, false, suggested));

  async function reload(s: Session): Promise<boolean> {
    return run(s, async () => {
      if (!s.path) return false;
      const decisionSnapshot = snapshot(s);
      if (s.dirty) {
        const decision = await deps.decide(s, 1);
        if (!current(decisionSnapshot) || decision === "cancel") return false;
        if (decision === "save" && (!(await saveJob(s, false, false)) || s.dirty)) return false;
      }
      const before = snapshot(s);
      const payload = await deps.read(s.path!);
      if (!current(before)) {
        deps.notify("The document changed while reloading; your edits were kept.");
        return false;
      }
      deps.replace(s, payload);
      await journal(s);
      deps.changed(s);
      return true;
    });
  }

  async function poll(): Promise<void> {
    if (polling || committing) return;
    polling = true;
    try {
      for (const s of deps.sessions.list()) {
        if (!s.path || isBusy(s)) continue;
        const before = snapshot(s);
        try {
          const stat = await deps.stat(before.path!);
          if (!current(before) || isBusy(s)) continue;
          const change = classifyDiskChange(s, stat);
          if (change === "unchanged") {
            deps.conflict(s, null);
            continue;
          }
          if (change === "deleted") {
            deps.conflict(s, "deleted");
            continue;
          }
          const payload = await deps.read(before.path!);
          if (!current(before) || isBusy(s)) {
            if (exists(s) && s.path === before.path && s.dirty && !isBusy(s)) {
              deps.conflict(s, "modified");
            }
            continue;
          }
          if (payload.content === deps.text(s)) {
            s.savedContent = payload.content;
            s.modifiedMs = payload.modifiedMs;
            s.size = payload.size;
            s.sha256 = payload.sha256;
            s.lineEnding = payload.lineEnding;
            s.hadBom = payload.hadBom;
            s.readOnly = payload.readOnly;
            s.conflict = null;
          } else if (!s.dirty) deps.replace(s, payload);
          else {
            deps.conflict(s, "modified");
            continue;
          }
          await journal(s);
          deps.changed(s);
        } catch {
          // A failed read (including a replacement with binary data) must not
          // make the old text look current or authorize a later overwrite.
          if (current(before)) deps.conflict(s, "modified");
        }
      }
    } finally {
      polling = false;
    }
  }

  async function close(
    targets: readonly Session[],
    finalize: (ready: () => boolean) => boolean | Promise<boolean>,
    wholeWindow = false,
  ): Promise<boolean> {
    if (closing) return false;
    closing = true;
    const approved: Snapshot[] = [];
    let completed = false;
    const initial = deps.sessions.list();
    const ready = () =>
      approved.every(current) &&
      (!wholeWindow || (deps.sessions.list().length === initial.length && initial.every(exists)));
    try {
      for (const s of targets) {
        await idle(s);
        if (!exists(s)) return false;
        let before = snapshot(s);
        if (s.dirty) {
          const decision = await deps.decide(s, targets.filter((t) => t.dirty).length);
          if (!current(before) || decision === "cancel") return false;
          if (decision === "save") {
            if (!(await save(s)) || s.dirty) return false;
            before = snapshot(s);
          }
        }
        approved.push(before);
      }
      if (!ready()) return false;
      committing = true;
      deps.committing(true);
      for (const s of targets) await deps.recovery.forget(s);
      if (!ready()) return false;
      completed = await finalize(ready);
      return completed;
    } finally {
      committing = false;
      deps.committing(false);
      // Cancellation after cleanup must immediately restore protection for any
      // edits that invalidated a closing decision, including background edits.
      for (const s of targets) {
        if (!completed && exists(s) && deps.text(s) !== s.savedContent) {
          s.dirty = true;
          await deps.recovery.flush(s, deps.text(s));
        }
      }
      closing = false;
    }
  }

  return {
    save,
    saveAs,
    reload,
    poll,
    close,
    idle,
    snapshot,
    current,
    get committing() {
      return committing;
    },
  };
}
