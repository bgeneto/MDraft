// Unit tests for the Optional tools selection and status rules.
//
//   node scripts/optional-tools-unit.mjs
//
// No application and no build: `src/optional-tools-state.ts` imports only types,
// which Node 24 strips. The dialog and the install queue are exercised in the CDP
// suite; this covers the rules that decide what starts checked, what the button
// says and how the three backend status shapes become rows.

import {
  OPTIONAL_TOOL_META,
  defaultSelection,
  downloadLabel,
  formatDownloadBytes,
  isInstallable,
  normalizeStatuses,
  progressPercent,
} from "../src/optional-tools-state.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const equal = (actual, expected, label) =>
  check(actual === expected, label, actual === expected ? "" : `got ${actual}, want ${expected}`);

const pandoc = (found = false, source = "path") => ({
  found,
  path: found ? "/usr/bin/pandoc" : null,
  version: found ? "3.12" : null,
  source: found ? source : null,
  pdfEngine: null,
});

const typst = (found = false, canInstall = true) => ({
  found,
  version: found ? "0.15.1" : null,
  path: found ? "/usr/bin/typst" : null,
  source: found ? "path" : null,
  canInstall,
  hint: canInstall ? "Install it from the official page." : "Automatic install is unavailable.",
  downloadPage: "https://typst.app/open-source/#download",
});

const latex = (overrides = {}) => ({
  backend: "none",
  bundledEnabled: false,
  bundledInstalled: false,
  previewInstalled: false,
  nativeEnabled: false,
  nativeRoot: null,
  nativeDistribution: null,
  nativeEngine: "lualatex",
  nativeEngines: [],
  nativeWsl: null,
  problem: null,
  ...overrides,
});

const missing = normalizeStatuses({
  pandoc: pandoc(false),
  typst: typst(false),
  latex: latex(),
});
const installed = normalizeStatuses({
  pandoc: pandoc(true),
  typst: typst(true),
  latex: latex({ backend: "native", nativeDistribution: "TeX Live 2025" }),
});

console.log("=== defaults ===");
equal(
  JSON.stringify(defaultSelection("first-run", missing)),
  JSON.stringify(["pandoc"]),
  "first run suggests Pandoc when it is missing",
);
equal(
  JSON.stringify(defaultSelection("first-run", installed)),
  JSON.stringify([]),
  "first run suggests nothing when every tool is ready",
);
equal(
  JSON.stringify(defaultSelection("context", missing, ["pandoc", "typst"])),
  JSON.stringify(["pandoc", "typst"]),
  "context checks exactly the tools the action needs",
);
equal(
  JSON.stringify(defaultSelection("manage", missing)),
  JSON.stringify([]),
  "manage starts empty",
);

console.log("\n=== button total ===");
equal(
  downloadLabel(["pandoc"], missing),
  `Download 1 item (≈ ${OPTIONAL_TOOL_META.pandoc.sizeMb} MB)`,
  "one selected item names its size",
);
equal(
  downloadLabel(["pandoc", "typst"], missing),
  `Download 2 items (≈ ${OPTIONAL_TOOL_META.pandoc.sizeMb + OPTIONAL_TOOL_META.typst.sizeMb} MB)`,
  "two selected items add their sizes",
);
equal(downloadLabel([], missing), "Done", "nothing selected is Done");
equal(downloadLabel(["pandoc"], installed), "Done", "an already-ready selection is not a download");
equal(
  downloadLabel(["pandoc", "typst"], {
    ...missing,
    typst: { kind: "blocked", hint: "manual", action: "download-page" },
  }),
  `Download 1 item (≈ ${OPTIONAL_TOOL_META.pandoc.sizeMb} MB)`,
  "a blocked tool is not counted",
);

console.log("\n=== progress ===");
equal(progressPercent(20, 40), 50, "half the bytes is 50%");
equal(progressPercent(0, null), null, "no total is indeterminate");
equal(progressPercent(0, 0), null, "a zero total is indeterminate");
equal(progressPercent(80, 40), 100, "the percentage is clamped");
equal(formatDownloadBytes(40 * 1024 * 1024), "40.0 MB", "bytes are shown in MB");

console.log("\n=== status shapes ===");
equal(missing.pandoc.kind, "missing", "a missing Pandoc is installable");
check(isInstallable(missing.pandoc), "missing Pandoc can be installed");
const noAuto = normalizeStatuses({
  pandoc: pandoc(true),
  typst: typst(false, false),
  latex: latex({ backend: "native" }),
});
equal(noAuto.typst.kind, "blocked", "Typst canInstall false becomes blocked");
check(!isInstallable(noAuto.typst), "a blocked Typst cannot be installed here");
equal(
  noAuto.typst.kind === "blocked" ? noAuto.typst.action : "",
  "download-page",
  "the blocked Typst row points at the download page",
);
equal(installed.pandoc.kind, "ready", "a found Pandoc is ready");
equal(
  installed.pandoc.kind === "ready" ? installed.pandoc.source : "",
  "path",
  "a PATH Pandoc keeps its source",
);
equal(installed.latex.kind, "ready", "a native TeX backend is ready");
equal(
  installed.latex.kind === "ready" ? installed.latex.source : "",
  "native",
  "native TeX is marked as such",
);

const off = normalizeStatuses({
  pandoc: pandoc(true),
  typst: typst(true),
  latex: latex({ previewInstalled: true, bundledEnabled: false }),
});
equal(off.latex.kind, "off", "installed but switched-off TeX is off, not missing");

const broken = normalizeStatuses({
  pandoc: pandoc(true),
  typst: typst(true),
  latex: latex({
    backend: "native",
    problem: "The selected TeX installation has moved.",
  }),
});
equal(broken.latex.kind, "blocked", "a broken native TeX is blocked");
equal(
  broken.latex.kind === "blocked" ? broken.latex.action : "",
  "latex-preferences",
  "a broken native TeX points at Preferences",
);

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
