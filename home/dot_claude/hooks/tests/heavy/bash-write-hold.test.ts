#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { assessBashCommand } from "../../lib/bash-write-hold.ts";
import { nodeHoldFs } from "../../lib/write-protection.ts";

describe("assessBashCommand - verified worktrees", () => {
  let scratch = "";
  let wt = "";
  let home = "";
  let currentWt = "";
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
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "bwh-wt-")));
    const repo = join(scratch, "repo");
    git("init", "-q", repo);
    git("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
    wt = join(repo, ".git", "worktree", "feat", "x");
    git("-C", repo, "worktree", "add", "-q", wt, "-b", "feat/x");
    home = join(scratch, "home");
    currentWt = join(home, "worktrees", "repo", "a", "b");
    mkdirSync(join(home, "worktrees", "repo"), { recursive: true });
    git("-C", repo, "worktree", "add", "-q", "-b", "feat/a/b", currentWt);
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));
  const heldIn = async (cmd: string, cwd: string, worktreeHome = "/home/u") =>
    (
      await assessBashCommand(cmd, {
        cwd,
        projectRoot: scratch,
        home: worktreeHome,
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
    strictEqual(await heldIn(`tee ${wt}/.git/config`, scratch), true);
  });
  it("allows new-root absolute content and holds the marker and gitfile", async () => {
    const marker = join(home, "worktrees", "repo", ".common-dir");
    writeFileSync(marker, "/different/repo/.git\n");
    strictEqual(
      await heldIn(`echo x > ${join(currentWt, "src", "x")}`, scratch, home),
      false,
    );
    strictEqual(await heldIn(`echo x > ${marker}`, scratch, home), true);
    strictEqual(
      await heldIn(`echo x > ${join(currentWt, ".git")}`, scratch, home),
      true,
    );
  });
});
