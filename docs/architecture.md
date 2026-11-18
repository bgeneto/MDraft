# MDraft architecture

MDraft is a native document editor. Rust/Tauri 2 owns filesystem access, native
menus, settings, external tools, and platform integration. TypeScript owns the
editor, previews, source correspondence, and application UI. The frontend cannot
use a Node filesystem API; it calls typed wrappers in `src/api.ts`.

## Documents and state

`src/main.ts` coordinates document lifecycle, tabs, menu events, settings patches,
preview ownership, and status. `src/editor.ts` owns CodeMirror behavior;
`src/sessions.ts` and `src/tabs.ts` manage per-document state. Rust document
commands validate paths and checked writes. Older settings must keep loading;
changes to command or settings contracts require an approved design.

Preview results are tied to their document identity, source revision, and render
generation. Stale work must not overwrite the active document. Switching format
or tab invalidates the previous surface and its selection map. Worker results
are committed only after confirming that they still own the current view.

While the pane shows nothing of the active document, a centred waiting surface
names the file and what is being done; once something readable is on screen,
progress belongs to the compiled toolbar. Ownership is not the test for
"something readable": the LaTeX preview frame owns the pane before it has drawn
a page, so the surface stays over it until the first page.

## Rendering and correspondence

Markdown and AsciiDoc rendering separate parsing/chunk preparation from DOM work.
Large documents use workers and deferred mapping where practical. Sanitization
applies before untrusted markup reaches the preview. HTML documents use a bounded
in-process URI scheme and bridge rather than an application HTTP server.

Line and word correspondence retain original-source positions across syntax,
includes, raw HTML, and asynchronous rendering. If a token cannot be aligned
unambiguously, drop that mapping rather than point to an unrelated source word.
Pointer gestures distinguish the pane the reader acted in from the pane that
follows, so selection and alignment do not feed back into each other.

Typst supports document and compiled PDF page views. Compilation, page text maps,
selection, zoom and viewport ownership must be coordinated; PDF text positions
are bound to the same source revision as the compiled output.

LaTeX projects resolve a root, includes, bibliography and local libraries through
Rust validation. Engine selection supports the configured browser capability and
explicitly selected native distributions: TeXpresso where JSPI exists, and the
single-threaded PhiTeX compatibility engine on Linux WebKitGTK without it. Both
run in a separate frame served by Rust from the application origin; downloaded
engine bytes are pinned by SHA-256, and PhiTeX's frame keeps `connect-src
'self'` while Rust fetches its package packs. The TeXpresso frame's bounded
project manifest lets the engine fetch a file it actually opens through a
per-frame capability on the same origin, without predicting every package's file
names; PhiTeX receives the bounded project snapshot directly. Native builds copy
that manifest into a session workspace, reuse its auxiliary files and caches,
and decide another pass or a bibliography tool from the generated file state. Project files are copied, never
hard-linked. Shell escape and project executables remain disabled. Native tools
are external programs running with the user's permissions.

## Preferences and external work

Persisted preferences are Rust defaults/serde data mirrored by `src/api.ts` and
applied by the frontend. A working control needs both read and write behavior,
and rendering/export paths must consume the setting consistently. Unsupported
preferences are explanatory notes.

Application backup and restore live in `src-tauri/src/backup/`. The source
registry captures known stores and immutable editor buffers, and writes a
versioned ZIP with per-file SHA-256 hashes. Restore validates into staging,
creates a verified safety ZIP, and journals category replacements before a
headless restart. Startup resolves interrupted transactions before constructing
the main window or loading settings. Recovered writing is kept in an independent
inbox with atomic revisions. The maintained archive contract and exclusions are
described in [backup-format.md](backup-format.md).

The application performs no telemetry or startup network requests. Downloads and
AI operations follow the explicit user actions and controls documented in the
README. A document can load resources from its own markup. On Windows the HTML
preview's reserved `.invalid` origin is answered inside WebView2, so opening an
HTML document sends no DNS query for it. Repository security
tools are development commands and are not shipped or run by the application.

## Public source and private records

Public builds require only this repository and its documented dependencies.
Synthetic regression fixtures live under `samples/`; reviewed site images are
canonical assets under `site/assets/img/`. Licenses, lockfiles, required fonts,
icons and fixture includes remain public distribution/build inputs.

Detailed owner plans, decision histories, audits, traps, research, source captures
and personal manual documents live in separate private storage. They are not
build inputs. Comments in public source retain the reasons needed to maintain
behavior; private records are optional additional context.
