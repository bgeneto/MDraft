//! A capped word-level diff for the panel's Changes view.
//!
//! The result is display-only: the only text that can be applied is the model's
//! answer. Keeping this module free of DOM and Tauri imports lets
//! `scripts/ai-unit.mjs` test it under Node.

export type DiffKind = "same" | "added" | "removed";

export interface DiffPart {
  value: string;
  kind: DiffKind;
}

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * Compare two passages word by word.
 *
 * Above the token cap the answer is still useful but an LCS would allocate a
 * matrix they do not need: show the whole before and after instead. The cap is
 * per side, so two 1,200-token passages produce a 1.44M-cell matrix.
 */
export function wordDiff(before: string, after: string, cap = 1200): DiffPart[] {
  if (before === after) {
    return before ? [{ value: before, kind: "same" }] : [];
  }
  const left = tokenize(before);
  const right = tokenize(after);
  if (left.length > cap || right.length > cap) {
    return [
      ...(before ? [{ value: before, kind: "removed" as const }] : []),
      ...(after ? [{ value: after, kind: "added" as const }] : []),
    ];
  }

  const columns = right.length + 1;
  const table = new Uint32Array((left.length + 1) * columns);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * columns + j] =
        left[i] === right[j]
          ? table[(i + 1) * columns + j + 1] + 1
          : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const append = (value: string, kind: DiffKind) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) {
      last.value += value;
      return;
    }
    parts.push({ value, kind });
  };

  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      append(left[i], "same");
      i++;
      j++;
    } else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) {
      append(left[i], "removed");
      i++;
    } else {
      append(right[j], "added");
      j++;
    }
  }
  while (i < left.length) append(left[i++], "removed");
  while (j < right.length) append(right[j++], "added");
  return parts;
}

/** Word counts for the Changes header. */
export function diffSummary(parts: readonly DiffPart[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const words = part.value.trim() ? part.value.trim().split(/\s+/).length : 0;
    if (part.kind === "added") added += words;
    if (part.kind === "removed") removed += words;
  }
  return { added, removed };
}
