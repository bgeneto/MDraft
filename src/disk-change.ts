//! What the disk says about a session's file.
//!
//! Kept pure and free of Tauri so the policy can be checked without an
//! application. The shell combines it with the reader's choice; this module
//! only answers the factual question.

import type { FileStat } from "./api";
import type { Session } from "./sessions";

export type DiskChangeKind = "unchanged" | "modified" | "deleted";

export type DiskSession = Pick<Session, "path" | "modifiedMs" | "size">;

/**
 * Compare a session's remembered disk revision with the current stat.
 *
 * `mtime` plus size is enough for the first pass. A same-millisecond rewrite of
 * identical size is indistinguishable without reading the file, and the
 * consequence is a benign Reload/Keep prompt rather than silent loss.
 */
export function classifyDiskChange(session: DiskSession, stat: FileStat): DiskChangeKind {
  if (!session.path) return "unchanged";
  if (!stat.exists) return "deleted";
  if (stat.modifiedMs === session.modifiedMs && stat.size === session.size) {
    return "unchanged";
  }
  return "modified";
}
