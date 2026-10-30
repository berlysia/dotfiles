import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  DEADLINE_MS,
  HARDENING_ARGS,
  KIND_LIMIT_MS,
  PREP_TIMING,
  createGit,
  defaultDeps,
  gitEnv,
  runInOwnGroup,
} from "./claude-worktree-git.ts";
import type { Deps, GitResult } from "./claude-worktree-git.ts";
import {
  currentRoot,
  isUnderManagedRoot,
  legacyRoot,
  repoName,
} from "./worktree-locations.ts";
import { formatMarkerFailure, reserveMarker } from "./worktree-marker.ts";
import type { MarkerDecision } from "./worktree-marker.ts";

// Creates Claude Code's worktrees under ~/worktrees/<repo>/worktree-<name>
// (spec K1-K3, K11). Removal (K5) and SubagentStop cleanup (K6) live in this
// module too so they share one definition of "no new work" (K4).

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

  const home = process.env.HOME;
  if (!home) return fail("git-failed", "HOME is not set");
  let target: string;
  try {
    repoName(commonDir);
    target = join(currentRoot(commonDir, home), branch);
  } catch {
    return fail("git-failed", "git common dir is not supported for worktrees");
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

  let markerDecision: MarkerDecision;
  try {
    markerDecision = reserveMarker(commonDir, home, target);
  } catch (error) {
    return fail(
      "git-failed",
      `could not reserve worktree location: ${String(error)}`,
    );
  }
  if (markerDecision.kind !== "ok-same") {
    return fail(
      markerDecision.kind === "unsafe-path" ? "symlinked-dir" : "path-occupied",
      formatMarkerFailure(markerDecision, commonDir, home),
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

// ---------------------------------------------------------------------------
// Removal (K5) and SubagentStop cleanup (K6)
// ---------------------------------------------------------------------------

export type KeptReason =
  | "reflog-not-single-creation"
  | "tip-moved"
  | "prunable"
  | "remove-incomplete"
  | "cas-missed";

export type RemoveResult =
  // ok: true <=> worktree_path does not exist after the call. `removed` says
  // whether this call removed it (false = it was already gone).
  | {
      ok: true;
      removed: boolean;
      keptBranch?: { name: string; reason: KeptReason };
    }
  | {
      ok: false;
      reason:
        | "not-git"
        | "bare-repo"
        | "outside-managed-dirs"
        | "not-registered"
        | "unexpected-head"
        | "path-remains";
      message: string;
    };

export type SubagentCleanupResult =
  | { action: "none" }
  | { action: "removed"; keptBranch?: { name: string; reason: "cas-missed" } }
  | {
      action: "kept";
      detail:
        | "reflog-not-single-creation"
        | "tip-moved"
        | "has-changes"
        | "remove-failed"
        | "git-failed";
      // Why git was not run or the helper refused, when that is more than the detail says.
      note?: string;
    };

const AGENT_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

type RepoContext = {
  main: WorktreeEntry;
  entries: WorktreeEntry[];
  commonDir: string;
  home: string;
};

type RepoLookup =
  | { ok: true; repo: RepoContext }
  | {
      ok: false;
      kind: "list-failed" | "bare-repo" | "timed-out" | "git-failed";
      message: string;
    };

// The porcelain list runs once in the caller's cwd (it may be inside a linked
// worktree); its first entry is the main worktree, which is the cwd of every
// later git call (never inside .git, M9).
function lookupRepo(git: Git, cwd: string): RepoLookup {
  const listed = git(["worktree", "list", "--porcelain", "-z"], "read", cwd);
  if (!listed.ok) {
    return listed.timedOut
      ? { ok: false, kind: "timed-out", message: "git worktree list timed out" }
      : { ok: false, kind: "list-failed", message: listed.stderr.trim() };
  }
  const entries = parseWorktreeList(listed.stdout);
  const main = entries[0];
  if (!main) {
    return {
      ok: false,
      kind: "git-failed",
      message: "git worktree list returned no entries",
    };
  }
  if (main.bare) {
    return {
      ok: false,
      kind: "bare-repo",
      message: `bare repository is not supported: ${main.path}`,
    };
  }
  const common = git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "read",
    main.path,
  );
  if (!common.ok) {
    return {
      ok: false,
      kind: common.timedOut ? "timed-out" : "git-failed",
      message: `git rev-parse --git-common-dir failed: ${common.stderr.trim()}`,
    };
  }
  let commonDir: string;
  try {
    commonDir = realpathSync(common.stdout);
  } catch (error) {
    return {
      ok: false,
      kind: "git-failed",
      message: `cannot resolve git common dir: ${String(error)}`,
    };
  }
  const home = process.env.HOME;
  if (!home) {
    return {
      ok: false,
      kind: "git-failed",
      message: "HOME is not set",
    };
  }
  try {
    repoName(commonDir);
    currentRoot(commonDir, home);
    legacyRoot(commonDir);
  } catch {
    return {
      ok: false,
      kind: "git-failed",
      message: "git common dir is not supported for worktrees",
    };
  }
  return { ok: true, repo: { main, entries, commonDir, home } };
}

// realpath for a path that may not exist: resolve the deepest existing
// ancestor and re-append the rest.
function canonicalize(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...[...missing].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Registration is checked separately; this function applies the shared location rule.
function isManagedLocation(repo: RepoContext, canonical: string): boolean {
  return isUnderManagedRoot(canonical, repo.commonDir, repo.home);
}

function managedBranchName(repo: RepoContext, path: string): string | null {
  const candidate = resolve(path);
  for (const root of [
    currentRoot(repo.commonDir, repo.home),
    legacyRoot(repo.commonDir),
  ]) {
    const rel = relative(resolve(root), candidate);
    if (
      rel !== "" &&
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !isAbsolute(rel)
    ) {
      return rel.split(sep).join("/");
    }
  }
  return null;
}

function pathIsUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function verifyManagedPath(repo: RepoContext, path: string): string | null {
  const candidate = resolve(path);
  if (!isUnderManagedRoot(candidate, repo.commonDir, repo.home)) {
    return `${path} is outside the managed worktree roots`;
  }

  const current = resolve(currentRoot(repo.commonDir, repo.home));
  const legacy = resolve(legacyRoot(repo.commonDir));
  const worktrees = resolve(join(repo.home, "worktrees"));
  let root: string;
  let walkRoot: string;
  if (pathIsUnder(candidate, current)) {
    root = current;
    walkRoot = worktrees;
  } else if (pathIsUnder(candidate, legacy)) {
    root = legacy;
    walkRoot = legacy;
  } else {
    return `${path} is outside the managed worktree roots`;
  }

  let currentPath = walkRoot;
  const segments = relative(walkRoot, candidate).split(sep).filter(Boolean);
  for (const segment of ["", ...segments]) {
    if (segment !== "") currentPath = join(currentPath, segment);
    try {
      const stat = lstatSync(currentPath);
      if (stat.isSymbolicLink()) {
        return `${currentPath} is a symbolic link`;
      }
      if (!stat.isDirectory()) return `${currentPath} is not a directory`;
    } catch {
      return `cannot inspect managed worktree path ${currentPath}`;
    }
  }

  try {
    const realRoot = realpathSync(root);
    const realPath = realpathSync(candidate);
    if (!pathIsUnder(realPath, realRoot)) {
      return `${path} resolves outside ${root}`;
    }
  } catch {
    return `cannot resolve managed worktree path ${path}`;
  }
  return null;
}

type HeadState =
  | { ok: true; ref: string | null }
  | { ok: false; message: string };

// ref is null for a detached HEAD (`symbolic-ref -q` exits 1 silently).
function readHeadRef(git: Git, worktreePath: string): HeadState {
  const head = git(["symbolic-ref", "-q", "HEAD"], "read", worktreePath);
  if (head.ok) return { ok: true, ref: head.stdout };
  if (!head.timedOut && head.status === 1) return { ok: true, ref: null };
  return {
    ok: false,
    message: `cannot read HEAD of ${worktreePath}: ${head.stderr.trim()}`,
  };
}

type WorkJudgement =
  | { kind: "done"; tip: string }
  | { kind: "unexpected-head" }
  | { kind: "has-work"; reason: "reflog-not-single-creation" | "tip-moved" }
  | { kind: "failed"; message: string };

// K4: "no new work" only when all three hold: HEAD is the branch itself, the
// branch reflog is exactly one `branch: Created from ` entry, and the tip is
// that entry's commit. Anything else (detached, reset, reflog off or expired)
// counts as work and keeps the branch. `tip` is the CAS expectation.
function isWorkDone(
  git: Git,
  mainPath: string,
  ref: string,
  headRef: string | null,
): WorkJudgement {
  if (headRef !== ref) return { kind: "unexpected-head" };
  const log = git(
    ["reflog", "show", "--format=%H%x09%gs", "--end-of-options", ref],
    "read",
    mainPath,
  );
  if (!log.ok) {
    return {
      kind: "failed",
      message: `cannot read reflog of ${ref}: ${log.stderr.trim()}`,
    };
  }
  const lines = log.stdout === "" ? [] : log.stdout.split("\n");
  const only = lines.length === 1 ? lines[0] : undefined;
  const tab = only === undefined ? -1 : only.indexOf("\t");
  if (only === undefined || tab < 0) {
    return { kind: "has-work", reason: "reflog-not-single-creation" };
  }
  const created = only.slice(0, tab);
  const subject = only.slice(tab + 1);
  if (
    !subject.startsWith("branch: Created from ") ||
    !SHA_PATTERN.test(created)
  ) {
    return { kind: "has-work", reason: "reflog-not-single-creation" };
  }
  const tip = git(
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    "read",
    mainPath,
  );
  if (!tip.ok) {
    return {
      kind: "failed",
      message: `cannot resolve ${ref}: ${tip.stderr.trim()}`,
    };
  }
  if (tip.stdout !== created) return { kind: "has-work", reason: "tip-moved" };
  return { kind: "done", tip: tip.stdout };
}

// WorktreeRemove (K5): remove a "removable" worktree, and its branch only when
// K4 says nothing new was done. Order: location -> registration -> HEAD -> K4
// -> `remove --force` once -> recheck the path -> CAS delete. Never prunes.
export function removeWorktree(
  input: { worktreePath: string; cwd: string },
  deps: Deps = defaultDeps(),
): RemoveResult {
  const startedAt = deps.now();
  const git = createGit(deps, startedAt);
  const fail = (
    reason: Extract<RemoveResult, { ok: false }>["reason"],
    message: string,
  ): RemoveResult => ({ ok: false, reason, message });

  const { worktreePath, cwd } = input;
  if (typeof cwd !== "string" || cwd === "") {
    return fail("not-git", "cwd is missing");
  }
  if (
    typeof worktreePath !== "string" ||
    !isAbsolute(worktreePath) ||
    worktreePath.includes("\0") ||
    worktreePath.split("/").includes("..")
  ) {
    return fail(
      "outside-managed-dirs",
      `worktree path must be absolute and free of ".." segments: ${JSON.stringify(worktreePath)}`,
    );
  }

  const lookup = lookupRepo(git, cwd);
  if (!lookup.ok) {
    if (lookup.kind === "bare-repo") return fail("bare-repo", lookup.message);
    if (lookup.kind === "list-failed") {
      return fail("not-git", `not inside a git repository: ${lookup.message}`);
    }
    // Nothing was touched; the path (if any) is still there.
    return fail("path-remains", lookup.message);
  }
  const { repo } = lookup;

  const canonical = canonicalize(worktreePath);
  const exists = pathExists(worktreePath);
  const registered = repo.entries.find(
    (entry) => canonicalize(entry.path) === canonical,
  );

  // 1. Gone and unknown: nothing to do, wherever it was.
  if (!exists && !registered) return { ok: true, removed: false };
  // 2. Location first, then registration.
  if (!isManagedLocation(repo, canonical)) {
    return fail(
      "outside-managed-dirs",
      `${worktreePath} is outside the managed worktree roots`,
    );
  }
  if (!registered) {
    return fail(
      "not-registered",
      `${worktreePath} is under a managed root but is not a registered worktree`,
    );
  }
  const branchName = managedBranchName(repo, canonical) ?? basename(canonical);
  const ref = `refs/heads/${branchName}`;
  // 3. Registered but the directory is gone: leave registration and branch.
  if (registered.prunable || !exists) {
    return {
      ok: true,
      removed: false,
      keptBranch: { name: branchName, reason: "prunable" },
    };
  }

  // 4. + K4, while the worktree still exists.
  const head = readHeadRef(git, registered.path);
  if (!head.ok) return fail("path-remains", head.message);
  const judgement = isWorkDone(git, repo.main.path, ref, head.ref);
  if (judgement.kind === "failed") {
    return fail("path-remains", judgement.message);
  }
  if (judgement.kind === "unexpected-head") {
    return fail(
      "unexpected-head",
      `${worktreePath} has HEAD ${head.ref ?? "(detached)"}, not ${ref}; leaving it alone`,
    );
  }

  const unsafePath = verifyManagedPath(repo, registered.path);
  if (unsafePath) {
    return fail("outside-managed-dirs", `${unsafePath}; leaving it alone`);
  }

  // 5. One forced remove, with the path git itself reported.
  const { result: removal } = removeCheckout(
    { git, deps, startedAt, repo },
    registered.path,
    ["worktree", "remove", "--force", "--", registered.path],
  );
  // 6. Trust the filesystem, not the exit code.
  if (!removal.ok) {
    if (pathExists(registered.path)) {
      return fail(
        "path-remains",
        `git worktree remove failed for ${registered.path}: ${removal.stderr.trim()}`,
      );
    }
    return {
      ok: true,
      removed: true,
      keptBranch: { name: branchName, reason: "remove-incomplete" },
    };
  }
  if (judgement.kind === "has-work") {
    return {
      ok: true,
      removed: true,
      keptBranch: { name: branchName, reason: judgement.reason },
    };
  }
  return deleteBranchIfUntouched(git, repo.main.path, ref, judgement.tip)
    ? { ok: true, removed: true }
    : {
        ok: true,
        removed: true,
        keptBranch: { name: branchName, reason: "cas-missed" },
      };
}

// update-ref -d with the expected old value: a compare-and-swap that leaves a
// branch alone if anything moved it after K4 looked.
function deleteBranchIfUntouched(
  git: Git,
  mainPath: string,
  ref: string,
  expectedTip: string,
): boolean {
  return git(["update-ref", "-d", ref, expectedTip], "update-ref", mainPath).ok;
}

// SubagentStop (K6): remove the worktree of this subagent, only when nothing
// was done in it. Every doubt resolves to "leave it".
export function cleanupSubagentWorktree(
  input: { agentId: string; cwd: string },
  deps: Deps = defaultDeps(),
): SubagentCleanupResult {
  const startedAt = deps.now();
  const git = createGit(deps, startedAt);
  const none: SubagentCleanupResult = { action: "none" };
  const kept = (
    detail: Extract<SubagentCleanupResult, { action: "kept" }>["detail"],
    note?: string,
  ): SubagentCleanupResult =>
    note === undefined
      ? { action: "kept", detail }
      : { action: "kept", detail, note };

  const { agentId, cwd } = input;
  if (
    typeof agentId !== "string" ||
    !AGENT_ID_PATTERN.test(agentId) ||
    typeof cwd !== "string" ||
    cwd === ""
  ) {
    return none;
  }

  const lookup = lookupRepo(git, cwd);
  if (!lookup.ok) {
    if (lookup.kind === "bare-repo") return none;
    if (lookup.kind === "list-failed") {
      // Not a repository at all is normal; any other list failure is not.
      const probe = git(["rev-parse", "--git-dir"], "read", cwd);
      return !probe.ok && !probe.timedOut ? none : kept("git-failed");
    }
    return kept("git-failed");
  }
  const { repo } = lookup;

  const dirName = `worktree-agent-${agentId}`;
  const ref = `refs/heads/${dirName}`;
  // Exact match on the registered branch and location; the path is never built
  // from agent_id.
  const entry = repo.entries.find(
    (candidate) =>
      candidate.branch === ref &&
      isUnderManagedRoot(candidate.path, repo.commonDir, repo.home),
  );
  if (!entry) return none;
  if (basename(canonicalize(entry.path)) !== dirName) return none;
  if (entry.prunable) return kept("git-failed");

  const head = readHeadRef(git, entry.path);
  if (!head.ok) return kept("git-failed");
  if (head.ref !== ref) return none;
  const judgement = isWorkDone(git, repo.main.path, ref, head.ref);
  if (judgement.kind === "failed") return kept("git-failed");
  if (judgement.kind === "unexpected-head") return none;
  if (judgement.kind === "has-work") return kept(judgement.reason);

  const status = git(["status", "--porcelain"], "read", entry.path);
  if (!status.ok) return kept("git-failed");
  if (status.stdout !== "") return kept("has-changes");

  if (verifyManagedPath(repo, entry.path)) return kept("git-failed");

  // No --force: git re-checks that the worktree is clean.
  const { result: removal, note } = removeCheckout(
    { git, deps, startedAt, repo },
    entry.path,
    ["worktree", "remove", "--", entry.path],
  );
  if (!removal.ok) return kept("remove-failed", note);
  return deleteBranchIfUntouched(git, repo.main.path, ref, judgement.tip)
    ? { action: "removed" }
    : {
        action: "removed",
        keptBranch: { name: dirName, reason: "cas-missed" },
      };
}

// ---------------------------------------------------------------------------
// Removal inside an agent-vm machine (ADR-0033 K7)
// ---------------------------------------------------------------------------

const VM_HELPER = "agent-vm-node-modules";
const DEFAULT_VM_MARKER = "/etc/agent-vm";

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Absolute PATH entries only: a relative entry would pick a file of whatever directory the hook runs in.
function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export type MountState = "none" | "mounted" | "unreadable";

// The kernel escapes space, tab, newline and backslash in a mountinfo path as three octal digits.
function decodeMountinfoPath(text: string): string {
  return text.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

// Is anything mounted at or under one of `paths`? A table with no parsable line counts as unreadable: an empty answer
// from a real mountinfo does not exist, so it must not read as "nothing is mounted".
export function findMountsUnder(
  mountinfo: string,
  paths: readonly string[],
): MountState {
  const roots = paths.map((path) => resolve(path));
  let parsed = 0;
  let mounted = false;
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    const raw = fields[4];
    if (fields.length < 7 || raw === undefined) continue;
    parsed += 1;
    const mountPoint = decodeMountinfoPath(raw);
    if (
      roots.some(
        (root) => mountPoint === root || mountPoint.startsWith(`${root}${sep}`),
      )
    ) {
      mounted = true;
    }
  }
  if (parsed === 0) return "unreadable";
  return mounted ? "mounted" : "none";
}

function readMountinfoFile(): string {
  return readFileSync("/proc/self/mountinfo", "utf8");
}

type Removal = { result: GitResult; note?: string };

// `git worktree remove` of a worktree that has agent-vm node_modules mounts empties the VM-side copies and then fails
// on the mount points. So inside a machine: through the helper when it is there; without it, git only when no mount
// is found under the worktree. A refusal, an unknown mount state and a failure to run all keep the worktree, and git
// is never the fallback.
function removeCheckout(
  ctx: { git: Git; deps: Deps; startedAt: number; repo: RepoContext },
  path: string,
  removeArgs: readonly string[],
): Removal {
  const { git, deps, startedAt, repo } = ctx;
  const plain = (): Removal => ({
    result: git(removeArgs, "remove", repo.main.path),
  });
  if (!existsSync(process.env.AGENT_VM_MARKER || DEFAULT_VM_MARKER)) {
    return plain();
  }
  const refused = (stderr: string, timedOut = false): Removal => ({
    result: { ok: false, status: null, stderr, timedOut },
    note: stderr,
  });

  const helper = findOnPath(VM_HELPER);
  if (helper) {
    const remaining = DEADLINE_MS - (deps.now() - startedAt);
    if (remaining <= 0) {
      return refused(`deadline exceeded before running ${VM_HELPER}`, true);
    }
    const outcome = runInOwnGroup(
      helper,
      [
        "remove",
        path,
        "--",
        "git",
        ...HARDENING_ARGS,
        "-C",
        repo.main.path,
        ...removeArgs,
      ],
      {
        cwd: repo.main.path,
        env: gitEnv(),
        timeoutMs: Math.min(KIND_LIMIT_MS.remove, remaining),
      },
    );
    if (outcome.failure !== null) {
      return refused(`could not run ${VM_HELPER}: ${outcome.failure}`);
    }
    if (outcome.timedOut) {
      return refused(
        `${VM_HELPER} did not finish in time; ${path} is kept`,
        true,
      );
    }
    if (outcome.status !== 0) {
      const text = outcome.output.trim();
      return refused(
        text !== ""
          ? text
          : `${VM_HELPER} stopped with ${outcome.signal ?? `status ${outcome.status}`}; ${path} is kept`,
      );
    }
    return { result: { ok: true, stdout: "" } };
  }

  let state: MountState;
  try {
    state = findMountsUnder((deps.readMountinfo ?? readMountinfoFile)(), [
      path,
      canonicalize(path),
    ]);
  } catch {
    state = "unreadable";
  }
  if (state === "none") return plain();
  const why =
    state === "mounted"
      ? "has agent-vm node_modules mounts"
      : "its mounts could not be read";
  return refused(
    `git was not run: ${path} ${why} and ${VM_HELPER} is not on PATH, and removing it with git would empty the VM-side copies and then fail. The worktree is kept. To remove it, from a shell where the helper is on PATH: ${VM_HELPER} remove ${shellQuote(path)} -- git worktree remove -- ${shellQuote(path)}`,
  );
}

// ---------------------------------------------------------------------------
// Dependency preparation after a create (ADR-0033 K1-K6)
// ---------------------------------------------------------------------------

const DEPS_CLI = "git-worktree-deps";
// Claude Code names a subagent's worktree agent-<id> (isolation: "worktree") or wf_<run>-<n> (workflow agents). The
// hook input has no other sign of who asks, so a name that looks like one is treated as one: a wrong guess toward
// "subagent" costs an install the agent runs itself, a wrong guess the other way runs the origin's scripts.
const SUBAGENT_NAME_PREFIXES = ["agent-", "wf_"] as const;
const OUTPUT_TAIL_LINES = 100;

export function isSubagentWorktreeName(name: string): boolean {
  return SUBAGENT_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// CSI sequences (the CLI colours its lines). stripControlChars alone would leave "[1;33m" behind.
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

// Runs git-worktree-deps for a worktree this hook has just created or found. Never throws and never fails the hook
// (K3): everything that goes wrong becomes one stderr line, and the caller still returns the worktree path. The
// result is the lines to put on the hook's stderr; the CLI's own stdout and stderr are among them.
export function prepareDependencies(
  input: { name: string; path: string; reused: boolean; startedAt: number },
  deps: Deps = defaultDeps(),
): string[] {
  const { name, path, reused, startedAt } = input;
  const timing = { ...PREP_TIMING, ...deps.timing };
  const retry = `${DEPS_CLI} ${shellQuote(path)}`;
  const elapsedMs = deps.now() - startedAt;

  // The CLI as a whole gets what is left of the hook's budget minus a reserve for the hook to return in.
  const cliMs = timing.budgetMs - elapsedMs - timing.cliReserveMs;
  if (cliMs < timing.minCliMs) {
    return [
      `dependency preparation skipped: too little of the hook's time is left (elapsed ${Math.round(elapsedMs / 1000)} s); to prepare it: ${retry}`,
    ];
  }
  const home = process.env.HOME;
  if (!home) return ["dependency preparation skipped: HOME is not set"];
  const cli = join(home, ".local", "bin", DEPS_CLI);
  if (!isExecutableFile(cli)) {
    return [
      `dependency preparation skipped: ${cli} is not an executable file; to prepare it later: ${retry}`,
    ];
  }

  // Only the session's own fresh worktree is installed: a reused one has run before, and a subagent's is told its
  // dependencies are missing instead (SubagentStart).
  const installSec = Math.min(
    timing.installCapSec,
    Math.floor((timing.budgetMs - elapsedMs - timing.installReserveMs) / 1000),
  );
  const install =
    !reused &&
    !isSubagentWorktreeName(name) &&
    installSec >= timing.minInstallSec;
  const args = install
    ? ["--source", "new", "--timeout", String(installSec), path]
    : ["--no-install", path];

  // The CLI gets the hook's whole environment: a package manager reads its registry credentials from it (K2).
  const outcome = runInOwnGroup(cli, args, {
    cwd: path,
    env: process.env,
    timeoutMs: cliMs,
  });
  const lines = stripAnsi(outcome.output)
    .split("\n")
    .filter((line) => line.trim() !== "");
  const out =
    lines.length > OUTPUT_TAIL_LINES
      ? [
          `(${lines.length - OUTPUT_TAIL_LINES} earlier lines of ${DEPS_CLI} output omitted)`,
          ...lines.slice(-OUTPUT_TAIL_LINES),
        ]
      : lines;
  if (outcome.timedOut) {
    out.push(
      `${DEPS_CLI} was stopped at the hook deadline (${Math.floor(cliMs / 1000)} s); the worktree is ready but its dependencies may be missing or partial. To finish: ${retry}`,
    );
  } else if (outcome.failure !== null) {
    out.push(`could not run ${DEPS_CLI}: ${outcome.failure}`);
  } else if (outcome.status !== 0) {
    out.push(
      `${DEPS_CLI} stopped with ${outcome.signal ?? `status ${outcome.status}`}; the worktree is ready but its dependencies may be missing. To retry: ${retry}`,
    );
  }
  return out;
}
