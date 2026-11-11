# Local TEXMF libraries are captured compiler inputs with their own origin, wired per distribution

**Status:** accepted
**Date:** 2026-11-11
**Default-folder setup and Preferences UI superseded by:**
[2026-11-11-latex-local-folder-default.md](2026-11-11-latex-local-folder-default.md).
The capture, search precedence and distribution wiring decisions remain accepted.

## Context

A reader could not register a personal TEXMF tree once and use its classes and
packages across projects. The bundled engine saw only a project-confined
snapshot, and the native runner replaced TEXMFHOME with an empty job directory,
so even an existing `~/texmf` was ignored. Copying a class beside every
document missed transitive `\LoadClass`/`\RequirePackage` loads.

Measured on 2026-11-11 (details in
[the plan](../plans/2026-11-10-local-texmf-libraries.md)):

- TeX Live 2025 (kpathsea 6.4.0): a relative brace list
  `TEXMFHOME={../texmf/0,../texmf/1}` resolves private files in list order,
  format-aware (the lualatex copy for lualatex, the latex copy for pdflatex,
  never the context copy), including `.bst`, Lua modules and `.otf` files, from
  a job path containing a comma, a space and `ü`. No `texhash` is needed.
- MiKTeX 23.1 ignores TEXMFHOME. `.;`-prefixed `TEXINPUTS`, `BSTINPUTS`,
  `BIBINPUTS`, `LUAINPUTS` and `OPENTYPEFONTS` with `//` work for all three
  engines; without the leading `.`, a library file beat the project's own copy.
  `--include-directory` does not recurse.
- The pinned WasmTeX LuaTeX worker writes its own `texmf.cnf`; kpathsea searches
  MEMFS directories on that path before the mirror resolver, so private names
  never meet its Bloom filter or negative cache. The SDK forwards project `.bib`
  files and a root-level `<style>.bst` to its separate BibTeX worker.
- WSL: Windows variables do not cross into WSL without WSLENV; `wsl.exe --exec
  /usr/bin/env -i …` passes an exact environment without a shell. Force-killing
  `wsl.exe` ended the Linux tree on WSL 2.7.11 (undocumented).

## Decision

- Registered libraries are an ordered, backend-owned settings list
  (`latexTexmfRoots`: id, kind personal|folder, path, layout tds|packages,
  enabled). Only `latex_texmf_configure` changes it; a whole-object settings
  save keeps the stored value. The personal folder resolves through
  `app_config_dir()/texmf` at use time.
- Rust indexes the runtime portions of each root under fixed bounds (8 roots,
  4,096 files, 64 MiB, 32 MiB per file, 16 levels, 65,536 entries), never
  follows links or junctions, rejects same-domain ambiguity, and captures one
  content-addressed snapshot per compile. A packages folder is mapped into a
  synthetic TDS tree. An enabled root that is missing, unreadable, oversized or
  conflicting fails the capture with a remedy.
- The snapshot travels beside the project (`ProjectSnapshot.texmf`), never in
  `files`. The project's generation includes its revision. Conversions request
  `includeLibraries: false`.
- Bundled engine: library files go through the SDK's public `files` option
  under the reserved `.mdraft-texmf/<n>/` prefix with a versioned manifest; the
  source-owned bootstrap worker replaces the upstream `writeTexmfCnf` global
  (the same mechanism as its `cacheFileName` hook) and inserts the library
  directories after `.` in TeX Live's lualatex order. A requested library
  `.bst`/`.bib` is handed off under its root name only when the project has no
  file of that name. The upstream worker stays byte-for-byte verified.
- Installed engines: libraries are staged as `job/texmf/<n>` and named by
  cwd-relative paths. kpathsea distributions get the TEXMFHOME brace list;
  MiKTeX gets the `.;`-prefixed variables. Nothing is registered with a
  distribution and no index updater runs.
- TeX Live inside WSL is a native target (`latexNativeWsl`): listed from the
  registry, looked into only by an explicit action, validated by a probe
  compile, and run through one launcher with a controlled PATH and an
  in-distribution `timeout`.

## Consequences

- Every change to wiring must keep the support matrix in the plan true; a
  regressed domain becomes a named limitation, not a silent gap.
- The bootstrap hook throws if the upstream cnf lines change; an SDK or engine
  repin must update `scripts/latex-sdk-unit.mjs` with the new lines.
- A computed `\bibliography`/`\bibliographystyle` name is outside the bundled
  handoff. Private font families by name are not supported; files by name are.
- Libraries add IPC bytes per compile, bounded by the limits above.
- WSL tests must run from a Medium-integrity copy of the test binary on hosts
  where the workspace is Low-integrity.
