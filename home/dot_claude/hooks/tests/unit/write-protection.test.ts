#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  CORE_PROTECTED_SOURCE,
  findHoldSegment,
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
