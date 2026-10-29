#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  isShapeSuspect,
  listSessions,
  type ListSessionsDeps,
} from "../../lib/sessions/list-sessions.ts";
import {
  SESSION_ROW_KEYS,
  type RepoIdentity,
} from "../../lib/sessions/types.ts";
import type { SessionFile } from "../../lib/sessions/read-session-files.ts";
import {
  FIXTURE_DIR,
  SELF_PID,
  fileOf,
  filesResult,
  injectedDeps,
  statLine,
} from "../support/sessions-inject.ts";

const SESSION_202 = "00000000-0000-4000-8000-000000000202";
const GIT: RepoIdentity = {
  repoStatus: "git",
  repo: "/r/.git",
  worktree: "/r",
  worktreePath: "/r",
  branch: "main",
};

// Every pid in `files` is alive, and every cwd is the same git repo.
function depsFor(
  files: SessionFile[],
  overrides: Partial<ListSessionsDeps> = {},
): ListSessionsDeps {
  const procStarts = new Map(
    files.map((f) => [
      f.pid,
      (JSON.parse(f.text) as { procStart: string }).procStart,
    ]),
  );
  return injectedDeps({
    readSessionFiles: () => filesResult(files),
    readStat: (pid) => {
      const start = procStarts.get(pid);
      if (pid === SELF_PID || start === undefined) return statLine(pid, "1");
      return statLine(pid, start);
    },
    identifyRepo: async () => GIT,
    ...overrides,
  }).deps;
}

const run = async (
  files: SessionFile[],
  options: Partial<Parameters<typeof listSessions>[0]> = {},
  overrides: Partial<ListSessionsDeps> = {},
) => {
  const result = await listSessions(
    { dir: "/x", ...options },
    depsFor(files, overrides),
  );
  if (!result.ok) throw new Error("expected ok");
  return result.value;
};

describe("listSessions on the dir-basic fixture", () => {
  it("lists the three live rows and skips the dead one without git", async () => {
    const { deps, identifyCalls } = injectedDeps();
    const result = await listSessions({ dir: FIXTURE_DIR }, deps);
    if (!result.ok) throw new Error("expected ok");
    const { list } = result.value;
    deepStrictEqual(
      list.sessions.map((r) => r.sessionId.slice(-3)),
      ["201", "202", "203"],
    );
    strictEqual(list.sessions[2]?.status, "unknown");
    strictEqual(list.scanned, 5);
    strictEqual(list.skipped, 1);
    strictEqual(list.invalid, 1);
    strictEqual(list.shapeSuspect, false);
    ok(!identifyCalls.includes("/fixture/repo-dead"));
  });

  it("marks the self row", async () => {
    const { deps } = injectedDeps();
    const result = await listSessions(
      { dir: FIXTURE_DIR, self: SESSION_202 },
      deps,
    );
    if (!result.ok) throw new Error("expected ok");
    deepStrictEqual(
      result.value.list.sessions.map((r) => r.isSelf),
      [false, true, false],
    );
    strictEqual(result.value.list.selfFound, true);
  });

  it("selfFound is false for an unknown self and null without self", async () => {
    const { deps } = injectedDeps();
    const none = await listSessions(
      { dir: FIXTURE_DIR, self: "00000000-0000-4000-8000-0000000000ff" },
      deps,
    );
    if (!none.ok) throw new Error("expected ok");
    strictEqual(none.value.list.selfFound, false);
    ok(none.value.list.sessions.every((r) => !r.isSelf));
    const unset = await listSessions({ dir: FIXTURE_DIR }, deps);
    if (!unset.ok) throw new Error("expected ok");
    strictEqual(unset.value.list.selfFound, null);
  });

  it("public rows hold exactly the SessionRow keys; internal rows keep worktreePath", async () => {
    const { deps } = injectedDeps();
    const result = await listSessions({ dir: FIXTURE_DIR }, deps);
    if (!result.ok) throw new Error("expected ok");
    const { list, internalRows } = result.value;
    for (const row of list.sessions) {
      deepStrictEqual(
        Object.keys(row).sort(),
        Object.keys(SESSION_ROW_KEYS).sort(),
      );
    }
    ok(internalRows.every((row) => "worktreePath" in row));
    const { worktreePath: _w, ...rest } =
      internalRows[0] as (typeof internalRows)[number];
    deepStrictEqual(list.sessions[0], rest);
  });

  it("shapeSuspect always equals isShapeSuspect of the counts", async () => {
    const { deps } = injectedDeps();
    const result = await listSessions({ dir: FIXTURE_DIR }, deps);
    if (!result.ok) throw new Error("expected ok");
    const l = result.value.list;
    strictEqual(
      l.shapeSuspect,
      isShapeSuspect(l.scanned, l.skipped, l.invalid),
    );
  });

  it("passes readSessionFiles failure through", async () => {
    const { deps } = injectedDeps({
      readSessionFiles: () => ({
        ok: false,
        error: { kind: "sessions-dir-unreadable", message: "m" },
      }),
    });
    const result = await listSessions({ dir: "/x" }, deps);
    strictEqual(result.ok, false);
    if (!result.ok) strictEqual(result.error.kind, "sessions-dir-unreadable");
  });
});

describe("listSessions row building", () => {
  it("flags duplicate sanitized names on both rows", async () => {
    const { list } = await run([
      fileOf(201, { name: "dup" }),
      fileOf(203, { name: "dup" }),
      fileOf(204, { name: "solo" }),
    ]);
    deepStrictEqual(
      list.sessions.map((r) => r.duplicateName),
      [true, true, false],
    );
  });

  it("strips an invisible character and marks the name unaddressable", async () => {
    const { list } = await run([fileOf(201, { name: "a​b" })]);
    strictEqual(list.sessions[0]?.name, "ab");
    strictEqual(list.sessions[0]?.addressable, false);
  });

  it("an RLO name is unaddressable and loses the control character", async () => {
    const { list } = await run([fileOf(201, { name: "a‮exe.txt" })]);
    strictEqual(list.sessions[0]?.name, "aexe.txt");
    strictEqual(list.sessions[0]?.addressable, false);
  });

  it("a null name is unaddressable and never a duplicate", async () => {
    const { list } = await run([
      fileOf(201, { name: null }),
      fileOf(202, { name: null }),
    ]);
    for (const row of list.sessions) {
      strictEqual(row.name, null);
      strictEqual(row.addressable, false);
      strictEqual(row.duplicateName, false);
    }
  });

  it("keeps a row whose liveness is unknown", async () => {
    const { list } = await run(
      [fileOf(201)],
      {},
      {
        readStat: (pid) => {
          if (pid === SELF_PID) return statLine(pid, "1");
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      },
    );
    strictEqual(list.sessions.length, 1);
    strictEqual(list.sessions[0]?.liveness, "unknown");
  });

  it("an unreadable /proc makes every row unknown instead of dropping them", async () => {
    const { list } = await run(
      [fileOf(201), fileOf(202)],
      {},
      {
        readStat: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      },
    );
    deepStrictEqual(
      list.sessions.map((r) => r.liveness),
      ["unknown", "unknown"],
    );
  });
});

describe("listSessions dedupe by sessionId", () => {
  const sameId = "00000000-0000-4000-8000-0000000000aa";

  it("keeps the larger procStart and runs git once", async () => {
    const calls: string[] = [];
    const { list } = await run(
      [
        fileOf(301, { sessionId: sameId, procStart: "100", cwd: "/old" }),
        fileOf(302, { sessionId: sameId, procStart: "200", cwd: "/new" }),
      ],
      {},
      {
        identifyRepo: async (cwd) => {
          calls.push(cwd);
          return GIT;
        },
      },
    );
    strictEqual(list.sessions.length, 1);
    deepStrictEqual(calls, ["/new"]);
  });

  it("compares procStart as BigInt, not Number", async () => {
    const calls: string[] = [];
    await run(
      [
        fileOf(301, {
          sessionId: sameId,
          procStart: "18446744073709551614",
          cwd: "/lower",
        }),
        fileOf(302, {
          sessionId: sameId,
          procStart: "18446744073709551615",
          cwd: "/higher",
        }),
      ],
      {},
      {
        identifyRepo: async (cwd) => {
          calls.push(cwd);
          return GIT;
        },
      },
    );
    deepStrictEqual(calls, ["/higher"]);
  });

  it("on equal procStart keeps the smaller pid", async () => {
    const calls: string[] = [];
    await run(
      [
        fileOf(302, { sessionId: sameId, procStart: "5", cwd: "/p302" }),
        fileOf(301, { sessionId: sameId, procStart: "5", cwd: "/p301" }),
      ],
      {},
      {
        identifyRepo: async (cwd) => {
          calls.push(cwd);
          return GIT;
        },
      },
    );
    deepStrictEqual(calls, ["/p301"]);
  });
});

describe("listSessions git phase", () => {
  it("never runs more than `concurrency` identifications at once", async () => {
    let active = 0;
    let max = 0;
    const files = Array.from({ length: 10 }, (_, i) => fileOf(400 + i));
    await run(
      files,
      {},
      {
        identifyRepo: async () => {
          active += 1;
          max = Math.max(max, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return GIT;
        },
      },
    );
    strictEqual(max, 4);
  });

  it("returns at the deadline even when identifyRepo ignores its signal", async () => {
    const files = [fileOf(401), fileOf(402)];
    const { list, internalRows } = await run(
      files,
      { deadlineMs: 30 },
      {
        identifyRepo: () => new Promise<RepoIdentity>(() => {}),
      },
    );
    for (const row of internalRows) {
      strictEqual(row.repoStatus, "error");
      strictEqual(row.repo, null);
      strictEqual(row.worktree, null);
      strictEqual(row.worktreePath, null);
      strictEqual(row.branch, null);
    }
    strictEqual(list.sessions.length, 2);
  });

  it("aborts the signal handed to identifyRepo at the deadline", async () => {
    let aborted = false;
    await run(
      [fileOf(401)],
      { deadlineMs: 20 },
      {
        identifyRepo: (_cwd, signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise<RepoIdentity>(() => {});
        },
      },
    );
    strictEqual(aborted, true);
  });

  it("drops a result that settles after the deadline", async () => {
    const { internalRows } = await run(
      [fileOf(401)],
      { deadlineMs: 20 },
      {
        identifyRepo: () =>
          new Promise<RepoIdentity>((resolve) =>
            setTimeout(() => resolve(GIT), 40),
          ),
      },
    );
    strictEqual(internalRows[0]?.repoStatus, "error");
    await new Promise((resolve) => setTimeout(resolve, 50));
    strictEqual(internalRows[0]?.repoStatus, "error");
  });

  it("clears the deadline timer when everything finishes first", async () => {
    let cleared = 0;
    await run(
      [fileOf(401), fileOf(402)],
      {},
      {
        clearTimer: (handle) => {
          cleared += 1;
          clearTimeout(handle as NodeJS.Timeout);
        },
      },
    );
    strictEqual(cleared, 1);
  });

  it("an exception in one row only turns that row into error", async () => {
    const { internalRows } = await run(
      [fileOf(401), fileOf(402), fileOf(403)],
      {},
      {
        identifyRepo: async (cwd) => {
          if (cwd === "/w/402") throw new Error("boom");
          return GIT;
        },
      },
    );
    deepStrictEqual(
      internalRows.map((r) => r.repoStatus),
      ["git", "error", "git"],
    );
  });

  it("an external abort ends the git phase like a deadline", async () => {
    const controller = new AbortController();
    const pending = run(
      [fileOf(401)],
      { signal: controller.signal },
      {
        identifyRepo: () => new Promise<RepoIdentity>(() => {}),
      },
    );
    setTimeout(() => controller.abort(), 10);
    const { internalRows } = await pending;
    strictEqual(internalRows[0]?.repoStatus, "error");
  });
});

describe("isShapeSuspect", () => {
  const table: Array<[number, number, number, boolean]> = [
    [2, 2, 2, true],
    [1, 1, 1, false],
    [3, 3, 1, false],
    [4, 4, 2, true],
    [3, 1, 1, false],
  ];
  for (const [scanned, skipped, invalid, expected] of table) {
    it(`(${scanned}, ${skipped}, ${invalid}) -> ${expected}`, () => {
      strictEqual(isShapeSuspect(scanned, skipped, invalid), expected);
    });
  }
});
