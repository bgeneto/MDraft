# The PhiTeX compatibility frame

The Linux fallback for WebKitGTK without JSPI (Ubuntu 26.04/26.10 ship
WebKitGTK 2.52.6). It hosts PhiTeX's `PreviewSession` and `Panel` on the
single-threaded `core1.wasm` worker and speaks MDraft's existing TeXpresso frame
protocol, so the host's toolbar, wait surface, source gestures, selection,
export and print do not fork.

## Files

- `index.html` — the frame document; the only script is `bundles/main.js`.
- `main.ts` — the bridge: `EditorHost`, a proxy `PreviewSink` over `Panel`, the
  protocol adapter, scroll viewport and export. Built to `bundles/main.js`.
- `bundles/engine-worker.js` — the frontends' single-thread worker bundle
  (`apps/overleaf/src/worker1.ts` at the pinned frontends revision), with its
  Shelf host rewritten to the frame's own `/phitex/shelf/` origin so the frame
  policy stays `connect-src 'self'`.
- `vendor/` — the pinned viewer/session source and licences; see
  `vendor/README.md`.

## Build

The release build needs the pinned frontends checkout, Node 24 and esbuild:

```sh
# from the MDraft checkout, with PHITEX_FRONTENDS pointing at the frontends
# revision named in vendor/README.md
node scripts/build-phitex-frame.mjs
```

The script bundles `main.ts` with esbuild, copies the pinned
`engine-worker.js`, rewrites its Shelf hosts, and writes `bundles/main.js` and
`bundles/engine-worker.js`. The generated files are committed so an ordinary
`npm run build` and a release do not need the frontends checkout; regenerate
them only when the pinned viewer/worker changes.

The engine and its data are not here: `src-tauri/phitex.json` pins the archive
(`core1.wasm`, the XeLaTeX format, TeX Live 2026 kernel, fonts, shims, Shelf
index and pack table) and `src-tauri/src/latex_phitex.rs` installs, serves and
caches it. The archive's whole SHA-256 is the trust root; the core checks each
Shelf pack against the release table again.

## Licence

The viewer and engine are AGPL-3.0-only; the application is AGPL-3.0-only. The
full notices are in `vendor/LICENSE` and `vendor/NOTICE`, and the source offer
is in `src/latex-licenses.ts`.

## Tests

`npm run build` typechecks the host and bundles the app. The frame itself is
tested against WebKitGTK 2.52.6 with the WebKitWebDriver harness in the owner
plan (`2026-11-17-latex-phitex-fallback.md`) and the `phitex-frame-test` script;
the Rust side has install/serve/path tests in `src-tauri/src/latex_phitex.rs`.
