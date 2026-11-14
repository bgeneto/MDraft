//! Exercise publication checks against real Git indexes and historical commits.
//!   npm run repo:hygiene:test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRepository, git, personalPaths } from "./repo-hygiene.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "mdraft-hygiene-test-"));
let count = 0;
const write = (name, value) => {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
};
const check = (label, callback) => {
  callback();
  console.log(`PASS ${label}`);
  count++;
};
const commit = () =>
  git(root, [
    "-c",
    "core.hooksPath=",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
try {
  git(root, ["init", "-q"]);
  const policy = {
    maxFileBytes: 1024 * 1024,
    samples: { "samples/needed.md": "test fixture" },
    images: {},
    documents: ["README.md"],
    sourceRoots: ["scripts", "src", "samples", "site", "docs", "tools", "profile", "coverage"],
    environmentTemplates: [".env.example"],
  };
  write("scripts/fixtures/public-assets.json", JSON.stringify(policy));
  write(".gitignore", "docs/plans/\n.env*\ncoverage/\n");
  write("README.md", "Public build guidance\n");
  write("samples/needed.md", "Synthetic fixture\n");
  write(".env.example", "# Synthetic configuration example only\n");
  write("src/naïve file.ts", "export const value = 1;\n");
  git(root, ["add", "-f", "."]);
  check("clean staged snapshot, safe template, and Unicode/space paths", () =>
    assert.deepEqual(checkRepository(root).failures, []),
  );
  check("generic documentation user names are not private identities", () =>
    assert.deepEqual(personalPaths(["", "home", "name", "example.md"].join("/")), []),
  );
  check("URL encoding cannot hide a private user directory", () =>
    assert.equal(
      personalPaths(["C%3A", "Users", "private-person", "document.md"].join("%5C")).length,
      1,
    ),
  );
  const image = "site/assets/img/reviewed.svg";
  const pixels = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  policy.images[image] = {
    purpose: "reviewed synthetic icon",
    sha256: createHash("sha256").update(pixels).digest("hex"),
  };
  write("scripts/fixtures/public-assets.json", JSON.stringify(policy));
  write(image, pixels);
  git(root, ["add", "scripts/fixtures/public-assets.json", image]);
  check("a reviewed image hash is accepted", () =>
    assert.deepEqual(checkRepository(root).failures, []),
  );
  write(image, "<svg><text>unreviewed replacement</text></svg>");
  git(root, ["add", image]);
  check("an accidental overwrite of an approved image is rejected", () =>
    assert(
      checkRepository(root).failures.some((failure) => failure.includes("image bytes changed")),
    ),
  );
  write(image, pixels);
  git(root, ["add", image]);
  const badPaths = [
    "docs/plans/private.md",
    ".env.production",
    "tools/helper/target/generated",
    "coverage/result.json",
    "samples/unreviewed.md",
    "site/assets/img/unreviewed.webp",
    "personal-notes.md",
    "profile/cache.sqlite3",
    "capture.har",
    "private-material/data.json",
  ];
  for (const name of badPaths) {
    write(name, "private/generated/unreviewed fixture\n");
    git(root, ["add", "-f", "--", name]);
    check(`forced addition is rejected: ${name}`, () =>
      assert(checkRepository(root).failures.some((failure) => failure.startsWith(name + ":"))),
    );
    git(root, ["rm", "-qf", "--", name]);
  }
  const userPath = ["C:", "Users", "private-person", "document.md"].join("/");
  write("src/value.ts", `const document = ${JSON.stringify(userPath)};\n`);
  git(root, ["add", "--", "src/value.ts"]);
  write("src/value.ts", "export const safe = true;\n");
  check("unstaged safe content cannot hide a staged personal path", () =>
    assert(
      checkRepository(root).failures.some((failure) => failure.includes("personal user-directory")),
    ),
  );
  git(root, ["add", "--", "src/value.ts"]);
  check("safe staged content is checked independently of the working tree", () => {
    write("src/value.ts", userPath);
    assert.deepEqual(checkRepository(root).failures, []);
  });
  write("src/value.ts", "export const safe = true;\n");
  commit();
  write("docs/plans/private.md", "An owner record\n");
  git(root, ["add", "-f", "--", "docs/plans/private.md"]);
  commit();
  git(root, ["rm", "-q", "docs/plans/private.md"]);
  commit();
  check("a clean tip cannot hide an owner record in its parents", () =>
    assert(
      checkRepository(root, { history: true }).failures.some((failure) =>
        failure.includes("docs/plans/private.md"),
      ),
    ),
  );
  check("the pre-push entry point checks outgoing refs other than HEAD", () => {
    const revision = git(root, ["rev-parse", "HEAD"]).toString().trim();
    const script = fileURLToPath(new URL("./repo-hygiene.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--root", root, "--pre-push"], {
      input: `refs/heads/other ${revision} refs/heads/other ${"0".repeat(40)}\n`,
      windowsHide: true,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pushed ref fails publication hygiene/);
  });
  check("Git index entries and policy remain available after history inspection", () => {
    assert(git(root, ["ls-files", "-z"]).includes(Buffer.from("naïve file")));
    assert.equal(
      JSON.parse(readFileSync(path.join(root, "scripts/fixtures/public-assets.json"))).samples[
        "samples/needed.md"
      ],
      "test fixture",
    );
  });
  console.log(`PASS ${count} publication hygiene checks`);
} finally {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith("mdraft-hygiene-test-"));
  rmSync(resolved, { recursive: true, force: true });
}
