//! The bundled engine's TeX Live year, read from the same file the backend reads.
//!
//! `src-tauri/latex-engine.json` names the active year and one profile per year; its
//! `active` line is the whole switch (docs/adr/2026-11-12-engine-profile-config.md).
//! Rust derives the asset root, the mirror and the digests from it, and the worker
//! shims in `public/wasmtex/<year>/` read their year from their own URL, so this
//! module only has to hand the SDK the year and the reader the size of the download.
// The attribute is what lets Node load this file for `scripts/latex-sdk-unit.mjs`, which
// imports `latex.ts` directly; Vite and tsc read it the same way.
import config from "../src-tauri/latex-engine.json" with { type: "json" };

interface EngineProfile {
  assets: Array<{ bytes: number }>;
}

const profiles = config.profiles as Record<string, EngineProfile>;
const profile = profiles[config.active];
if (!profile || !/^\d{4}$/.test(config.active)) {
  throw new Error(
    `src-tauri/latex-engine.json: "active" is ${config.active}, which has no profile`,
  );
}

/** The TeX Live year the SDK is told to compile with. */
export const LATEX_ENGINE_YEAR = config.active as "2025" | "2026";

/** The size of the engine download, in whole MiB, for the reader's messages. */
export const LATEX_DOWNLOAD_MIB = Math.round(
  profile.assets.reduce((total, asset) => total + asset.bytes, 0) / (1024 * 1024),
);
