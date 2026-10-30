#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  inspectWorktreePath,
  type WorktreeVerifyFs,
} from "../../lib/worktree-verify.ts";
import { nodeHoldFs } from "../../lib/write-protection.ts";

type LayoutOptions = {
  head?: boolean;
  objects?: boolean;
  reversePointer?: string;
  gitFile?: string;
};

function makeScratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "worktree-verify-")));
}

function makeLayout(
  home: string,
  repoDir: string,
  worktree: string,
  options: LayoutOptions = {},
) {
  const commonDir = join(repoDir, ".git");
  const adminDir = join(commonDir, "worktrees", "admin");
  const gitFile = join(worktree, ".git");
  mkdirSync(adminDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  if (options.head !== false)
    writeFileSync(join(commonDir, "HEAD"), "ref: refs/heads/main\n");
  if (options.objects !== false)
    mkdirSync(join(commonDir, "objects"), { recursive: true });
  writeFileSync(gitFile, options.gitFile ?? `gitdir: ${adminDir}\n`);
  writeFileSync(
    join(adminDir, "gitdir"),
    `${options.reversePointer ?? gitFile}\n`,
  );
  return { commonDir, adminDir, gitFile, home, worktree };
}

function inspect(
  path: string,
  home: string,
  fs: WorktreeVerifyFs = nodeHoldFs,
) {
  return inspectWorktreePath(path, home, fs);
}

const scratchDirs: string[] = [];
afterEach(() => {
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("inspectWorktreePath", () => {
  it("accepts a new-root worktree with a nested branch path", () => {
    const scratch = makeScratch();
    scratchDirs.push(scratch);
    const home = join(scratch, "home");
    const worktree = join(home, "worktrees", "repo", "a", "b");
    const layout = makeLayout(home, join(scratch, "repo"), worktree);
    strictEqual(inspect(join(worktree, "src", "x.ts"), home).root, worktree);
    strictEqual(layout.commonDir, join(scratch, "repo", ".git"));
  });

  it("accepts a legacy-root worktree only when its common dir matches the path", () => {
    const scratch = makeScratch();
    scratchDirs.push(scratch);
    const home = join(scratch, "home");
    const commonDir = join(scratch, "repo", ".git");
    const worktree = join(commonDir, "worktree", "feature");
    makeLayout(home, join(scratch, "repo"), worktree);
    strictEqual(inspect(join(worktree, "src", "x.ts"), home).root, worktree);
  });

  it("rejects a repo B worktree placed under repo A's current root", () => {
    const scratch = makeScratch();
    scratchDirs.push(scratch);
    const home = join(scratch, "home");
    const worktree = join(home, "worktrees", "repo-a", "x");
    makeLayout(home, join(scratch, "repo-b"), worktree);
    strictEqual(inspect(join(worktree, "src", "y.ts"), home).root, null);
  });

  it("rejects an admin directory whose reverse pointer names another gitfile", () => {
    const scratch = makeScratch();
    scratchDirs.push(scratch);
    const home = join(scratch, "home");
    const worktree = join(home, "worktrees", "repo", "feature");
    const wrongGitFile = join(scratch, "other", ".git");
    mkdirSync(join(scratch, "other"), { recursive: true });
    writeFileSync(wrongGitFile, "not a linked worktree\n");
    makeLayout(home, join(scratch, "repo"), worktree, {
      reversePointer: wrongGitFile,
    });
    strictEqual(inspect(join(worktree, "src", "y.ts"), home).root, null);
  });

  it("rejects a common dir without HEAD and objects", () => {
    const scratch = makeScratch();
    scratchDirs.push(scratch);
    const home = join(scratch, "home");
    const worktree = join(home, "worktrees", "repo", "feature");
    makeLayout(home, join(scratch, "repo"), worktree, {
      head: false,
      objects: false,
    });
    strictEqual(inspect(join(worktree, "src", "y.ts"), home).root, null);
  });

  it("rejects a common dir whose basename is not .git", () => {
    const scratch = makeScratch();
    scratchDirs.push(scratch);
    const home = join(scratch, "home");
    const worktree = join(home, "worktrees", basename(scratch), "feature");
    const commonDir = join(scratch, "repo.git");
    const adminDir = join(commonDir, "worktrees", "admin");
    const gitFile = join(worktree, ".git");
    mkdirSync(adminDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(commonDir, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(commonDir, "objects"), { recursive: true });
    writeFileSync(gitFile, `gitdir: ${adminDir}\n`);
    writeFileSync(join(adminDir, "gitdir"), `${gitFile}\n`);
    strictEqual(inspect(join(worktree, "src", "y.ts"), home).root, null);
  });

  it("rejects a current repo root that is a symlink", () => {
    const scratch = makeScratch();
    scratchDirs.push(scratch);
    const home = join(scratch, "home");
    const worktrees = join(home, "worktrees");
    const root = join(worktrees, "repo");
    const outside = join(scratch, "outside");
    const worktree = join(root, "feature");
    makeLayout(home, join(scratch, "repo"), worktree);
    renameSync(root, outside);
    symlinkSync(outside, root);
    strictEqual(inspect(join(worktree, "src", "y.ts"), home).root, null);
  });

  it("rejects a .git file with more than one gitdir line", () => {
    const scratch = makeScratch();
    scratchDirs.push(scratch);
    const home = join(scratch, "home");
    const worktree = join(home, "worktrees", "repo", "feature");
    const layout = makeLayout(home, join(scratch, "repo"), worktree, {
      gitFile: "gitdir: /tmp/admin\nsecond line\n",
    });
    strictEqual(inspect(join(worktree, "src", "y.ts"), home).root, null);
    strictEqual(layout.worktree, worktree);
  });

  it("uses the shallowest .git candidate and holds when that candidate is forged", () => {
    const scratch = makeScratch();
    scratchDirs.push(scratch);
    const home = join(scratch, "home");
    const commonDir = join(scratch, "repo", ".git");
    const nested = join(home, "worktrees", "repo", "outer", "inner");
    makeLayout(home, join(scratch, "repo"), nested);
    mkdirSync(join(home, "worktrees", "repo", "outer"), { recursive: true });
    mkdirSync(join(home, "worktrees", "repo", "outer", ".git"));
    strictEqual(inspect(join(nested, "src", "y.ts"), home).root, null);
    strictEqual(commonDir, join(scratch, "repo", ".git"));
  });

  it("returns a candidate failure for paths below either managed root", () => {
    const scratch = makeScratch();
    scratchDirs.push(scratch);
    const home = join(scratch, "home");
    const current = inspect(
      join(home, "worktrees", "repo", "plain", "src", "x"),
      home,
    );
    const legacy = inspect(
      join(scratch, "repo", ".git", "worktree", "plain", "src", "x"),
      home,
    );
    strictEqual(current.candidate, true);
    strictEqual(legacy.candidate, true);
    if (current.candidate) strictEqual(current.root, null);
    if (legacy.candidate) strictEqual(legacy.root, null);
  });
});
