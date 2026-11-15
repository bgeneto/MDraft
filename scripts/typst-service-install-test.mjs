// Opt-in end-to-end check for the published Typst companion service.
//
// It exercises the same path as Preferences › Export: the app downloads the
// release archive named by the embedded manifest, verifies its pinned SHA-256,
// unpacks it under app_data_dir/typst/service/<version>/, then compiles a
// `.typ` preview through the daemon.
//
// The suite downloads from the public GitHub release, so it is skipped unless
// `MDRAFT_TYPST_SERVICE_E2E=1` is set. It runs against the isolated
// `.test-automation` profile, never the owner's data.
//
// Usage: node scripts/typst-service-install-test.mjs <cdp-port>

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openPage, sleep } from "./cdp-page.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.argv[2];
if (!port) {
  console.error("usage: node scripts/typst-service-install-test.mjs <cdp-port>");
  process.exit(2);
}

if (process.env.MDRAFT_TYPST_SERVICE_E2E !== "1") {
  console.log(
    "SKIP: set MDRAFT_TYPST_SERVICE_E2E=1 to download and install the published Typst service",
  );
  process.exit(0);
}

const target =
  process.platform === "win32" && process.arch === "x64"
    ? "x86_64-pc-windows-msvc"
    : process.platform === "linux" && process.arch === "x64"
      ? "x86_64-unknown-linux-musl"
      : null;
if (!target) {
  console.log(`SKIP: no published Typst service asset for ${process.platform}/${process.arch}`);
  process.exit(0);
}

const manifest = JSON.parse(
  readFileSync(join(repoRoot, "src-tauri", "typst-service.json"), "utf8"),
);
const asset = manifest.assets[target];
if (!asset) {
  console.error(`FAIL  the manifest has no asset for ${target}`);
  process.exit(1);
}

let passed = 0;
let total = 0;
function check(label, ok, detail = "") {
  total += 1;
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ""}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

const samplesDir = join(repoRoot, "samples");
const initialTempFiles = new Set(
  readdirSync(samplesDir).filter((name) => name.startsWith(".mdraft-preview-")),
);

const page = await openPage(port);
try {
  // 1. The public archive the manifest names must be the pinned bytes.
  const url = `${manifest.releaseUrl.replace(/\/$/, "")}/${asset.assetName}`;
  const response = await fetch(url, { redirect: "follow" });
  check(`the release asset responds (${url})`, response.ok, `HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  check(
    `${asset.assetName} byte length matches the manifest`,
    archive.length === asset.bytes,
    `expected ${asset.bytes}, got ${archive.length}`,
  );
  const digest = createHash("sha256").update(archive).digest("hex");
  check(
    `${asset.assetName} SHA-256 matches the manifest`,
    digest === asset.sha256,
    `expected ${asset.sha256}, got ${digest}`,
  );

  // 2. The isolated profile starts without a managed service and the embedded
  // manifest makes the install available.
  const before = await page.evaluate(`window.__TAURI_INTERNALS__.invoke("typst_service_status")`);
  check("the isolated profile starts without the service", before?.installed === false);
  check("the embedded manifest is installable", before?.canInstall === true);
  check(
    "the pre-install hint does not claim a checksum is missing",
    !String(before?.hint ?? "").includes("awaiting published release checksum"),
    String(before?.hint ?? ""),
  );

  // 3. Run the real install command without holding the CDP evaluate call open
  // for the whole download; poll the result instead.
  await page.evaluate(`(() => {
    window.__mdraftTypstInstall = { done: false, error: null, status: null };
    window.__TAURI_INTERNALS__
      .invoke("install_typst_service")
      .then((status) => {
        window.__mdraftTypstInstall.done = true;
        window.__mdraftTypstInstall.status = status;
      })
      .catch((error) => {
        window.__mdraftTypstInstall.done = true;
        window.__mdraftTypstInstall.error = String(error);
      });
  })()`);

  const installDeadline = Date.now() + 10 * 60 * 1000;
  let install;
  while (Date.now() < installDeadline) {
    install = await page.evaluate(`window.__mdraftTypstInstall`);
    if (install?.done) break;
    await sleep(500);
  }
  check("the install command completes", install?.done === true);
  check("the install command succeeds", !install?.error, String(install?.error ?? ""));

  // 4. The installed status is the pinned service, and the unpacked binary is
  // really on disk.
  const after = await page.evaluate(`window.__TAURI_INTERNALS__.invoke("typst_service_status")`);
  check("the service reports installed", after?.installed === true);
  check("the service version is 0.1.0", after?.version === "0.1.0", String(after?.version));
  check(
    "the Typst version is 0.15.1",
    after?.typstVersion === "0.15.1",
    String(after?.typstVersion),
  );
  check("the protocol version is 1", after?.protocolVersion === 1, String(after?.protocolVersion));
  check(
    "the manifest version is 0.1.0",
    after?.manifestVersion === "0.1.0",
    String(after?.manifestVersion),
  );
  check(
    "the installed path exists and is a file",
    Boolean(after?.path) && existsSync(after.path) && statSync(after.path).isFile(),
    String(after?.path),
  );
  check(
    "the installed hint no longer waits for a checksum",
    !String(after?.hint ?? "").includes("awaiting published release checksum"),
    String(after?.hint ?? ""),
  );

  // 5. Enable the service and force a compile. `compileCount` only advances
  // when the daemon compiled in-process, so it proves this was not a CLI run.
  const settings = await page.evaluate(`window.__TAURI_INTERNALS__.invoke("get_settings")`);
  settings.typstIncrementalService = true;
  await page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("save_settings", { settings: ${JSON.stringify(settings)} })`,
  );

  const previewReady = await waitFor(
    `Boolean(document.querySelector(".typst-page-shell, .typst-document"))`,
    20_000,
  );
  check("the Typst preview is ready before compiling", previewReady);
  const clicked = await page.evaluate(`(() => {
    const button = document.querySelector(".compiled-compile");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  check("the Compile button is available", clicked === true);

  const serviceDeadline = Date.now() + 60_000;
  let service;
  while (Date.now() < serviceDeadline) {
    service = await page.evaluate(`window.__TAURI_INTERNALS__.invoke("typst_service_status")`);
    if (service?.compileCount > 0 && service?.active) break;
    await sleep(250);
  }
  check("the service is enabled", service?.enabled === true);
  check("the service worker is active", service?.active === true);
  check(
    "the service compiled the preview",
    service?.compileCount > 0,
    String(service?.compileCount),
  );

  const newTempFiles = readdirSync(samplesDir).filter(
    (name) => name.startsWith(".mdraft-preview-") && !initialTempFiles.has(name),
  );
  check(
    "the service wrote no preview temp files",
    newTempFiles.length === 0,
    newTempFiles.join(", "),
  );

  // 6. Turning it off must still render through the stock CLI.
  const beforeFallback = service?.compileCount ?? 0;
  settings.typstIncrementalService = false;
  await page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("save_settings", { settings: ${JSON.stringify(settings)} })`,
  );
  await page.evaluate(`(() => {
    const button = document.querySelector(".compiled-compile");
    if (button && !button.disabled) button.click();
  })()`);
  await sleep(3000);
  const fallback = await page.evaluate(`window.__TAURI_INTERNALS__.invoke("typst_service_status")`);
  check("disabling the service stops using it", fallback?.enabled === false);
  check(
    "the service compile count does not advance after disabling",
    (fallback?.compileCount ?? 0) === beforeFallback,
    `${beforeFallback} -> ${fallback?.compileCount}`,
  );
  const fallbackPreview = await page.evaluate(
    `Boolean(document.querySelector(".typst-page-shell, .typst-document"))`,
  );
  check("the preview still renders through the CLI fallback", fallbackPreview);
} finally {
  page.close();
}

console.log(`${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);

async function waitFor(expression, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
}
