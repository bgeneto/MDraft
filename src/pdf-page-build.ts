//! Pure, file-aware PDF word matching; the viewer calls it in a worker.
import {
  createTypstPageMap,
  tokenizeWords,
  TypstPageMap,
  type PageMapLine,
  type SourceWord,
} from "./typst-page-map.ts";
import type { TypstSpanAnchor } from "./api";
import type { PdfSourceFile, PdfWordAnchor } from "./pdf-page-map";

const MATH_TOKENS = /[\p{L}\p{M}]+|[\p{N}]+/gu;

function normalizeMathToken(text: string): string {
  // Some TeX fonts map `\mu` to the micro sign in PDF's ToUnicode table.
  return text.normalize("NFC").replace(/\u00b5/g, "μ");
}

export async function buildPdfWordAnchors(
  language: "typst" | "latex",
  files: readonly PdfSourceFile[],
  lines: readonly PageMapLine[],
  spanMap?: readonly TypstSpanAnchor[],
): Promise<PdfWordAnchor[]> {
  if (!files.length) return [];
  if (language === "typst") {
    return buildTypstAnchors(files, lines, spanMap);
  }
  const { latexSourceContent, maskLatexConditionals } = await import("./latex-word-map.ts");
  const { maskLiteralRegions, referencesIn } = await import("./latex-references.ts");
  const available = new Map(files.map((file) => [file.path, file]));
  const pending = [files[0].path],
    reachable = new Set<string>();
  while (pending.length) {
    const name = pending.pop()!;
    if (reachable.has(name)) continue;
    const file = available.get(name);
    if (!file) continue;
    reachable.add(name);
    for (const ref of referencesIn(maskLiteralRegions(maskLatexConditionals(file.source)), name)) {
      if (ref.kind !== "input" && ref.kind !== "include") continue;
      const candidate = /\.tex$/i.test(ref.name) ? ref.name : `${ref.name}.tex`;
      if (available.has(candidate)) pending.push(candidate);
    }
  }
  let combined = "";
  const words: SourceWord[] = [];
  const ranges: Array<{ path: string; from: number; to: number }> = [];
  const mathCandidates: Array<{
    file: string;
    from: number;
    to: number;
    tokens: string[];
    scripted?: true;
    scriptedTokens?: string[];
  }> = [];
  for (const file of files.filter((entry) => reachable.has(entry.path))) {
    if (ranges.length) {
      // A sentinel prevents an anchor window joining unrelated project files.
      words.push({ text: "", norm: "\u0000", from: combined.length, to: combined.length });
      combined += "\n";
    }
    const base = combined.length;
    ranges.push({ path: file.path, from: base, to: base + file.source.length });
    const content = latexSourceContent(file.source, file.path);
    for (const word of content.words)
      words.push({ ...word, from: base + word.from, to: base + word.to });
    for (const expression of content.math) mathCandidates.push({ file: file.path, ...expression });
    combined += file.source;
  }
  const map = new TypstPageMap(combined, lines, words);
  const anchors: PdfWordAnchor[] = [];
  for (const part of map.scrollAnchors()) {
    let lo = 0,
      hi = ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ranges[mid].to < part.to) lo = mid + 1;
      else hi = mid;
    }
    const file = ranges[lo] && part.from >= ranges[lo].from ? ranges[lo] : undefined;
    if (file)
      anchors.push({
        ...part,
        file: file.path,
        from: part.from - file.from,
        to: part.to - file.from,
      });
  }
  const compareSource = (a: PdfWordAnchor, b: PdfWordAnchor) =>
    a.file.localeCompare(b.file) || a.from - b.from || a.to - b.to;
  // Most documents have no supported math. Avoid tokenizing the entire PDF a
  // second time, and avoid a second copy of its prose anchors, in that case.
  if (!mathCandidates.length) return anchors.sort(compareSource);

  const signatures = new Map<string, number>();
  const signature = (tokens: readonly string[]) => tokens.join("\u0001");
  const prepared = mathCandidates.map((candidate) => ({
    candidate,
    expected: candidate.tokens.map(normalizeMathToken),
    scripts: (candidate.scriptedTokens ?? []).map(normalizeMathToken),
  }));
  for (const { expected } of prepared) {
    const key = signature(expected);
    signatures.set(key, (signatures.get(key) ?? 0) + 1);
  }
  const eligible = prepared.filter(
    ({ expected }) => expected.length >= 2 && signatures.get(signature(expected)) === 1,
  );
  if (!eligible.length) return anchors.sort(compareSource);

  type MathProposal = { anchors: PdfWordAnchor[] };
  const proposals: MathProposal[] = [];
  const lineTokens = lines.map((pageLine) =>
    [...pageLine.text.matchAll(MATH_TOKENS)].map((match) => ({
      text: normalizeMathToken(match[0]),
      from: match.index ?? 0,
      to: (match.index ?? 0) + match[0].length,
    })),
  );
  const wantedTokens = new Set(eligible.flatMap(({ expected }) => expected));
  const frequencies = new Map<string, number>();
  for (const tokens of lineTokens)
    for (const token of tokens)
      if (wantedTokens.has(token.text))
        frequencies.set(token.text, (frequencies.get(token.text) ?? 0) + 1);
  const pivotFor = (tokens: readonly string[]): number => {
    let pivot = 0;
    for (let at = 1; at < tokens.length; at += 1)
      if ((frequencies.get(tokens[at]) ?? 0) < (frequencies.get(tokens[pivot]) ?? 0)) pivot = at;
    return pivot;
  };
  const searches = eligible.map((entry) => {
    let base: string[] | null = entry.scripts.length ? entry.expected.slice() : null;
    if (base) {
      for (const scripted of [...entry.scripts].reverse()) {
        const at = base.lastIndexOf(scripted);
        if (at < 0) {
          base = null;
          break;
        }
        base.splice(at, 1);
      }
      if (base && base.length < 2) base = null;
    }
    return {
      ...entry,
      fullPivot: pivotFor(entry.expected),
      base,
      basePivot: base ? pivotFor(base) : 0,
    };
  });
  // Index only the least frequent token of each search. Indexing every PDF
  // token duplicates a large prose document even when it has very little math.
  const pivots = new Set<string>();
  for (const search of searches) {
    pivots.add(search.expected[search.fullPivot]);
    if (search.base) pivots.add(search.base[search.basePivot]);
  }
  const occurrences = new Map<string, Array<{ line: number; at: number }>>();
  for (let line = 0; line < lineTokens.length; line += 1) {
    for (let at = 0; at < lineTokens[line].length; at += 1) {
      const token = lineTokens[line][at].text;
      if (!pivots.has(token)) continue;
      const bucket = occurrences.get(token) ?? [];
      bucket.push({ line, at });
      occurrences.set(token, bucket);
    }
  }

  for (const { candidate, expected, scripts, fullPivot, base, basePivot } of searches) {
    const matches: MathProposal[] = [];
    const baseAnchor = (
      line: number,
      first: { from: number },
      last: { to: number },
    ): PdfWordAnchor => ({
      file: candidate.file,
      from: candidate.from,
      to: candidate.to,
      line,
      start: first.from,
      end: last.to,
      region: lines[line].region,
      atomic: true,
    });
    const findSequence = (
      wanted: readonly string[],
      pivot: number,
      found: (line: number, at: number) => boolean,
    ): void => {
      for (const position of occurrences.get(wanted[pivot]) ?? []) {
        const line = position.line;
        const tokens = lineTokens[line];
        const at = position.at - pivot;
        if (at < 0 || at + wanted.length > tokens.length) continue;
        let accepts = true;
        for (let part = 0; part < wanted.length; part += 1) {
          if (tokens[at + part].text !== wanted[part]) {
            accepts = false;
            break;
          }
          if (part === 0) continue;
          const gap = lines[line].text.slice(tokens[at + part - 1].to, tokens[at + part].from);
          // Space-separated words alone do not prove formula ownership. Script
          // coefficients are allowed because PDF.js may normalize their layout.
          if (
            /^\s+$/u.test(gap) &&
            !(
              candidate.scripted &&
              (/^\p{N}+$/u.test(tokens[at + part - 1].text) ||
                /^\p{N}+$/u.test(tokens[at + part].text))
            )
          ) {
            accepts = false;
            break;
          }
        }
        if (accepts && found(line, at)) return;
      }
    };
    findSequence(expected, fullPivot, (line, at) => {
      const tokens = lineTokens[line];
      matches.push({ anchors: [baseAnchor(line, tokens[at], tokens[at + expected.length - 1])] });
      // A second occurrence already makes the source equation ambiguous.
      return matches.length > 1;
    });

    if (matches.length === 0 && base && scripts.length) {
      // Superscripts and subscripts can be emitted as a distinct PDF.js line.
      // Match the expression body first, then require each script token exactly
      // once in an immediately adjacent line of the same PDF reading region.
      findSequence(base, basePivot, (line, at) => {
        const tokens = lineTokens[line];
        const scriptParts: PdfWordAnchor[] = [];
        const neighbours = [line - 1, line + 1].filter(
          (next) => next >= 0 && next < lines.length && lines[next].region === lines[line].region,
        );
        for (const scriptedValue of scripts) {
          const found = neighbours.flatMap((next) =>
            lineTokens[next]
              .filter((token) => token.text === scriptedValue)
              .map((token) => ({ line: next, token })),
          );
          if (found.length !== 1) return false;
          const [{ line: scriptLine, token }] = found;
          scriptParts.push(baseAnchor(scriptLine, token, token));
        }
        matches.push({
          anchors: [baseAnchor(line, tokens[at], tokens[at + base.length - 1]), ...scriptParts],
        });
        return matches.length > 1;
      });
    }
    if (matches.length === 1) proposals.push(matches[0]);
  }
  // If two different source formulas claim overlapping PDF text, neither has
  // enough evidence to own that visual occurrence. Per line, track the two
  // furthest-ending intervals belonging to distinct proposals. Each interval
  // need only compare with the furthest interval from another proposal.
  const conflicted = new Set<number>();
  type OwnedInterval = { owner: number; start: number; end: number };
  const intervalsByLine = new Map<number, OwnedInterval[]>();
  for (let owner = 0; owner < proposals.length; owner += 1) {
    for (const part of proposals[owner].anchors) {
      const bucket = intervalsByLine.get(part.line) ?? [];
      bucket.push({ owner, start: part.start, end: part.end });
      intervalsByLine.set(part.line, bucket);
    }
  }
  for (const intervals of intervalsByLine.values()) {
    intervals.sort((a, b) => a.start - b.start || b.end - a.end);
    let first: OwnedInterval | undefined;
    let second: OwnedInterval | undefined;
    for (const current of intervals) {
      const other = first?.owner === current.owner ? second : first;
      if (other && other.end > current.start) {
        conflicted.add(other.owner);
        conflicted.add(current.owner);
      }
      if (first?.owner === current.owner) {
        if (current.end > first.end) first = current;
      } else if (second?.owner === current.owner) {
        if (current.end > second.end) second = current;
        if (first && second.end > first.end) [first, second] = [second, first];
      } else if (!first || current.end > first.end) {
        second = first;
        first = current;
      } else if (!second || current.end > second.end) {
        second = current;
      }
    }
  }
  const math = proposals.flatMap((proposal, index) =>
    conflicted.has(index) ? [] : proposal.anchors,
  );
  if (!math.length) return anchors.sort(compareSource);
  const mathByLine = new Map<number, Array<{ start: number; end: number }>>();
  for (const part of math) {
    const bucket = mathByLine.get(part.line) ?? [];
    bucket.push({ start: part.start, end: part.end });
    mathByLine.set(part.line, bucket);
  }
  for (const [line, intervals] of mathByLine) {
    intervals.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: Array<{ start: number; end: number }> = [];
    for (const interval of intervals) {
      const prior = merged[merged.length - 1];
      if (prior && interval.start <= prior.end) prior.end = Math.max(prior.end, interval.end);
      else merged.push({ ...interval });
    }
    mathByLine.set(line, merged);
  }
  const prose = anchors.filter((word) => {
    const intervals = mathByLine.get(word.line);
    if (!intervals) return true;
    let lo = 0,
      hi = intervals.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (intervals[mid].end <= word.start) lo = mid + 1;
      else hi = mid;
    }
    return lo === intervals.length || intervals[lo].start >= word.end;
  });
  return [...prose, ...math].sort(compareSource);
}

function normalizeTypstPath(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");
}

function resolveSpanFile(
  rawFile: string,
  files: readonly PdfSourceFile[],
  byNorm: ReadonlyMap<string, PdfSourceFile>,
): PdfSourceFile | null {
  const norm = normalizeTypstPath(rawFile);
  const direct = byNorm.get(norm);
  if (direct) return direct;
  let suffixMatch: PdfSourceFile | null = null;
  for (const file of files) {
    const fileNorm = normalizeTypstPath(file.path);
    if (!fileNorm) continue;
    if (fileNorm.endsWith(`/${norm}`) || norm.endsWith(`/${fileNorm}`)) {
      if (suffixMatch) return null;
      suffixMatch = file;
    }
  }
  if (suffixMatch) return suffixMatch;
  // Single-file untitled/default preview uses `path: ""`.
  if (files.length === 1 && files[0].path === "") return files[0];
  return null;
}

async function extractTypstProseWords(source: string): Promise<SourceWord[]> {
  const { typstParser } = await import("codemirror-lang-typst/lezer");
  const words: SourceWord[] = [];
  typstParser.parse(source).iterate({
    enter(node) {
      if (
        [
          "LetBinding",
          "SetRule",
          "ShowRule",
          "LineComment",
          "BlockComment",
          "Equation",
          "Raw",
          "Import",
          "Include",
        ].includes(node.name)
      ) {
        return false;
      }
      if (node.name === "Text") {
        for (const word of tokenizeWords(source.slice(node.from, node.to))) {
          words.push({ ...word, from: node.from + word.from, to: node.from + word.to });
        }
        return false;
      }
    },
  });
  return words;
}

function spanMatchesLine(anchor: TypstSpanAnchor, line: PageMapLine): boolean {
  if (line.yPt === undefined) return false;
  const lineHeight = Math.max(1, line.heightPt ?? 12);
  const lineTopPt = line.yPt - lineHeight;
  const lineBottomPt = line.yPt + lineHeight * 0.45;
  const anchorBaselinePt = anchor.yPt + anchor.heightPt * 0.85;
  const tolY = Math.max(lineHeight, anchor.heightPt) * 0.65;
  const verticalOk =
    Math.abs(line.yPt - anchorBaselinePt) <= tolY ||
    (anchor.yPt <= lineBottomPt + 2 && anchor.yPt + anchor.heightPt >= lineTopPt - 2);
  if (!verticalOk) return false;
  if (line.leftPt !== undefined && line.rightPt !== undefined) {
    return anchor.xPt <= line.rightPt + 6 && anchor.xPt + anchor.widthPt >= line.leftPt - 6;
  }
  return true;
}

function collectWordsInRanges(
  sortedWords: readonly SourceWord[],
  ranges: ReadonlyArray<{ start: number; end: number }>,
): SourceWord[] {
  const collected: SourceWord[] = [];
  const seenFrom = new Set<number>();
  for (const { start, end } of ranges) {
    let lo = 0;
    let hi = sortedWords.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedWords[mid].to <= start) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sortedWords.length && sortedWords[i].from < end; i += 1) {
      const word = sortedWords[i];
      if (!seenFrom.has(word.from)) {
        seenFrom.add(word.from);
        collected.push(word);
      }
    }
  }
  return collected.sort((a, b) => a.from - b.from);
}

function alignLineWordsWithSource(
  pdfWords: readonly SourceWord[],
  srcWords: readonly SourceWord[],
  minSpanStart: number,
  filePath: string,
  lineIdx: number,
  region: string,
): PdfWordAnchor[] {
  if (!pdfWords.length || !srcWords.length) return [];
  const matched: PdfWordAnchor[] = [];
  let srcCursor = 0;
  for (const pdfWord of pdfWords) {
    // Bounded lookahead tolerates inline markup/unmatched symbols inside a line
    // without skipping across unrelated paragraphs.
    const limit = Math.min(srcWords.length, srcCursor + 12);
    for (let j = srcCursor; j < limit; j += 1) {
      if (srcWords[j].norm === pdfWord.norm) {
        matched.push({
          file: filePath,
          from: srcWords[j].from,
          to: srcWords[j].to,
          line: lineIdx,
          start: pdfWord.from,
          end: pdfWord.to,
          region,
        });
        srcCursor = j + 1;
        break;
      }
    }
  }
  if (!matched.length) return [];
  // Single-word lines must anchor near the compiler's span start; longer lines
  // require at least two literally verified prose tokens.
  if (pdfWords.length === 1) {
    return Math.abs(matched[0].from - minSpanStart) <= 16 ? matched : [];
  }
  return matched.length >= 2 ? matched : [];
}

async function buildTypstAnchors(
  files: readonly PdfSourceFile[],
  lines: readonly PageMapLine[],
  spanMap?: readonly TypstSpanAnchor[],
): Promise<PdfWordAnchor[]> {
  if (!spanMap?.length) {
    const file = files[0];
    const map = await createTypstPageMap(file.source, lines);
    return map
      .scrollAnchors()
      .map((part) => ({ ...part, file: file.path }))
      .sort((a, b) => a.from - b.from || a.to - b.to);
  }

  const byNorm = new Map<string, PdfSourceFile>();
  for (const file of files) {
    const norm = normalizeTypstPath(file.path);
    if (norm) byNorm.set(norm, file);
  }
  const wordsByFile = new Map<PdfSourceFile, SourceWord[]>();
  const getFileWords = async (file: PdfSourceFile): Promise<SourceWord[]> => {
    const cached = wordsByFile.get(file);
    if (cached) return cached;
    const parsed = await extractTypstProseWords(file.source);
    wordsByFile.set(file, parsed);
    return parsed;
  };

  const spansByPage = new Map<number, TypstSpanAnchor[]>();
  for (const anchor of spanMap) {
    const bucket = spansByPage.get(anchor.page) ?? [];
    bucket.push(anchor);
    spansByPage.set(anchor.page, bucket);
  }
  for (const bucket of spansByPage.values()) {
    bucket.sort((a, b) => a.yPt - b.yPt || a.xPt - b.xPt);
  }

  const anchoredLines = new Set<number>();
  const spanAnchors: PdfWordAnchor[] = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx];
    if (line.page === undefined || line.yPt === undefined) continue;
    const pageSpans = spansByPage.get(line.page);
    if (!pageSpans?.length) continue;

    const matchingSpans = pageSpans.filter((anchor) => spanMatchesLine(anchor, line));
    if (!matchingSpans.length) continue;

    const byFile = new Map<PdfSourceFile, Array<{ start: number; end: number }>>();
    for (const anchor of matchingSpans) {
      const file = resolveSpanFile(anchor.file, files, byNorm);
      if (!file) continue;
      if (anchor.utf16End > file.source.length || anchor.utf16Start >= anchor.utf16End) continue;
      const list = byFile.get(file) ?? [];
      list.push({ start: anchor.utf16Start, end: anchor.utf16End });
      byFile.set(file, list);
    }
    if (!byFile.size) continue;

    const pdfWords = tokenizeWords(line.text);
    if (!pdfWords.length) continue;

    let best: PdfWordAnchor[] = [];
    for (const [file, ranges] of byFile) {
      const fileWords = await getFileWords(file);
      const srcWords = collectWordsInRanges(fileWords, ranges);
      const minStart = ranges.reduce((m, r) => Math.min(m, r.start), Number.POSITIVE_INFINITY);
      const aligned = alignLineWordsWithSource(
        pdfWords,
        srcWords,
        minStart,
        file.path,
        lineIdx,
        line.region,
      );
      if (aligned.length > best.length) best = aligned;
    }
    if (best.length) {
      anchoredLines.add(lineIdx);
      spanAnchors.push(...best);
    }
  }

  if (anchoredLines.size < lines.length) {
    const primary = files[0];
    const fallbackMap = await createTypstPageMap(primary.source, lines);
    for (const part of fallbackMap.scrollAnchors()) {
      if (!anchoredLines.has(part.line)) {
        spanAnchors.push({ ...part, file: primary.path });
      }
    }
  }

  return spanAnchors.sort((a, b) =>
    a.file === b.file ? a.from - b.from || a.to - b.to : a.file.localeCompare(b.file),
  );
}
