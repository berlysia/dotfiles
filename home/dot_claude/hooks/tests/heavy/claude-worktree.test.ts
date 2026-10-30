import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  cleanupSubagentWorktree,
  createWorktree,
  removeWorktree,
} from "../../lib/claude-worktree.ts";
import type {
  CreateResult,
  RemoveResult,
  SubagentCleanupResult,
} from "../../lib/claude-worktree.ts";
import { DEADLINE_MS } from "../../lib/claude-worktree-git.ts";
import type { Deps } from "../../lib/claude-worktree-git.ts";
import { currentRoot } from "../../lib/worktree-locations.ts";
import { reserveMarker } from "../../lib/worktree-marker.ts";
import {
  GIT_FAILURE,
  GIT_TIMEOUT,
  addLinkedWorktree,
  createBareWithLinkedWorktree,
  createEmptyRepo,
  createRepo,
  createRepoWithNewlinePath,
  createTempTracker,
  createWorktreesInParallel,
  git,
  interceptGit,
  withReadOnlyDir,
} from "../support/claude-worktree-fixture.ts";
import type { Repo } from "../support/claude-worktree-fixture.ts";

const temp = createTempTracker();
const originalHome = process.env.HOME;
const testHome = temp.make("cwt-home-");
process.env.HOME = testHome;
after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  temp.cleanup();
});

const isRoot = process.getuid?.() === 0;

function create(
  repo: Repo,
  name: string,
  deps?: Deps,
  cwd = repo.dir,
): CreateResult {
  return createWorktree({ name, cwd }, deps);
}

function expectOk(result: CreateResult): Extract<CreateResult, { ok: true }> {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function expectFail(
  result: CreateResult,
  reason: Extract<CreateResult, { ok: false }>["reason"],
): Extract<CreateResult, { ok: false }> {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, reason, result.message);
  return result;
}

function branchExists(repo: Repo, branch: string): boolean {
  return git(repo.dir, "branch", "--list", branch) !== "";
}

function worktreePath(repo: Repo, branch: string): string {
  return join(currentRoot(repo.commonDir, testHome), branch);
}

function listedPaths(repo: Repo): string[] {
  return git(repo.dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

describe("createWorktree: placement and base", () => {
  it("C09: branches from origin/HEAD into ~/worktrees/<repo>/worktree-<name>", () => {
    const repo = createRepo(temp, { origin: true, localAhead: true });
    assert.notEqual(repo.originSha, repo.baseSha);
    const result = expectOk(create(repo, "bold-oak-a3f2"));
    assert.equal(result.path, worktreePath(repo, "worktree-bold-oak-a3f2"));
    assert.equal(result.reused, false);
    assert.deepEqual(result.warnings, []);
    assert.equal(
      git(repo.dir, "rev-parse", "worktree-bold-oak-a3f2"),
      repo.originSha,
    );
    assert.equal(
      git(result.path, "symbolic-ref", "HEAD"),
      "refs/heads/worktree-bold-oak-a3f2",
    );
  });

  it("C10: falls back to HEAD with a warning when origin/HEAD is missing", () => {
    const repo = createRepo(temp);
    const result = expectOk(create(repo, "no-origin"));
    assert.equal(
      git(repo.dir, "rev-parse", "worktree-no-origin"),
      repo.baseSha,
    );
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /origin\/HEAD not found/);
    assert.match(result.warnings[0] ?? "", /main/);
  });

  it("C11: from inside a linked worktree, places under the main repo's worktree root", () => {
    const repo = createRepo(temp);
    const linked = addLinkedWorktree(temp, repo, "human-branch");
    const result = expectOk(create(repo, "from-linked", undefined, linked));
    assert.equal(result.path, worktreePath(repo, "worktree-from-linked"));
  });

  it("C12: creating the same name twice reuses the worktree", () => {
    const repo = createRepo(temp);
    const first = expectOk(create(repo, "twice"));
    const countAfterFirst = listedPaths(repo).length;
    const second = expectOk(create(repo, "twice"));
    assert.equal(second.path, first.path);
    assert.equal(second.reused, true);
    assert.equal(listedPaths(repo).length, countAfterFirst);
  });

  it("C13: the new branch has a single reflog entry 'branch: Created from '", () => {
    const repo = createRepo(temp);
    expectOk(create(repo, "reflog"));
    const entries = git(
      repo.dir,
      "reflog",
      "show",
      "--format=%gs",
      "refs/heads/worktree-reflog",
    ).split("\n");
    assert.equal(entries.length, 1);
    assert.ok(entries[0]?.startsWith("branch: Created from "), entries[0]);
  });
});

describe("createWorktree: validation", () => {
  const invalidNames = [
    "a/b",
    "../x",
    "-x",
    "",
    "x".repeat(101),
    "foo.",
    "foo.lock",
    "a..b",
    "foo\n",
    "a b",
    "a\x00b",
    "a@{b",
  ];
  for (const name of invalidNames) {
    it(`C14: rejects ${JSON.stringify(name.length > 20 ? `${name.slice(0, 8)}...(${name.length})` : name)}`, () => {
      const repo = createRepo(temp);
      const before = listedPaths(repo);
      expectFail(create(repo, name), "invalid-name");
      assert.deepEqual(listedPaths(repo), before);
      assert.equal(existsSync(join(repo.commonDir, "worktree")), false);
      assert.equal(git(repo.dir, "branch", "--list", "worktree-*"), "");
    });
  }

  it("C14: accepts names Claude Code generates and a 100 char name", () => {
    const repo = createRepo(temp);
    for (const name of [
      "agent-a278c2e632b92ee6c",
      "bridge-cse_01AbC",
      "x".repeat(100),
    ]) {
      expectOk(create(repo, name));
    }
  });

  it("C15: not-git for a directory outside any repo", () => {
    const dir = temp.make("cwt-nogit-");
    expectFail(createWorktree({ name: "x", cwd: dir }), "not-git");
    expectFail(
      createWorktree({ name: "x", cwd: join(dir, "missing") }),
      "not-git",
    );
  });

  it("C15: bare-repo when the main entry is bare", () => {
    const { linkedDir } = createBareWithLinkedWorktree(temp);
    expectFail(createWorktree({ name: "x", cwd: linkedDir }), "bare-repo");
  });

  it("C15: a bare repo dir as cwd is refused too (safe.bareRepository may hide it)", () => {
    const { bareDir } = createBareWithLinkedWorktree(temp);
    const result = createWorktree({ name: "x", cwd: bareDir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(["not-git", "bare-repo"].includes(result.reason));
  });

  it("C15: no-base-commit for a repo without commits", () => {
    const dir = createEmptyRepo(temp);
    expectFail(createWorktree({ name: "x", cwd: dir }), "no-base-commit");
    assert.equal(existsSync(join(dir, ".git", "worktree")), false);
  });

  it("C16: symlinked-dir when the current repo root is a symlink", () => {
    const repo = createRepo(temp);
    const elsewhere = temp.make("cwt-elsewhere-");
    mkdirSync(join(testHome, "worktrees"), { recursive: true });
    symlinkSync(elsewhere, join(testHome, "worktrees", basename(repo.dir)));
    expectFail(create(repo, "x"), "symlinked-dir");
    assert.equal(branchExists(repo, "worktree-x"), false);
  });

  it("T4: an unmarked current repo root is not adopted", () => {
    const repo = createRepo(temp);
    const root = currentRoot(repo.commonDir, testHome);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "keep.txt"), "keep\n");
    expectFail(create(repo, "unmarked"), "path-occupied");
    assert.equal(existsSync(join(root, ".common-dir")), false);
    assert.equal(branchExists(repo, "worktree-unmarked"), false);
    assert.equal(listedPaths(repo).length, 1);
    assert.equal(existsSync(join(root, "keep.txt")), true);
  });

  it("T4: a marker owned by another repo is unchanged and blocks creation", () => {
    const repo = createRepo(temp);
    const other = createRepo(temp);
    const root = currentRoot(repo.commonDir, testHome);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, ".common-dir"),
      `${realpathSync(other.commonDir)}\n`,
    );
    const markerBefore = readFileSync(join(root, ".common-dir"), "utf8");
    expectFail(create(repo, "conflict"), "path-occupied");
    assert.equal(readFileSync(join(root, ".common-dir"), "utf8"), markerBefore);
    assert.equal(branchExists(repo, "worktree-conflict"), false);
    assert.equal(listedPaths(repo).length, 1);
  });

  it("T4: a healthy WorktreeCreate location is marked and used", () => {
    const repo = createRepo(temp);
    const result = expectOk(create(repo, "foo"));
    assert.equal(result.path, worktreePath(repo, "worktree-foo"));
    assert.equal(
      readFileSync(
        join(currentRoot(repo.commonDir, testHome), ".common-dir"),
        "utf8",
      ),
      `${realpathSync(repo.commonDir)}\n`,
    );
  });
});

describe("createWorktree: occupied placement", () => {
  it("C17: unregistered directory at the target", () => {
    const repo = createRepo(temp);
    mkdirSync(worktreePath(repo, "worktree-occ"), { recursive: true });
    expectFail(create(repo, "occ"), "path-occupied");
    assert.equal(branchExists(repo, "worktree-occ"), false);
  });

  it("C17: broken symlink at the target", () => {
    const repo = createRepo(temp);
    mkdirSync(currentRoot(repo.commonDir, testHome), { recursive: true });
    symlinkSync("/nonexistent-target", worktreePath(repo, "worktree-broken"));
    expectFail(create(repo, "broken"), "path-occupied");
    assert.equal(branchExists(repo, "worktree-broken"), false);
  });

  it("C17: registered but detached", () => {
    const repo = createRepo(temp);
    const made = expectOk(create(repo, "det"));
    git(made.path, "checkout", "-q", "--detach");
    expectFail(create(repo, "det"), "path-occupied");
    assert.ok(existsSync(made.path));
  });

  it("C17: registered but HEAD does not resolve to a commit", () => {
    const repo = createRepo(temp);
    const made = expectOk(create(repo, "unborn"));
    git(repo.dir, "update-ref", "-d", "refs/heads/worktree-unborn");
    const result = expectFail(create(repo, "unborn"), "path-occupied");
    assert.ok(result.message.length > 0);
    assert.ok(existsSync(made.path));
  });

  it("C17: prunable registration is left alone and reported", () => {
    const repo = createRepo(temp);
    const made = expectOk(create(repo, "prun"));
    rmSync(made.path, { recursive: true, force: true });
    const result = expectFail(create(repo, "prun"), "path-occupied");
    assert.match(result.message, /git worktree prune/);
    assert.ok(listedPaths(repo).includes(made.path));
    assert.equal(branchExists(repo, "worktree-prun"), true);
  });

  it("C18: a branch with no worktree is branch-exists and is kept", () => {
    const repo = createRepo(temp);
    git(repo.dir, "branch", "worktree-lonely");
    const before = git(repo.dir, "rev-parse", "worktree-lonely");
    const result = expectFail(create(repo, "lonely"), "branch-exists");
    assert.match(result.message, /git branch -D worktree-lonely/);
    assert.equal(git(repo.dir, "rev-parse", "worktree-lonely"), before);
    assert.equal(existsSync(worktreePath(repo, "worktree-lonely")), false);
  });
});

describe("createWorktree: coexistence", () => {
  it("C19: a worktree made by hand with the same name is reused untouched", () => {
    const repo = createRepo(temp);
    const path = worktreePath(repo, "worktree-foo");
    assert.equal(reserveMarker(repo.commonDir, testHome, path).kind, "ok-same");
    git(repo.dir, "worktree", "add", "-q", "-b", "worktree-foo", path);
    const tip = git(repo.dir, "rev-parse", "worktree-foo");
    const result = expectOk(create(repo, "foo"));
    assert.equal(result.reused, true);
    assert.equal(result.path, path);
    assert.equal(git(repo.dir, "rev-parse", "worktree-foo"), tip);
    assert.ok(existsSync(path));
  });

  it("C20: a human worktree at .git/worktree/feat/x is not changed", () => {
    const repo = createRepo(temp);
    const human = join(repo.commonDir, "worktree", "feat", "x");
    git(repo.dir, "worktree", "add", "-q", "-b", "feat/x", human);
    const tip = git(repo.dir, "rev-parse", "feat/x");
    expectOk(create(repo, "other"));
    assert.ok(listedPaths(repo).includes(human));
    assert.equal(git(repo.dir, "rev-parse", "feat/x"), tip);
    assert.equal(git(human, "symbolic-ref", "HEAD"), "refs/heads/feat/x");
  });

  it("C21: an unrelated prunable registration survives a create", () => {
    const repo = createRepo(temp);
    const external = join(temp.make("cwt-ext-"), "ext");
    git(repo.dir, "worktree", "add", "-q", "-b", "external", external);
    rmSync(external, { recursive: true, force: true });
    expectOk(create(repo, "fresh"));
    assert.ok(listedPaths(repo).includes(external));
    assert.equal(branchExists(repo, "external"), true);
  });
});

describe("createWorktree: failure handling", () => {
  it(
    "C22: add failing on an unwritable parent leaves no worktree or branch",
    { skip: isRoot ? "chmod does not restrict root" : false },
    () => {
      const repo = createRepo(temp);
      const worktreeDir = currentRoot(repo.commonDir, testHome);
      mkdirSync(worktreeDir);
      assert.equal(
        reserveMarker(repo.commonDir, testHome, worktreeDir).kind,
        "ok-same",
      );
      const result = withReadOnlyDir(worktreeDir, () => create(repo, "ro"));
      expectFail(result, "git-failed");
      assert.equal(branchExists(repo, "worktree-ro"), false);
      assert.equal(listedPaths(repo).length, 1);
    },
  );

  it("C22 control: an injected add failure with an untouched branch rolls the branch back", () => {
    const repo = createRepo(temp);
    const { deps } = interceptGit([
      { match: ["worktree", "add"], replace: GIT_FAILURE, times: 2 },
    ]);
    expectFail(create(repo, "rb", deps), "git-failed");
    assert.equal(branchExists(repo, "worktree-rb"), false);
  });

  it("C26b: a failed add is retried once; the retry succeeds with a single reflog entry (I4)", () => {
    const repo = createRepo(temp);
    const { deps, calls } = interceptGit([
      { match: ["worktree", "add"], replace: GIT_FAILURE, times: 1 },
    ]);
    const result = expectOk(create(repo, "retry", deps));
    assert.equal(result.reused, false);
    assert.equal(
      calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "add")
        .length,
      2,
    );
    assert.ok(existsSync(result.path));
    const entries = git(
      repo.dir,
      "reflog",
      "show",
      "--format=%gs",
      "refs/heads/worktree-retry",
    ).split("\n");
    assert.equal(entries.length, 1);
    assert.ok(entries[0]?.startsWith("branch: Created from "), entries[0]);
  });

  it("C26b: two failed adds give git-failed and leave no branch (I5)", () => {
    const repo = createRepo(temp);
    const { deps, calls } = interceptGit([
      { match: ["worktree", "add"], replace: GIT_FAILURE, times: 5 },
    ]);
    expectFail(create(repo, "twice-bad", deps), "git-failed");
    assert.equal(
      calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "add")
        .length,
      2,
    );
    assert.equal(branchExists(repo, "worktree-twice-bad"), false);
  });

  it("C26b: an add that times out is not retried", () => {
    const repo = createRepo(temp);
    const { deps, calls } = interceptGit([
      { match: ["worktree", "add"], replace: GIT_TIMEOUT, times: 5 },
    ]);
    expectFail(create(repo, "no-retry", deps), "git-failed");
    assert.equal(
      calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "add")
        .length,
      1,
    );
  });

  it("C23: add timing out keeps the branch and names the recovery command", () => {
    const repo = createRepo(temp);
    const { deps } = interceptGit([
      { match: ["worktree", "add"], replace: GIT_TIMEOUT },
    ]);
    const result = expectFail(create(repo, "slow", deps), "git-failed");
    assert.match(result.message, /git branch -D worktree-slow/);
    assert.equal(branchExists(repo, "worktree-slow"), true);
  });

  it("C24: add failing after the tip moved keeps the branch", () => {
    const repo = createRepo(temp);
    const { deps } = interceptGit([
      {
        match: ["worktree", "add"],
        before: () => {
          const moved = git(
            repo.dir,
            "commit-tree",
            "HEAD^{tree}",
            "-p",
            "HEAD",
            "-m",
            "moved",
          );
          git(repo.dir, "update-ref", "refs/heads/worktree-moved", moved);
        },
        replace: GIT_FAILURE,
      },
    ]);
    const result = expectFail(create(repo, "moved", deps), "git-failed");
    assert.match(result.message, /git branch -D worktree-moved/);
    assert.equal(branchExists(repo, "worktree-moved"), true);
  });

  it("C24: add failing after the branch was checked out elsewhere keeps the branch", () => {
    const repo = createRepo(temp);
    const elsewhere = join(temp.make("cwt-else-"), "else");
    const { deps } = interceptGit([
      {
        match: ["worktree", "add"],
        before: () =>
          git(repo.dir, "worktree", "add", "-q", elsewhere, "worktree-taken"),
        replace: GIT_FAILURE,
      },
    ]);
    expectFail(create(repo, "taken", deps), "git-failed");
    assert.equal(branchExists(repo, "worktree-taken"), true);
    assert.ok(existsSync(elsewhere));
  });

  it("C27: a git common dir path containing a newline is git-failed", () => {
    const dir = createRepoWithNewlinePath(temp);
    const result = createWorktree({ name: "nl", cwd: dir });
    expectFail(result, "git-failed");
    assert.equal(git(dir, "branch", "--list", "worktree-*"), "");
  });

  it("C27: a registered worktree whose path has a newline does not confuse create", () => {
    const repo = createRepo(temp);
    const weird = join(
      temp.make("cwt-nlwt-"),
      "wt\nbranch refs/heads/worktree-evil",
    );
    git(repo.dir, "worktree", "add", "-q", "-b", "weird", weird);
    const made = expectOk(create(repo, "evil"));
    assert.equal(made.reused, false);
    assert.ok(lstatSync(weird).isDirectory());
    assert.equal(
      git(repo.dir, "symbolic-ref", "--short", "-q", "HEAD"),
      "main",
    );
    assert.equal(branchExists(repo, "weird"), true);
  });
});

describe("createWorktree: concurrency", () => {
  it(
    "C25: two parallel creations of one name leave exactly one winner",
    { timeout: 60_000 },
    async () => {
      const repo = createRepo(temp);
      const results = await createWorktreesInParallel(temp, [
        { cwd: repo.dir, name: "race" },
        { cwd: repo.dir, name: "race" },
      ]);
      const fresh = results.filter((r) => r.ok && !r.reused);
      assert.equal(fresh.length, 1, JSON.stringify(results));
      for (const result of results) {
        if (result.ok) continue;
        assert.ok(
          ["branch-exists", "path-occupied"].includes(result.reason),
          JSON.stringify(result),
        );
      }
      const winner = fresh[0];
      assert.ok(winner?.ok);
      if (winner?.ok) assert.ok(existsSync(winner.path));
      assert.equal(branchExists(repo, "worktree-race"), true);
    },
  );

  it(
    "C26: four different names in parallel all succeed, 20 times",
    { timeout: 300_000 },
    async () => {
      const repo = createRepo(temp);
      const failures: CreateResult[] = [];
      for (let i = 0; i < 20; i++) {
        const jobs = ["a", "b", "c", "d"].map((suffix) => ({
          cwd: repo.dir,
          name: `par-${i}-${suffix}`,
        }));
        const results = await createWorktreesInParallel(temp, jobs);
        for (const result of results) if (!result.ok) failures.push(result);
      }
      assert.deepEqual(failures, []);
    },
  );
});

// ---------------------------------------------------------------------------
// removeWorktree (K4, K5)
// ---------------------------------------------------------------------------

function remove(
  repo: Repo,
  worktreePath: string,
  deps?: Deps,
  cwd = repo.dir,
): RemoveResult {
  return removeWorktree({ worktreePath, cwd }, deps);
}

function expectRemoved(
  result: RemoveResult,
): Extract<RemoveResult, { ok: true }> {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function expectRemoveFail(
  result: RemoveResult,
  reason: Extract<RemoveResult, { ok: false }>["reason"],
): Extract<RemoveResult, { ok: false }> {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, reason, result.message);
  return result;
}

function makeWorktree(repo: Repo, name: string): string {
  return expectOk(create(repo, name)).path;
}

function commitIn(dir: string, file: string): void {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, "add", "--", file);
  git(dir, "commit", "-q", "-m", `add ${file}`);
}

// Moves a branch tip to a new commit without going through the code under test.
function moveTip(repo: Repo, branch: string): void {
  const moved = git(
    repo.dir,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "moved",
  );
  git(repo.dir, "update-ref", `refs/heads/${branch}`, moved);
}

describe("removeWorktree: K4 judgement and branch handling", () => {
  it("C28: removes an untouched worktree and its branch with a CAS on the old sha", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "clean");
    const { deps, calls } = interceptGit();
    const result = expectRemoved(remove(repo, path, deps));
    assert.equal(result.removed, true);
    assert.equal(result.keptBranch, undefined);
    assert.equal(existsSync(path), false);
    assert.equal(branchExists(repo, "worktree-clean"), false);
    const cas = calls.find((call) => call.args[0] === "update-ref");
    assert.deepEqual(cas?.args, [
      "update-ref",
      "-d",
      "refs/heads/worktree-clean",
      repo.baseSha,
    ]);
    assert.equal(
      calls.some(
        (call) => call.args[0] === "worktree" && call.args[1] === "prune",
      ),
      false,
    );
  });

  it("C29: a commit in the worktree removes the worktree but keeps the branch", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "worked");
    commitIn(path, "w.txt");
    const result = expectRemoved(remove(repo, path));
    assert.equal(result.removed, true);
    assert.deepEqual(result.keptBranch, {
      name: "worktree-worked",
      reason: "reflog-not-single-creation",
    });
    assert.equal(existsSync(path), false);
    assert.equal(branchExists(repo, "worktree-worked"), true);
  });

  it("C30: a branch reset back to its creation commit is still work", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "reset");
    commitIn(path, "w.txt");
    git(path, "reset", "-q", "--hard", "HEAD~1");
    const result = expectRemoved(remove(repo, path));
    assert.equal(result.keptBranch?.reason, "reflog-not-single-creation");
    assert.equal(branchExists(repo, "worktree-reset"), true);
  });

  it("C30: a worktree created with reflogs disabled keeps its branch", () => {
    const repo = createRepo(temp);
    git(repo.dir, "config", "core.logAllRefUpdates", "false");
    const path = makeWorktree(repo, "nolog");
    const result = expectRemoved(remove(repo, path));
    assert.equal(result.keptBranch?.reason, "reflog-not-single-creation");
    assert.equal(branchExists(repo, "worktree-nolog"), true);
  });

  it("C31: detached HEAD with a commit is unexpected-head and nothing is removed", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "detached");
    git(path, "checkout", "-q", "--detach");
    commitIn(path, "d.txt");
    expectRemoveFail(remove(repo, path), "unexpected-head");
    assert.equal(existsSync(path), true);
    assert.equal(branchExists(repo, "worktree-detached"), true);
  });

  it("C31: another branch checked out in the worktree is unexpected-head", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "switched");
    git(path, "checkout", "-q", "-b", "other-work");
    commitIn(path, "o.txt");
    expectRemoveFail(remove(repo, path), "unexpected-head");
    assert.equal(existsSync(path), true);
    assert.equal(branchExists(repo, "other-work"), true);
  });

  it("C31: a branch that disagrees with the directory name is unexpected-head", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "mismatch");
    git(path, "checkout", "-q", "-B", "worktree-other");
    expectRemoveFail(remove(repo, path), "unexpected-head");
    assert.equal(existsSync(path), true);
    assert.equal(branchExists(repo, "worktree-mismatch"), true);
  });

  it("C32: a tip moved after the judgement is not deleted (cas-missed)", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "racy");
    const { deps } = interceptGit([
      {
        match: ["update-ref", "-d"],
        before: () => moveTip(repo, "worktree-racy"),
      },
    ]);
    const result = expectRemoved(remove(repo, path, deps));
    assert.equal(result.removed, true);
    assert.equal(result.keptBranch?.reason, "cas-missed");
    assert.equal(existsSync(path), false);
    assert.equal(branchExists(repo, "worktree-racy"), true);
  });

  it("T4: WorktreeRemove leaves a current-root worktree and branch behind a replaced symlink", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "symlink-current");
    const root = currentRoot(repo.commonDir, testHome).slice(0, -1);
    const outside = temp.make("cwt-current-outside-");
    writeFileSync(join(root, "outside.txt"), "keep\n");
    renameSync(root, join(outside, "moved"));
    symlinkSync(join(outside, "moved"), root);

    expectRemoveFail(remove(repo, path), "outside-managed-dirs");
    assert.equal(existsSync(path), true);
    assert.equal(branchExists(repo, "worktree-symlink-current"), true);
    assert.ok(listedPaths(repo).includes(path));
    assert.equal(
      readFileSync(join(outside, "moved", "outside.txt"), "utf8"),
      "keep\n",
    );
  });

  it("T4: WorktreeRemove leaves a legacy-root worktree and branch behind a replaced symlink", () => {
    const repo = createRepo(temp);
    const root = join(repo.commonDir, "worktree");
    const path = join(root, "worktree-symlink-legacy");
    git(
      repo.dir,
      "worktree",
      "add",
      "-q",
      "-b",
      "worktree-symlink-legacy",
      path,
    );
    const outside = temp.make("cwt-legacy-outside-");
    writeFileSync(join(root, "outside.txt"), "keep\n");
    renameSync(root, join(outside, "moved"));
    symlinkSync(join(outside, "moved"), root);

    expectRemoveFail(remove(repo, path), "outside-managed-dirs");
    assert.equal(existsSync(path), true);
    assert.equal(branchExists(repo, "worktree-symlink-legacy"), true);
    assert.ok(listedPaths(repo).includes(path));
    assert.equal(
      readFileSync(join(outside, "moved", "outside.txt"), "utf8"),
      "keep\n",
    );
  });

  it("T4: a symlink swapped after validation makes git reject remove and preserves the outside directory", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "swap-before-remove");
    const root = currentRoot(repo.commonDir, testHome).slice(0, -1);
    const outside = temp.make("cwt-swap-outside-");
    const decoyRoot = join(outside, "decoy");
    const actualRoot = join(outside, "actual");
    mkdirSync(join(decoyRoot, "worktree-swap-before-remove"), {
      recursive: true,
    });
    writeFileSync(
      join(decoyRoot, "worktree-swap-before-remove", "outside.txt"),
      "keep\n",
    );
    const { deps } = interceptGit([
      {
        match: ["worktree", "remove"],
        before: () => {
          renameSync(root, actualRoot);
          symlinkSync(decoyRoot, root);
        },
      },
    ]);

    const result = expectRemoveFail(remove(repo, path, deps), "path-remains");
    assert.match(result.message, /validation failed/i);
    assert.equal(branchExists(repo, "worktree-swap-before-remove"), true);
    assert.ok(listedPaths(repo).includes(path));
    assert.equal(
      readFileSync(
        join(decoyRoot, "worktree-swap-before-remove", "outside.txt"),
        "utf8",
      ),
      "keep\n",
    );
    assert.equal(
      existsSync(join(actualRoot, "worktree-swap-before-remove")),
      true,
    );
  });
});

describe("removeWorktree: what may be removed", () => {
  it("T4: registered worktrees under either managed root can be removed", () => {
    const repo = createRepo(temp);
    const current = makeWorktree(repo, "current-root");
    const legacyDir = join(repo.commonDir, "worktree");
    const legacy = join(legacyDir, "feat", "x");
    git(repo.dir, "worktree", "add", "-q", "-b", "feat/x", legacy);
    const victim = makeWorktree(repo, "victim");
    const preHook = join(repo.dir, ".claude", "worktrees", "x");
    git(repo.dir, "worktree", "add", "-q", "-b", "claude-x", preHook);
    const external = addLinkedWorktree(temp, repo, "external-b");
    const link = join(legacyDir, "worktree-link");
    symlinkSync(external, link);

    const cases: { label: string; path: string }[] = [
      { label: "main worktree", path: repo.dir },
      { label: "pre-hook .claude/worktrees", path: preHook },
      { label: "symlink to an unmanaged worktree", path: link },
      {
        label: "dot-dot segment",
        path: `${current}/../worktree-victim`,
      },
      { label: "relative path", path: "worktree-current-root" },
    ];
    for (const { label, path } of cases) {
      const result = remove(repo, path);
      assert.equal(result.ok, false, `${label}: ${JSON.stringify(result)}`);
      if (!result.ok) {
        assert.equal(result.reason, "outside-managed-dirs", label);
      }
    }
    const registered = listedPaths(repo);
    for (const path of [repo.dir, preHook, external, legacy, current, victim]) {
      assert.ok(existsSync(path), `${path} still exists`);
      assert.ok(registered.includes(path), `${path} still registered`);
    }
    for (const branch of [
      "feat/x",
      "claude-x",
      "external-b",
      "worktree-victim",
      "worktree-current-root",
    ]) {
      assert.equal(branchExists(repo, branch), true, branch);
    }

    const removedLegacy = expectRemoved(remove(repo, legacy));
    assert.equal(removedLegacy.removed, true);
    assert.equal(branchExists(repo, "feat/x"), false);
    const removedCurrent = expectRemoved(remove(repo, current));
    assert.equal(removedCurrent.removed, true);
    assert.equal(branchExists(repo, "worktree-current-root"), false);
  });

  it("C34: an existing unregistered path outside the managed dir is outside-managed-dirs", () => {
    const repo = createRepo(temp);
    const stray = temp.make("cwt-stray-");
    expectRemoveFail(remove(repo, stray), "outside-managed-dirs");
    assert.ok(existsSync(stray));
  });

  it("C35: an unregistered directory in the managed location is not-registered", () => {
    const repo = createRepo(temp);
    const stray = join(repo.commonDir, "worktree", "worktree-stray");
    mkdirSync(stray, { recursive: true });
    expectRemoveFail(remove(repo, stray), "not-registered");
    assert.ok(existsSync(stray));
  });

  it("C36: a missing, unregistered path is ok with removed: false, in or out of the managed dir", () => {
    const repo = createRepo(temp);
    const inside = join(repo.commonDir, "worktree", "worktree-ghost");
    const outside = join(temp.make("cwt-gone-"), "nothing-here");
    for (const path of [inside, outside]) {
      const result = expectRemoved(remove(repo, path));
      assert.equal(result.removed, false);
      assert.equal(result.keptBranch, undefined);
    }
  });

  it("C37: removing the same path twice succeeds both times", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "twice");
    assert.equal(expectRemoved(remove(repo, path)).removed, true);
    const again = expectRemoved(remove(repo, path));
    assert.equal(again.removed, false);
    assert.equal(again.keptBranch, undefined);
  });

  it("C44: a worktree of another repository is outside the cwd repo's managed dirs", () => {
    const repoA = createRepo(temp);
    const repoB = createRepo(temp);
    const path = makeWorktree(repoA, "foreign");
    expectRemoveFail(
      remove(repoA, path, undefined, repoB.dir),
      "outside-managed-dirs",
    );
    assert.ok(existsSync(path));
    assert.equal(branchExists(repoA, "worktree-foreign"), true);
  });
});

describe("removeWorktree: prunable, failures and the deadline", () => {
  it("C38: a managed prunable registration is left with its branch", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "gone");
    rmSync(path, { recursive: true });
    const result = expectRemoved(remove(repo, path));
    assert.equal(result.removed, false);
    assert.deepEqual(result.keptBranch, {
      name: "worktree-gone",
      reason: "prunable",
    });
    assert.ok(listedPaths(repo).includes(path));
    assert.equal(branchExists(repo, "worktree-gone"), true);
  });

  it("C39: another prunable registration survives a removal", () => {
    const repo = createRepo(temp);
    const away = join(temp.make("cwt-away-"), "away");
    git(repo.dir, "worktree", "add", "-q", "-b", "away-b", away);
    rmSync(away, { recursive: true });
    const path = makeWorktree(repo, "target");
    expectRemoved(remove(repo, path));
    assert.equal(existsSync(path), false);
    assert.ok(listedPaths(repo).includes(away));
    assert.match(git(repo.dir, "worktree", "list", "--porcelain"), /prunable/);
  });

  it("C40: a worktree locked by a human stays, with its branch", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "locked");
    git(repo.dir, "worktree", "lock", path);
    expectRemoveFail(remove(repo, path), "path-remains");
    assert.ok(existsSync(path));
    assert.equal(branchExists(repo, "worktree-locked"), true);
  });

  it("C41: a failed remove that left no path is ok with remove-incomplete", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "partial");
    const { deps } = interceptGit([
      {
        match: ["worktree", "remove"],
        before: () => rmSync(path, { recursive: true }),
        replace: GIT_FAILURE,
      },
    ]);
    const result = expectRemoved(remove(repo, path, deps));
    assert.equal(result.removed, true);
    assert.deepEqual(result.keptBranch, {
      name: "worktree-partial",
      reason: "remove-incomplete",
    });
    assert.equal(branchExists(repo, "worktree-partial"), true);
  });

  it("C42: running out of deadline before the remove leaves the path", () => {
    const repo = createRepo(temp);
    const path = makeWorktree(repo, "late");
    let clock = 0;
    const { deps, calls } = interceptGit(
      [
        {
          match: ["rev-parse", "--verify"],
          after: () => {
            clock = DEADLINE_MS + 1;
          },
        },
      ],
      { now: () => clock },
    );
    expectRemoveFail(remove(repo, path, deps), "path-remains");
    assert.ok(existsSync(path));
    assert.equal(branchExists(repo, "worktree-late"), true);
    assert.equal(
      calls.some(
        (call) => call.args[0] === "worktree" && call.args[1] === "remove",
      ),
      false,
    );
  });

  it(
    "C43: a read-only directory inside makes the remove fail and the path stays",
    { skip: isRoot && "root ignores directory permissions" },
    () => {
      const repo = createRepo(temp);
      const path = makeWorktree(repo, "rodir");
      const sub = join(path, "sub");
      mkdirSync(sub);
      writeFileSync(join(sub, "f.txt"), "f\n");
      try {
        chmodSync(sub, 0o555);
        expectRemoveFail(remove(repo, path), "path-remains");
      } finally {
        chmodSync(sub, 0o755);
      }
      assert.ok(existsSync(path));
      assert.equal(branchExists(repo, "worktree-rodir"), true);
    },
  );
});

// ---------------------------------------------------------------------------
// cleanupSubagentWorktree (K6)
// ---------------------------------------------------------------------------

const AGENT = "a278c2e632b92ee6c";

function cleanup(
  repo: Repo,
  agentId: string,
  deps?: Deps,
  cwd = repo.dir,
): SubagentCleanupResult {
  return cleanupSubagentWorktree({ agentId, cwd }, deps);
}

function makeAgentWorktree(repo: Repo, agentId = AGENT): string {
  return makeWorktree(repo, `agent-${agentId}`);
}

describe("cleanupSubagentWorktree", () => {
  it("T4: SubagentStop keeps a current-root worktree and branch behind a replaced symlink", () => {
    const repo = createRepo(temp);
    const path = makeAgentWorktree(repo);
    const root = currentRoot(repo.commonDir, testHome).slice(0, -1);
    const outside = temp.make("cwt-agent-current-outside-");
    writeFileSync(join(root, "outside.txt"), "keep\n");
    renameSync(root, join(outside, "moved"));
    symlinkSync(join(outside, "moved"), root);

    assert.deepEqual(cleanup(repo, AGENT), {
      action: "kept",
      detail: "git-failed",
    });
    assert.equal(existsSync(path), true);
    assert.equal(branchExists(repo, `worktree-agent-${AGENT}`), true);
    assert.ok(listedPaths(repo).includes(path));
    assert.equal(
      readFileSync(join(outside, "moved", "outside.txt"), "utf8"),
      "keep\n",
    );
  });

  it("T4: SubagentStop keeps a legacy-root worktree and branch behind a replaced symlink", () => {
    const repo = createRepo(temp);
    const root = join(repo.commonDir, "worktree");
    const path = join(root, `worktree-agent-${AGENT}`);
    git(
      repo.dir,
      "worktree",
      "add",
      "-q",
      "-b",
      `worktree-agent-${AGENT}`,
      path,
    );
    const outside = temp.make("cwt-agent-legacy-outside-");
    writeFileSync(join(root, "outside.txt"), "keep\n");
    renameSync(root, join(outside, "moved"));
    symlinkSync(join(outside, "moved"), root);

    assert.deepEqual(cleanup(repo, AGENT), {
      action: "kept",
      detail: "git-failed",
    });
    assert.equal(existsSync(path), true);
    assert.equal(branchExists(repo, `worktree-agent-${AGENT}`), true);
    assert.ok(listedPaths(repo).includes(path));
    assert.equal(
      readFileSync(join(outside, "moved", "outside.txt"), "utf8"),
      "keep\n",
    );
  });

  it("C45: an untouched worktree is removed with its branch", () => {
    const repo = createRepo(temp);
    const path = makeAgentWorktree(repo);
    assert.deepEqual(cleanup(repo, AGENT), { action: "removed" });
    assert.equal(existsSync(path), false);
    assert.equal(branchExists(repo, `worktree-agent-${AGENT}`), false);
  });

  it("C45: a worktree holding only ignored files is removed", () => {
    const repo = createRepo(temp);
    appendFileSync(join(repo.commonDir, "info", "exclude"), "ignored.txt\n");
    const path = makeAgentWorktree(repo);
    writeFileSync(join(path, "ignored.txt"), "x\n");
    assert.deepEqual(cleanup(repo, AGENT), { action: "removed" });
    assert.equal(existsSync(path), false);
  });

  it("C46: an untracked file keeps the worktree (has-changes)", () => {
    const repo = createRepo(temp);
    const path = makeAgentWorktree(repo);
    writeFileSync(join(path, "new.txt"), "x\n");
    assert.deepEqual(cleanup(repo, AGENT), {
      action: "kept",
      detail: "has-changes",
    });
    assert.ok(existsSync(path));
  });

  it("C46: a commit keeps the worktree and branch", () => {
    const repo = createRepo(temp);
    const path = makeAgentWorktree(repo);
    commitIn(path, "c.txt");
    const result = cleanup(repo, AGENT);
    assert.equal(result.action, "kept");
    if (result.action === "kept") {
      assert.ok(
        ["tip-moved", "reflog-not-single-creation"].includes(result.detail),
        result.detail,
      );
    }
    assert.ok(existsSync(path));
    assert.equal(branchExists(repo, `worktree-agent-${AGENT}`), true);
  });

  it("C47: no matching worktree is none", () => {
    const repo = createRepo(temp);
    const path = makeAgentWorktree(repo, "bbbb");
    assert.deepEqual(cleanup(repo, AGENT), { action: "none" });
    assert.ok(existsSync(path));
  });

  it("C47: the same result from inside the worktree or from the main worktree", () => {
    const inside = createRepo(temp);
    const insidePath = makeAgentWorktree(inside);
    assert.deepEqual(cleanup(inside, AGENT, undefined, insidePath), {
      action: "removed",
    });
    assert.equal(existsSync(insidePath), false);

    const main = createRepo(temp);
    const mainPath = makeAgentWorktree(main);
    assert.deepEqual(cleanup(main, AGENT, undefined, main.dir), {
      action: "removed",
    });
    assert.equal(existsSync(mainPath), false);
  });

  it("C48: a malformed agent_id is none and touches nothing", () => {
    const repo = createRepo(temp);
    const path = makeAgentWorktree(repo);
    for (const agentId of ["../x", "a".repeat(65), ""]) {
      assert.deepEqual(cleanup(repo, agentId), { action: "none" }, agentId);
    }
    assert.ok(existsSync(path));
  });

  it("C48: a cwd that is not a git repository, or a bare one, is none", () => {
    const plain = temp.make("cwt-plain-");
    assert.deepEqual(cleanupSubagentWorktree({ agentId: AGENT, cwd: plain }), {
      action: "none",
    });
    const { linkedDir } = createBareWithLinkedWorktree(temp);
    assert.deepEqual(
      cleanupSubagentWorktree({ agentId: AGENT, cwd: linkedDir }),
      { action: "none" },
    );
  });

  it("C49: a matched worktree whose HEAD is another branch is none", () => {
    const repo = createRepo(temp);
    const path = makeAgentWorktree(repo);
    const { deps } = interceptGit([
      {
        match: ["symbolic-ref"],
        replace: { ok: true, stdout: "refs/heads/somewhere-else" },
      },
    ]);
    assert.deepEqual(cleanup(repo, AGENT, deps), { action: "none" });
    assert.ok(existsSync(path));
  });

  it("C50: prunable, deadline and status failures are kept as git-failed", () => {
    const prunableRepo = createRepo(temp);
    const gone = makeAgentWorktree(prunableRepo);
    rmSync(gone, { recursive: true });
    assert.deepEqual(cleanup(prunableRepo, AGENT), {
      action: "kept",
      detail: "git-failed",
    });
    assert.equal(branchExists(prunableRepo, `worktree-agent-${AGENT}`), true);

    const lateRepo = createRepo(temp);
    const latePath = makeAgentWorktree(lateRepo);
    let clock = 0;
    const late = interceptGit(
      [
        {
          match: ["rev-parse", "--path-format=absolute"],
          after: () => {
            clock = DEADLINE_MS + 1;
          },
        },
      ],
      { now: () => clock },
    );
    assert.deepEqual(cleanup(lateRepo, AGENT, late.deps), {
      action: "kept",
      detail: "git-failed",
    });
    assert.ok(existsSync(latePath));

    const statusRepo = createRepo(temp);
    const statusPath = makeAgentWorktree(statusRepo);
    const failing = interceptGit([{ match: ["status"], replace: GIT_FAILURE }]);
    assert.deepEqual(cleanup(statusRepo, AGENT, failing.deps), {
      action: "kept",
      detail: "git-failed",
    });
    assert.ok(existsSync(statusPath));
  });

  it("C51: a failing remove is kept as remove-failed and the branch stays", () => {
    const repo = createRepo(temp);
    const path = makeAgentWorktree(repo);
    const { deps } = interceptGit([
      { match: ["worktree", "remove"], replace: GIT_FAILURE },
    ]);
    assert.deepEqual(cleanup(repo, AGENT, deps), {
      action: "kept",
      detail: "remove-failed",
    });
    assert.ok(existsSync(path));
    assert.equal(branchExists(repo, `worktree-agent-${AGENT}`), true);
  });

  it("C52: a CAS miss after the remove reports removed with the kept branch", () => {
    const repo = createRepo(temp);
    const path = makeAgentWorktree(repo);
    const { deps, calls } = interceptGit([
      {
        match: ["update-ref", "-d"],
        before: () => moveTip(repo, `worktree-agent-${AGENT}`),
      },
    ]);
    assert.deepEqual(cleanup(repo, AGENT, deps), {
      action: "removed",
      keptBranch: { name: `worktree-agent-${AGENT}`, reason: "cas-missed" },
    });
    assert.equal(existsSync(path), false);
    assert.equal(branchExists(repo, `worktree-agent-${AGENT}`), true);
    const cas = calls.find((call) => call.args[0] === "update-ref");
    assert.equal(cas?.args[3], repo.baseSha);
  });
});
