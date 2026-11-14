//! Reject private records, unapproved assets, generated output and personal paths.
//!   node scripts/repo-hygiene.mjs [--history] [--root <repository>]
//! Reads Git objects from the index, so forced additions cannot bypass the policy.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function git(root, args, options = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args[0]} failed (${result.status ?? result.error?.code})`);
  return result.stdout;
}

export function gitFiles(root, revision = null) {
  const args = revision ? ["ls-tree", "-rz", revision] : ["ls-files", "--stage", "-z"];
  return git(root, args)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const fields = record.slice(0, tab).split(" ");
      return {
        name: record.slice(tab + 1),
        mode: fields[0],
        oid: revision ? fields[2] : fields[1],
        stage: revision ? "0" : fields[2],
      };
    });
}

export function readBlobs(root, files) {
  const ids = [...new Set(files.map((file) => file.oid))];
  if (!ids.length) return new Map();
  const data = git(root, ["cat-file", "--batch"], { input: `${ids.join("\n")}\n` });
  const blobs = new Map();
  let offset = 0;
  for (const oid of ids) {
    const end = data.indexOf(10, offset);
    if (end < 0) throw new Error("Incomplete Git object header");
    const [actual, type, sizeText] = data.subarray(offset, end).toString().split(" ");
    const size = Number(sizeText);
    if (actual !== oid || type !== "blob" || !Number.isSafeInteger(size) || size < 0)
      throw new Error("Unexpected Git object in the file index");
    offset = end + 1;
    if (offset + size >= data.length || data[offset + size] !== 10)
      throw new Error("Incomplete Git object contents");
    blobs.set(oid, data.subarray(offset, offset + size));
    offset += size + 1;
  }
  return blobs;
}

const privatePath =
  /(?:^|\/)(?:adr|audits|plans|handoffs|\.playwright-mcp|MDraft-owner|MDraft-live|mdraft-audit)(?:\/|$)|^docs\/(?:agent-guide|backlog[^/]*|og-source\.html|screenshots|samples|sample-files|texpresso|ícones)(?:\/|$)/i;
const generatedPath =
  /(?:^|\/)(?:node_modules|target|dist|dist-ssr|bin|_site|coverage|playwright-report|test-results|\.ruff_cache|\.pytest_cache|__pycache__|\.VSCodeCounter|\.local)(?:\/|$)/i;
const secretName =
  /(?:^|\/)(?:\.env(?:\..*)?|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|txt|env))?)(?:$)|\.(?:pem|key|pfx|p12|jks|keystore|kdbx)$/i;
const artifactName =
  /\.(?:log|har|etl|prof|cpuprofile|heapsnapshot|dmp|pdf|docx?|xlsx?|zip|7z|tar|gz|exe|dll|msi|so|dylib|AppImage|deb|rpm|bak|backup)$|\.(?:sqlite\d*|db)(?:-(?:wal|shm))?$/i;
const stateName = /(?:^|\/)(?:settings\.json|ai-prompts\.md|\.window-state\.json|\.mdraft\.json)$/i;
const imageName = /\.(?:png|jpe?g|webp|gif|bmp|svg|ico|icns)$/i;
const safeUser =
  /^(?:reader|writer|user|username|name|alice|bob|ana|me|x|u|test(?:[-_].*)?|example|demo|dev|runner|runneradmin|public|default|…|\{[^}]+\})$/i;

export function personalPaths(text) {
  const decoded = text.replace(/(?:%[a-f\d]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
  const matches = decoded.matchAll(
    /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/mnt\/[a-z]\/Users\/|\/(?:home|Users)\/)([^\\/\s"'`<>]+)/gi,
  );
  return [...matches].filter((match) => !safeUser.test(match[1]));
}

export function inspectFiles(files, blobs, policy, { historical = false } = {}) {
  const failures = [];
  const seen = new Set(files.map((file) => file.name));
  for (const file of files) {
    const label = file.name;
    const reject = (reason) => failures.push(`${label}: ${reason}`);
    if (file.stage !== "0") {
      reject("unmerged index entry");
      continue;
    }
    if (!["100644", "100755"].includes(file.mode)) {
      reject("symlinks and submodules need an explicit publication review");
      continue;
    }
    if (privatePath.test(label))
      reject("owner record or raw capture belongs outside the public repository");
    if (generatedPath.test(label) || artifactName.test(label))
      reject("generated output or document/archive export");
    const safeTemplate = (policy.environmentTemplates ?? []).includes(label);
    if (
      policy.rootFiles &&
      !label.includes("/") &&
      !policy.rootFiles.includes(label) &&
      !safeTemplate
    )
      reject("unreviewed file at the repository root");
    if (
      policy.sourceRoots &&
      label.includes("/") &&
      !policy.sourceRoots.includes(label.split("/")[0])
    )
      reject("folder is outside the reviewed public source roots");
    if (secretName.test(label) && !safeTemplate) reject("credential/environment/signing file");
    if (stateName.test(label) && label !== ".vscode/settings.json")
      reject("application/profile state");
    if (label.startsWith("samples/") && !policy.samples[label])
      reject("sample has no reviewed test purpose");
    if (imageName.test(label) && !policy.images[label])
      reject("image has no reviewed publication/test purpose");
    if (
      !historical &&
      (label.startsWith("docs/") || /\.(?:md|rst|txt)$/i.test(label)) &&
      !policy.documents.includes(label) &&
      !policy.samples[label]
    )
      reject("document is outside the public documentation inventory");
    const data = blobs.get(file.oid);
    if (!data) {
      reject("Git blob is missing");
      continue;
    }
    const image = policy.images[label];
    if (
      !historical &&
      image?.sha256 &&
      createHash("sha256").update(data).digest("hex") !== image.sha256
    )
      reject("image bytes changed without an explicit reviewed inventory update");
    if (data.length > policy.maxFileBytes)
      reject("file exceeds the reviewed source/asset size limit");
    if (!data.subarray(0, 8000).includes(0) && personalPaths(data.toString("utf8")).length)
      reject("literal personal user-directory path; use a synthetic fixture or portable path");
  }
  if (!historical) {
    for (const name of [
      ...Object.keys(policy.samples),
      ...Object.keys(policy.images),
      ...policy.documents,
    ])
      if (!seen.has(name)) failures.push(`${name}: required public inventory entry is missing`);
  }
  return [...new Set(failures)];
}

export function checkRepository(root, { history = false, revision = null } = {}) {
  const files = gitFiles(root, revision);
  const blobs = readBlobs(root, files);
  const config = files.find((file) => file.name === "scripts/fixtures/public-assets.json");
  if (!config) throw new Error("The staged public asset inventory is missing");
  const policy = JSON.parse(blobs.get(config.oid).toString("utf8"));
  const failures = inspectFiles(files, blobs, policy);
  let commits = 0;
  if (history) {
    const revisions = git(root, ["rev-list", revision ?? "HEAD"])
      .toString()
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    const seenTrees = new Set();
    const checkedFiles = new Set();
    const historicalBlobs = new Map(blobs);
    for (const revision of revisions) {
      const tree = git(root, ["rev-parse", `${revision}^{tree}`])
        .toString()
        .trim();
      if (seenTrees.has(tree)) continue;
      seenTrees.add(tree);
      const historicalFiles = gitFiles(root, revision).filter((file) => {
        const key = `${file.name}\0${file.mode}\0${file.oid}`;
        if (checkedFiles.has(key)) return false;
        checkedFiles.add(key);
        return true;
      });
      const missing = historicalFiles.filter((file) => !historicalBlobs.has(file.oid));
      for (const [oid, data] of readBlobs(root, missing)) historicalBlobs.set(oid, data);
      const found = inspectFiles(historicalFiles, historicalBlobs, policy, { historical: true });
      for (const issue of found) failures.push(`${revision.slice(0, 12)} ${issue}`);
    }
    let metadata = git(root, [
      "log",
      revision ?? "HEAD",
      "--format=%H%x00%ae%x00%ce%x00%B%x00",
    ]).toString("utf8");
    if (revision && git(root, ["cat-file", "-t", revision]).toString().trim() === "tag")
      metadata += git(root, ["cat-file", "-p", revision]).toString("utf8");
    if (personalPaths(metadata).length)
      failures.push("history: personal user-directory path in commit metadata");
    if (/@[^\s<>\0]+\.(?:lan|localdomain)\b/i.test(metadata))
      failures.push("history: workstation-hostname email identity");
    commits = revisions.length;
  }
  return { files: files.length, commits, failures: [...new Set(failures)] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const rootAt = args.indexOf("--root");
    const root =
      rootAt < 0
        ? path.resolve(fileURLToPath(new URL("..", import.meta.url)))
        : path.resolve(args[rootAt + 1]);
    if (args.includes("--pre-push")) {
      const revisions = new Set();
      for (const line of readFileSync(0, "utf8").trim().split(/\r?\n/).filter(Boolean)) {
        const fields = line.split(/\s+/);
        const revision = fields[1];
        if (fields.length !== 4 || !/^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(revision))
          throw new Error("Invalid pre-push ref input");
        if (!/^0+$/.test(revision)) revisions.add(revision);
      }
      for (const revision of revisions) {
        const result = checkRepository(root, { history: true, revision });
        if (result.failures.length)
          throw new Error(`Pushed ref fails publication hygiene: ${result.failures[0]}`);
        const scanner = fileURLToPath(new URL("./security-scan.mjs", import.meta.url));
        const resultScan = spawnSync(
          process.execPath,
          [scanner, "--history", "--revision", revision, "--root", root],
          { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] },
        );
        if (resultScan.error || resultScan.status !== 0)
          throw new Error("Pushed ref fails the secret scan");
      }
      console.log(`PASS publication checks for all ${revisions.size} pushed refs`);
    } else {
      const refAt = args.indexOf("--revision");
      const revision = refAt < 0 ? null : args[refAt + 1];
      if (revision !== null && !/^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(revision))
        throw new Error("Invalid scan revision");
      const result = checkRepository(root, { history: args.includes("--history"), revision });
      for (const failure of result.failures.slice(0, 40)) console.error(`FAIL ${failure}`);
      if (result.failures.length > 40)
        console.error(`FAIL ${result.failures.length - 40} additional policy violations`);
      if (result.failures.length) process.exitCode = 1;
      else
        console.log(
          `PASS publication hygiene: ${result.files} staged files${result.commits ? `; ${result.commits} commits` : ""}`,
        );
    }
  } catch (error) {
    console.error(`FAIL publication hygiene: ${error.message}`);
    process.exitCode = 1;
  }
}
