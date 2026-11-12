# Syntax-aware, local spellchecking

**Status:** done (approved 2026-11-12)
**Date:** 2026-11-12
**ADR:** ../adr/2026-11-12-spellcheck-extraction.md

## Context and goal

Spell is a global preference, but the source editor explicitly disables it for
HTML, JavaScript, JSON and CSS. The status flag therefore says On while its
tooltip says the setting has no effect. The existing checker was built for
prose: one shared set of skip nodes and regular expressions selects words, one
document-wide language is chosen, and the Rust backend checks each word against
an installed operating-system dictionary. That is not enough to distinguish a
page's text from an HTML attribute, an identifier from a JavaScript comment,
or a translation from a JSON key.

The goal is useful, low-noise spelling marks and safe corrections in those
formats, while retaining and improving checking in the existing prose formats.
Context in this plan means the document's syntax, the role of a piece of text,
and its declared or selected language. Checks remain word-level and local.

## Scope and non-scope

In scope:

- Source-editor checking for HTML, JavaScript, JSON and CSS, in addition to
  Markdown/plain text, Typst, AsciiDoc and LaTeX. Embedded JavaScript and CSS
  within HTML follow their respective rules when their nested grammar is ready.
- Language-aware extraction, word segmentation, mapping diagnostics and
  corrections back to the exact source, suggestions, and conservative handling
  of incomplete syntax.
- Installed OS dictionaries beyond the current English/Portuguese allowlist,
  subject to the platform and encoding limits below; automatic selection,
  explicit per-document language overrides, and inherited HTML language tags.
- User controls for code and JSON strings and optional identifier checking;
  separate session-only Ignore and persistent Add to dictionary actions.
- The editor status, native menu, old settings, documentation, targeted unit,
  platform, UI and performance validation.

Not in scope:

- Sentence-aware spelling, real-word error detection, grammar or style checking,
  LanguageTool, AI models, cloud services, an HTTP server, a new language
  engine, or sending any document text over the network.
- Adding an npm or Cargo dependency, shipping or downloading dictionaries, or
  changing the existing startup/network policy. If a dependency proves
  necessary, measure its bundle, installer and typing costs and seek a separate
  plan amendment before adding it.
- New document types or grammar support for TypeScript, JSX, YAML, Python,
  JSON-with-comments and other currently unsupported formats. Unknown
  extensions must not be advertised as supported; adapters are extensible for
  future explicit format work.
- Rendered-preview underlines, project configuration files, project-wide
  dictionaries, automatic symbol renaming, or a document-wide spelling report.
  Marks and actions are in the source editor.

## Approach and rejected alternatives

Keep CodeMirror and the existing OS backends. Split the frontend spelling
pipeline into format adapters, language selection, segmentation/source mapping,
and the editor plugin. Each adapter returns bounded checkable passages with a
source range, context kind, optional language and a mapping from decoded UTF-16
boundaries to source boundaries. A passage is checked only when its syntax and
mapping are trustworthy. Batch words by dictionary and retain the existing
Tauri command names, arguments and successful return shapes. The plugin owns
marks, suggestions, per-request generations and the per-document runtime
state; the shell owns persisted settings and active-tab controls.

The current HTML source mapper is useful for text-node entities and CRLF, but
must not be assumed correct for attribute decoding or JavaScript/JSON escapes.
Extract or reuse only its proven pieces and test each source context separately.
Lezer mixed-language overlays require special care: the repository records an
order-dependent lookup trap in docs/agent-guide/traps/editor-and-ui.md. Test
warm as well as fresh trees and use a traversal that reliably enters mounted
trees. Wait for the current grammar and its parse; do not check with the
previous tab's grammar while a lazy load is in flight.

### Default text selection

| Format | Check by default | Do not check by default |
| --- | --- | --- |
| HTML | Text in ordinary elements and textarea, and human-readable attributes: title, alt, placeholder and aria-label. Honor an explicitly inherited spellcheck=false; a nearer spellcheck=true may re-enable it. | Tag/attribute names, id, class, href, src, style and event-handler values as HTML prose; text in code, pre, kbd and samp. Do not treat translate=no as a spelling prohibition: it has different semantics. |
| JavaScript | Prose in line/block/JSDoc comments and eligible human-readable strings. In template literals check literal segments only, never interpolation expressions. | Identifiers, imports, regular expressions, paths, URLs, hashes, and machine-oriented strings. Ignore JSDoc tags and types while checking their prose. |
| JSON | Human-readable string values. Keys and machine-oriented values remain excluded. | Keys, numbers, booleans, null, URLs, paths, IDs, hashes and patterns. |
| CSS | Prose in comments and literal strings in the content property. | Selectors, property and custom-property names, other values, URLs and identifiers. |
| Markdown, Typst, AsciiDoc, LaTeX | Existing prose and link labels. Fix LaTeX prose in recognized formatting and heading arguments, including section, textbf and emph. | Existing code, math, front matter, comments and other non-prose boundaries. Unknown LaTeX commands and ambiguous arguments fail closed. |

For JavaScript and JSON, the default string mode is Human-readable. A value is
eligible when its immediately associated name or an enclosing JSON property
denotes a known prose field (title, description, label, message, placeholder,
alt, caption, text, tooltip, help, messages, labels, strings or translations),
or when it contains at least two alphabetic words separated by whitespace.
Case and common camel/snake/kebab spelling are normalized for field matching.
An explicit machine field such as id, key, url, uri, href, src, path, file,
format, pattern, regex, token, hash, color or class, and recognizable URL,
path, email, data URL, hash and encoded-data values, take precedence over
prose heuristics. Apply the machine-value exclusions in every string mode.
Document these as heuristics, not semantic guarantees. Include single-word
translations under a recognized translation container. Import specifiers,
tagged templates of unknown meaning and interpolation expressions are never
eligible. A style attribute is not prose, but its mounted CSS grammar can
provide eligible CSS comments or content strings.

Add a Code and JSON strings preference with Human-readable (default), All
eligible strings, and Off. All eligible strings widens the prose-field test but
does not check the machine values and syntax listed above. Add Check code
identifiers, off by default: split camelCase, PascalCase and snake_case into
components and underline misspelled components, while retaining existing
acronym and personal-word exclusions. It may inspect JavaScript identifiers and
JSON property names, but never makes a replacement or claims to rename a symbol;
the user can ignore/add a word or edit the source manually.

For HTML, inherit the nearest explicit lang and spellcheck attributes through
nested elements. A per-document installed-language choice overrides everything
else. Follow global uses the pinned global dictionary, or the Automatic rules
when the global preference is Automatic. An explicit per-document Automatic
choice uses the Automatic rules even if the global preference is pinned. In
Automatic, use the nearest declared language first, then confident existing
English/Portuguese prose detection, then an installed dictionary matching the
OS/webview preferred locale. If none can be selected, show why and do not
underline with an unrelated dictionary. When an explicit declaration or manual
choice names a missing dictionary, explain the affected passages and do not
silently fall back; other passages with an available dictionary may still be
checked. Automatic detection is not promised for every installed language;
those languages work through declarations, locale fallback or an explicit
choice. Do not change read-aloud's separate language precedence.

Keep the current persisted global dictionary and personal-word settings. Add a
per-document choice to the existing spelling-language UI: Follow global,
Automatic, or an installed language. Follow global removes any stored path
override; Automatic is itself a persistable override. An untitled document keeps
its choice in its session; after save, persist it for the path. For saved
documents, store at most 100 path/language entries in settings, deduplicated by
the existing platform path-identity rule. Setting a choice makes it newest;
evict the least-recently-set entry when full, and do not rewrite settings just
because a file was reopened. Reopening the same path restores its choice; Save
As copies the current choice to the new path and leaves the old path's choice
intact. Restored tabs reload their path choice. A not-installed saved choice
remains visible and does not silently switch dictionaries. An unsaved untitled
choice is session-only and is not added to crash-recovery data.

Generalize OS language discovery and matching without treating user-supplied
language tags as filesystem paths. Preserve the existing English alias and
existing en-GB, pt-BR and pt-PT settings. Windows and macOS expose compatible
languages reported by their existing OS services. On Linux, discover paired
installed Hunspell files in the existing trusted system roots, validate tags
and encoding, and expose only dictionaries the implementation can correctly
read as UTF-8; do not claim support for non-UTF-8 dictionaries. Limit and
perform discovery off the UI thread. Unsupported encodings remain a documented
limitation, not a reason to silently produce wrong results. GAP-020 remains
open for any platform/encoding capability or validation not completed here.

The current backend can turn an engine failure into an empty misspelling list.
Preserve the successful payloads but surface actual discovery/check/suggestion
failures as rejected commands, with useful but non-sensitive UI feedback. A
missing dictionary is distinct from a clean document. Audit the read-aloud
caller and any tests that consume these commands for this failure behavior.

Alternatives rejected:

- Simply remove the HTML/source guards: the existing extractor would check
  markup, code and machine data as ordinary prose.
- Check every string and identifier by default: syntax alone cannot establish
  whether a value is human language, so paths and keys would create noise.
- Use raw regexes as the only parser: nested HTML, escaped strings, templates,
  and partially typed files need structure and reliable source boundaries.
- Use a new code-spelling package or bundled dictionary: the existing parsers
  and OS engines already supply the necessary foundation, and adding one has
  size, licensing and shipped-runtime costs that have not been measured.
- Add sentence or cloud checking: explicitly outside this request and the
  current user-initiated-network policy.

## Steps

- Progress: the eight-format corpus exercises the real extraction paths with a
  fake dictionary, including long escaped passages and worker-result bounds.
  Typst uses its structural parser in a bounded worker. The Windows Rust suite
  passed 436 tests (7 ignored) with a workspace-local temporary directory; the
  full Linux Rust suite passed 441 tests (7 ignored). Windows Clippy, the frontend
  build, lint, formatting, and the spelling corpus pass. The real-dictionary UI
  suite passed 19/19 on the final app build, including escaped replacement,
  undo, Save As, read-only, delayed suggestions and Ignore/Add. The active
  spelling performance checks pass. The three-launch tab restoration suite
  passed 40/40, including independent dictionary choices across restart.
  The final build also passed smoke 123/123, HTML 65/65, AsciiDoc 54/54,
  menu 172/172, and preview performance 36/36. Format-document 152/152 and
  tabs 113/113 passed before the final configuration-invalidation fix; the
  focused spelling suite covers that fix. The P0 lifecycle and recovery-restore
  suites passed 46/46 and 13/13. macOS is not available on this host.
- Verification deviation: the requested clean commit exposed pre-existing
  frontend quality failures: two intentional NUL sentinel regexes failed lint,
  and the committed Portuguese site had malformed image attributes. Replaced
  one sentinel operation with the equivalent string operation, documented the
  other lint exception, and restored the corrupted site values from the
  preceding revision. The spelling replacement check now avoids a NUL regex.
  These repairs are needed to make the requested quality gates meaningful.
- Verification deviation: spelling decorations split CodeMirror DOM marks, so
  the AsciiDoc word-sync test now joins adjacent decorated fragments before
  checking the selected text. Its first selection also needs a readiness-aware
  retry while synchronization settles. The preferences search test accounts for
  the new document dictionary help matching both words in “auto save”.

### Input measurements

Windows release build, same machine, 33 real key events per run; each cell is
three runs in order. Ages are milliseconds, heap is sampled JavaScript heap in
MB. The on runs waited for the spelling status to become active. The separate
preview overlap and positive-control checks also passed. No added median p95
exceeded 20 ms; the largest individual observed age was 6.2 ms. These are from
the final build after the configuration-invalidation fix.

| Format | Spell | p50 | p95 | p99 | max | heap MB |
| --- | --- | --- | --- | --- | --- | --- |
| Markdown | off | 1.0 / 1.0 / 0.9 | 1.7 / 2.6 / 2.5 | 1.9 / 3.4 / 3.2 | 1.9 / 3.4 / 3.2 | 54.0 / 59.5 / 62.8 |
| Markdown | on | 0.9 / 1.0 / 0.9 | 2.2 / 1.4 / 1.4 | 6.2 / 1.4 / 1.4 | 6.2 / 1.4 / 1.4 | 44.5 / 51.8 / 35.2 |
| HTML | off | 1.1 / 1.1 / 0.8 | 2.5 / 2.3 / 2.5 | 2.6 / 3.2 / 3.4 | 2.6 / 3.2 / 3.4 | 56.6 / 58.5 / 68.4 |
| HTML | on | 0.8 / 1.1 / 1.3 | 1.4 / 2.1 / 2.4 | 1.7 / 6.0 / 2.7 | 1.7 / 6.0 / 2.7 | 60.0 / 65.3 / 63.0 |
| JavaScript | off | 0.9 / 0.9 / 1.0 | 1.5 / 1.8 / 1.3 | 1.5 / 2.1 / 1.4 | 1.5 / 2.1 / 1.4 | 57.2 / 72.1 / 53.6 |
| JavaScript | on | 1.0 / 0.9 / 1.0 | 2.8 / 1.8 / 1.9 | 3.0 / 2.3 / 3.1 | 3.0 / 2.3 / 3.1 | 74.1 / 61.6 / 77.2 |
| JSON | off | 1.0 / 1.1 / 1.1 | 1.7 / 1.4 / 1.5 | 2.0 / 1.5 / 2.1 | 2.0 / 1.5 / 2.1 | 47.9 / 71.6 / 75.0 |
| JSON | on | 0.9 / 0.9 / 1.0 | 1.5 / 1.4 / 1.5 | 1.7 / 2.2 / 1.7 | 1.7 / 2.2 / 1.7 | 75.1 / 61.4 / 52.7 |

- [x] 1. Establish a labeled, app-free corpus for all eight current document
      types, including real-world mixed HTML, translation JSON and code, plus
      the current prose-format exclusions. Record which spans should and should
      not be checked and preserve the existing behavior as a regression
      baseline. Add a fake dictionary so expected errors do not depend on a
      machine's OS vocabulary.
- [x] 2. Define the passage, context, decoded-boundary and diagnostic types.
      Extract format adapters and the word-level pipeline from the current
      spelling plugin. Install the correct grammar before checking; re-run
      after a lazy parser arrives. Implement the table and string/identifier
      policies above, including HTML nested languages and safe LaTeX prose
      arguments. Skip uncertain or partially parsed regions rather than guess.
- [x] 3. Implement Unicode-aware word segmentation with Intl.Segmenter when
      available and a tested code-point/combining-mark fallback. Normalize
      words for checking without losing original UTF-16 ranges. Audit the
      frontend and Rust word filters so valid single-character words and
      scripts without case are not rejected merely by English-specific rules.
      Map HTML text and attribute entities, JavaScript strings/templates and
      JSON escapes to source; never invent an interior boundary of an expansion.
- [x] 4. Generalize installed-dictionary discovery and matching, preserving
      existing tags and successful Tauri payloads. Validate Linux dictionary
      encodings and report actual engine failures. Resolve language by the
      precedence above, per passage, without sharing one tab's detected state
      with another. Batch by language and preserve the existing request bounds.
- [x] 5. Add backwards-compatible settings for string mode, identifier mode
      and bounded per-path dictionary choices. Wire the existing preferences,
      language menu, sessions, Save As and tab restoration. Make Ignore
      session-only and Add to dictionary persistent, keeping all previously
      saved personal words.
- [x] 6. Enable the feature and native menu for the newly supported formats;
      report off, missing dictionary, parser pending, active and check failure
      accurately without a dead control. Recheck visible/changed passages
      first, defer remaining visible work, bound caches and invalidate them on
      dictionary or setting changes. Keep request, session, document
      incarnation and revision guards across edits, tab changes, parser loads
      and delayed suggestions. Store each mark's own dictionary so suggestions
      use the language of that passage.
- [x] 7. Apply suggestions only after verifying the current source and session.
      Encode replacements for the original HTML, JavaScript or JSON context,
      preserve unrelated bytes and make one undoable edit. Disable replacement
      in read-only documents, identifiers and ambiguous mappings. Never apply
      a correction automatically.
- [x] 8. Extend tests and script catalogs, run the ordered checks and
      performance comparison below, and record results and deviations here.
      Write the ADR for the adapter/source-map boundary. Update the guide and
      GAP-020 to describe actual coverage and any remaining limitations.

## Files and modules

- src/spellcheck.ts and new src/spelling/ modules: passage adapters, word
  segmentation, mappings, request coordination, marks and suggestion actions.
- src/editor.ts and src/code-context.ts: parser readiness, compartment
  reconfiguration and shared mixed-language context where appropriate; avoid
  broad changes to paste or tag-closing behavior.
- src/html-source-map.ts: reuse or extract proven HTML text mapping only if
  its callers and existing tests keep their behavior.
- src/language.ts: reuse language-tag and prose-detection helpers without
  changing read-aloud semantics.
- src/main.ts, src/preferences.ts, src/sessions.ts and src/api.ts: settings,
  per-document language, status/menu wiring and compatibility wrappers.
- src-tauri/src/spellcheck.rs and src-tauri/src/settings.rs: platform
  discovery/check errors, Unicode handling, bounded persisted choices, defaults
  and normalization. src-tauri/src/menu.rs: enablement and its tests.
- scripts/spellcheck-unit.mjs, scripts/spellcheck-test.mjs,
  scripts/menu-test.mjs and scripts/dom-smoke.mjs: new extraction tests and
  focused UI/settings coverage. Extend scripts/preview-performance-test.mjs
  for the spell-on/off measurement. Register the new app-free suite in
  package.json and scripts/test-all.mjs; document it in
  docs/agent-guide/catalog/editor-and-documents.md.
- docs/guide.md and docs/backlog.md: user-visible behavior, dictionary limits
  and the remaining GAP-020 work. This plan and the ADR record the decision,
  results and any deviations.

## Risks and rollback

- False positives in machine strings are the largest usability risk; default to
  the documented conservative rules and keep the widening mode opt-in.
- Wrong offsets or re-encoding could damage source. Validate both decoded and
  raw boundaries and the current snapshot; decline an ambiguous correction.
- Lazy, incomplete and mixed-language trees can misclassify content. Check
  grammar identity, parse coverage, mounted overlays and warmed tree lookups.
- More languages and concurrent tabs can overwhelm the Windows STA worker or
  the Linux dictionary mutex. Batch and bound requests, cache by language and
  normalized word, prioritize visible content and discard stale work.
- A pinned or missing dictionary must not become a different language without
  notice. Linux non-UTF-8 dictionaries are intentionally not advertised.
- The existing Spell switch disables all new checking immediately. If a
  regression cannot be isolated, revert the implementation files together,
  retain old settings compatibility, and leave the prior checker in place.
  Installation and rollback do not rewrite source documents, and the feature
  does not write to the OS dictionary.
- At plan time the worktree already contains unrelated changes, including
  several files this plan may touch. Recheck and preserve those changes before
  implementing or rolling back; do not reset the worktree.

## Tests and validation

Run the relevant layers in repository order, using Node 24 for app-free
TypeScript imports and the Windows MSVC wrapper for every Cargo invocation.

- npm run build, the new spellcheck:unit suite, npm run html:map:unit and
  npm run read-aloud:unit. Add focused Rust tests for language-tag aliases,
  matching, malicious tags, discovery/encoding failures, old settings,
  bounded path entries and explicit backend errors; run the Rust suite through
  scripts/with-msvc.cmd on Windows and also on Linux. Run the macOS platform
  checks on a macOS host if available; record an explicit gap if not.
- Unit fixtures cover every checked and skipped context in the table; embedded
  script/style and style attributes; warm parser overlays; malformed/unclosed
  syntax; HTML language inheritance and spellcheck overrides; JSON escapes;
  JavaScript template interpolation; HTML entities and attributes; CRLF,
  surrogate pairs, combining marks and apostrophes; locale fallback; missing
  dictionaries; and all string/identifier modes.
- Extend the isolated UI spelling layer to use temporary HTML, JS, JSON, CSS
  and existing prose documents. Check actual underlines, suggestions, ignore
  versus add, read-only behavior, per-document language, Save As, tab switching,
  stale responses, undo and exact saved bytes. A real dictionary integration
  check must establish that the installed checker rejects its chosen test word;
  report an explicit skip when no suitable dictionary is available. Unit tests
  remain deterministic with the fake engine.
- Run the affected isolated spelling, menu, HTML, AsciiDoc, format-document and
  tabs layers through npm test with --only, plus the new unit layer. Preserve
  the harness's user-instance guard and do not delete the reader's settings.
  Run the frontend formatting and lint checks and record pre-existing failures.
- Measure real keyboard input on the existing 1.2 MB preview-performance
  fixture with spelling on and off, using the same machine and build. Extend
  the probe with large HTML and JS/JSON sources. Record at least three runs,
  p50/p95/p99/max input age and memory; the existing p95 <= 100 ms and max
  <= 150 ms checks must still pass. Investigate a repeatable added p95 above
  20 ms rather than accepting it without explanation.

## Acceptance criteria

- With an installed matching dictionary and Spell on, a misspelled eligible
  word is underlined in HTML text and human-facing attributes, JS comments and
  strings, JSON prose values and CSS comments/content. Source-only code,
  machine values, excluded spans and template expressions remain unmarked.
- The documented string modes and optional identifier mode behave as stated;
  identifiers never receive a misleading automatic rename/correction action.
- Existing Markdown, Typst, AsciiDoc and LaTeX checking retains code/math
  exclusions; misspelled prose in the named LaTeX commands is checked.
- HTML language inheritance, explicit per-document/global choices and
  Automatic precedence select only available dictionaries. Per-path choices
  survive restart and Save As as described; old settings and personal words
  load unchanged. Unsupported or unavailable dictionaries are explained.
- Corrections in entities and escaped strings edit the intended word only,
  preserve valid source syntax, refuse ambiguous or stale mappings, and undo in
  one step. Read-only documents never change.
- Status and menu agree with the setting and actual capabilities; grammar-load
  and engine failures do not masquerade as a clean check. There is no new
  startup network activity, outbound request, dictionary download or Node
  runtime in the shipped application.
- The deterministic corpus and focused UI/platform suites available on the
  test hosts pass, unavailable platform checks are reported explicitly, and
  measured input responsiveness meets the stated performance checks.

## Open questions

- The proposed defaults are conservative prose strings and identifier checking
  off. Approval of the plan accepts these defaults unless changed explicitly.
- The proposed Linux scope is installed UTF-8 Hunspell dictionaries; other
  encodings need a separately measured conversion approach. Approval accepts
  that limitation unless the scope is amended.
- The per-document path mapping stores up to 100 recent overrides in settings.
  Approval accepts that persistence and eviction behavior unless amended.
