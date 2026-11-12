//! The encoding catalogue the shell shows, and the in-document encoding
//! declarations a conversion must keep consistent.
//!
//! Pure: no DOM, no Tauri, so `scripts/encoding-unit.mjs` runs it in Node.
//! Rust owns the bytes (`src-tauri/src/text_encoding.rs`); this module only
//! names the canonical `encoding_rs` labels Rust sends and validates.

export interface EncodingInfo {
  /** Canonical `encoding_rs` label, the value sessions and IPC carry. */
  label: string;
  /** Short name for the status bar. */
  short: string;
  /** Longer description for the dialog's lists. */
  title: string;
}

export interface EncodingGroup {
  name: string;
  encodings: EncodingInfo[];
}

const e = (label: string, short: string, title = short): EncodingInfo => ({ label, short, title });

/**
 * Every encoding `text_encoding::OFFERED` lists, grouped by script. The Rust
 * test proves that list has no duplicates; the unit test proves this one
 * matches it.
 */
export const ENCODING_GROUPS: readonly EncodingGroup[] = [
  {
    name: "Unicode",
    encodings: [
      e("UTF-8", "UTF-8"),
      e("UTF-16LE", "UTF-16 LE", "UTF-16 Little Endian"),
      e("UTF-16BE", "UTF-16 BE", "UTF-16 Big Endian"),
    ],
  },
  {
    name: "Western European",
    encodings: [
      e("windows-1252", "Windows-1252", "Windows-1252 (Latin-1, ISO-8859-1)"),
      e("ISO-8859-15", "ISO-8859-15", "ISO-8859-15 (Latin-9, with €)"),
      e("macintosh", "Mac Roman", "Mac OS Roman"),
      e("ISO-8859-3", "ISO-8859-3", "ISO-8859-3 (South European)"),
      e("ISO-8859-10", "ISO-8859-10", "ISO-8859-10 (Nordic)"),
      e("ISO-8859-14", "ISO-8859-14", "ISO-8859-14 (Celtic)"),
    ],
  },
  {
    name: "Central European",
    encodings: [
      e("windows-1250", "Windows-1250"),
      e("ISO-8859-2", "ISO-8859-2", "ISO-8859-2 (Latin-2)"),
      e("ISO-8859-16", "ISO-8859-16", "ISO-8859-16 (South-Eastern European)"),
    ],
  },
  {
    name: "Cyrillic",
    encodings: [
      e("windows-1251", "Windows-1251"),
      e("ISO-8859-5", "ISO-8859-5"),
      e("KOI8-R", "KOI8-R", "KOI8-R (Russian)"),
      e("KOI8-U", "KOI8-U", "KOI8-U (Ukrainian)"),
      e("IBM866", "CP866", "CP866 (DOS Cyrillic)"),
      e("x-mac-cyrillic", "Mac Cyrillic"),
    ],
  },
  {
    name: "Greek",
    encodings: [e("windows-1253", "Windows-1253"), e("ISO-8859-7", "ISO-8859-7")],
  },
  {
    name: "Turkish",
    encodings: [e("windows-1254", "Windows-1254", "Windows-1254 (ISO-8859-9)")],
  },
  {
    name: "Baltic",
    encodings: [
      e("windows-1257", "Windows-1257"),
      e("ISO-8859-13", "ISO-8859-13"),
      e("ISO-8859-4", "ISO-8859-4"),
    ],
  },
  {
    name: "Hebrew",
    encodings: [
      e("windows-1255", "Windows-1255"),
      e("ISO-8859-8", "ISO-8859-8", "ISO-8859-8 (visual)"),
      e("ISO-8859-8-I", "ISO-8859-8-I", "ISO-8859-8-I (logical)"),
    ],
  },
  {
    name: "Arabic",
    encodings: [e("windows-1256", "Windows-1256"), e("ISO-8859-6", "ISO-8859-6")],
  },
  { name: "Vietnamese", encodings: [e("windows-1258", "Windows-1258")] },
  { name: "Thai", encodings: [e("windows-874", "Windows-874", "Windows-874 (TIS-620)")] },
  {
    name: "Japanese",
    encodings: [
      e("Shift_JIS", "Shift_JIS"),
      e("EUC-JP", "EUC-JP"),
      e("ISO-2022-JP", "ISO-2022-JP"),
    ],
  },
  {
    name: "Chinese",
    encodings: [
      e("GBK", "GBK", "GBK (Simplified)"),
      e("gb18030", "GB18030", "GB18030 (Simplified)"),
      e("Big5", "Big5", "Big5 (Traditional)"),
    ],
  },
  { name: "Korean", encodings: [e("EUC-KR", "EUC-KR")] },
];

const byLabel = new Map(
  ENCODING_GROUPS.flatMap((group) =>
    group.encodings.map((info) => [info.label.toLowerCase(), { ...info, group: group.name }]),
  ),
);

export function encodingInfo(label: string): (EncodingInfo & { group: string }) | null {
  return byLabel.get(label.toLowerCase()) ?? null;
}

/** Human-facing name for a canonical label, e.g. `Windows-1252`, `UTF-16 LE`. */
export function displayEncoding(label: string): string {
  return encodingInfo(label)?.short ?? label;
}

export const isUnicode = (label: string) => /^utf-(8|16le|16be)$/i.test(label);

/**
 * Common aliases a document may declare, mapped to the canonical label, so that
 * `latin1` in a Windows-1252 file is recognised as consistent. Following WHATWG,
 * ISO-8859-1 and ASCII are Windows-1252, and ISO-8859-9 is Windows-1254.
 */
const ALIASES: Record<string, string> = {
  utf8: "UTF-8",
  "utf-8": "UTF-8",
  "utf-16": "UTF-16LE",
  "utf-16le": "UTF-16LE",
  "utf-16be": "UTF-16BE",
  latin1: "windows-1252",
  "iso-8859-1": "windows-1252",
  iso88591: "windows-1252",
  "iso8859-1": "windows-1252",
  "us-ascii": "windows-1252",
  ascii: "windows-1252",
  ansinew: "windows-1252",
  cp1252: "windows-1252",
  latin9: "ISO-8859-15",
  latin2: "ISO-8859-2",
  latin3: "ISO-8859-3",
  latin4: "ISO-8859-4",
  latin5: "windows-1254",
  "iso-8859-9": "windows-1254",
  latin10: "ISO-8859-16",
  cp1250: "windows-1250",
  cp1251: "windows-1251",
  cp1255: "windows-1255",
  cp1257: "windows-1257",
  cp866: "IBM866",
  "koi8-r": "KOI8-R",
  "koi8-u": "KOI8-U",
  applemac: "macintosh",
  maccyr: "x-mac-cyrillic",
  "shift-jis": "Shift_JIS",
  sjis: "Shift_JIS",
  "windows-31j": "Shift_JIS",
  gb2312: "GBK",
  "x-gbk": "GBK",
  "euc-kr": "EUC-KR",
  "tis-620": "windows-874",
};

/** Canonical label for a declared name, or the lower-cased name if unknown. */
export function canonicalDeclared(name: string): string {
  const key = name.trim().toLowerCase();
  return ALIASES[key] ?? encodingInfo(key)?.label ?? key;
}

/** `inputenc` option names, the reverse direction: what to write for a target. */
const INPUTENC: Record<string, string> = {
  "UTF-8": "utf8",
  "windows-1252": "ansinew",
  "ISO-8859-15": "latin9",
  "ISO-8859-2": "latin2",
  "ISO-8859-3": "latin3",
  "ISO-8859-4": "latin4",
  "ISO-8859-16": "latin10",
  "windows-1254": "latin5",
  "windows-1250": "cp1250",
  "windows-1251": "cp1251",
  "windows-1257": "cp1257",
  IBM866: "cp866",
  "KOI8-R": "koi8-r",
  macintosh: "applemac",
  "x-mac-cyrillic": "maccyr",
};

/** Every `inputenc` encoding option this module recognises in a preamble. */
const INPUTENC_OPTIONS = new Set([
  ...Object.values(INPUTENC),
  "utf8",
  "latin1",
  "cp1252",
  "cp1255",
  "cp850",
  "cp437",
  "koi8-u",
]);

export interface Declaration {
  kind: "inputenc" | "meta" | "xml";
  /** UTF-16 offsets of the declared name in the document text. */
  from: number;
  to: number;
  /** The name as written, e.g. `latin1`. */
  declared: string;
}

/** True when `offset` sits after an unescaped `%` on its line (a TeX comment). */
function inTexComment(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] === "\\") index += 1;
    else if (before[index] === "%") return true;
  }
  return false;
}

/**
 * The encoding declarations in a document, in document order.
 *
 * Only declarations whose name can be rewritten in place are returned: the
 * `inputenc` option, an HTML `<meta charset>` or `http-equiv` charset, and an
 * XML prolog's `encoding`.
 */
export function findDeclarations(text: string, language: string): Declaration[] {
  const found: Declaration[] = [];
  if (language === "latex") {
    const inputenc = /\\(?:usepackage|RequirePackage)\s*\[([^\]]*)\]\s*\{inputenc\}/g;
    for (const match of text.matchAll(inputenc)) {
      if (inTexComment(text, match.index)) continue;
      const optionsStart = match.index + match[0].indexOf("[") + 1;
      const options = match[1];
      for (const option of options.matchAll(/[^,\s]+/g)) {
        if (!INPUTENC_OPTIONS.has(option[0].toLowerCase())) continue;
        const from = optionsStart + option.index;
        found.push({ kind: "inputenc", from, to: from + option[0].length, declared: option[0] });
        break;
      }
    }
  } else if (language === "html") {
    const xml = /^\uFEFF?\s*<\?xml\b[^>]*?\bencoding\s*=\s*(["'])([^"']+)\1/.exec(text);
    if (xml) {
      const from = xml.index + xml[0].length - xml[2].length - 1;
      found.push({ kind: "xml", from, to: from + xml[2].length, declared: xml[2] });
    }
    for (const tag of text.matchAll(/<meta\b[^>]*>/gi)) {
      const charset = /\bcharset\s*=\s*["']?([A-Za-z0-9._:-]+)/i.exec(tag[0]);
      if (!charset) continue;
      const from = tag.index + charset.index + charset[0].length - charset[1].length;
      found.push({ kind: "meta", from, to: from + charset[1].length, declared: charset[1] });
    }
  }
  return found;
}

/**
 * What a declaration should say for `target`, or null when it already agrees
 * or the target has no name in that syntax (UTF-16 has no `inputenc` option,
 * and an HTML page in UTF-16 is identified by its BOM, not by `<meta>`).
 */
export function declarationReplacement(declaration: Declaration, target: string): string | null {
  if (canonicalDeclared(declaration.declared) === target) return null;
  if (declaration.kind === "inputenc") return INPUTENC[target] ?? null;
  if (/^UTF-16/i.test(target)) return null;
  const written = target === "UTF-8" ? "utf-8" : target;
  // Keep the document's letter case style for the common utf-8/UTF-8 spelling.
  return declaration.declared === declaration.declared.toUpperCase()
    ? written.toUpperCase()
    : written;
}
