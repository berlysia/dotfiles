import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createGit, defaultDeps } from "../../lib/claude-worktree-git.ts";
import {
  createRepo,
  createTempTracker,
  git,
} from "../support/claude-worktree-fixture.ts";

const temp = createTempTracker();
after(() => temp.cleanup());

describe("createGit", () => {
  it("C01: runs a read in a temp repo and returns trimmed stdout", () => {
    const repo = createRepo(temp);
    const run = createGit(defaultDeps(), Date.now());
    const result = run(
      ["rev-parse", "--is-inside-work-tree"],
      "read",
      repo.dir,
    );
    assert.deepEqual(result, { ok: true, stdout: "true" });
  });

  it("C02: returns ok:false with stderr for an unknown subcommand and a missing cwd", () => {
    const repo = createRepo(temp);
    const run = createGit(defaultDeps(), Date.now());
    const unknown = run(["no-such-subcommand"], "read", repo.dir);
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.notEqual(unknown.stderr, "");
      assert.equal(unknown.timedOut, false);
    }
    const missingCwd = run(
      ["status"],
      "read",
      join(repo.dir, "does-not-exist"),
    );
    assert.equal(missingCwd.ok, false);
    if (!missingCwd.ok) assert.notEqual(missingCwd.stderr, "");
  });
});

describe("git hardening", () => {
  it("C06: does not run post-checkout hooks", () => {
    const repo = createRepo(temp);
    const marker = join(repo.dir, "hook-ran");
    const hooks = join(repo.commonDir, "hooks");
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);

    // Control: without the hardening the hook does fire in this environment.
    const controlPath = join(temp.make("cwt-ctl-"), "ctl");
    execFileSync(
      "git",
      ["worktree", "add", "-q", "-b", "control", controlPath],
      {
        cwd: repo.dir,
        stdio: "ignore",
      },
    );
    assert.equal(
      existsSync(marker),
      true,
      "control: hook should fire without hardening",
    );
    execFileSync("rm", ["-f", marker]);

    const run = createGit(defaultDeps(), Date.now());
    const path = join(temp.make("cwt-hook-"), "wt");
    const result = run(
      ["worktree", "add", "-b", "hardened", "--", path],
      "add",
      repo.dir,
    );
    assert.equal(result.ok, true);
    assert.equal(existsSync(marker), false);
  });

  it("C07: does not start a core.fsmonitor command", () => {
    const repo = createRepo(temp);
    const marker = join(repo.dir, "fsmonitor-ran");
    const script = join(temp.make("cwt-fsm-"), "fsm.sh");
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(script, 0o755);
    git(repo.dir, "config", "core.fsmonitor", script);

    execFileSync("git", ["status"], { cwd: repo.dir, stdio: "ignore" });
    assert.equal(
      existsSync(marker),
      true,
      "control: fsmonitor should fire without hardening",
    );
    execFileSync("rm", ["-f", marker]);

    const run = createGit(defaultDeps(), Date.now());
    const result = run(["status"], "read", repo.dir);
    assert.equal(result.ok, true);
    assert.equal(existsSync(marker), false);
  });

  it("C08: ignores GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_COUNT / GIT_SSH_COMMAND from the parent", () => {
    const target = createRepo(temp);
    const decoy = createRepo(temp);
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
    };
    process.env.GIT_DIR = decoy.commonDir;
    process.env.GIT_WORK_TREE = decoy.dir;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "injected";
    process.env.GIT_SSH_COMMAND = "echo injected";
    try {
      const run = createGit(defaultDeps(), Date.now());
      const top = run(["rev-parse", "--show-toplevel"], "read", target.dir);
      assert.deepEqual(top, { ok: true, stdout: target.dir });
      const name: GitResult = run(
        ["config", "--get", "user.name"],
        "read",
        target.dir,
      );
      assert.notDeepEqual(name, { ok: true, stdout: "injected" });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
