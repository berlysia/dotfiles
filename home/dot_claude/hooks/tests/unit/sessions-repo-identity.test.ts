#!/usr/bin/env node --test

import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import type { ExecGitResult } from "../../lib/git-env.ts";
import {
  identifyRepo,
  type RepoIdentityDeps,
} from "../../lib/sessions/repo-identity.ts";

const ok = (stdout: string): ExecGitResult => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  overflow: false,
});
const fail = (
  code: number | null,
  stderr = "",
  extra: Partial<ExecGitResult> = {},
): ExecGitResult => ({
  code,
  stdout: "",
  stderr,
  timedOut: false,
  overflow: false,
  ...extra,
});

type Script = {
  common?: ExecGitResult;
  toplevel?: ExecGitResult;
  head?: ExecGitResult;
  realpath?: (p: string) => string;
  stat?: () => Promise<{ isDirectory(): boolean }>;
  onCall?: (kind: string) => void;
};

const setup = (script: Script) => {
  const calls: string[] = [];
  const deps: RepoIdentityDeps = {
    stat: script.stat ?? (async () => ({ isDirectory: () => true })),
    realpath: async (p) => (script.realpath ?? ((x) => x))(p),
    execGit: async (args) => {
      const kind = args.includes("--git-common-dir")
        ? "common"
        : args.includes("--show-toplevel")
          ? "toplevel"
          : "head";
      calls.push(kind);
      script.onCall?.(kind);
      const r =
        kind === "common"
          ? script.common
          : kind === "toplevel"
            ? script.toplevel
            : script.head;
      return r ?? fail(null);
    },
  };
  return { deps, calls };
};

const NULLS = {
  repo: null,
  worktree: null,
  worktreePath: null,
  branch: null,
};

describe("identifyRepo", () => {
  it("returns git with repo, worktree and branch", async () => {
    const { deps, calls } = setup({
      common: ok("/r/.git\n"),
      toplevel: ok("/r\n"),
      head: ok("main\n"),
    });
    deepStrictEqual(await identifyRepo("/r", deps), {
      repoStatus: "git",
      repo: "/r/.git",
      worktree: "/r",
      worktreePath: "/r",
      branch: "main",
    });
    deepStrictEqual(calls, ["common", "toplevel", "head"]);
  });

  it("returns not-git without calling the later commands", async () => {
    const { deps, calls } = setup({
      common: fail(
        128,
        "fatal: not a git repository (or any of the parent directories): .git",
      ),
    });
    deepStrictEqual(await identifyRepo("/x", deps), {
      repoStatus: "not-git",
      ...NULLS,
    });
    deepStrictEqual(calls, ["common"]);
  });

  it("treats dubious ownership as error", async () => {
    const { deps } = setup({
      common: fail(
        128,
        "fatal: detected dubious ownership in repository at '/r'",
      ),
    });
    strictEqual((await identifyRepo("/r", deps)).repoStatus, "error");
  });

  it("treats a bare repository refusal as error", async () => {
    const { deps } = setup({
      common: fail(
        128,
        "fatal: cannot use bare repository '/b.git' (safe.bareRepository is 'explicit')",
      ),
    });
    strictEqual((await identifyRepo("/b.git", deps)).repoStatus, "error");
  });

  it("treats a code 128 with other text as error, not not-git", async () => {
    const { deps } = setup({ common: fail(128, "fatal: something else") });
    strictEqual((await identifyRepo("/r", deps)).repoStatus, "error");
  });

  it("treats timeout and overflow as error", async () => {
    for (const extra of [{ timedOut: true }, { overflow: true }]) {
      const { deps } = setup({ common: fail(null, "", extra) });
      deepStrictEqual(await identifyRepo("/r", deps), {
        repoStatus: "error",
        ...NULLS,
      });
    }
  });

  it("treats a common-dir containing a newline as error", async () => {
    const { deps, calls } = setup({ common: ok("/a\n/b/.git\n") });
    deepStrictEqual(await identifyRepo("/r", deps), {
      repoStatus: "error",
      ...NULLS,
    });
    deepStrictEqual(calls, ["common"]);
  });

  it("rejects a newline in common-dir even if realpath would yield a clean path", async () => {
    // Isolates the newline check from the unsafe-character check on repo.
    const { deps } = setup({
      common: ok("/a\n/b/.git\n"),
      realpath: () => "/b/.git",
    });
    strictEqual((await identifyRepo("/r", deps)).repoStatus, "error");
  });

  it("treats a realpath with bidi or invisible characters as error", async () => {
    for (const bad of ["/r/‮.git", "/r/ㅤ.git"]) {
      const { deps } = setup({
        common: ok("/r/.git\n"),
        realpath: () => bad,
      });
      strictEqual((await identifyRepo("/r", deps)).repoStatus, "error", bad);
    }
  });

  it("treats a realpath failure and an over-long repo as error", async () => {
    const failing = setup({ common: ok("/r/.git\n") });
    failing.deps.realpath = async () => {
      throw new Error("ENOENT");
    };
    strictEqual((await identifyRepo("/r", failing.deps)).repoStatus, "error");

    const long = "/" + "a".repeat(1024);
    const over = setup({ common: ok(`${long}\n`) });
    strictEqual((await identifyRepo("/r", over.deps)).repoStatus, "error");
    const edge = setup({ common: ok(`/${"a".repeat(1023)}\n`) });
    strictEqual((await identifyRepo("/r", edge.deps)).repoStatus, "git");
  });

  it("cuts a long toplevel for display but keeps the raw path", async () => {
    const top = "/" + "d".repeat(93);
    strictEqual(top.length, 94);
    const { deps } = setup({
      common: ok("/r/.git\n"),
      toplevel: ok(`${top}\n`),
      head: ok("main\n"),
    });
    const result = await identifyRepo("/r", deps);
    strictEqual(result.worktreePath, top);
    strictEqual(result.worktree?.length, 80);
    strictEqual(result.worktree?.startsWith("…"), true);
  });

  it("keeps git and repo when toplevel fails", async () => {
    const { deps } = setup({
      common: ok("/r/.git\n"),
      toplevel: fail(128, "fatal: this operation must be run in a work tree"),
      head: ok("main\n"),
    });
    deepStrictEqual(await identifyRepo("/r/.git", deps), {
      repoStatus: "git",
      repo: "/r/.git",
      worktree: null,
      worktreePath: null,
      branch: "main",
    });
  });

  it("treats a toplevel containing a newline as no worktree", async () => {
    const { deps } = setup({
      common: ok("/r/.git\n"),
      toplevel: ok("/a\n/b\n"),
      head: ok("main\n"),
    });
    const result = await identifyRepo("/r", deps);
    strictEqual(result.repoStatus, "git");
    strictEqual(result.worktreePath, null);
    strictEqual(result.worktree, null);
  });

  it("returns a null branch for a detached HEAD", async () => {
    const { deps } = setup({
      common: ok("/r/.git\n"),
      toplevel: ok("/r\n"),
      head: fail(1),
    });
    const result = await identifyRepo("/r", deps);
    strictEqual(result.repoStatus, "git");
    strictEqual(result.branch, null);
  });

  it("does not start git when cwd is missing or not a directory", async () => {
    const cases: Array<() => Promise<{ isDirectory(): boolean }>> = [
      async () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
      async () => ({ isDirectory: () => false }),
    ];
    for (const stat of cases) {
      const { deps, calls } = setup({ common: ok("/r/.git\n"), stat });
      deepStrictEqual(await identifyRepo("/r", deps), {
        repoStatus: "error",
        ...NULLS,
      });
      deepStrictEqual(calls, []);
    }
  });

  it("stops after an abort and starts no further git", async () => {
    const controller = new AbortController();
    const { deps, calls } = setup({
      common: ok("/r/.git\n"),
      toplevel: ok("/r\n"),
      head: ok("main\n"),
      onCall: (kind) => {
        if (kind === "common") controller.abort();
      },
    });
    deepStrictEqual(await identifyRepo("/r", deps, controller.signal), {
      repoStatus: "error",
      ...NULLS,
    });
    deepStrictEqual(calls, ["common"]);
  });

  it("stops after an abort between toplevel and symbolic-ref", async () => {
    const controller = new AbortController();
    const { deps, calls } = setup({
      common: ok("/r/.git\n"),
      toplevel: ok("/r\n"),
      head: ok("main\n"),
      onCall: (kind) => {
        if (kind === "toplevel") controller.abort();
      },
    });
    strictEqual(
      (await identifyRepo("/r", deps, controller.signal)).repoStatus,
      "error",
    );
    deepStrictEqual(calls, ["common", "toplevel"]);
  });

  it("does not throw when a dependency throws", async () => {
    const { deps } = setup({});
    deps.execGit = async () => {
      throw new Error("boom");
    };
    strictEqual((await identifyRepo("/r", deps)).repoStatus, "error");
  });
});
