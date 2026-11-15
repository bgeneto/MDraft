//! Capture immutable editor text without constructing a whole-archive buffer.

import type { BackupBuffer } from "./api.ts";

/** A CodeMirror Text value or a small adapter around an already-owned string. */
export interface BackupText {
  readonly length: number;
  sliceString(from: number, to: number): string;
}

export interface BackupDocument {
  metadata: BackupBuffer;
  text: BackupText;
}

export interface BackupSink {
  begin(jobId: string, metadata: BackupBuffer): Promise<void>;
  append(jobId: string, id: string, sequence: number, bytes: Uint8Array): Promise<number>;
  finish(jobId: string, id: string, sequences: number, bytes: number): Promise<void>;
}

// At most 32 Ki UTF-16 units: even four-byte UTF-8 stays inside Rust's 256 KiB
// IPC limit. Do not split a surrogate pair at a chunk boundary.
const CHUNK_UNITS = 32 * 1024;

export function textFromString(value: string): BackupText {
  return { length: value.length, sliceString: (from, to) => value.slice(from, to) };
}

function highSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function lowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (highSurrogate(code)) {
      if (index + 1 >= value.length || !lowSurrogate(value.charCodeAt(index + 1))) return false;
      index += 1;
    } else if (lowSurrogate(code)) return false;
  }
  return true;
}

/** Every acknowledgement is checked before the next chunk is sent. */
export async function captureBackupDocuments(
  jobId: string,
  documents: readonly BackupDocument[],
  sink: BackupSink,
  canceled: () => boolean,
): Promise<void> {
  const encoder = new TextEncoder();
  for (const document of documents) {
    if (canceled()) throw new Error("The backup was canceled.");
    await sink.begin(jobId, document.metadata);
    let position = 0;
    let sequence = 0;
    let total = 0;
    while (position < document.text.length) {
      if (canceled()) throw new Error("The backup was canceled.");
      let end = Math.min(position + CHUNK_UNITS, document.text.length);
      if (end < document.text.length) {
        const left = document.text.sliceString(end - 1, end).charCodeAt(0);
        const right = document.text.sliceString(end, end + 1).charCodeAt(0);
        if (highSurrogate(left) && lowSurrogate(right)) end -= 1;
      }
      const text = document.text.sliceString(position, end);
      if (!validUnicode(text)) {
        throw new Error(`“${document.metadata.name}” contains text that cannot be saved as UTF-8.`);
      }
      const bytes = encoder.encode(text);
      const acknowledged = await sink.append(jobId, document.metadata.id, sequence, bytes);
      total += bytes.length;
      if (acknowledged !== total)
        throw new Error("An unsaved document was not captured completely.");
      position = end;
      sequence += 1;
    }
    await sink.finish(jobId, document.metadata.id, sequence, total);
  }
}
