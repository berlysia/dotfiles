#!/usr/bin/env node --test

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  resolveCliDeps,
  runDeliveryPolicyCli,
  type DeliveryPolicyCliDeps,
} from "../../cli/delivery-policy.ts";
import {
  appendLedger,
  buildDeliveryPolicyQuestion,
  ledgerDir,
  ledgerPath,
  waitsPath,
  type GhResult,
} from "../../lib/delivery-policy.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const T0 = Date.parse("2026-10-23T00:00:00.000Z");

interface World {
  repoStatus: number;
  viewer: string;
  /** Consumed one per head-sha read; the last one repeats. */
  shas: string[];
  pr: {
    state: string;
    author: string;
    baseRepository: string;
    changedFiles: number;
    mergeStateStatus: string;
  };
  checkRuns: Array<{ name: string; status: string; conclusion: string | null }>;
  files: string[];
  mergeStatus: number;
  failOn: string | null;
  /** Runs before the Nth call whose args contain `marker`. */
  onCall: Array<(args: string[]) => void>;
}

function freshWorld(): World {
  return {
    repoStatus: 0,
    viewer: "berlysia",
    shas: [SHA_A],
    pr: {
      state: "OPEN",
      author: "berlysia",
      baseRepository: "berlysia/dotfiles",
      changedFiles: 1,
      mergeStateStatus: "CLEAN",
    },
    checkRuns: [
      { name: "status-check", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
    files: ["docs/a.md"],
    mergeStatus: 0,
    failOn: null,
    onCall: [],
  };
}

const ok = (stdout: string): GhResult => ({ status: 0, stdout, stderr: "" });

describe("delivery-policy CLI", () => {
  let home: string;
  let world: World;
  let calls: string[][];
  let out: string;
  let err: string;
  let wall: number;
  let mono: number;
  let sleeps: number;
  let wallAdvances: boolean;
  let timeouts: Array<number | undefined>;
  let ghCost: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "delivery-policy-cli-"));
    world = freshWorld();
    calls = [];
    out = "";
    err = "";
    wall = T0;
    mono = 1000;
    sleeps = 0;
    wallAdvances = true;
    timeouts = [];
    ghCost = 0;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function gh(
    args: string[],
    options?: { timeoutMs?: number },
  ): Promise<GhResult> {
    calls.push(args);
    timeouts.push(options?.timeoutMs);
    mono += ghCost;
    for (const hook of world.onCall) hook(args);
    const text = args.join(" ");
    if (world.failOn !== null && text.includes(world.failOn)) {
      return { status: 1, stdout: "", stderr: "boom" };
    }
    if (args[0] === "repo") {
      if (world.repoStatus !== 0) {
        return { status: world.repoStatus, stdout: "", stderr: "no remote" };
      }
      return ok(
        JSON.stringify({
          nameWithOwner: "berlysia/dotfiles",
          owner: { id: "x", login: "berlysia" },
          isInOrganization: false,
          defaultBranchRef: { name: "main" },
          url: "https://github.com/berlysia/dotfiles",
        }),
      );
    }
    if (args[0] === "pr" && args[1] === "merge") {
      return { status: world.mergeStatus, stdout: "", stderr: "" };
    }
    if (args[0] === "api" && args[1] === "user") {
      return ok(JSON.stringify({ login: world.viewer }));
    }
    if (args[0] === "api" && args[1] === "graphql") {
      if (text.includes("headRefOid")) {
        const sha = world.shas.length > 1 ? world.shas.shift() : world.shas[0];
        return ok(
          JSON.stringify({
            data: { repository: { pullRequest: { headRefOid: sha } } },
          }),
        );
      }
      if (text.includes("checkSuites")) {
        return ok(
          JSON.stringify({
            data: {
              repository: {
                object: {
                  checkSuites: {
                    nodes: [
                      {
                        app: { databaseId: 15368 },
                        checkRuns: { nodes: world.checkRuns },
                      },
                    ],
                  },
                },
              },
            },
          }),
        );
      }
      return ok(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: world.pr.state,
                author: { login: world.pr.author },
                baseRepository: { nameWithOwner: world.pr.baseRepository },
                baseRefName: "main",
                headRefName: "feat/x",
                isCrossRepository: false,
                changedFiles: world.pr.changedFiles,
                mergeStateStatus: world.pr.mergeStateStatus,
              },
            },
          },
        }),
      );
    }
    const path = args[1] ?? "";
    if (path.includes("/rules/branches/")) {
      return ok(
        JSON.stringify([
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "status-check" }],
            },
          },
        ]),
      );
    }
    if (path.includes("/protection/required_status_checks")) {
      return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    }
    const files = /\/pulls\/\d+\/files\?per_page=100&page=(\d+)/.exec(path);
    if (files) {
      const page = Number(files[1]);
      return ok(
        JSON.stringify(
          world.files
            .slice((page - 1) * 100, page * 100)
            .map((filename) => ({ filename })),
        ),
      );
    }
    return { status: 1, stdout: "", stderr: `unexpected call ${text}` };
  }

  const deps = (): DeliveryPolicyCliDeps => ({
    home,
    gh,
    now: () => wall,
    monotonic: () => mono,
    sleep: async (ms) => {
      sleeps++;
      if (wallAdvances) wall += ms;
      mono += ms;
    },
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });

  const run = (...args: string[]) => runDeliveryPolicyCli(args, deps());
  const record = (
    scope: "commit" | "pr" | "merge",
    at = "2026-10-22T00:00:00.000Z",
  ) => appendLedger(home, { repo: "berlysia/dotfiles", scope, at });
  const mergeCalls = () =>
    calls.filter((c) => c[0] === "pr" && c[1] === "merge");
  const lastLine = () => out.trimEnd().split("\n").at(-1);

  it("rejects bad arguments with 2", async () => {
    assert.equal(await run("merge", "abc"), 2);
    assert.equal(await run("merge", "0"), 2);
    assert.equal(await run("merge"), 2);
    assert.equal(await run("show", "x"), 2);
    assert.equal(await run("ask", "--cwd", "/tmp"), 2);
    assert.equal(await run(), 2);
    assert.equal(calls.length, 0);
  });

  it("resolveCliDeps without --cwd is 2", () => {
    const resolved = resolveCliDeps(["show"]);
    assert.equal(resolved.ok, false);
    assert.equal(!resolved.ok && resolved.exitCode, 2);
    const relative = resolveCliDeps(["--cwd", "relative", "show"]);
    assert.equal(relative.ok, false);
    const good = resolveCliDeps(["--cwd", tmpdir(), "show"]);
    assert.equal(good.ok && good.args.join(" "), "show");
  });

  it("ask prints the question JSON; an unresolvable repo is 40 with empty stdout", async () => {
    assert.equal(await run("ask"), 0);
    assert.deepEqual(JSON.parse(out), {
      questions: buildDeliveryPolicyQuestion(
        "berlysia/dotfiles",
        "https://github.com/berlysia/dotfiles",
      ),
    });
    out = "";
    world.repoStatus = 1;
    assert.equal(await run("ask"), 40);
    assert.equal(out, "");
    assert.match(err, /no remote/);
  });

  it("show prints the scope line, or unrecorded", async () => {
    assert.equal(await run("show"), 0);
    assert.equal(out, "delivery-policy: scope: unrecorded\n");
    out = "";
    record("merge");
    assert.equal(await run("show"), 0);
    assert.equal(out, "delivery-policy: scope: merge (2026-10-22)\n");
  });

  it("show keeps an unreadable at as written", async () => {
    record("pr", "yesterday-ish");
    await run("show");
    assert.equal(out, "delivery-policy: scope: pr (yesterday-ish)\n");
  });

  it("show with an invalid line at physical line 3 is 40 and names it, the ledger and the procedure", async () => {
    record("merge");
    writeFileSync(
      ledgerPath(home),
      `${readFileSync(ledgerPath(home), "utf-8")}\n${JSON.stringify({ v: 2, repo: "x/y", scope: "pr", at: "x" })}`,
    );
    assert.equal(await run("show"), 40);
    assert.match(out, /^delivery-policy: scope: merge \(/);
    assert.match(out, /delivery-policy: invalid: 3: version/);
    assert.ok(out.includes(ledgerPath(home)));
    assert.match(out, /removes the invalid lines by hand/);
  });

  it("show with an unresolvable repo is 40 with empty stdout", async () => {
    world.repoStatus = 1;
    assert.equal(await run("show"), 40);
    assert.equal(out, "");
  });

  it("merges when every condition holds, with the checked sha", async () => {
    record("merge");
    assert.equal(await run("merge", "5"), 0);
    assert.deepEqual(mergeCalls(), [
      [
        "pr",
        "merge",
        "5",
        "-R",
        "berlysia/dotfiles",
        "--merge",
        "--match-head-commit",
        SHA_A,
      ],
    ]);
    assert.match(
      out,
      /scope merge recorded 2026-10-22; to change it run ~\/\.local\/bin\/delivery-policy ask/,
    );
    assert.equal(lastLine()?.startsWith("delivery-policy: 0: "), true);
  });

  it("scope pr is 20 and never merges", async () => {
    record("pr");
    assert.equal(await run("merge", "5"), 20);
    assert.equal(mergeCalls().length, 0);
    assert.equal(lastLine()?.startsWith("delivery-policy: 20: "), true);
  });

  it("an unrecorded scope is 20", async () => {
    assert.equal(await run("merge", "5"), 20);
  });

  it("an invalid ledger line is 40 with the invalid lines printed and no merge", async () => {
    record("merge");
    writeFileSync(
      ledgerPath(home),
      `${readFileSync(ledgerPath(home), "utf-8")}\n{broken`,
    );
    assert.equal(await run("merge", "5"), 40);
    assert.match(out, /delivery-policy: invalid: 3: json/);
    assert.ok(out.includes(ledgerPath(home)));
    assert.match(out, /removes the invalid lines by hand/);
    assert.equal(lastLine()?.startsWith("delivery-policy: 40: "), true);
    assert.equal(mergeCalls().length, 0);
  });

  it("a gh failure is 40 and never merges", async () => {
    record("merge");
    world.failOn = "checkSuites";
    assert.equal(await run("merge", "5"), 40);
    assert.equal(mergeCalls().length, 0);
  });

  it("a protected path is 30", async () => {
    record("merge");
    world.files = [".github/workflows/ci.yml"];
    assert.equal(await run("merge", "5"), 30);
    assert.equal(mergeCalls().length, 0);
  });

  it("pending checks wait up to the 100s deadline, then 10, and record the wait", async () => {
    record("merge");
    world.checkRuns = [
      { name: "status-check", status: "IN_PROGRESS", conclusion: null },
    ];
    assert.equal(await run("merge", "5"), 10);
    // waits end before the 100s deadline: the last 15s sleep that would cross it is skipped
    assert.ok(mono - 1000 < 100_000);
    assert.ok(sleeps >= 5);
    assert.equal(mergeCalls().length, 0);
    const entries = JSON.parse(readFileSync(waitsPath(home), "utf-8"))
      .entries as Record<string, string>;
    assert.deepEqual(Object.keys(entries), [`berlysia/dotfiles#5@${SHA_A}`]);
  });

  it("a slow gh cannot carry one call past 110s: per-call timeouts shrink and the run ends with 10", async () => {
    record("merge");
    world.checkRuns = [
      { name: "status-check", status: "IN_PROGRESS", conclusion: null },
    ];
    ghCost = 9000;
    assert.equal(await run("merge", "5"), 10);
    assert.ok(mono - 1000 <= 110_000, `elapsed ${mono - 1000}`);
    assert.equal(mergeCalls().length, 0);
    for (const t of timeouts)
      assert.ok(t !== undefined && t <= 10_000 && t > 0);
    assert.ok(timeouts.some((t) => t !== undefined && t < 10_000));
  });

  it("per-call timeouts are positive integers even when the monotonic clock has fractions", async () => {
    // performance.now() returns fractional milliseconds; execFile rejects a
    // non-integer timeout with ERR_OUT_OF_RANGE, which ended a real run with 40.
    record("merge");
    world.checkRuns = [
      { name: "status-check", status: "IN_PROGRESS", conclusion: null },
    ];
    mono = 1000.617;
    ghCost = 9000.383;
    assert.equal(await run("merge", "5"), 10);
    assert.ok(timeouts.length > 0);
    for (const t of timeouts)
      assert.ok(t !== undefined && Number.isInteger(t) && t >= 1, `${t}`);
  });

  it("a wait that started exactly 20 minutes ago is 12; one second less is 10", async () => {
    record("merge");
    world.checkRuns = [];
    mkdirSync(ledgerDir(home), { recursive: true });
    const key = `berlysia/dotfiles#5@${SHA_A}`;
    const seed = (msAgo: number) =>
      writeFileSync(
        waitsPath(home),
        JSON.stringify({
          v: 1,
          entries: { [key]: new Date(T0 - msAgo).toISOString() },
        }),
      );
    seed(20 * 60_000);
    assert.equal(await run("merge", "5"), 12);
    wall = T0;
    mono = 1000;
    // The wall clock is held still so the judgement is about the first
    // decision; with it running, 100s of waiting would cross the budget.
    wallAdvances = false;
    seed(20 * 60_000 - 1000);
    assert.equal(await run("merge", "5"), 10);
  });

  it("a broken waits file is rebuilt and the wait goes on", async () => {
    record("merge");
    world.checkRuns = [];
    mkdirSync(ledgerDir(home), { recursive: true });
    writeFileSync(waitsPath(home), "{not json");
    assert.equal(await run("merge", "5"), 10);
    const entries = JSON.parse(readFileSync(waitsPath(home), "utf-8")).entries;
    assert.equal(Object.keys(entries).length, 1);
  });

  it("a future first-wait time counts as now, and entries older than a day are dropped", async () => {
    record("merge");
    world.checkRuns = [];
    mkdirSync(ledgerDir(home), { recursive: true });
    const key = `berlysia/dotfiles#5@${SHA_A}`;
    writeFileSync(
      waitsPath(home),
      JSON.stringify({
        v: 1,
        entries: {
          [key]: new Date(T0 + 3600_000).toISOString(),
          "old/repo#1@x": new Date(T0 - 25 * 3600_000).toISOString(),
        },
      }),
    );
    assert.equal(await run("merge", "5"), 10);
    // the key existed (future-dated), so nothing was rewritten here; a new key prunes
    wall = T0;
    mono = 1000;
    world.shas = [SHA_B];
    assert.equal(await run("merge", "5"), 10);
    const entries = JSON.parse(readFileSync(waitsPath(home), "utf-8"))
      .entries as Record<string, string>;
    assert.equal("old/repo#1@x" in entries, false);
    assert.ok(`berlysia/dotfiles#5@${SHA_B}` in entries);
  });

  it("a head that changed on the second round is 11", async () => {
    record("merge");
    world.checkRuns = [];
    world.shas = [SHA_A, SHA_A, SHA_B];
    assert.equal(await run("merge", "5"), 11);
    assert.equal(mergeCalls().length, 0);
  });

  it("a head that changed between the first read and the re-read after the files is 11", async () => {
    record("merge");
    world.shas = [SHA_A, SHA_B];
    assert.equal(await run("merge", "5"), 11);
    assert.equal(mergeCalls().length, 0);
  });

  it("a scope narrowed to pr while waiting stops the merge with 20", async () => {
    record("merge");
    world.checkRuns = [
      { name: "status-check", status: "IN_PROGRESS", conclusion: null },
    ];
    let flipped = false;
    world.onCall.push(() => {
      if (sleeps >= 1 && !flipped) {
        flipped = true;
        world.checkRuns = [
          { name: "status-check", status: "COMPLETED", conclusion: "SUCCESS" },
        ];
        record("pr");
      }
    });
    assert.equal(await run("merge", "5"), 20);
    assert.equal(mergeCalls().length, 0);
  });

  it("reads every page of files and checks the count against changedFiles", async () => {
    record("merge");
    world.files = Array.from({ length: 150 }, (_, i) => `docs/f${i}.md`);
    world.pr.changedFiles = 150;
    assert.equal(await run("merge", "5"), 0);
    const pages = calls.filter((c) => (c[1] ?? "").includes("/files?"));
    assert.equal(pages.length, 2);
  });

  it("a file count that does not match changedFiles is 40", async () => {
    record("merge");
    world.pr.changedFiles = 3;
    assert.equal(await run("merge", "5"), 40);
    assert.equal(mergeCalls().length, 0);
  });

  it("a failing gh pr merge is 40", async () => {
    record("merge");
    world.mergeStatus = 1;
    assert.equal(await run("merge", "5"), 40);
  });
});
