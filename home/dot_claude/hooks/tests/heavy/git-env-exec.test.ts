#!/usr/bin/env node --test

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execGit, gitEnv, gitSafetyArgs } from "../../lib/git-env.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "git-env-exec-")));
after(() => rmSync(root, { recursive: true, force: true }));

// Setup git is isolated from the user's global config so the fixture does not
// depend on it (safe.bareRepository, commit.gpgsign, ...). The subject under
// test, execGit, does not get these.
const setupGit = (cwd: string, ...args: string[]) => {
  const r = spawnSync(
    "git",
    ["-c", "safe.bareRepository=all", "-c", "commit.gpgsign=false", ...args],
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

describe("execGit with a real git", () => {
  it("does not run core.fsmonitor or core.hooksPath programs from the repo config", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    setupGit(repo, "init", "-q");
    const marks = join(root, "marks");
    mkdirSync(marks);
    const fsmonitor = join(root, "fsmonitor.sh");
    writeFileSync(fsmonitor, `#!/bin/sh\ntouch "${marks}/fsmonitor"\n`);
    chmodSync(fsmonitor, 0o755);
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    for (const hook of [
      "post-index-change",
      "post-checkout",
      "reference-transaction",
    ]) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch "${marks}/${hook}"\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
    setupGit(repo, "config", "core.fsmonitor", fsmonitor);
    setupGit(repo, "config", "core.hooksPath", hooks);
    writeFileSync(join(repo, "f.txt"), "x");

    const result = await execGit(["status", "--porcelain"], repo, {
      timeoutMs: 10000,
    });
    strictEqual(result.code, 0, result.stderr);
    ok(result.stdout.includes("f.txt"));
    deepStrictEqual(
      [
        existsSync(join(marks, "fsmonitor")),
        existsSync(join(marks, "post-index-change")),
      ],
      [false, false],
    );
  });

  it("passes the safety args first and a filtered env to the git on PATH", async () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const record = join(root, "record");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}.argv"\nenv > "${record}.env"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const saved = {
      PATH: process.env.PATH,
      COUNT: process.env.GIT_CONFIG_COUNT,
    };
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
    process.env.GIT_CONFIG_COUNT = "1";
    try {
      await execGit(["status"], "/work");
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.COUNT === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = saved.COUNT;
    }
    const argv = readFileSync(`${record}.argv`, "utf8").split("\n");
    deepStrictEqual(argv.slice(0, 6), gitSafetyArgs());
    const allowed = new Set([
      ...Object.keys(
        gitEnv({ PATH: "/x", HOME: "/x", TMPDIR: "/x", USER: "x" }),
      ),
      "PWD",
      "SHLVL",
      "_",
      "OLDPWD",
    ]);
    for (const line of readFileSync(`${record}.env`, "utf8").split("\n")) {
      if (!line) continue;
      const key = line.slice(0, line.indexOf("="));
      ok(allowed.has(key), `unexpected env key ${key}`);
    }
  });
});
