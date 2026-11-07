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
  let anchors: PdfWordAnchor[] = [];
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
  const signatures = new Map<string, number>();
  const signature = (tokens: readonly string[]) => tokens.join("\u0001");
  for (const candidate of mathCandidates) {
    const key = signature(candidate.tokens.map(normalizeMathToken));
    signatures.set(key, (signatures.get(key) ?? 0) + 1);
  }
  type MathProposal = { anchors: PdfWordAnchor[] };
  const proposals: MathProposal[] = [];
  const lineTokens = lines.map((pageLine) =>
    [...pageLine.text.matchAll(MATH_TOKENS)].map((match) => ({
      text: normalizeMathToken(match[0]),
      from: match.index ?? 0,
      to: (match.index ?? 0) + match[0].length,
    })),
  );
  for (const candidate of mathCandidates) {
    const expected = candidate.tokens.map(normalizeMathToken);
    const key = signature(expected);
    // A single variable or number is too common to establish equation ownership.
    if (candidate.tokens.length < 2 || signatures.get(key) !== 1) continue;
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
    const sequenceAt = (
      line: number,
      tokens: (typeof lineTokens)[number],
      wanted: readonly string[],
    ): number[] => {
      const found: number[] = [];
      for (let at = 0; at + wanted.length <= tokens.length; at += 1) {
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
        if (accepts) found.push(at);
      }
      return found;
    };
    for (let line = 0; line < lines.length; line += 1) {
      const tokens = lineTokens[line];
      for (const at of sequenceAt(line, tokens, expected)) {
        matches.push({ anchors: [baseAnchor(line, tokens[at], tokens[at + expected.length - 1])] });
      }
    }

    if (matches.length === 0 && candidate.scriptedTokens?.length) {
      // Superscripts and subscripts can be emitted as a distinct PDF.js line.
      // Match the expression body first, then require each script token exactly
      // once in an immediately adjacent line of the same PDF reading region.
      const baseExpected = expected.slice();
      let removable = true;
      for (const scripted of [...candidate.scriptedTokens].reverse().map(normalizeMathToken)) {
        const at = baseExpected.lastIndexOf(scripted);
        if (at < 0) {
          removable = false;
          break;
        }
        baseExpected.splice(at, 1);
      }
      if (!removable || baseExpected.length < 2) continue;
      for (let line = 0; line < lines.length; line += 1) {
        const tokens = lineTokens[line];
        for (const at of sequenceAt(line, tokens, baseExpected)) {
          const scriptParts: PdfWordAnchor[] = [];
          let valid = true;
          const neighbours = [line - 1, line + 1].filter(
            (next) => next >= 0 && next < lines.length && lines[next].region === lines[line].region,
          );
          for (const scriptedValue of candidate.scriptedTokens.map(normalizeMathToken)) {
            const occurrences = neighbours.flatMap((next) =>
              lineTokens[next]
                .filter((token) => token.text === scriptedValue)
                .map((token) => ({ line: next, token })),
            );
            if (occurrences.length !== 1) {
              valid = false;
              break;
            }
            const [{ line: scriptLine, token }] = occurrences;
            scriptParts.push(baseAnchor(scriptLine, token, token));
          }
          if (valid) {
            matches.push({
              anchors: [
                baseAnchor(line, tokens[at], tokens[at + baseExpected.length - 1]),
                ...scriptParts,
              ],
            });
          }
        }
      }
    }
    if (matches.length === 1) proposals.push(matches[0]);
  }
  // If two different source formulas claim overlapping PDF text, neither has
  // enough evidence to own that visual occurrence.
  const conflicted = new Set<number>();
  for (let a = 0; a < proposals.length; a += 1) {
    for (let b = a + 1; b < proposals.length; b += 1) {
      const overlaps = proposals[a].anchors.some((left) =>
        proposals[b].anchors.some(
          (right) => left.line === right.line && left.start < right.end && right.start < left.end,
        ),
      );
      if (overlaps) {
        conflicted.add(a);
        conflicted.add(b);
      }
    }
  }
  const math = proposals.flatMap((proposal, index) =>
    conflicted.has(index) ? [] : proposal.anchors,
  );
  for (const part of math) {
    // Give a verified equation its own PDF text range if a prose candidate also
    // happened to claim those same glyphs.
    anchors = anchors.filter(
      (word) => !(word.line === part.line && word.start < part.end && part.start < word.end),
    );
  }
  return [...anchors, ...math].sort(
    (a, b) => a.file.localeCompare(b.file) || a.from - b.from || a.to - b.to,
  );
}
