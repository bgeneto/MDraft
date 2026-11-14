//! Pinned, redacted Gitleaks scan of Git's staged files and optionally HEAD history.
//!   node scripts/security-scan.mjs [--staged | --history | --self-test]
//! Tools/reports live in the OS cache/temp directory, never in the checkout.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitFiles, readBlobs } from "./repo-hygiene.mjs";

const VERSION = "8.30.1";
const ASSETS = {
  "win32-x64": [
    "windows_x64.zip",
    "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",
    "17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c",
  ],
  "win32-arm64": [
    "windows_arm64.zip",
    "b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f",
    "200df852fdecbedb19a33960657333cba5e231740bc8968972b507b50f93b194",
  ],
  "linux-x64": [
    "linux_x64.tar.gz",
    "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    "88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509",
  ],
  "linux-arm64": [
    "linux_arm64.tar.gz",
    "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
    "00e91bbe655bd7c47753e8cfe61cb76ea1a5d7e7702fe161ee40102b46b3823b",
  ],
  "darwin-x64": [
    "darwin_x64.tar.gz",
    "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
    "cee01fea7173f1b779dff188e1c26ecbcb4027d394acc573b23aaf0be260e291",
  ],
  "darwin-arm64": [
    "darwin_arm64.tar.gz",
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
    "ba52fb1bfabbcde42f032afad3d6e0b19dff8ed105229a16e7caa338bbc0e84f",
  ],
};
const hash = (data) => createHash("sha256").update(data).digest("hex");

function removeTemporary(directory, parent, prefix) {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(parent) ||
    !path.basename(resolved).startsWith(prefix)
  )
    throw new Error("Refusing cleanup outside the expected temporary directory");
  rmSync(resolved, { recursive: true, force: true });
}

function scanBytes(data) {
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) {
    if (data.length % 2) throw new Error("Invalid UTF-16 source blob");
    const text = Buffer.from(data.subarray(2));
    if (data[0] === 0xfe) text.swap16();
    return Buffer.from(text.toString("utf16le"));
  }
  return data;
}

async function binary() {
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error("No pinned Gitleaks build for this platform");
  const cacheRoot =
    process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const cache = path.join(
    cacheRoot,
    "mdraft-security",
    `gitleaks-${VERSION}-${process.platform}-${process.arch}`,
  );
  const name = process.platform === "win32" ? "gitleaks.exe" : "gitleaks";
  const target = path.join(cache, name);
  mkdirSync(cache, { recursive: true });
  // Verify the executable on every run; an existing cache entry is not trusted.
  if (existsSync(target) && hash(readFileSync(target)) === asset[2]) return target;
  const archive = path.join(cache, `gitleaks_${VERSION}_${asset[0]}`);
  if (!existsSync(archive) || hash(readFileSync(archive)) !== asset[1]) {
    const response = await fetch(
      `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_${asset[0]}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) throw new Error(`Gitleaks download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== asset[1]) throw new Error("Gitleaks archive checksum mismatch");
    writeFileSync(archive, bytes);
  }
  const unpack = mkdtempSync(path.join(cache, "unpack-"));
  try {
    const result = spawnSync("tar", ["-xf", archive, "-C", unpack, name], {
      windowsHide: true,
      stdio: "pipe",
    });
    if (result.error || result.status !== 0)
      throw new Error("Cannot unpack pinned Gitleaks; install the platform tar utility");
    const extracted = path.join(unpack, name);
    if (hash(readFileSync(extracted)) !== asset[2])
      throw new Error("Gitleaks executable checksum mismatch");
    if (process.platform !== "win32") chmodSync(extracted, 0o700);
    renameSync(extracted, target);
  } finally {
    removeTemporary(unpack, cache, "unpack-");
  }
  return target;
}

export async function scan(root, { history = false, selfTest = false, revision = null } = {}) {
  const executable = await binary();
  const temp = mkdtempSync(path.join(os.tmpdir(), "mdraft-secret-scan-"));
  try {
    const files = gitFiles(root, revision);
    const blobs = readBlobs(root, files);
    const config = path.join(temp, "rules.toml");
    const ignore = path.join(temp, "empty-ignore");
    // Fixed default rules cannot be replaced by a working-tree config or environment override.
    writeFileSync(config, 'title = "MDraft publication scan"\n[extend]\nuseDefault = true\n');
    writeFileSync(ignore, "");
    const contents = path.join(temp, "staged");
    mkdirSync(contents);
    for (const file of files) {
      if (file.stage !== "0" || !["100644", "100755"].includes(file.mode))
        throw new Error("Unmerged or non-file Git index entry");
      const destination = path.resolve(contents, ...file.name.split("/"));
      if (!destination.startsWith(contents + path.sep)) throw new Error("Invalid staged path");
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, scanBytes(blobs.get(file.oid)));
    }
    const env = { ...process.env };
    delete env.GITLEAKS_CONFIG;
    delete env.GITLEAKS_CONFIG_TOML;
    const run = (mode, target, name, extra = []) => {
      const report = path.join(temp, `${name}.json`);
      const result = spawnSync(
        executable,
        [
          mode,
          "--config",
          config,
          "--gitleaks-ignore-path",
          ignore,
          "--ignore-gitleaks-allow",
          "--redact=100",
          "--no-banner",
          "--no-color",
          "--log-level=warn",
          "--report-format=json",
          "--report-path",
          report,
          "--max-archive-depth=3",
          ...extra,
          target,
        ],
        { env, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
      if (result.error || ![0, 1].includes(result.status))
        throw new Error(`Gitleaks ${name} failed to execute`);
      const findings = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : [];
      if (findings.length || result.status === 1) {
        // Never echo source lines, matches, token values, or temporary personal paths.
        const rules = [...new Set(findings.map((finding) => finding.RuleID))].join(", ");
        if (selfTest && name === "sentinel") return true;
        throw new Error(
          `${name}: ${findings.length} potential secrets (${rules || "scanner flagged content"}); inspect locally with redaction`,
        );
      }
      return false;
    };
    if (selfTest) {
      const sentinel = path.join(temp, "sentinel");
      mkdirSync(sentinel);
      writeFileSync(
        path.join(sentinel, "credential.txt"),
        `token = ${["gh", "p_"].join("")}${randomBytes(18).toString("hex")}\n`,
      );
      if (!run("dir", sentinel, "sentinel"))
        throw new Error("The secret detector failed its synthetic positive control");
      console.log("PASS pinned secret detector rejects a synthetic credential without printing it");
      const fixture = path.join(temp, "merge-fixture");
      mkdirSync(fixture);
      const fixtureEnv = {
        ...env,
        GIT_AUTHOR_NAME: "Synthetic fixture",
        GIT_COMMITTER_NAME: "Synthetic fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      };
      const fixtureGit = (args) => {
        const result = spawnSync("git", ["-C", fixture, ...args], {
          env: fixtureEnv,
          windowsHide: true,
          encoding: "utf8",
        });
        if (result.error || result.status !== 0)
          throw new Error(
            `Cannot prepare the synthetic history control (${args[0]}, ${result.status})`,
          );
        return result.stdout.trim();
      };
      fixtureGit(["init", "-q", "-b", "main"]);
      writeFileSync(path.join(fixture, "safe.txt"), "Public synthetic fixture\n");
      fixtureGit(["add", "safe.txt"]);
      const cleanTree = fixtureGit(["write-tree"]);
      const base = fixtureGit(["commit-tree", cleanTree, "-m", "base"]);
      const left = fixtureGit(["commit-tree", cleanTree, "-p", base, "-m", "left"]);
      const right = fixtureGit(["commit-tree", cleanTree, "-p", base, "-m", "right"]);
      writeFileSync(
        path.join(fixture, "credential.txt"),
        readFileSync(path.join(sentinel, "credential.txt")),
      );
      fixtureGit(["add", "credential.txt"]);
      const merged = fixtureGit([
        "commit-tree",
        fixtureGit(["write-tree"]),
        "-p",
        left,
        "-p",
        right,
        "-m",
        "merge-only fixture",
      ]);
      fixtureGit(["rm", "-qf", "credential.txt"]);
      const tip = fixtureGit(["commit-tree", cleanTree, "-p", merged, "-m", "remove fixture"]);
      fixtureGit(["update-ref", "refs/heads/main", tip]);
      let rejected = false;
      try {
        await scan(fixture, { history: true });
      } catch (error) {
        if (!error.message.includes("potential secrets")) throw error;
        rejected = true;
      }
      if (!rejected) throw new Error("A merge-only historical credential escaped the detector");
      console.log("PASS a clean tip cannot hide a merge-only historical synthetic credential");
      return;
    }
    run("dir", contents, "staged snapshot");
    if (history) {
      const ref = revision ?? "HEAD";
      if (ref !== "HEAD" && !/^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(ref))
        throw new Error("Invalid scan revision");
      run("git", root, "ref history", [`--log-opts=--full-history ${ref}`]);
      // A merge can introduce a secret without an ordinary added-line patch.
      // Inspect complete reachable blobs too, including files removed at the tip.
      const snapshots = path.join(temp, "history-blobs");
      mkdirSync(snapshots);
      const ids = git(root, ["rev-list", "--objects", "--no-object-names", ref])
        .toString()
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      const kinds = git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
        input: `${ids.join("\n")}\n`,
      })
        .toString()
        .trim()
        .split(/\r?\n/);
      const blobIds = kinds
        .filter((line) => line.endsWith(" blob"))
        .map((line) => line.split(" ")[0]);
      for (let start = 0; start < blobIds.length; start += 32) {
        const batch = blobIds.slice(start, start + 32).map((oid) => ({ oid }));
        for (const [oid, data] of readBlobs(root, batch)) {
          const text = scanBytes(data);
          if (text.subarray(0, 8000).includes(0)) continue;
          writeFileSync(path.join(snapshots, `${oid}.txt`), text);
        }
      }
      run("dir", snapshots, "complete historical blobs");
      const metadata = path.join(temp, "metadata");
      mkdirSync(metadata);
      writeFileSync(
        path.join(metadata, "commits.txt"),
        git(root, ["log", ref, "--format=%H%n%an <%ae>%n%cn <%ce>%n%B"]).toString("utf8"),
      );
      if (git(root, ["cat-file", "-t", ref]).toString().trim() === "tag")
        writeFileSync(path.join(metadata, "tag.txt"), git(root, ["cat-file", "-p", ref]));
      run("dir", metadata, "ref metadata");
    }
    console.log(
      `PASS pinned secret scan: ${files.length} staged files${history ? " and HEAD history" : ""}`,
    );
  } finally {
    removeTemporary(temp, os.tmpdir(), "mdraft-secret-scan-");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const rootAt = process.argv.indexOf("--root");
    const refAt = process.argv.indexOf("--revision");
    const root =
      rootAt < 0
        ? path.resolve(fileURLToPath(new URL("..", import.meta.url)))
        : path.resolve(process.argv[rootAt + 1]);
    const revision = refAt < 0 ? null : process.argv[refAt + 1];
    if (revision !== null && !/^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(revision))
      throw new Error("Invalid scan revision");
    await scan(root, {
      history: process.argv.includes("--history"),
      selfTest: process.argv.includes("--self-test"),
      revision,
    });
  } catch (error) {
    console.error(`FAIL secret scan: ${error.message}`);
    process.exitCode = 1;
  }
}
