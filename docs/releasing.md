# Publishing an MDraft release

The application release flow is **version-bump PR → merge into `master` → push
a new `v*` tag**. Merging a PR runs source checks; pushing the tag starts the
[Release workflow](../.github/workflows/release.yml), which builds and publishes
the downloadable artifacts. Do not create a release tag on an unmerged feature
branch.

The examples below use `0.9.2`. Substitute the intended, unused version throughout.
These instructions describe the main application; the optional Typst companion
has a separate `typst-service-v*` release line and
[workflow](../.github/workflows/typst-service-release.yml).

## 1. Prepare the version-bump PR

Follow the workspace and branch rules in [AGENTS.md](../AGENTS.md). Keep the main
checkout available to other tasks and create a dedicated clean worktree from
the latest `origin/master`:

```powershell
git fetch origin
git worktree add ../MDraft-work/release-0.9.2 -b codex/release-0.9.2 origin/master
cd ../MDraft-work/release-0.9.2
git status --porcelain
npm ci
```

The status output must be empty before editing. For agent-assisted releases,
obtain the written-plan approval required by AGENTS.md before a version bump
spanning more than three files; keep the plan in private owner storage.

Update the application version consistently in:

- `package.json` and the root package metadata in `package-lock.json`;
- `src-tauri/tauri.conf.json`;
- `src-tauri/Cargo.toml`;
- the `mdraft` package entry in `src-tauri/Cargo.lock`.

`npm version 0.9.2 --no-git-tag-version` updates the npm files without creating
a commit or tag. Update the Tauri and Rust metadata separately; do not change
unrelated dependency versions. The release tag must be exactly `v` followed by
the application version.

Check the intended tag and run the relevant release checks:

```powershell
node scripts/check-version.mjs v0.9.2
npm run build
.\scripts\cargo-vcvars.cmd test --manifest-path src-tauri\Cargo.toml
```

The cargo command above is for Windows. On Linux use
`cargo test --manifest-path src-tauri/Cargo.toml`. Run the affected functional
layers through the isolated harness, plus any manual installer/platform checks
needed for the changes being shipped. The source Quality checks are not a
substitute for checking release installers on supported platforms.

Stage only the intended files, run `npm run repo:hygiene` and
`npm run security:scan`, commit with a descriptive message, push the topic branch,
and open a PR into `master`. Merge it after Quality passes and the review is
done. Release changes always go through a PR, even while small fixes may be
pushed directly to `master`.

## 2. Tag the merged release commit

After the PR is merged, fetch again and use a fresh read-only checkout of the
merged default branch. This also works when the PR was squash-merged: do not
assume the version-bump branch's old commit is the merged commit.

Run these commands from the main repository directory:

```powershell
git fetch origin
git worktree add --detach ../MDraft-work/tag-0.9.2 origin/master
cd ../MDraft-work/tag-0.9.2
git status --porcelain
node scripts/check-version.mjs v0.9.2
git log -1 --oneline
git ls-remote --tags origin refs/tags/v0.9.2
```

Confirm the checkout is clean, the version check passes, and the commit shown is
the reviewed release commit. The last command must return no existing tag. If
the tag exists, inspect its existing release/run; do not replace it.

Create an annotated tag and push only that tag:

```powershell
git tag -a v0.9.2 -m "MDraft 0.9.2" HEAD
git push origin refs/tags/v0.9.2
```

The detached checkout is only for inspection and tagging; do not edit or commit
there. Avoid `git push --tags` and `--follow-tags`, which can publish unrelated
local tags. Existing `v*` tags are protected against updates and deletion; new
release tags can be created without disabling those protections.

## 3. Follow CI and verify the published artifacts

Open [Actions → Release](https://github.com/bgeneto/MDraft/actions/workflows/release.yml),
or list runs with:

```powershell
gh run list --repo bgeneto/MDraft --workflow release.yml --limit 5
```

For a pushed `v*` tag the workflow:

1. Checks that the tag, npm version, Tauri version and Rust crate version agree
   before installing the build toolchain.
2. Runs Rust tests and builds Windows x64 and Linux x64 in parallel. A failure
   on one platform does not cancel the other.
3. Stages outputs under `bin/windows/amd64/` and `bin/linux/amd64/` on the runners
   and uploads available workflow artifacts, even when a build fails later.
4. After **both** platform jobs succeed, creates a non-draft, non-prerelease
   GitHub release with generated notes and the staged installers/binaries.
   Checksums and manifests receive platform-specific names to avoid collisions.

The workflow uses GitHub's provided token; no personal publishing token is needed
in repository files. Only its publish job requests repository contents write
permission. The existing pinned-action and tag protections stay enabled.

Verify the files and platform checksums on the
[release page](https://github.com/bgeneto/MDraft/releases). Workflow artifacts
are also available from the run page. Do not commit generated build output.
The [Pages workflow](../.github/workflows/pages.yml) refreshes the site after a
successful tagged Release run, using the current default-branch site source and
latest stable release version. The `github-pages` environment only permits
deployments from branches, so a release published manually does not trigger the
site by itself; dispatch Pages from `master` after publishing it (see below).

## Failed builds and corrections

For a transient build failure, use **Re-run failed jobs** on the original run,
or dispatch the workflow against the same existing tag:

```powershell
gh workflow run release.yml --repo bgeneto/MDraft --ref v0.9.2
```

Dispatching against a branch builds inspection artifacts but skips the release
publish job; select the tag when retrying publication. A successful job on one
platform alone does not publish the combined release.

If a release had to be published manually (for example, from a run's artefacts
after an infrastructure failure), deploy the site separately. A manual release
does not trigger Pages, and the environment rejects tag refs:

```powershell
gh workflow run pages.yml --repo bgeneto/MDraft --ref master
```

The workflow checks out `master`, resolves the latest published release as the
site version, and deploys. Verify the version on the site afterwards.

If a fix requires source changes, merge a new PR with a new version and publish
a new tag. Do not move/delete the previous tag or replace already published
release files as an ordinary retry. Changes to published tags, assets or remote
security settings need explicit owner approval of the concrete operation.
