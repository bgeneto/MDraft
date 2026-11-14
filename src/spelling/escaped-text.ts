//! Decode source string contents while retaining safe UTF-16 source boundaries.

export interface DecodedText {
  text: string;
  /** Null means a decoded boundary has no safe source boundary. */
  offsets: Array<number | null>;
}

export function decodeEscapedText(
  raw: string,
  language: "json" | "javascript",
  multiline = false,
): DecodedText | null {
  let text = "";
  const offsets: Array<number | null> = [0];
  const append = (value: string, end: number): void => {
    text += value;
    for (let index = 1; index < value.length; index += 1) offsets.push(null);
    offsets.push(end);
  };
  for (let at = 0; at < raw.length;) {
    const char = raw[at];
    if (char !== "\\") {
      if (
        (!multiline && (char === "\n" || char === "\r")) ||
        (language === "json" && char.charCodeAt(0) < 32)
      )
        return null;
      const code = raw.codePointAt(at);
      if (code === undefined) return null;
      const value = String.fromCodePoint(code);
      at += value.length;
      append(value, at);
      continue;
    }
    const next = raw[at + 1];
    if (!next) return null;
    const simple: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (language === "javascript") {
      simple["'"] = "'";
      simple[String.fromCharCode(96)] = String.fromCharCode(96);
      simple["$"] = "$";
      simple.v = "\v";
    }
    if (next in simple) {
      at += 2;
      append(simple[next], at);
      continue;
    }
    if (next === "u") {
      const braced =
        language === "javascript" ? /^\{([0-9a-fA-F]{1,6})\}/.exec(raw.slice(at + 2)) : null;
      const digits = braced?.[1] ?? raw.slice(at + 2, at + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(digits) && !braced) return null;
      const value = Number.parseInt(digits, 16);
      if (value > 0x10ffff) return null;
      at += braced ? 2 + braced[0].length : 6;
      append(String.fromCodePoint(value), at);
      continue;
    }
    if (language === "javascript" && next === "x") {
      const digits = raw.slice(at + 2, at + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(digits)) return null;
      at += 4;
      append(String.fromCharCode(Number.parseInt(digits, 16)), at);
      continue;
    }
    return null;
  }
  // A surrogate pair can also arrive as two independent unicode escapes.
  for (let index = 1; index < text.length; index += 1) {
    const before = text.charCodeAt(index - 1);
    const after = text.charCodeAt(index);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
      offsets[index] = null;
  }
  return { text, offsets };
}

/** Return a source range only when both decoded boundaries are unambiguous. */
export function sourceRange(
  decoded: DecodedText,
  from: number,
  to: number,
): { from: number; to: number } | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) return null;
  const start = decoded.offsets[from];
  const end = decoded.offsets[to];
  return start == null || end == null || start >= end ? null : { from: start, to: end };
}
