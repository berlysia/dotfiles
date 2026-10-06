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
  CORE_PROTECTED_SOURCE,
  classifyWriteTarget,
  findHoldSegment,
  type HoldFs,
  nodeHoldFs,
} from "../../lib/write-protection.ts";

const names = { home: "/home/u", chezmoiSource: "/src/chezmoi/home" };
const holds = (p: string, rule: "outside" | "worktree") =>
  findHoldSegment(p, rule, names) !== null;

describe("findHoldSegment - outside worktrees (2a)", () => {
  it("holds any dot segment", () => {
    strictEqual(holds("/w/p/.github/ci.yml", "outside"), true);
    strictEqual(holds("/w/p/.tmp/a.md", "outside"), true);
  });
  it("leaves plain paths, '.' and '..' segments alone", () => {
    strictEqual(holds("/w/p/src/a.ts", "outside"), false);
    strictEqual(holds("./src/a.ts", "outside"), false);
  });
  it("holds bunfig.toml whatever the case", () => {
    strictEqual(holds("/w/p/bunfig.toml", "outside"), true);
    strictEqual(holds("/w/p/BunFig.TOML", "outside"), true);
  });
  it("holds chezmoi sources of the global git config, and only those", () => {
    strictEqual(holds("/src/chezmoi/home/dot_gitconfig.tmpl", "outside"), true);
    strictEqual(
      holds("/src/chezmoi/home/private_dot_config/git/ignore", "outside"),
      true,
    );
    strictEqual(holds("/src/chezmoi/home/dot_zshrc", "outside"), false);
  });
  it("does not hold a non-dot bare-repo-like name (K8 covers it)", () => {
    strictEqual(holds("/tmp/x/g.git/config", "outside"), false);
  });
});

describe("findHoldSegment - worktree interior (2b)", () => {
  it("holds core protected names whatever the case", () => {
    for (const rel of [
      ".git",
      "vendor/sub/.git",
      ".claude/settings.json",
      ".Claude/settings.json",
      ".GIT",
      ".vscode/tasks.json",
      ".config/git/config",
      ".npmrc",
      "bunfig.toml",
      ".husky/pre-commit",
    ]) {
      strictEqual(holds(rel, "worktree"), true, rel);
    }
  });
  it("leaves other dot names alone", () => {
    for (const rel of [
      ".github/workflows/ci.yml",
      ".gitignore",
      ".tmp/sessions/x/plan.md",
      "src/a.ts",
    ]) {
      strictEqual(holds(rel, "worktree"), false, rel);
    }
  });
  it("names its source and version", () => {
    strictEqual(
      /permission-modes.*2026-10-06.*2\.1\.291/.test(CORE_PROTECTED_SOURCE),
      true,
    );
  });
});

describe("classifyWriteTarget", () => {
  let scratch = "";
  let repo = "";
  let wt = "";
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { stdio: "ignore" },
    );
  const kind = (
    p: string,
    opts?: { worktreeRootIsContent?: boolean },
    fs: HoldFs = nodeHoldFs,
  ) => classifyWriteTarget(p, { ...names, fs }, opts).kind;
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
