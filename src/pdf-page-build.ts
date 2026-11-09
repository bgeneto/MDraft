//! Pure, file-aware PDF word matching; the viewer calls it in a worker.
import {
  createTypstPageMap,
  TypstPageMap,
  type PageMapLine,
  type SourceWord,
} from "./typst-page-map.ts";
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
): Promise<PdfWordAnchor[]> {
  if (!files.length) return [];
  if (language === "typst") {
    const file = files[0];
    const map = await createTypstPageMap(file.source, lines);
    return map
      .scrollAnchors()
      .map((part) => ({ ...part, file: file.path }))
      .sort((a, b) => a.from - b.from || a.to - b.to);
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
