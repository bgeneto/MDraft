// Deny writes and history-changing Git commands while a protected branch is
// checked out, and deny branch switches from a dirty working tree.
//
// During active development master accepts direct commits, so no branch is
// protected and only the dirty-switch guard is active. Add "master" back to
// PROTECTED_BRANCHES to restore the topic-branch-only workflow.
//
// Deliberately no dependency on the plugin package: a plain { id, setup }
// object keeps this working across OpenCode builds whose plugin API differs.

import { execFileSync } from "node:child_process";
import path from "node:path";

const PROTECTED_BRANCHES = new Set<string>();

const MUTATING_GIT =
  /(?:^|[;&|]\s*)(?:&\s*)?git(?:\.exe)?\s+(?:-[Cc]\s+\S+\s+)*(?:commit|merge|rebase|cherry-pick|revert|reset|push|pull|apply|am|stash\s+(?:drop|pop|clear)|branch\s+-[dD]|tag\s+-d)\b/i;

// A branch-changing switch. `git checkout -- <path>` restores files and must
// stay allowed, so the negative lookahead exempts the pathspec form.
const SWITCH_GIT =
  /(?:^|[;&|]\s*)(?:&\s*)?git(?:\.exe)?\s+(?:-[Cc]\s+\S+\s+)*(?:switch|checkout)\b(?!\s+--(?:\s|$))/i;

// The recovery path for edits accidentally made on master: create a branch and
// take them along. A dirty feature branch may not do this.
const CREATE_BRANCH =
  /(?:^|[;&|]\s*)(?:&\s*)?git(?:\.exe)?\s+(?:-[Cc]\s+\S+\s+)*(?:switch\s+(?:-[cC]|--create)\b|checkout\s+(?:-[bB]|--orphan)\b)/i;

function normalized(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, path.resolve(root, candidate));
  if (relative === "") return false;
  const value = normalized(relative);
  return !value.startsWith("..") && !path.isAbsolute(relative);
}

export default {
  id: "mdraft.branch-guard",

  async setup(ctx: any) {
    const permission = ctx?.permission;
    const vcs = ctx?.vcs;
    if (typeof permission?.hook !== "function") {
      console.warn(
        "[mdraft.branch-guard] branch-aware permission hooks are unavailable; .githooks/pre-commit still guards commits",
      );
      return;
    }

    const root: string =
      ctx.location?.project?.canonical ?? ctx.location?.directory ?? process.cwd();

    const currentBranch = async (): Promise<string> => {
      try {
        return execFileSync("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], {
          encoding: "utf8",
          windowsHide: true,
        }).trim();
      } catch {
        try {
          if (typeof vcs?.get !== "function") return "";
          const info = await vcs.get();
          return info?.branch?.current ?? "";
        } catch {
          return "";
        }
      }
    };

    const denial = (branch: string) =>
      `BLOCKED: '${branch}' is protected. Create a topic branch first: ` +
      `git fetch origin && git switch -c <type>/<short-slug> origin/${branch}. ` +
      `Read-only work and 'git switch -c' are allowed.`;

    const dirtyDenial = (branch: string) =>
      `BLOCKED: the working tree has uncommitted changes on '${branch}'. ` +
      `Commit or stash them before switching, or use a separate worktree: ` +
      `git worktree add ../MDraft-work/<short-slug> -b <type>/<short-slug> origin/master. ` +
      `Do not carry another task's changes onto a new branch.`;

    const workingTreeDirty = (): boolean => {
      try {
        return (
          execFileSync("git", ["-C", root, "status", "--porcelain"], {
            encoding: "utf8",
            windowsHide: true,
          }).trim() !== ""
        );
      } catch {
        return false;
      }
    };

    await permission.hook("evaluate", async (event: any) => {
      if (event.action !== "edit" && event.action !== "shell") return;

      const branch = await currentBranch();
      const protectedBranch = PROTECTED_BRANCHES.has(branch);
      const resources: readonly string[] = event.resources ?? [];

      if (event.action === "edit") {
        if (protectedBranch && resources.some((resource) => isInside(root, resource))) {
          event.effect = "deny";
          event.message = denial(branch);
        }
        return;
      }

      if (protectedBranch && resources.some((command) => MUTATING_GIT.test(command))) {
        event.effect = "deny";
        event.message = denial(branch);
        return;
      }

      const switches = resources.filter((command) => SWITCH_GIT.test(command));
      if (!switches.length || !workingTreeDirty()) return;

      // Edits were already made on master; creating a topic branch is the
      // recovery path. Every other dirty switch can contaminate another task.
      if (protectedBranch && switches.some((command) => CREATE_BRANCH.test(command))) return;

      event.effect = "deny";
      event.message = dirtyDenial(branch);
    });
  },
};
