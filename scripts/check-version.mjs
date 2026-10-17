//! Check that every version in the repository agrees, and that a release tag
//! matches it.
//!
//!     node scripts/check-version.mjs          # the two files must agree
//!     node scripts/check-version.mjs v0.1.0   # ...and the tag must match
//!
//! Three places carry a version and Tauri only reads one of them:
//!
//! | File | Used for |
//! | --- | --- |
//! | `package.json` | the npm package, and what the About box shows |
//! | `src-tauri/tauri.conf.json` | the bundle names and the installer metadata |
//! | the git tag | what the release is called |
//!
//! They drift silently. A `v0.2.0` tag whose `tauri.conf.json` still says
//! `0.1.0` publishes installers named `MDraft_0.1.0_...` under a 0.2.0 release,
//! and nothing in the build complains. CI runs this before building so the
//! failure arrives in seconds instead of after a 20-minute build.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relative) {
  const path = join(repoRoot, relative);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`Could not read ${relative}: ${error.message}`);
    process.exit(1);
  }
}

const packageVersion = readJson("package.json").version;
const tauriVersion = readJson("src-tauri/tauri.conf.json").version;

// The crate's own version, which `env!("CARGO_PKG_VERSION")` bakes into the
// binary. It is not what names an installer — tauri.conf.json does that — so it
// drifts without anything visibly breaking, and it shipped a 0.2.0 build whose
// User-Agent still said 0.1.0.
const cargoVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(
  readFileSync("src-tauri/Cargo.toml", "utf8"),
)?.[1];

// An explicit argument wins; otherwise fall back to what GitHub Actions
// provides, so the same command works locally and in the workflow.
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";

const problems = [];

if (!packageVersion) problems.push("package.json has no version");
if (!tauriVersion) problems.push("src-tauri/tauri.conf.json has no version");

if (packageVersion && cargoVersion && packageVersion !== cargoVersion) {
  problems.push(
    `package.json says ${packageVersion} but src-tauri/Cargo.toml says ` +
      `${cargoVersion}. The crate version is compiled into the binary.`,
  );
}

if (packageVersion && tauriVersion && packageVersion !== tauriVersion) {
  problems.push(
    `package.json says ${packageVersion} but src-tauri/tauri.conf.json says ` +
      `${tauriVersion}. Tauri bundles the version from tauri.conf.json, so the ` +
      `installers would be named after the wrong release.`,
  );
}

const version = tauriVersion ?? packageVersion;

// A tag is only checked when one was supplied: running this on an ordinary
// commit is a valid use.
if (tag && version) {
  if (!tag.startsWith("v")) {
    problems.push(`the tag ${tag} does not start with "v"; expected v${version}`);
  } else if (tag.slice(1) !== version) {
    problems.push(
      `the tag ${tag} does not match the version ${version}. ` +
        `Bump both files first, or tag v${version}.`,
    );
  }
}

if (problems.length > 0) {
  console.error("Version check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  tag
    ? `versions agree: ${version}, tag ${tag}`
    : `versions agree: ${version} (package.json and tauri.conf.json)`,
);
