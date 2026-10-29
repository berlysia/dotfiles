import { realpath, stat } from "node:fs/promises";
import { execGit, type ExecGitResult } from "../git-env.ts";
import { hasUnsafeLabelChars, sanitizeLabel } from "../sanitize-label.ts";
import type { RepoIdentity } from "./types.ts";

export type RepoIdentityDeps = {
  stat: (path: string) => Promise<{ isDirectory(): boolean }>;
  realpath: (path: string) => Promise<string>;
  execGit: (
    args: readonly string[],
    cwd: string,
    opts: { signal?: AbortSignal },
  ) => Promise<ExecGitResult>;
};

export const defaultRepoIdentityDeps: RepoIdentityDeps = {
  stat,
  realpath,
  execGit,
};

// repo is shown in --json, which can reach a model's context, so it is held to
// the same character set as sanitizeLabel and a length cap.
const MAX_REPO_LENGTH = 1024;

const unknown = (repoStatus: "not-git" | "error"): RepoIdentity => ({
  repoStatus,
  repo: null,
  worktree: null,
  worktreePath: null,
  branch: null,
});

// One trailing newline is git's terminator. A newline left after removing it
// means the path itself holds one, and the part after it would be taken for a
// second path.
function singleLine(stdout: string): string | null {
  const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  return value === "" || value.includes("\n") ? null : value;
}

/**
 * Never throws. Runs up to three git commands in sequence (not one combined
 * rev-parse): in a bare repo or inside .git the toplevel lookup fails, and
 * combining would turn that into a failure of the whole identification.
 */
export async function identifyRepo(
  cwd: string,
  deps: RepoIdentityDeps = defaultRepoIdentityDeps,
  signal?: AbortSignal,
): Promise<RepoIdentity> {
  try {
    return await identify(cwd, deps, signal);
  } catch {
    return unknown("error");
  }
}

async function identify(
  cwd: string,
  deps: RepoIdentityDeps,
  signal: AbortSignal | undefined,
): Promise<RepoIdentity> {
  // Stat first so a dead cwd never starts git; git -C on a missing path would
  // also be "error", but only after a process launch.
  const gitOpts = signal ? { signal } : {};
  const cwdStat = await deps.stat(cwd).catch(() => null);
  if (cwdStat === null || !cwdStat.isDirectory()) return unknown("error");
  if (signal?.aborted) return unknown("error");

  const common = await deps.execGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
    gitOpts,
  );
  if (signal?.aborted) return unknown("error");
  if (common.timedOut || common.overflow) return unknown("error");
  if (common.code === 128 && common.stderr.includes("not a git repository")) {
    return unknown("not-git");
  }
  if (common.code !== 0) return unknown("error");

  const commonDir = singleLine(common.stdout);
  if (commonDir === null) return unknown("error");
  const repo = await deps.realpath(commonDir).catch(() => null);
  if (
    repo === null ||
    repo.length > MAX_REPO_LENGTH ||
    hasUnsafeLabelChars(repo)
  ) {
    return unknown("error");
  }

  const base: RepoIdentity = {
    repoStatus: "git",
    repo,
    worktree: null,
    worktreePath: null,
    branch: null,
  };

  const toplevel = await deps.execGit(
    ["rev-parse", "--show-toplevel"],
    cwd,
    gitOpts,
  );
  if (signal?.aborted) return unknown("error");
  const topValue = toplevel.code === 0 ? singleLine(toplevel.stdout) : null;
  const worktreePath =
    topValue === null ? null : await deps.realpath(topValue).catch(() => null);

  const head = await deps.execGit(
    ["symbolic-ref", "--short", "-q", "HEAD"],
    cwd,
    gitOpts,
  );
  if (signal?.aborted) return unknown("error");
  const headValue = head.code === 0 ? singleLine(head.stdout) : null;

  return {
    ...base,
    worktree:
      worktreePath === null ? null : sanitizeLabel(worktreePath, "tail"),
    worktreePath,
    branch: headValue === null ? null : sanitizeLabel(headValue, "head"),
  };
}
