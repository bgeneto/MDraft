//! Conservative recognition of legacy Markdown image destinations.
//!
//! A backslash before punctuation may be either a Markdown escape or a Windows
//! separator. This helper proposes a local candidate; callers must try the
//! ordinary Markdown destination first and must never probe a UNC share.

/** Extract a simple inline or reference-definition destination without guessing. */
export function legacyImageCandidate(raw: string, parsed: string): string | null {
  const inline =
    /^!\[(?:[^\]\\\r\n]|\\.)*\]\([ \t]*(?:<([^<>\r\n]+)>|([^\s()]+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\)))?[ \t]*\)$/.exec(
      raw,
    );
  const definition = /^\[[^\]\r\n]+\]:[ \t]*(?:<([^<>\r\n]+)>|([^\s()]+))/.exec(raw);
  const candidate = inline?.[1] ?? inline?.[2] ?? definition?.[1] ?? definition?.[2];
  if (!candidate || !/^(?:[A-Za-z]:\\|[^\\/:*?"<>|\r\n]+\\)/.test(candidate)) return null;
  // No UNC, already escaped separators, device paths, or invalid Windows names.
  if (
    candidate.includes("\\\\") ||
    /[<>"|?*]/.test(candidate) ||
    [...candidate].some((character) => character.charCodeAt(0) < 32)
  )
    return null;
  const tail = /^[A-Za-z]:/.test(candidate) ? candidate.slice(2) : candidate;
  if (tail.includes(":")) return null;
  // Accept only a discrepancy explained entirely by Markdown punctuation
  // escapes. Entities, URL encodings and other transformations stay untouched.
  const markdownDecoded = candidate.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
  return markdownDecoded === parsed && candidate !== parsed ? candidate : null;
}
