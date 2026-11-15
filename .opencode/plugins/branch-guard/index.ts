// Deny writes and history-changing Git commands while master/main is checked
// out. The pre-commit hook is the tool-agnostic backstop; this plugin catches
// the common agent path at edit time and explains the remedy before any file
// changes.
//
// Deliberately no dependency on the plugin package: a plain { id, setup }
// object keeps this working across OpenCode builds whose plugin API differs.

import { execFileSync } from "node:child_process";
import path from "node:path";

const PROTECTED_BRANCHES = new Set(["master", "main"]);

const MUTATING_GIT =
  /(?:^|[;&|]\s*)(?:&\s*)?git(?:\.exe)?\s+(?:-[Cc]\s+\S+\s+)*(?:commit|merge|rebase|cherry-pick|revert|reset|push|pull|apply|am|stash\s+(?:drop|pop|clear)|branch\s+-[dD]|tag\s+-d)\b/i;

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

    await permission.hook("evaluate", async (event: any) => {
      const branch = await currentBranch();
      if (!PROTECTED_BRANCHES.has(branch)) return;

      const resources: readonly string[] = event.resources ?? [];

      if (event.action === "edit") {
        if (resources.some((resource) => isInside(root, resource))) {
          event.effect = "deny";
          event.message = denial(branch);
        }
        return;
      }

      if (event.action === "shell") {
        if (resources.some((command) => MUTATING_GIT.test(command))) {
          event.effect = "deny";
          event.message = denial(branch);
        }
      }
    });
  },
};
