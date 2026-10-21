#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { assessBashCommand } from "../../lib/bash-write-hold.ts";
import { nodeHoldFs } from "../../lib/write-protection.ts";

describe("assessBashCommand - verified worktrees", () => {
  let scratch = "";
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
