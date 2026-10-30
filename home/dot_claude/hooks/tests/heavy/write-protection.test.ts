#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  classifyWriteTarget,
  type HoldFs,
  nodeHoldFs,
} from "../../lib/write-protection.ts";

const names = { home: "/home/u", chezmoiSource: "/src/chezmoi/home" };

describe("classifyWriteTarget", () => {
  let scratch = "";
  let repo = "";
  let wt = "";
  // The fixture git must not read the developer's global config: commit signing there would
  // wait on a signing agent and time the test out.
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    );
  const kind = (
    p: string,
    opts?: { worktreeRootIsContent?: boolean },
    fs: HoldFs = nodeHoldFs,
    home = names.home,
  ) => classifyWriteTarget(p, { ...names, home, fs }, opts).kind;
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "wp-")));
    repo = join(scratch, "repo");
    git("init", "-q", repo);
    git("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
    wt = join(repo, ".git", "worktree", "feat", "x");
    git("-C", repo, "worktree", "add", "-q", wt, "-b", "feat/x");
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("treats ordinary files in a verified worktree as worktree-content", () => {
    for (const rel of ["src/a.ts", ".github/ci.yml", ".gitignore"]) {
      strictEqual(kind(join(wt, rel)), "worktree-content", rel);
    }
  });
  it("allows new-root nested worktree content and ignores its marker value", () => {
    const home = join(scratch, "home");
    const worktree = join(home, "worktrees", "repo", "a", "b");
    git("-C", repo, "worktree", "add", "-q", "-b", "feat/a/b", worktree);
    writeFileSync(
      join(home, "worktrees", "repo", ".common-dir"),
      "/elsewhere/.git\n",
    );

    strictEqual(
      kind(join(worktree, ".github", "x"), undefined, nodeHoldFs, home),
      "worktree-content",
    );
    strictEqual(
      kind(join(worktree, "src", "x"), undefined, nodeHoldFs, home),
      "worktree-content",
    );
    strictEqual(
      kind(join(worktree, ".git"), undefined, nodeHoldFs, home),
      "hold",
    );
  });
  it("holds a repo B worktree placed under repo A's current root", () => {
    const home = join(scratch, "home");
    const repoB = join(scratch, "repo-b");
    git("init", "-q", repoB);
    git("-C", repoB, "commit", "-q", "--allow-empty", "-m", "init");
    const fake = join(home, "worktrees", "repo", "repo-b-worktree");
    git("-C", repoB, "worktree", "add", "-q", "-b", "fake", fake);
    strictEqual(
      kind(join(fake, "src", "y"), undefined, nodeHoldFs, home),
      "hold",
    );
  });
  it("finds the worktree when a character before it changes length on lower-casing", () => {
    // U+0130 lower-cases to two code units; an index taken on the lower-cased copy then slices
    // the original one unit too far and the real worktree is no longer recognised.
    const oddRepo = join(scratch, "\u0130", "repo");
    mkdirSync(join(scratch, "\u0130"));
    git("init", "-q", oddRepo);
    git("-C", oddRepo, "commit", "-q", "--allow-empty", "-m", "init");
    const oddWt = join(oddRepo, ".git", "worktree", "feat", "y");
    git("-C", oddRepo, "worktree", "add", "-q", oddWt, "-b", "feat/y");
    strictEqual(kind(join(oddWt, "src/a.ts")), "worktree-content");
    // The same shape without a verifiable worktree still holds.
    strictEqual(
      kind(
        join(scratch, "\u0130", "none", ".git", "worktree", "f", "src/a.ts"),
      ),
      "hold",
    );
  });
  it("holds protected names inside the worktree, whatever the case", () => {
    for (const rel of [
      ".git",
      ".claude/settings.json",
      ".CLAUDE/settings.json",
      "vendor/sub/.git",
    ]) {
      strictEqual(kind(join(wt, rel)), "hold", rel);
    }
  });
  it("holds the worktree root for Edit, and treats it as content for Bash words", () => {
    strictEqual(kind(wt), "hold");
    strictEqual(kind(wt, { worktreeRootIsContent: true }), "worktree-content");
  });
  it("holds a forged worktree whose gitfile does not point back", () => {
    const fake = join(repo, ".git", "worktree", "fake");
    mkdirSync(fake, { recursive: true });
    writeFileSync(
      join(fake, ".git"),
      `gitdir: ${join(repo, ".git", "worktrees", "x")}\n`,
    );
    strictEqual(kind(join(fake, "src/a.ts")), "hold");
  });
  it("stops at a .git that is not a regular file", () => {
    const odd = join(repo, ".git", "worktree", "odd");
    mkdirSync(join(odd, ".git"), { recursive: true });
    strictEqual(kind(join(odd, "src/a.ts")), "hold");
  });
  it("holds a path that leaves the worktree through a symlink", () => {
    symlinkSync(join(repo, ".git"), join(wt, "escape"));
    strictEqual(kind(join(wt, "escape/config")), "hold");
  });
  it("holds the main .git and is ordinary for a plain path", () => {
    strictEqual(kind(join(repo, ".git/config")), "hold");
    strictEqual(kind(join(repo, "src/a.ts")), "ordinary");
  });
  it("holds a path with '..'", () => {
    strictEqual(kind(`${repo}/src/../src/a.ts`), "hold");
  });
  it("holds when lstat fails with anything but ENOENT", () => {
    const failing: HoldFs = {
      ...nodeHoldFs,
      lstat: (p: string) => {
        if (p.endsWith("/.git"))
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        return nodeHoldFs.lstat(p);
      },
    };
    strictEqual(kind(join(wt, "src/a.ts"), undefined, failing), "hold");
  });
});
