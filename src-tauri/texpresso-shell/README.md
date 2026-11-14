# The TeXpresso shell

The page MDraft loads in the preview frame of the TeXpresso backend. Everything
here is embedded in the executable and served by
`src-tauri/src/latex_texpresso.rs` at `mdraft-tex://…/texpresso/`. Decision:
[the production ADR](../../docs/architecture.md).

## What is ours and what is not

| File | Origin |
| --- | --- |
| `index.html`, `texpresso.css`, `theme.js` | The markup, styles and theme script of the TeXpresso web application's page, release `release-0-133-g454f1bc`. The inline scripts and styles were moved into files so the frame's Content-Security-Policy needs no `'unsafe-inline'` for scripts. |
| `config.js` | TeXpresso's `config.js`, rewritten: the `tt2026` bundle only, data from `/texpresso-data/`, and every optional service (`feedback`, `crashes`, `mailbox`, `dropbox`, `github`, `movedFrom`, ICE servers) switched off. |
| `worker.js` | TeXpresso's worker entry, reduced to the two imports it needs. |
| `mdraft-pre.js`, `mdraft-boot.js`, `mdraft-bridge.js`, `mdraft-embedded.css` | MDraft's: dialog suppression and the service-worker shadow, engine selection before start, the `postMessage` bridge, and the styles that hide the application's own editor and toolbar. |

Not here, on purpose: `sw.js`, the web manifest, icons and the manual.

The application itself (`ocaml.js`, `ocaml-worker.js`, the engines, `xdvipdfmx`
and `vendor/`) is **not in this repository**. It is downloaded on demand from
the origin named in `src-tauri/texpresso.json`, and each file is refused unless
it matches the SHA-256 pinned there. The pins were taken from the copy captured
on 2026-11-12 and compared, byte for byte, with the files the release serves
(2026-11-13: all twelve identical). `vendor/codemirror/vim.js` and
`vendor/pdfjs/pdf.min.mjs` are not pinned: the embedded preview never asked
for them.

## Licence

- `let-def/texpresso`, the native tool, is MIT licensed (Frédéric Bour). The
  author confirmed that the web build is MIT as well, under the same terms.
  The notice is `src/assets/wasmtex-licenses/LICENSES/TeXpresso-MIT.txt`.
- The engines are modified XeTeX and LuaTeX. Upstream LuaTeX and `xdvipdfmx`
  are GPL (version 2 or later) and upstream XeTeX carries an MIT-style licence;
  the GPL source offer and the component notices stay with the distribution.
- The TeX Live files of the bundle keep their own licences, as they do for the
  WasmTex engine.

The licence gate is answered; the decision is recorded in
[the production ADR](../../docs/architecture.md).
