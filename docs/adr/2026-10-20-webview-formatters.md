# Document formatting runs in the webview, not the Rust backend

**Status:** accepted
**Date:** 2026-10-20

## Context

The editor had no way to reformat a document. Spelling already owned a
right-click menu on a misspelled word; everywhere else the webview's own menu
appeared. A right-click **Format Document** was needed for Markdown, HTML and
Typst, with three constraints: nothing is fetched, parsed or instantiated until
the reader uses it; the initial bundle must not grow; and a formatter failure
must be recoverable rather than fatal.

The native route was measured and rejected on cost. With the release profile
(`opt-level = 3`, thin LTO, 16 codegen units, `panic = "abort"`, `strip = true`)
and a 147,456-byte baseline, `typstyle-core` 0.14.4 added 542.5 KB,
`dprint-plugin-markdown` 0.26.0 added 461.5 KB and `markup_fmt` 0.27.6 added
653.0 KB — 1.58 MiB for all three. The WebAssembly route costs 349.6 KiB of
Brotli-compressed assets (Prettier standalone 24.4 KiB, its Markdown plugin
71.5 KiB, its HTML plugin 45.5 KiB, Typstyle 205.0 KiB and its bindings 3.2 KiB),
decompressed only on first use.

There is also an MSRV conflict: `typstyle-core` 0.15.0 through 0.15.2 require
Rust 1.92, while the project pins 1.91. A prebuilt WebAssembly module has no
MSRV cost. Finally, the release profile is `panic = "abort"`: a parser bug that
panics on adversarial input would terminate the application. A WebAssembly trap
is an exception the dispatcher catches, leaving the buffer untouched.

## Decision

Formatting runs in the webview:

- Markdown and HTML use Prettier's `standalone` build with the matching language
  plugin.
- Typst uses `@typstyle/typstyle-wasm-bundler`; its wasm-bindgen glue and the
  Vite `?init` loader are loaded together, and the module is instantiated once.
- `src/format/formatters.ts` owns the dynamic imports, the formatter options and
  the snapshot rule. `src/format/menu.ts` owns the right-click menu, which
  listens on `document` so the spelling plugin's `stopPropagation()` wins.
- There is no `#[tauri::command]` and no `src/api.ts` wrapper for formatting.
- AsciiDoc is excluded: no maintained source formatter exists for it.

The initial entry chunk imports only the menu installer; every formatter is a
dynamic import. A format is one transaction over the whole document, so one undo
restores the exact original bytes, and a result is applied only if the buffer's
`Text` identity is the one it was computed from.

## Consequences

- The installed executable grows by the compressed formatter assets, not by
  native code linked for every user. The entry chunk grows by a few KB.
- The first Format Document in a session pays a module load — 70–210 KB
  compressed — and a 1 MB document blocks the window for roughly 0.8 s. A later
  change may move the Prettier path to a module worker; the dispatcher interface
  does not depend on that.
- Prettier is MIT and Typstyle is Apache-2.0. Their notices must travel with the
  binary; Preferences › General names both.
- A new formattable language must add a loader and options here rather than a
  Rust command, and a new menu entry must keep the snapshot rule.
- On a webview that cannot instantiate WebAssembly, the fallback is the native
  route — a larger change and a new plan, not a drop-in switch.
