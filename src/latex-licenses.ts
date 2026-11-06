//! Notices distributed with the pinned WasmTex SDK and separately loaded engines.
import sdkLicense from "./assets/wasmtex-licenses/WasmTex-MIT.txt?raw";
import thirdParty from "./assets/wasmtex-licenses/THIRD_PARTY_NOTICES.md?raw";

const notices = import.meta.glob("./assets/wasmtex-licenses/LICENSES/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const LATEX_LICENSES = [
  "# Experimental LuaLaTeX: licences and source",
  "",
  "The WasmTex SDK is MIT licensed. The separately downloaded LuaHBTeX engine is GPL-2.0-only, with component notices; BibTeX and individual TeX Live files have their own terms.",
  "",
  "[Engine manifest (2025-3a6c0df0b2b95005)](https://corca-ai.github.io/wasmtex/wasmtex/2025/manifest.json)",
  "",
  "[Corresponding engine source archive](https://github.com/corca-ai/wasmtex/releases/download/engine-2025-3a6c0df0b2b95005/wasmtex-2025-3a6c0df0b2b95005-source.tar.xz)",
  "",
  "Source archive SHA-256: `34529fcbdf887731d229fe8e25acacf862d04115cacdc0df0ba244a71017136b`.",
  "",
  "## WasmTex SDK",
  "",
  sdkLicense,
  "",
  "## WasmTex third-party notices",
  "",
  thirdParty,
  ...Object.entries(notices)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, text]) => ["", `## ${path.split("/").pop()}`, "", text]),
].join("\n");
