# Installed fonts are enumerated by family name and resolved by the OS

**Status:** accepted
**Date:** 2026-10-29

## Context

The Typography pickers offered a hard-coded list of about twenty families:
the thirteen bundled faces plus faces likely to be installed on Windows, macOS
or a Linux desktop. A reader who owned a different font could not select it,
even though the webview already renders any installed family by name. The
request is every font installed on the operating system, on all three desktop
platforms.

Three routes were possible:

- enumerate the platform's font families and let the existing CSS stack name
  them;
- copy or serve each selected font file and declare it with `@font-face`;
- use the browser's `queryLocalFonts()`.

The second route is larger than it looks: Chromium can use only face 0 of a TTC
collection, many Windows and macOS families ship as TTC, every weight and
italic is a separate file, arbitrary system paths would need a new protocol or
CSP entry, and the application would carry or redistribute font binaries. The
third route is Chromium-only, needs a permission prompt and is absent from
WKWebView and WebKitGTK.

## Decision

**Enumerate family names; never read, copy or serve a system font file.**

A Tauri command asks the same native text stack the webview uses — DirectWrite
on Windows, CoreText on macOS, fontconfig on Linux — for its family names. It
uses `fontique`, which wraps those APIs and has no font-data requirement for
enumeration. One canonical name is taken per family id
(`family_ids()` + `family_name()`), not every localized alias. Names are
trimmed, deduplicated case-insensitively, stripped of hidden `.`/`@` entries and
CSS generic keywords, sorted and capped in length. The scan runs on a blocking
worker only when Typography is first shown and is cached for the session on
both sides; a failed or empty scan is reported to the panel, which keeps the
bundled faces and a short suggested list usable.

The picker writes the usual stack (`"Chosen Family", <role fallback tail>`).
The OS resolves weights, italics, variable axes and collections exactly as it
does for the built-in System preset. The supported formats are therefore the
formats the platform text engine exposes and the webview can use: TrueType
(`.ttf`), OpenType with CFF or TrueType outlines (`.otf`), collections
(`.ttc`/`.otc`) and variable fonts; macOS may also expose `.dfont` families.
Type 1 and bitmap formats are not rendered by the webview. WOFF/WOFF2 remain
the bundled fonts' delivery format, not an installed-font format.

Exported HTML names a system family but does not embed its file; a reader
without the face sees the stack's fallback. A printed PDF embeds glyphs through
the normal print path, as every document does. Only the bundled OFL families
keep the existing data-URL embedding.

On Linux, `fontique`'s `fontconfig-dlopen` feature loads the system
`libfontconfig` at run time through `dlib`. This avoids adding a build-time
`pkg-config` dependency; fontconfig is already present wherever GTK runs, and a
missing library produces an empty collection and a readable error rather than
an abort.

## Consequences

- No new URL scheme, CSP `font-src` entry, asset protocol use, binary cache or
  export weight. The feature is a text list over IPC.
- Face weights and italics, TTC collections and variable fonts work because the
  OS handles them; there is no face-0 limitation.
- A family installed while MDraft is running appears after a restart. On
  Windows DirectWrite's shared collection is cached, and the application
  deliberately does not offer a Reload button that would work on Linux/macOS
  but not there.
- A saved family that the current scan does not contain is shown as
  **Not installed**, not silently replaced.
- `fontique` is a new Cargo dependency (Apache-2.0 OR MIT, MSRV 1.88) with
  platform-specific backends. It is compiled only where the application is;
  the command boundary keeps a future replacement local.
- The Preferences global search does not index every family name; the picker
  has its own search, and indexing hundreds of names would make almost every
  query match the Typography section.

## Alternatives rejected

- **`@font-face` with a file URL or data URL:** TTC face selection, per-face
  weights, memory duplication, CSP/protocol work and redistribution questions;
  it duplicates a resolution the webview already performs.
- **`fontdb` / directory scanning:** pure Rust and small, but a directory scan
  misses fonts installed outside the standard folders and parses name tables
  instead of asking the platform. It remains the fallback if `fontique` is ever
  unusable.
- **`queryLocalFonts()`:** Chromium-only, permission-gated, absent from
  WebKitGTK and WKWebView, and not controllable from Tauri.
- **`fc-list`/PowerShell/registry subprocesses:** a console flash on Windows,
  locale-dependent output and no single cross-platform answer.
- **Native enumeration code per OS:** the same APIs with three times the
  surface to maintain; the command boundary is the reusable part.
