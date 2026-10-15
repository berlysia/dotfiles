import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createWorktree } from "../../lib/claude-worktree.ts";
import type { CreateResult } from "../../lib/claude-worktree.ts";
import type { Deps } from "../../lib/claude-worktree-git.ts";
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
after(() => temp.cleanup());

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

function listedPaths(repo: Repo): string[] {
  return git(repo.dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

describe("createWorktree: placement and base", () => {
  it("C09: branches from origin/HEAD into <common>/worktree/worktree-<name>", () => {
    const repo = createRepo(temp, { origin: true, localAhead: true });
    assert.notEqual(repo.originSha, repo.baseSha);
    const result = expectOk(create(repo, "bold-oak-a3f2"));
    assert.equal(
      result.path,
      join(repo.commonDir, "worktree", "worktree-bold-oak-a3f2"),
    );
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

  it("C11: from inside a linked worktree, places under the main .git/worktree", () => {
    const repo = createRepo(temp);
    const linked = addLinkedWorktree(temp, repo, "human-branch");
    const result = expectOk(create(repo, "from-linked", undefined, linked));
    assert.equal(
      result.path,
      join(repo.commonDir, "worktree", "worktree-from-linked"),
    );
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

  it("C16: symlinked-dir when <common>/worktree is a symlink", () => {
    const repo = createRepo(temp);
    const elsewhere = temp.make("cwt-elsewhere-");
    symlinkSync(elsewhere, join(repo.commonDir, "worktree"));
    expectFail(create(repo, "x"), "symlinked-dir");
    assert.equal(branchExists(repo, "worktree-x"), false);
  });
});

describe("createWorktree: occupied placement", () => {
  it("C17: unregistered directory at the target", () => {
    const repo = createRepo(temp);
    mkdirSync(join(repo.commonDir, "worktree", "worktree-occ"), {
      recursive: true,
    });
    expectFail(create(repo, "occ"), "path-occupied");
    assert.equal(branchExists(repo, "worktree-occ"), false);
  });

  it("C17: broken symlink at the target", () => {
    const repo = createRepo(temp);
    mkdirSync(join(repo.commonDir, "worktree"), { recursive: true });
    symlinkSync(
      "/nonexistent-target",
      join(repo.commonDir, "worktree", "worktree-broken"),
    );
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
    assert.equal(
      existsSync(join(repo.commonDir, "worktree", "worktree-lonely")),
      false,
    );
  });
});

describe("createWorktree: coexistence", () => {
  it("C19: a worktree made by hand with the same name is reused untouched", () => {
    const repo = createRepo(temp);
    const path = join(repo.commonDir, "worktree", "worktree-foo");
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
      const worktreeDir = join(repo.commonDir, "worktree");
      mkdirSync(worktreeDir);
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
