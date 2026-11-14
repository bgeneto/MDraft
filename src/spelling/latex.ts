//! Non-prose LaTeX ranges. Known text commands retain their prose arguments.

const PROSE_COMMANDS = new Set([
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
  "title",
  "author",
  "caption",
  "footnote",
  "textbf",
  "textit",
  "emph",
  "underline",
  "textsc",
  "textrm",
  "textsf",
]);

function escaped(text: string, at: number): boolean {
  let count = 0;
  for (let index = at - 1; index >= 0 && text[index] === "\\"; index -= 1) count += 1;
  return count % 2 === 1;
}

function closing(text: string, at: number, open: string, close: string): number {
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    if (escaped(text, index)) continue;
    if (text[index] === open) depth += 1;
    else if (text[index] === close && --depth === 0) return index;
  }
  return -1;
}

export function latexSkipRanges(text: string, base: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const proseOpenings = new Set<number>();
  const add = (from: number, to: number) => {
    if (to > from) ranges.push([base + from, base + to]);
  };
  const verbatim =
    /\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|alltt)\}[\s\S]*?\\end\{\1\}/g;
  for (const match of text.matchAll(verbatim)) add(match.index, match.index + match[0].length);
  for (const match of text.matchAll(/\\(?:verb|lstinline)\*?/g)) {
    if (escaped(text, match.index)) continue;
    let at = match.index + match[0].length;
    if (text[at] === "[") {
      const end = closing(text, at, "[", "]");
      if (end < 0) continue;
      at = end + 1;
    }
    const delimiter = text[at];
    if (!delimiter || /\s/u.test(delimiter)) continue;
    const lineEnd = text.indexOf("\n", at + 1);
    const end = text.indexOf(delimiter, at + 1);
    add(
      match.index,
      end >= 0 && (lineEnd < 0 || end < lineEnd) ? end + 1 : lineEnd >= 0 ? lineEnd : text.length,
    );
  }

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "%" || escaped(text, index)) continue;
    const end = text.indexOf("\n", index);
    add(index, end < 0 ? text.length : end);
    index = end < 0 ? text.length : end;
  }

  for (const match of text.matchAll(/\\([a-zA-Z@]+)\*?/g)) {
    const at = match.index;
    if (escaped(text, at)) continue;
    const name = match[1];
    add(at, at + match[0].length);
    let cursor = at + match[0].length;
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] === "[") {
      const end = closing(text, cursor, "[", "]");
      if (end < 0) {
        add(cursor, text.length);
        continue;
      }
      add(cursor, end + 1);
      cursor = end + 1;
    }
    for (let argument = 0; argument < 3; argument += 1) {
      while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
      if (text[cursor] !== "{") break;
      const end = closing(text, cursor, "{", "}");
      if (end < 0) {
        add(cursor, text.length);
        break;
      }
      const prose =
        (PROSE_COMMANDS.has(name) && argument === 0) || (name === "href" && argument === 1);
      if (prose) {
        proseOpenings.add(cursor);
        add(cursor, cursor + 1);
        add(end, end + 1);
      } else {
        add(cursor, end + 1);
      }
      cursor = end + 1;
    }
  }

  for (const match of text.matchAll(/\{[^{}\n]*\}/g)) {
    if (!proseOpenings.has(match.index)) add(match.index, match.index + match[0].length);
  }
  return ranges;
}
