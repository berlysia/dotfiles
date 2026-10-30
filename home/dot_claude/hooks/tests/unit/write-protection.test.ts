#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyWriteTarget,
  CORE_PROTECTED_SOURCE,
  findHoldSegment,
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

describe("classifyWriteTarget - current worktree root", () => {
  it("allows verified nested worktree content and holds its .git file", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "wp-current-")));
    try {
      const home = join(scratch, "home");
      const repo = join(scratch, "repo");
      const commonDir = join(repo, ".git");
      const worktree = join(home, "worktrees", "repo", "a", "b");
      const adminDir = join(commonDir, "worktrees", "admin");
      mkdirSync(adminDir, { recursive: true });
      mkdirSync(join(worktree, "src"), { recursive: true });
      mkdirSync(join(commonDir, "objects"), { recursive: true });
      writeFileSync(join(commonDir, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(worktree, ".git"), `gitdir: ${adminDir}\n`);
      writeFileSync(join(adminDir, "gitdir"), `${join(worktree, ".git")}\n`);
      writeFileSync(
        join(home, "worktrees", "repo", ".common-dir"),
        "/elsewhere/.git\n",
      );
      const context = { ...names, home, fs: nodeHoldFs };

      strictEqual(
        classifyWriteTarget(join(worktree, ".github", "x"), context).kind,
        "worktree-content",
      );
      strictEqual(
        classifyWriteTarget(join(worktree, ".git"), context).kind,
        "hold",
      );
      strictEqual(
        classifyWriteTarget(join(worktree, "src", "x"), context).kind,
        "worktree-content",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
