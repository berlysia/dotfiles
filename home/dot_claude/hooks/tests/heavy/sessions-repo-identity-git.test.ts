#!/usr/bin/env node --test

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { notStrictEqual, strictEqual } from "node:assert";
import {
  defaultRepoIdentityDeps,
  identifyRepo,
} from "../../lib/sessions/repo-identity.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-identity-")));
after(() => rmSync(root, { recursive: true, force: true }));

// Setup git is isolated from the user's global config (safe.bareRepository,
// signing, ...). The subject under test, identifyRepo, does not get these.
const setupGit = (cwd: string, ...args: string[]) => {
  const r = spawnSync(
    "git",
    [
      "-c",
      "safe.bareRepository=all",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  strictEqual(r.status, 0, r.stderr);
};

const makeRepo = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir);
  setupGit(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "f.txt"), "x");
  setupGit(dir, "add", "f.txt");
  setupGit(dir, "commit", "-q", "-m", "init");
  return dir;
};

const identify = (cwd: string) => identifyRepo(cwd, defaultRepoIdentityDeps);

describe("identifyRepo with a real git", () => {
  it("gives a repo and its linked worktree the same repo and different worktreePath", async () => {
    const main = makeRepo("main-repo");
    const linked = join(root, "linked");
    setupGit(main, "worktree", "add", "-q", "-b", "side", linked);
    const a = await identify(main);
    const b = await identify(linked);
    strictEqual(a.repoStatus, "git");
    strictEqual(b.repoStatus, "git");
    strictEqual(a.repo, b.repo);
    strictEqual(a.repo, join(main, ".git"));
    strictEqual(a.worktreePath, main);
    strictEqual(b.worktreePath, linked);
    strictEqual(a.branch, "main");
    strictEqual(b.branch, "side");
  });

  it("returns not-git outside any repository", async () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    const result = await identify(dir);
    strictEqual(result.repoStatus, "not-git");
    strictEqual(result.repo, null);
  });

  it("returns a null branch for a detached HEAD", async () => {
    const repo = makeRepo("detached");
    setupGit(repo, "checkout", "-q", "--detach");
    const result = await identify(repo);
    strictEqual(result.repoStatus, "git");
    strictEqual(result.branch, null);
  });

  it("returns error inside a bare repo, but git in its linked worktree", async () => {
    const source = makeRepo("bare-source");
    const bare = join(root, "bare.git");
    setupGit(root, "clone", "-q", "--bare", source, bare);
    strictEqual((await identify(bare)).repoStatus, "error");

    const linked = join(root, "bare-linked");
    setupGit(bare, "worktree", "add", "-q", linked, "main");
    const result = await identify(linked);
    strictEqual(result.repoStatus, "git");
    strictEqual(result.repo, bare);
    strictEqual(result.worktreePath, linked);
    strictEqual(result.branch, "main");
  });

  it("ignores GIT_DIR in the caller's env", async () => {
    const target = makeRepo("env-target");
    const other = makeRepo("env-other");
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, ".git");
    try {
      const result = await identify(target);
      strictEqual(result.repo, join(target, ".git"));
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  it("returns error for a repo whose directory name has a newline", async () => {
    const dir = join(root, "new\nline");
    mkdirSync(dir);
    setupGit(dir, "init", "-q");
    const result = await identify(dir);
    strictEqual(result.repoStatus, "error");
    strictEqual(result.repo, null);
    notStrictEqual(result.repoStatus, "git");
  });
});
