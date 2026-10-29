#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  execGit,
  gitEnv,
  gitSafetyArgs,
  type ExecFileImpl,
} from "../../lib/git-env.ts";

const ALLOWED_KEYS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_OPTIONAL_LOCKS",
  "GIT_TERMINAL_PROMPT",
  "LC_ALL",
]);

describe("gitEnv", () => {
  it("drops relative and empty PATH entries", () => {
    strictEqual(gitEnv({ PATH: ".:/usr/bin::bin:/bin" }).PATH, "/usr/bin:/bin");
  });

  it("keeps only allowlisted keys and forces LC_ALL=C", () => {
    let seed = 7;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };
    const source: Record<string, string> = {
      PATH: "/usr/bin",
      GIT_DIR: "/x",
      GIT_WORK_TREE: "/x",
      GIT_EXEC_PATH: "/x",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.pager",
      LC_ALL: "ja_JP.UTF-8",
    };
    for (let i = 0; i < 50; i++) source[`GIT_R${next().toString(36)}`] = "1";
    const env = gitEnv(source);
    for (const key of Object.keys(env)) ok(ALLOWED_KEYS.has(key), key);
    strictEqual(env.LC_ALL, "C");
    strictEqual(env.GIT_CONFIG_GLOBAL, "/dev/null");
    strictEqual(env.GIT_CONFIG_NOSYSTEM, "1");
  });
});

describe("execGit", () => {
  type Call = {
    file: string;
    args: readonly string[];
    options: Parameters<ExecFileImpl>[2];
  };
  const fake =
    (
      result: {
        error?: Record<string, unknown> | null;
        stdout?: string;
        stderr?: string;
      },
      calls: Call[],
    ): ExecFileImpl =>
    (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(
        (result.error ?? null) as never,
        result.stdout ?? "",
        result.stderr ?? "",
      );
      return undefined;
    };

  it("builds the argv, env and options", async () => {
    const calls: Call[] = [];
    const result = await execGit(["status"], "/work", {
      execFileImpl: fake({ stdout: "ok" }, calls),
    });
    strictEqual(result.code, 0);
    strictEqual(result.stdout, "ok");
    const call = calls[0];
    ok(call);
    strictEqual(call.file, "git");
    deepStrictEqual(call.args, [...gitSafetyArgs(), "-C", "/work", "status"]);
    deepStrictEqual(call.options.env, gitEnv());
    strictEqual(call.options.killSignal, "SIGKILL");
    strictEqual(call.options.maxBuffer, 65536);
    strictEqual(call.options.timeout, 2000);
  });

  it("passes opts.maxBuffer through", async () => {
    const calls: Call[] = [];
    await execGit(["status"], "/work", {
      maxBuffer: 1234,
      execFileImpl: fake({}, calls),
    });
    strictEqual(calls[0]?.options.maxBuffer, 1234);
  });

  it("reports overflow with code null", async () => {
    const result = await execGit(["status"], "/work", {
      execFileImpl: fake(
        { error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true } },
        [],
      ),
    });
    strictEqual(result.code, null);
    strictEqual(result.overflow, true);
    strictEqual(result.timedOut, false);
  });

  it("reports a timeout", async () => {
    const result = await execGit(["status"], "/work", {
      execFileImpl: fake({ error: { killed: true, signal: "SIGKILL" } }, []),
    });
    strictEqual(result.timedOut, true);
    strictEqual(result.code, null);
  });

  it("reports a non-zero exit with stderr", async () => {
    const result = await execGit(["status"], "/work", {
      execFileImpl: fake({ error: { code: 128 }, stderr: "fatal: x" }, []),
    });
    strictEqual(result.code, 128);
    strictEqual(result.stderr, "fatal: x");
  });

  it("does not start git for a cwd containing NUL", async () => {
    const calls: Call[] = [];
    const result = await execGit(["status"], "/a\0b", {
      execFileImpl: fake({}, calls),
    });
    strictEqual(calls.length, 0);
    strictEqual(result.code, null);
  });

  it("does not throw when starting fails synchronously", async () => {
    const result = await execGit(["status"], "/work", {
      execFileImpl: () => {
        throw new Error("boom");
      },
    });
    strictEqual(result.code, null);
  });
});

describe("gitSafetyArgs", () => {
  it("is the three -c pairs", () => {
    deepStrictEqual(gitSafetyArgs(), [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "safe.bareRepository=explicit",
    ]);
  });
});
