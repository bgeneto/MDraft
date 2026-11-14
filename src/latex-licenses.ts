//! Notices distributed with the pinned preview engine, the TeX Live data it
//! reads, and the hidden WasmTex backend that remains in the source.
import sdkLicense from "./assets/wasmtex-licenses/WasmTex-MIT.txt?raw";
import thirdParty from "./assets/wasmtex-licenses/THIRD_PARTY_NOTICES.md?raw";

const notices = import.meta.glob("./assets/wasmtex-licenses/LICENSES/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const LATEX_LICENSES = [
  "# LaTeX preview: licences and source",
  "",
  "The incremental preview engine (TeXpresso) is MIT licensed; the author confirmed that the web build carries the same licence as the native tool. Its LuaTeX and XeTeX engines and `xdvipdfmx` are GPL (version 2 or later), and the TeX Live files keep their own terms.",
  "",
  "The hidden WasmTex backend remains in the source for its regression layer; its SDK and engine notices are included below.",
  "",
  "[TeXpresso source](https://github.com/let-def/texpresso)",
  "",
  "## WasmTex manifest (hidden backend)",
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
