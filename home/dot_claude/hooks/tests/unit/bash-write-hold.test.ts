#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  assessBashCommand,
  maskProjectRoot,
} from "../../lib/bash-write-hold.ts";
import { nodeHoldFs } from "../../lib/write-protection.ts";
import { withParseBudget } from "../support/parse-budget.ts";

describe("assessBashCommand", () => {
  let cwd = "";
  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "bwh-")));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));
  const ctx = () => ({
    cwd,
    projectRoot: cwd,
    home: "/home/u",
    chezmoiSource: "/src/chezmoi/home",
    fs: nodeHoldFs,
  });
  const held = async (cmd: string) =>
    (await assessBashCommand(cmd, ctx())).reason !== null;

  it("does not hold commands without hold paths", async () => {
    for (const cmd of [
      "git status",
      "git add .",
      "git -C sub log --oneline",
      "bun run test",
      "ls src ../x ./y",
      "echo hi > /dev/null",
      "cat a.ts",
    ]) {
      strictEqual(await held(cmd), false, cmd);
    }
  });
  it("holds dot paths in every spelling", async () => {
    for (const cmd of [
      "tee .claude/settings.json",
      "tee '.claude/settings.json'",
      'tee ".claude/settings.json"',
      'tee .cl"aude"/x',
      "echo x > .git/info/exclude",
      "cp a.txt .VSCODE/a.txt",
      "ls --dir=.tmp",
      "dd of=.claude/x",
    ]) {
      strictEqual(await held(cmd), true, cmd);
    }
  });
  it("holds words it cannot resolve and cwd changes", async () => {
    for (const cmd of [
      "cat $HOME/notes.txt",
      "cp a $(pwd)/b",
      "echo a{b,c}",
      "cd sub && cat a.txt",
      "pushd sub",
    ]) {
      strictEqual(await held(cmd), true, cmd);
    }
  });
  it("holds names split by quotes or backslashes", async () => {
    for (const cmd of [
      "cat bunfig.to'ml'",
      "cat \\.claude/x",
      "cat dot_git'config'.tmpl",
    ]) {
      strictEqual(await held(cmd), true, cmd);
    }
  });
  it("holds a word with '..' after the first segment", async () => {
    strictEqual(await held("cat sub/link/../x"), true);
    strictEqual(await held("cat ../x"), false);
  });
  it("holds on a syntax error", async () => {
    strictEqual(await held("echo 'unterminated"), true);
  });
  it("holds when the parser gives up", async () => {
    await withParseBudget(0, async () => {
      strictEqual(await held("ls budget-probe-dir"), true);
    });
  });
});

describe("assessBashCommand - a project root under a dot directory", () => {
  let scratch = "";
  let root = "";
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "bwh-root-")));
    // Like ~/.local/share/chezmoi: the project root itself sits under a dot directory.
    root = join(scratch, ".local", "share", "repo");
    mkdirSync(join(root, "src"), { recursive: true });
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));
  const heldWith = async (cmd: string, cwd: string, projectRoot: string) =>
    (
      await assessBashCommand(cmd, {
        cwd,
        projectRoot,
        home: "/home/u",
        chezmoiSource: "/src/chezmoi/home",
        fs: nodeHoldFs,
      })
    ).reason !== null;
  const heldAt = (cmd: string) => heldWith(cmd, root, root);

  it("does not count dot segments above the project root, relative or absolute", async () => {
    for (const cmd of [
      "git status",
      "ls src",
      "git add .",
      `git -C ${root} status`,
      `cat ${root}/src/a.ts`,
    ]) {
      strictEqual(await heldAt(cmd), false, cmd);
    }
  });
  it("still holds dot paths below the project root", async () => {
    strictEqual(await heldAt("cat .claude/x"), true);
    strictEqual(await heldAt(`cat ${root}/.claude/x`), true);
  });
  it("leaves '..' to the word stage after masking the root", async () => {
    // The whole-text stage does not look at '..'; hasInnerParentSegment holds it.
    strictEqual(await heldAt(`cat ${root}/../x`), true);
  });
  it("judges a word whole when a symlink leads out of the project root", async () => {
    symlinkSync(join(scratch, ".local"), join(root, "up"));
    strictEqual(await heldAt("cat up/share"), true);
  });
  it("applies two-segment protected names across the project root boundary", async () => {
    const config = join(scratch, ".config");
    mkdirSync(join(config, "git"), { recursive: true });
    strictEqual(await heldWith("tee git/config", config, config), true);
  });
  it("does not trust a project root that core protects", async () => {
    for (const protectedDir of [".claude", ".git", join(".config", "git")]) {
      const dir = join(scratch, protectedDir, "sub");
      mkdirSync(dir, { recursive: true });
      strictEqual(
        await heldWith("tee settings.json", dir, dir),
        true,
        protectedDir,
      );
    }
  });
  it("masks the root only as a whole path prefix", () => {
    const c = {
      cwd: root,
      projectRoot: root,
      home: "/home/u",
      chezmoiSource: "/src/chezmoi/home",
      fs: nodeHoldFs,
    };
    strictEqual(maskProjectRoot(`cat ${root}/a`, c), "cat PROJ/a");
    strictEqual(maskProjectRoot(`cat ${root}2/a`, c), `cat ${root}2/a`);
    strictEqual(maskProjectRoot(`cat ${root}-evil/a`, c), `cat ${root}-evil/a`);
    strictEqual(maskProjectRoot(`cat /o${root}/b`, c), `cat /o${root}/b`);
  });
  it("uses the project root, not the cwd, as the base", async () => {
    // cwd below a dot directory that is not the project root: no relaxation.
    const other = join(scratch, ".ssh-like", "sub");
    mkdirSync(other, { recursive: true });
    strictEqual(await heldWith("tee notes.txt", other, root), true);
  });
});

describe("assessBashCommand - verified worktrees", () => {
  let scratch = "";
  let wt = "";
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { stdio: "ignore" },
    );
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "bwh-wt-")));
    const repo = join(scratch, "repo");
    git("init", "-q", repo);
    git("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
    wt = join(repo, ".git", "worktree", "feat", "x");
    git("-C", repo, "worktree", "add", "-q", wt, "-b", "feat/x");
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));
  const heldIn = async (cmd: string, cwd: string) =>
    (
      await assessBashCommand(cmd, {
        cwd,
        projectRoot: scratch,
        home: "/home/u",
        chezmoiSource: "/src/chezmoi/home",
        fs: nodeHoldFs,
      })
    ).reason !== null;

  it("does not hold work inside the worktree, absolute or relative", async () => {
    strictEqual(await heldIn(`git -C ${wt} status`, scratch), false);
    strictEqual(await heldIn(`cat ${wt}/src/a.ts`, scratch), false);
    strictEqual(await heldIn("git add .", wt), false);
    strictEqual(await heldIn("cat .github/ci.yml", wt), true); // dot fragment in text: core's allow rules decide
  });
  it("holds protected names inside the worktree", async () => {
    strictEqual(await heldIn(`tee ${wt}/.claude/x.json`, scratch), true);
  });
});
