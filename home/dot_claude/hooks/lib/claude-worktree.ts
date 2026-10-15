import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createGit, defaultDeps } from "./claude-worktree-git.ts";
import type { Deps } from "./claude-worktree-git.ts";

// Creates Claude Code's worktrees under <git-common-dir>/worktree/worktree-<name>
// (spec K1-K3, K11). Removal and SubagentStop cleanup live in this module too
// (added by later tasks) so they share the "no new work" definition.

export type CreateResult =
  | { ok: true; path: string; reused: boolean; warnings: string[] }
  | {
      ok: false;
      reason:
        | "invalid-name"
        | "not-git"
        | "bare-repo"
        | "no-base-commit"
        | "symlinked-dir"
        | "path-occupied"
        | "branch-exists"
        | "git-failed";
      message: string;
    };

type WorktreeEntry = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  prunable: boolean;
};

// `git worktree list --porcelain -z`: NUL-terminated fields, an empty field
// ends a record. Unlike the newline form, a path holding "\n" cannot forge a
// field.
function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const field of stdout.split("\0")) {
    if (field === "") {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = {
        path: field.slice("worktree ".length),
        head: null,
        branch: null,
        bare: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length);
    else if (field.startsWith("branch "))
      current.branch = field.slice("branch ".length);
    else if (field === "bare") current.bare = true;
    else if (field === "prunable" || field.startsWith("prunable "))
      current.prunable = true;
  }
  if (current) entries.push(current);
  return entries;
}

const NAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ZERO_SHA_PATTERN = /^0+$/;

export function createWorktree(
  input: { name: string; cwd: string },
  deps: Deps = defaultDeps(),
): CreateResult {
  // One deadline covers the first attempt and the retry.
  return createOnce(input, createGit(deps, deps.now()), true);
}

type Git = ReturnType<typeof createGit>;

// canRetry: R8. Concurrent `git worktree add` calls can fail while reading each
// other's half-written admin dir (observed: "failed to read
// .git/worktrees/<x>/commondir"). When that happens and this call has already
// rolled back its own branch, redo the whole judgement once (K11).
function createOnce(
  input: { name: string; cwd: string },
  git: Git,
  canRetry: boolean,
): CreateResult {
  const fail = (
    reason: Extract<CreateResult, { ok: false }>["reason"],
    message: string,
  ): CreateResult => ({ ok: false, reason, message });

  const { name, cwd } = input;
  if (
    typeof name !== "string" ||
    !NAME_PATTERN.test(name) ||
    name.includes("..") ||
    name.endsWith(".lock")
  ) {
    return fail(
      "invalid-name",
      `invalid worktree name ${JSON.stringify(name)}: use letters, digits, ".", "_", "-" (1-100 chars, start and end with an alphanumeric, no "..", not ending in ".lock", no "/")`,
    );
  }
  const branch = `worktree-${name}`;
  const ref = `refs/heads/${branch}`;

  // The porcelain list runs once in the caller's cwd (which may be inside a
  // linked worktree); its first entry is the main worktree. Everything after
  // runs with the main worktree as cwd (never inside .git, M9).
  const listed = git(["worktree", "list", "--porcelain", "-z"], "read", cwd);
  if (!listed.ok) {
    return listed.timedOut
      ? fail("git-failed", "git worktree list timed out")
      : fail("not-git", `not inside a git repository: ${listed.stderr.trim()}`);
  }
  const entries = parseWorktreeList(listed.stdout);
  const main = entries[0];
  if (!main) return fail("not-git", "git worktree list returned no entries");
  if (main.bare) {
    return fail("bare-repo", `bare repository is not supported: ${main.path}`);
  }

  const refCheck = git(
    ["check-ref-format", "--branch", branch],
    "read",
    main.path,
  );
  if (!refCheck.ok) {
    return refCheck.timedOut
      ? fail("git-failed", "git check-ref-format timed out")
      : fail("invalid-name", `${branch} is not a valid branch name`);
  }

  const commonResult = git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "read",
    main.path,
  );
  if (!commonResult.ok) {
    return fail(
      "git-failed",
      `git rev-parse --git-common-dir failed: ${commonResult.stderr.trim()}`,
    );
  }
  let commonDir: string;
  try {
    commonDir = realpathSync(commonResult.stdout);
  } catch (error) {
    return fail(
      "git-failed",
      `cannot resolve git common dir: ${String(error)}`,
    );
  }
  if (CONTROL_CHARS.test(commonDir)) {
    // The path would be printed on a single stdout line (I1).
    return fail(
      "git-failed",
      "git common dir path contains control characters",
    );
  }

  const worktreeDir = join(commonDir, "worktree");
  const target = join(worktreeDir, branch);
  try {
    if (lstatSync(worktreeDir).isSymbolicLink()) {
      return fail("symlinked-dir", `${worktreeDir} is a symbolic link`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return fail(
        "git-failed",
        `cannot inspect ${worktreeDir}: ${String(error)}`,
      );
    }
  }

  const registered = entries.find((entry) => entry.path === target);
  if (registered) {
    if (registered.prunable) {
      return fail(
        "path-occupied",
        `${target} is registered but missing (prunable). Run \`git worktree prune\`, check that ${branch} holds nothing you need, then \`git branch -D ${branch}\``,
      );
    }
    const resolvable =
      registered.head !== null && !ZERO_SHA_PATTERN.test(registered.head);
    if (registered.branch === ref && resolvable) {
      return { ok: true, path: target, reused: true, warnings: [] };
    }
    const current =
      registered.branch ??
      (registered.head ? `detached ${registered.head}` : "unknown");
    return fail(
      "path-occupied",
      `${target} is registered with HEAD ${current}, not ${ref} at a commit (another call may be creating it, or an earlier creation was interrupted)`,
    );
  }
  try {
    lstatSync(target);
    return fail(
      "path-occupied",
      `${target} exists but is not a registered worktree`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return fail("git-failed", `cannot inspect ${target}: ${String(error)}`);
    }
  }

  // K2: branch from origin/HEAD without fetching; fall back to HEAD.
  const warnings: string[] = [];
  let baseSha: string;
  const originHead = git(
    [
      "rev-parse",
      "--verify",
      "--end-of-options",
      "refs/remotes/origin/HEAD^{commit}",
    ],
    "read",
    main.path,
  );
  if (originHead.ok) {
    baseSha = originHead.stdout;
  } else {
    if (originHead.timedOut)
      return fail("git-failed", "git rev-parse timed out");
    const headCommit = git(
      ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
      "read",
      main.path,
    );
    if (!headCommit.ok) {
      return headCommit.timedOut
        ? fail("git-failed", "git rev-parse timed out")
        : fail(
            "no-base-commit",
            "neither origin/HEAD nor HEAD resolves to a commit",
          );
    }
    baseSha = headCommit.stdout;
    const symbolic = git(
      ["symbolic-ref", "--short", "-q", "HEAD"],
      "read",
      main.path,
    );
    const where =
      symbolic.ok && symbolic.stdout !== ""
        ? symbolic.stdout
        : baseSha.slice(0, 7);
    warnings.push(`origin/HEAD not found; branching from HEAD (${where})`);
  }
  if (!SHA_PATTERN.test(baseSha)) {
    return fail(
      "git-failed",
      `unexpected base commit from git: ${JSON.stringify(baseSha)}`,
    );
  }

  // K11-1: creating the branch is the atomic claim on this name.
  const branchResult = git(
    ["branch", "--no-track", "--", branch, baseSha],
    "branch",
    main.path,
  );
  if (!branchResult.ok) {
    if (branchResult.timedOut) {
      return fail(
        "git-failed",
        `git branch timed out; ${branch} may exist (check with \`git branch --list ${branch}\`)`,
      );
    }
    const exists = git(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", ref],
      "read",
      main.path,
    );
    if (exists.ok) {
      return fail(
        "branch-exists",
        `${branch} already exists without a worktree at ${target}: another call may be creating it, or an earlier creation left it behind. If you have confirmed it is a leftover, remove it with \`git branch -D ${branch}\``,
      );
    }
    return fail(
      "git-failed",
      `git branch failed: ${branchResult.stderr.trim()}`,
    );
  }

  const addResult = git(
    ["worktree", "add", "--", target, branch],
    "add",
    main.path,
  );
  if (addResult.ok) {
    return { ok: true, path: target, reused: false, warnings };
  }

  const detail = addResult.stderr.trim();
  const recovery = `branch ${branch} was left behind; check it, then \`git branch -D ${branch}\``;
  if (addResult.timedOut) {
    // Outcome unknown: the worktree may be half-created, so touch nothing.
    return fail(
      "git-failed",
      `git worktree add did not finish (${detail}); ${recovery}`,
    );
  }

  // K11-3: delete only a branch this call made and nothing else uses.
  if (removeOwnBranch(git, main.path, ref, baseSha)) {
    if (canRetry) return createOnce(input, git, false);
    return fail("git-failed", `git worktree add failed: ${detail}`);
  }
  return fail("git-failed", `git worktree add failed: ${detail}; ${recovery}`);
}

function removeOwnBranch(
  git: Git,
  mainPath: string,
  ref: string,
  baseSha: string,
): boolean {
  const listed = git(
    ["worktree", "list", "--porcelain", "-z"],
    "read",
    mainPath,
  );
  if (!listed.ok) return false;
  if (parseWorktreeList(listed.stdout).some((entry) => entry.branch === ref))
    return false;
  const tip = git(
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    "read",
    mainPath,
  );
  if (!tip.ok || tip.stdout !== baseSha) return false;
  // update-ref -d with the old value is a compare-and-swap.
  return git(["update-ref", "-d", ref, baseSha], "update-ref", mainPath).ok;
}
