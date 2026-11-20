# PhiTeX viewer (vendored)

This directory is MDraft's pinned copy of the PhiTeX preview frontend used by
`src-tauri/phitex-shell/main.ts`.

- Upstream: `https://github.com/accl-kaust/PhiTeX-frontends`
  at `6607cb4f2d617fe45d0c2f32e3614390edb5a4c8` (viewer, overleaf platform and
  strippages).
- Viewer source: `common/src/viewer/` from that revision (the frontends
  submodule `phitex/viewer/src` at `a14d29f6c91d12c93b0ed2196fd49f56933d31bc`).
- Engine source: `https://github.com/accl-kaust/PhiTeX` at
  `69eea3393206fe553b77266df1bd3be98402d6b4` (the pinned release the archive's
  `core1.wasm`, formats and kernel files come from).
- The `platform.ts` and `common/platform.ts` files are the frontends' browser
  platform (IndexedDB, same-origin asset URLs).
- `LICENSE` is the PhiTeX AGPL-3.0-only licence text; `NOTICE` is the upstream
  notice with its third-party material.

Only the modules the viewer/session needs are copied. The engine is **not**
vendored here: its pinned archive is downloaded by `src-tauri/src/latex_phitex.rs`
from the MDraft origin. The single-thread host and engine are built for
`wasm32-wasip1`; they do not need JSPI or `SharedArrayBuffer`.

MDraft's embedded viewer options disable the opening and expose pane-relative
fit width in `panel.ts`. `viewer.ts` reads composed selection ranges on WebKit
and allows source marks without scrolling. `session.ts` exposes the existing
cached glyphs for scroll correspondence, cancels superseded selections, and
accepts replacement project snapshots on resync.

This copy is source, not a build: `bundles/main.js` and `bundles/engine-worker.js`
are generated from it and from the frontends' worker bundle; see
`src-tauri/phitex-shell/README.md`.
