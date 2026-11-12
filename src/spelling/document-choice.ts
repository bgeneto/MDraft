//! Persisted dictionary choices use the same path identity as document tabs.

import { pathKey } from "../sessions.ts";

export interface DocumentChoice {
  path: string;
  language: string;
}

export function pathSpellingChoice(entries: readonly DocumentChoice[], path: string): string {
  const key = pathKey(path);
  return entries.find((entry) => pathKey(entry.path) === key)?.language ?? "follow";
}

export function rememberPathSpellingChoice(
  entries: readonly DocumentChoice[],
  path: string,
  choice: string,
): DocumentChoice[] {
  const key = pathKey(path);
  const next = entries.filter((entry) => pathKey(entry.path) !== key);
  if (choice !== "follow") next.push({ path, language: choice });
  return next.slice(-100);
}
