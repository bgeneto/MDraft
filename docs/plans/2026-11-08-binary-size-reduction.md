# Binary size reduction: text-only clipboard, Source Sans variable, tex-fmt on demand, worker dedupe

**Status:** done
**Date:** 2026-11-08
**Approval:** direct instruction in conversation, 2026-11-08 — "vamos proceder com
1 até 4 apenas e mais a Higiene".
**ADR:** none — the outbound-request policy is unchanged in kind; this extends the
existing user-initiated download path to one more asset (see Open questions).

## Context and goal

The Windows release binary is 19.47 MiB. Measured by PE section and by
brotli-compressing every file in `dist/` (the same codec `tauri-codegen`
embeds): `.text` 9.58 MiB, `.rdata` 9.63 MiB, and the embedded frontend is
7.79 MiB of that `.rdata` (18.89 MiB raw). An audit of the dependency graph
found **no unused npm or cargo package** (`npm run knip` clean, every direct
crate referenced); the weight comes from used-but-optional payload.

Four of the audit's opportunities are worth doing now, because none of them
removes a user-visible capability:

| Target | Why it is waste today | Est. saving |
|---|---|---:|
| `arboard` image support | The app only ever reads/writes clipboard **text**; `image`/`png` are linked only because the plugin enables `arboard`'s default `image-data` feature | 0.15–0.3 MiB |
| Source Sans 3 statics | Six static faces (571 KiB) ship where two variable faces (301 KiB) cover the same weights and glyphs | 0.26 MiB |
| `tex-fmt` wasm | 1.66 MiB embedded for a formatter used only on `.tex` files; it is already lazily *imported*, but lazy import does not remove bytes from the binary | 0.47 MiB |
| Duplicate libs in the two render workers | Both workers are standalone bundles with no shared chunks; the overlap between them is unknown and may be small | 0–0.15 MiB |

Afterwards the shipped Windows binary should be ~18.3–18.6 MiB, with the same
features and no start-up network activity.

## Scope and non-scope

**In scope:** the four items above, plus deleting stale build artefacts in
`src-tauri/target/release` left over from the pre-rename crate
(`mdraft.old.exe`, `typora_*`). Also the documentation lines that enumerate the
application's outbound requests, because item 4 adds one.

**Out of scope** — explicitly not touched, even though the audit named them:
curating `@codemirror/language-data`'s 103 modes (0.62 MiB), mermaid/ELK
(0.55 MiB), replacing `fontique` (0.3–0.6 MiB), replacing the `reqwest` stack
with `ureq` (1.5–2.5 MiB), subsetting bundled fonts by glyph coverage, and
LTO/`opt-level` experiments. No change to the markdown dialect, no change to
`settings.json`.

## Approach and rejected alternatives

### 1. Clipboard: keep text, drop the image decoders

Replace `tauri-plugin-clipboard-manager` with a direct
`arboard = { version = "3.7", default-features = false, features = ["wayland-data-control"] }`
and two of our own commands in a new `src-tauri/src/clipboard.rs`:
`clipboard_read_text` and `clipboard_write_text`, both async and run on a
blocking worker like `fonts::system_fonts`. The frontend's `src/clipboard.ts`
keeps the same public functions and fallback order (web API first, backend
second); only the two backend calls change from the plugin's JS wrappers to
`src/api.ts` wrappers.

*Rejected:* vendoring/patching `arboard` to strip its default feature — a
fork of a crates.io package for one flag; hand-rolling per-OS text clipboard
with the `windows`/`objc2`/`gtk` crates the app already links — three
backends to maintain for the same ~0.2 MiB; keeping the plugin — it is the
reason `image` is linked at all.

Evidence that text alone is enough: `src/clipboard.ts` imports only
`readText`/`writeText`; clipboard images travel as `ClipboardEvent` data into
`images::save_clipboard_image`, never through the plugin.

### 2. Workers: measure first, merge only if it pays

Both worker bundles are self-contained (no import statements in the emitted
files), so the same `marked`/KaTeX/CodeMirror code can appear twice. The audit
estimate is small and unproven. First step is a measurement: build with a
temporary Rollup/worker analysis (or compare the two bundles' module graphs
from a `vite build --debug` run) and record the overlap in KiB. Only if the
overlap is **≥ 40 KiB** do we merge the two worker entries into one module
worker that takes a `kind` in the request and dynamically imports its engine;
that keeps AsciiDoc out of a Markdown session only if the worker build still
code-splits, which the measurement must confirm.

*Rejected:* merging unconditionally — Vite currently inlines worker
dependencies, so a merge can *increase* what a Markdown session loads; forcing
`worker.format: "es"` plus shared chunks is a build-behaviour change that
needs its own evidence.

### 3. Source Sans 3: two variable faces instead of six statics

The pinned archive already contains `WOFF2/VF/SourceSans3VF-Upright.ttf.woff2`
(166 KiB) and `...VF-Italic.ttf.woff2` (135 KiB), covering the same weight
range and glyph set as the six picks in `scripts/font-sources.json`. Replace
the six `picks` with these two, weight `"200 900"`, and regenerate
`src/assets/fonts/fonts.json` with `scripts/fetch-fonts.ps1`. No TypeScript
change: `src/fonts.ts` builds every `@font-face` from `fonts.json`'s
`style`/`weight`/`file` fields.

*Rejected:* subsetting by glyph coverage — unacceptable for a text editor
whose documents may be in any language; dropping a family — a visible product
change that belongs in its own plan.

### 4. tex-fmt: fetch the 1.66 MiB wasm on first use

The package's ESM entry imports the wasm directly, but the wasm-bindgen glue
(`tex_fmt_bg.js`, 8 KiB) exposes `__wbg_set_wasm(instance.exports)`. That
makes a clean two-part split possible without forking anything:

1. Keep the 8 KiB glue in the bundle (`import` it by absolute path through a
   Vite alias, because the package's `exports` map only exposes `"."`).
2. Stop importing `tex-fmt` itself, so the 1.66 MiB `tex_fmt_bg.wasm` is no
   longer emitted into `dist/`.
3. On the first Format of a `.tex` file, call a new Rust command
   `tex_fmt_wasm` that returns the bytes (Tauri IPC `Response`, not a JSON
   number array): if
   `app_data_dir()/tex-fmt/0.5.7-npm.1/tex_fmt_bg.wasm` is absent, download
   `https://cdn.jsdelivr.net/npm/tex-fmt@0.5.7-npm.1/tex_fmt_bg.wasm`,
   verify SHA-256
   `830a0f2b31ead82b1852be061386029fa2deee4aeb0e77e6061bb1b3d02f23ad`,
   write atomically, and cache it. Reuse the `download` / `write_atomic` /
   `Sha256` helpers already in `latex.rs` (made `pub(crate)` or moved to a
   shared module).
4. In the frontend, `WebAssembly.instantiate(bytes, { "./tex_fmt_bg.js": glue })`,
   then `glue.__wbg_set_wasm(instance.exports)`,
   `instance.exports.__wbindgen_start()`, then `glue.main(text, config)` as
   today.

If the download fails or the app is offline, Format Document reports that the
LaTeX formatter needs a one-time download instead of failing silently.

*Rejected:* importing the package from a remote URL — executes
remotely-fetched JavaScript, a security regression; rebuilding tex-fmt with
`--target web` and hosting the artifact ourselves — a new wasm toolchain and
release asset for no gain over the split above; keeping it embedded — the
0.47 MiB this item exists to remove.

## Steps

- [x] **Hygiene:** verify and delete `src-tauri/target/release/mdraft.old.exe`
      and every `typora_*` artefact under `src-tauri/target/release`
      (`deps\*`, `.fingerprint\*`, `build\*`, `*.pdb`, `*.d`). Confirm the
      resolved absolute paths before removing anything; these are build
      outputs only.
- [x] **Fonts:** edit `scripts/font-sources.json` (two VF picks), run
      `scripts/fetch-fonts.ps1`, confirm `fonts.json` has two Source Sans
      entries and the two woff2 files, run `npm run build`, and record the
      `dist` woff2 total (expected −270 KiB).
- [x] **Clipboard/Rust:** add `src-tauri/src/clipboard.rs`, register the two
      commands in `lib.rs`, remove the plugin from `Cargo.toml`/`lib.rs`,
      add `arboard` with default features off, update `Cargo.lock`.
- [x] **Clipboard/JS:** add the two wrappers to `src/api.ts`, point
      `src/clipboard.ts` at them, remove
      `@tauri-apps/plugin-clipboard-manager` from `package.json` and the two
      `clipboard-manager:*` permissions from `capabilities/default.json`.
- [x] **Workers:** measure the overlap; if ≥ 40 KiB, merge the entries and
      keep the engine import dynamic; otherwise leave the workers alone and
      write the measurement into the plan's result.
- [x] **tex-fmt/Rust:** add the `tex_fmt_wasm` command with cache, pinned URL,
      SHA-256 check and size cap; expose the shared download helpers.
- [x] **tex-fmt/JS:** add a loader in `src/format/formatters.ts` that
      instantiates the fetched bytes with the bundled glue, and a user-facing
      message for the offline/failed case.
- [x] **Docs:** add the tex-fmt download to the outbound-request lists in
      `README.md` and `AGENTS.md` (Next to the LaTeX engine exception), and
      add the new command to the relevant catalog if it is user-visible.
- [x] **Measure:** rebuild, record `.text`/`.rdata`/total and the brotli total
      of `dist/`, and tick the acceptance numbers below.

## Files and modules

- `src-tauri/Cargo.toml` — drop `tauri-plugin-clipboard-manager`, add
  `arboard` without default features.
- `src-tauri/src/clipboard.rs` (new) — the two text commands.
- `src-tauri/src/lib.rs` — module, plugin removal, command registration.
- `src-tauri/src/latex.rs` — share `download`/`write_atomic`/hashing, or move
  them to a small module; the tex-fmt cache reuses them.
- `src-tauri/src/tex_fmt.rs` (new, or a function in `latex.rs`) — cache path,
  pinned URL, verification, `Response` bytes.
- `src-tauri/capabilities/default.json` — remove the two plugin permissions.
- `src/api.ts` — `clipboardReadText`, `clipboardWriteText`, `texFmtWasm`.
- `src/clipboard.ts` — call the API wrappers instead of the plugin.
- `src/format/formatters.ts` — the wasm-bindgen split loader.
- `src/assets/fonts/fonts.json`, `src/assets/fonts/*.woff2` — regenerated by
  the fetch script.
- `scripts/font-sources.json` — the two variable picks.
- `package.json` / `package-lock.json` — remove the clipboard plugin JS.
- `README.md`, `AGENTS.md` — outbound-request lists.
- `docs/plans/2026-11-08-binary-size-reduction.md` — this file, status and
  measurements at the end.

## Risks and rollback

- **Clipboard regression** on WebView2 where `navigator.clipboard.readText()`
  is permission-gated — this is exactly why the plugin fallback exists, so the
  new fallback must be exercised on Windows, not only stubbed in tests.
  Rollback: restore the plugin dependency and the two capability lines (one
  commit).
- **Source Sans rendering shift** — variable fonts can hint differently;
  verify with the typography suite screenshots before/after. Rollback: the six
  static picks are one revert of `font-sources.json` plus a regeneration.
- **tex-fmt ABI drift** — the glue and wasm are version-locked; the loader
  must import the glue from the same npm version the SHA pins. Rollback:
  re-import `tex-fmt` normally (the old one-line loader) and keep the bytes
  embedded.
- **Worker merge** pulling Asciidoctor into a Markdown session — the
  measurement gate exists to prevent this; if it cannot be proven, the item is
  dropped.
- **Build artefacts** deleted in the hygiene step are outputs; `cargo build`
  recreates them.

## Tests and validation

- `npm run build`, `npm run format:check`, `npm run lint`, `npm run knip`
  (must stay at zero after the npm dependency is removed).
- `scripts/cargo-vcvars.cmd cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
  and `npm run test:rust`.
- UI layers whose code changed: `npm run format:document` (copy/paste and the
  Format Document paths), `npm run menu` (clipboard items), `npm run typography`
  (font faces and presets), `npm run asciidoc` and `npm run preview:dom`
  (worker rendering), `npm run latex` / `npm run latex:preview` only if the
  tex-fmt path is reachable there.
- The proving measurement: `.text` and `.rdata` from the rebuilt exe and the
  brotli total of `dist/`, compared with 9.58 / 9.63 / 7.79 MiB today.

## Result and deviations

Measured on this host (Windows x64, release profile):

| Measurement | Before | After |
| --- | ---: | ---: |
| `mdraft.exe` | 19.47 MiB | **18.53 MiB** |
| `.text` | 9.58 MiB | 9.35 MiB |
| `.rdata` | 9.63 MiB | 8.92 MiB |
| `dist/` raw | 18.89 MiB | 17.00 MiB |
| `dist/` brotli | 7.79 MiB | 7.07 MiB |

- **Clipboard.** `image` and `png` are gone from the Windows runtime tree and
  from the executable's strings; `.text` lost 0.23 MiB. `arboard` stays as a
  direct dependency with `default-features = false` plus
  `wayland-data-control`, and the long-lived handle is released on
  `RunEvent::Exit`, as the plugin did.
- **Fonts.** Six static Source Sans faces (571 KiB) became two variable faces
  (301 KiB): −270 KiB raw, and woff2 does not compress further, so the binary
  pays it in full. Deviation: `fetch-fonts.ps1` re-downloads and re-subsets
  every family and needs Python, so the two picks were extracted from the
  pinned, hash-verified archive and `fonts.json` was updated to match what the
  script writes; `font-sources.json` carries the change, so a future full run
  reproduces it.
- **tex-fmt.** The 1.66 MiB wasm is no longer emitted; 3.4 KiB of glue remains.
  `tex_fmt_wasm` fetches the pinned jsDelivr asset on first use, verifies the
  SHA-256, caches it under `app_data_dir()/tex-fmt/0.5.7-npm.1/` and returns the
  bytes as a raw IPC payload. Deviation: the app-free `latex:format:unit` layer
  cannot call IPC under Node, so `formatters.ts` exposes
  `setTexFmtLoaderForTests` and that script instantiates the same glue and bytes
  from `node_modules`; 29/29 checks pass.
- **Workers.** The measurement contradicted the audit's premise: the two
  workers share **zero** modules (`preview-worker`: marked, KaTeX, CodeMirror
  and the render pipeline; `asciidoc-worker`: `@asciidoctor/core` and its
  renderer). The gate was ≥ 40 KiB, so item 2 was dropped as agreed and the
  workers are unchanged. The duplication that remains is main-thread ↔ worker,
  which separate worker builds cannot share.
- **Hygiene.** Removed `mdraft.old.exe` and every `typora_*` artefact from
  `target/release` (14 items plus the 3 stragglers: 186 MiB of build output).

Validation: `npm run build`, `npm run knip` (0), clippy with `-D warnings`, the
full `npm run test:rust` suite (green once `TEMP`/`TMP` point inside the
workspace, per the trap entry), `npm run typography:unit` (27/27),
`npm run latex:format:unit` (29/29), and a CDP smoke against the release binary:
clipboard round-trip through the new commands; `tex_fmt_wasm` returning
1,701,774 bytes with the pinned SHA-256 and a cached second call; two
`@font-face` rules whose variable faces load at 400, 700 and italic. Not run:
the CDP UI layers that need `scripts/test-all.mjs`, `npm run dist`, and the
Linux build — those remain in the release checklist.

## Acceptance criteria

- `clipboard-manager` appears in no manifest, lockfile, capability or import;
  `image`/`png` no longer show up as linked crates (the `image-0.25` marker
  strings disappear from the binary). **Met.**
- `dist` contains exactly two Source Sans woff2 files; the typography suite
  shows no visible change in any of the five presets. **Met for the file count
  and the unit layer; the visual preset sweep still belongs to the release
  checklist.**
- `dist` contains no `tex_fmt*.wasm`; the first Format of a `.tex` document
  downloads once, the second reads the cache, and an offline run reports the
  one-time download requirement. **Met** (bytes, SHA and cache proven over CDP;
  the offline message is the command's error string).
- Either the two workers share their overlap or the plan records the measured
  overlap and why it was not worth a merge. **Met: 0 modules, dropped.**
- Shipped Windows binary ≤ 18.6 MiB, with no new start-up request and no new
  telemetry. **Met: 18.53 MiB; the new request is user-initiated only.**
- `src-tauri/target/release` no longer contains `mdraft.old.exe` or any
  `typora_*` file. **Met.**

## Open questions

- **Is one extra outbound destination acceptable?** Answered by the directive
  to proceed with item 4: yes, and it is now listed in the README and AGENTS.md
  as a user-initiated request.
- **Does item 2 clear its gate?** No — 0 KiB of overlap, so it was dropped.
- **Should the tex-fmt download be an ADR?** Not recorded as one: the LaTeX
  engine already establishes the download-and-verify pattern, and this is one
  more asset behind the same policy.
