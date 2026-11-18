# LaTeX syntax service (vendored)

This directory is a verbatim copy of the MIT-licensed LaTeX syntax service used
by the project before the bundled PDF engine was removed (SDK version 0.1.0).
It contains no WebAssembly and no PDF engine: only the pure parser/tokenizer
modules reachable from `syntax.js` were copied. The package is no longer a
dependency; this copy exists so the project preserves the parser behaviour and
its tests without carrying the removed engine's name in source or docs.

The upstream project is Corca AI's Wasm TeX SDK, MIT licensed. See `LICENSE`.
