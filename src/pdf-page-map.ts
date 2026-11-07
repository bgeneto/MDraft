//! Serializable PDF/source word links. Geometry and DOM ranges stay in the viewer.

import { tokenizeWords, type PageMapLine } from "./typst-page-map.ts";

export interface PdfSourceFile {
  path: string;
  source: string;
}

export interface PdfWordAnchor {
  file: string;
  from: number;
  to: number;
  line: number;
  start: number;
  end: number;
  region: string;
  /** A whole verified equation maps as one source/PDF selection. */
  atomic?: true;
}

export interface PdfSourceRange {
  file: string;
  from: number;
  to: number;
  atomic?: true;
}

/** The same accepted word links answer source and PDF gestures. */
export class PdfPageMap {
  private readonly byLine = new Map<number, PdfWordAnchor[]>();
  private readonly byFile = new Map<string, PdfWordAnchor[]>();

  private readonly lines: readonly PageMapLine[];
  private readonly strict: boolean;

  constructor(lines: readonly PageMapLine[], anchors: readonly PdfWordAnchor[], strict: boolean) {
    this.lines = lines;
    this.strict = strict;
    this.add(anchors);
  }

  add(anchors: readonly PdfWordAnchor[]): void {
    for (const anchor of anchors) {
      const line = this.byLine.get(anchor.line) ?? [];
      line.push(anchor);
      this.byLine.set(anchor.line, line);
      const file = this.byFile.get(anchor.file) ?? [];
      file.push(anchor);
      this.byFile.set(anchor.file, file);
    }
  }

  wordAt(line: number, offset: number, bias: "start" | "end" = "start"): PdfWordAnchor | null {
    return (
      this.byLine
        .get(line)
        ?.find((part) =>
          bias === "start"
            ? offset >= part.start && offset < part.end
            : offset > part.start && offset <= part.end,
        ) ?? null
    );
  }

  sourceRange(
    startLine: number,
    start: number,
    endLine: number,
    end: number,
  ): PdfSourceRange | null {
    const first = this.wordAt(startLine, start);
    const last = this.wordAt(endLine, end, "end");
    if (
      !first ||
      !last ||
      first.file !== last.file ||
      first.region !== last.region ||
      first.from > last.from
    )
      return null;
    if (this.strict) {
      let previous = first.from;
      for (let line = startLine; line <= endLine; line += 1) {
        const item = this.lines[line];
        if (!item || item.region !== first.region) return null;
        const lo = line === startLine ? start : 0;
        const hi = line === endLine ? end : item.text.length;
        for (const word of tokenizeWords(item.text)) {
          if (word.to <= lo || word.from >= hi) continue;
          const part = this.wordAt(line, word.from);
          if (!part || part.file !== first.file || part.from < previous || part.to > last.to)
            return null;
          previous = part.from;
        }
      }
    }
    return {
      file: first.file,
      from: first.from,
      to: last.to,
      ...(first.atomic && last.atomic ? { atomic: true as const } : {}),
    };
  }

  atomicAtSource(file: string, offset: number): PdfSourceRange | null {
    const parts = this.byFile.get(file) ?? [];
    let lo = 0,
      hi = parts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (parts[mid].to <= offset) lo = mid + 1;
      else hi = mid;
    }
    for (let at = lo; at < parts.length && parts[at].from <= offset; at += 1) {
      const part = parts[at];
      if (part.atomic && part.from <= offset && offset <= part.to)
        return { file: part.file, from: part.from, to: part.to, atomic: true };
    }
    return null;
  }

  partsForSource(file: string, from: number, to: number): PdfWordAnchor[] {
    const parts = this.byFile.get(file) ?? [];
    let lo = 0,
      hi = parts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (parts[mid].to <= from) lo = mid + 1;
      else hi = mid;
    }
    const result: PdfWordAnchor[] = [];
    for (let at = lo; at < parts.length && parts[at].from < to; at += 1) result.push(parts[at]);
    return result;
  }

  /** Merge ordinary punctuation and spaces, but never paint intervening TeX syntax. */
  sourceSegments(
    file: string,
    from: number,
    to: number,
    source: string,
  ): Array<{ from: number; to: number }> {
    const segments: Array<{ from: number; to: number }> = [];
    for (const part of this.partsForSource(file, from, to)) {
      const last = segments[segments.length - 1];
      if (last && part.from <= last.to) last.to = Math.max(last.to, part.to);
      else if (last && /^[\s.,:;!?'"’“”()\-–—]*$/u.test(source.slice(last.to, part.from)))
        last.to = part.to;
      else segments.push({ from: part.from, to: part.to });
    }
    return segments;
  }
}
