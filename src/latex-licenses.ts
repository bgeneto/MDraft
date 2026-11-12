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
  "[Engine manifest (2026-f5d94438a7c75a23)](https://corca-ai.github.io/wasmtex/wasmtex/2026/manifest.json)",
  "",
  "[Corresponding engine source archive](https://github.com/corca-ai/wasmtex/releases/download/engine-2026-f5d94438a7c75a23/wasmtex-2026-f5d94438a7c75a23-source.tar.xz)",
  "",
  "Source archive SHA-256: `e6a1f9b8ad84c7127368bb521217af381407fcc0d5c5518114345d55b470d637`.",
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
