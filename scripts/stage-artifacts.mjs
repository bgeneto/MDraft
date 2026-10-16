#!/usr/bin/env node
//! Stage the built installers into bin/<os>/<arch>/.
//!
//! Tauri scatters its output across
//! `src-tauri/target/release/bundle/<kind>/`, which makes it awkward to attach
//! to a release. This collects the runnable binary and every installer it finds
//! into one predictable folder, with checksums and a manifest.
//!
//!   node scripts/stage-artifacts.mjs [--dry-run]

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

/** Rust target triples, not Node's, name the release folder. */
const OS = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] ?? process.platform;
const ARCH = { x64: "amd64", arm64: "arm64", ia32: "386" }[process.arch] ?? process.arch;

/** Tauri's bundle subdirectory for each target, with the extensions it emits. */
const BUNDLE_KINDS = {
  nsis: [".exe"],
  msi: [".msi"],
  dmg: [".dmg"],
  deb: [".deb"],
  rpm: [".rpm"],
  appimage: [".AppImage"],
};

const config = JSON.parse(readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
const productName = config.productName;
const version = config.version ?? "0.0.0";

const releaseDir = join(repoRoot, "src-tauri", "target", "release");
const bundleRoot = join(releaseDir, "bundle");
const destDir = join(repoRoot, "bin", OS, ARCH);

if (!existsSync(bundleRoot)) {
  console.error(`No bundles at ${bundleRoot}.`);
  console.error("Run the build first:  npm run dist");
  process.exit(1);
}

/** Everything to stage, as absolute source paths. */
const sources = [];

// The bare executable, for people who would rather not install anything.
//
// Its name is not simply the product name: cargo names the binary after the
// Cargo package, while `productName` is the display name the bundlers use. With
// productName "MDraft" and package "mdraft" the two differ only in case on
// Windows, but they can differ outright (a spaced product name, a renamed
// package), so try every plausible name instead of guessing one.
const cargoPackage = (() => {
  try {
    const toml = readFileSync(join(repoRoot, "src-tauri", "Cargo.toml"), "utf8");
    const section = toml.split(/^\[/m).find((part) => part.startsWith("package]"));
    return /^\s*name\s*=\s*"([^"]+)"/m.exec(section ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
})();

const binaryNames = [...new Set(
  [config.mainBinaryName, productName, cargoPackage].filter(
    (name) => typeof name === "string" && name.length > 0,
  ),
)];

for (const name of binaryNames) {
  const candidate = [join(releaseDir, `${name}.exe`), join(releaseDir, name)].find(
    (path) => existsSync(path) && statSync(path).isFile(),
  );
  if (candidate) {
    sources.push(candidate);
    break;
  }
}

const skipped = [];
for (const [kind, extensions] of Object.entries(BUNDLE_KINDS)) {
  const dir = join(bundleRoot, kind);
  if (!existsSync(dir)) continue;
  let matched = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // A macOS .app is a directory; distributing it needs `ditto`/zip, which is
      // a packaging decision rather than a copy.
      skipped.push(`${kind}/${entry} (directory)`);
      continue;
    }
    if (!extensions.some((ext) => entry.endsWith(ext))) continue;
    // Tauri names bundles `<productName>_<version>_<rest>`, but the directory
    // keeps whatever an earlier build left there. Copying everything would ship
    // an installer carrying the previous product name or version, which is how a
    // rename silently produces two installers with different names.
    if (!entry.includes(productName) || !entry.includes(version)) {
      skipped.push(`${kind}/${entry} (not ${productName} ${version})`);
      continue;
    }
    sources.push(full);
    matched++;
  }
  if (matched === 0) {
    console.error(`No ${kind} bundle matching "${productName}" ${version} in ${dir}.`);
    console.error(`Contents: ${readdirSync(dir).join(", ") || "(empty)"}`);
    process.exit(1);
  }
}

if (sources.length === 0) {
  console.error(`Found no artefacts under ${bundleRoot}.`);
  process.exit(1);
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const humanSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;

if (dryRun) {
  console.log(`would stage into bin/${OS}/${ARCH}/`);
  for (const source of sources) console.log(`  ${source}`);
  process.exit(0);
}

// Remove stale artefacts so an older version cannot linger next to a new one.
if (existsSync(destDir)) {
  for (const entry of readdirSync(destDir)) {
    const full = join(destDir, entry);
    if (statSync(full).isFile() && /\.(exe|msi|msix|dmg|deb|rpm|AppImage|zip|txt|json)$/i.test(entry)) {
      rmSync(full, { force: true });
    }
  }
}
mkdirSync(destDir, { recursive: true });

const staged = [];
for (const source of sources) {
  const name = source.split(/[\\/]/).pop();
  const target = join(destDir, name);
  copyFileSync(source, target);
  staged.push({ name, bytes: statSync(target).size, sha256: sha256(target) });
}
staged.sort((a, b) => a.name.localeCompare(b.name));

// `sha256sum -c` compatible, so it works with the usual tooling.
writeFileSync(
  join(destDir, "SHA256SUMS.txt"),
  staged.map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n",
);

writeFileSync(
  join(destDir, "manifest.json"),
  JSON.stringify(
    {
      product: productName,
      version,
      os: OS,
      arch: ARCH,
      generatedAt: new Date().toISOString(),
      files: staged,
    },
    null,
    2,
  ) + "\n",
);

console.log(`staged ${staged.length} artefact(s) into bin/${OS}/${ARCH}/`);
for (const file of staged) {
  console.log(`  ${humanSize(file.bytes).padStart(9)}  ${file.name}`);
}
console.log(`  ${"".padStart(9)}  SHA256SUMS.txt, manifest.json`);
for (const note of skipped) console.log(`  skipped ${note}`);
