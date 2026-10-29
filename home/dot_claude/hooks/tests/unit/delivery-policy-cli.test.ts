#!/usr/bin/env node --test

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  isHelpRequest,
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
  /** The `status` field of the commit; undefined leaves the key out. */
  status: unknown;
  files: string[];
  mergeStatus: number;
  failOn: string | null;
  /** One per check-run read, in order: "fail" answers a gh error. Empty or spent means ok. */
  checkOutcomes: Array<"fail" | "ok">;
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
    status: null,
    files: ["docs/a.md"],
    mergeStatus: 0,
    failOn: null,
    checkOutcomes: [],
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
    home = realpathSync(mkdtempSync(join(tmpdir(), "delivery-policy-cli-")));
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
        if (world.checkOutcomes.shift() === "fail") {
          return { status: 1, stdout: "", stderr: "boom" };
        }
        return ok(
          JSON.stringify({
            data: {
              repository: {
                object: {
                  status: world.status,
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

  it("prints usage to stdout with 0 for a lone --help or -h", async () => {
    for (const flag of ["--help", "-h"]) {
      out = "";
      err = "";
      assert.equal(await run(flag), 0);
      assert.match(out, /merge <PR number>/);
      for (const code of ["10", "11", "12", "20", "30", "40"])
        assert.match(out, new RegExp(`\\b${code}\\b`));
      assert.equal(err, "");
    }
    assert.equal(calls.length, 0);
  });

  it("keeps --help after a command as a bad argument", async () => {
    assert.equal(await run("show", "--help"), 2);
    assert.equal(await run("merge", "1", "--help"), 2);
    assert.equal(out, "");
    assert.equal(calls.length, 0);
  });

  it("isHelpRequest needs exactly one help flag", () => {
    assert.equal(isHelpRequest(["--help"]), true);
    assert.equal(isHelpRequest(["-h"]), true);
    assert.equal(isHelpRequest(["show", "--help"]), false);
    assert.equal(isHelpRequest(["--cwd", "/tmp", "--help"]), false);
    assert.equal(isHelpRequest([]), false);
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

  describe("commit statuses", () => {
    const botStatus = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      context: "status-check",
      state: "SUCCESS",
      creator: { __typename: "Bot" },
      ...overrides,
    });
    const withStatus = (...contexts: unknown[]) => {
      world.checkRuns = [];
      world.status = { contexts };
    };

    it("merges on a Bot's SUCCESS status, reading the same sha it merges", async () => {
      record("merge");
      withStatus(botStatus());
      assert.equal(await run("merge", "5"), 0);
      assert.equal(mergeCalls().length, 1);
      const read = calls.find((c) => c.join(" ").includes("checkSuites"));
      assert.ok(read?.includes(`sha=${SHA_A}`));
      assert.equal(mergeCalls()[0]?.at(-1), SHA_A);
    });

    it("waits out the budget (12) on a User's SUCCESS status and does not merge", async () => {
      record("merge");
      withStatus(botStatus({ creator: { __typename: "User" } }));
      assert.equal(await run("merge", "5"), 12);
      assert.equal(mergeCalls().length, 0);
    });

    it("a null status with a passing check run still merges", async () => {
      record("merge");
      world.status = null;
      assert.equal(await run("merge", "5"), 0);
    });

    it("a status with a null creator on an unrelated context does not block", async () => {
      record("merge");
      world.status = {
        contexts: [botStatus({ context: "other", creator: null })],
      };
      assert.equal(await run("merge", "5"), 0);
    });

    it("a required status with a null creator is not counted (waits out the budget, 12)", async () => {
      record("merge");
      withStatus(botStatus({ creator: null }));
      assert.equal(await run("merge", "5"), 12);
      assert.equal(mergeCalls().length, 0);
    });

    it("a status node without state is 40", async () => {
      record("merge");
      withStatus({ context: "status-check", creator: { __typename: "Bot" } });
      assert.equal(await run("merge", "5"), 40);
      assert.equal(mergeCalls().length, 0);
    });

    it("a response without the status key is 40", async () => {
      record("merge");
      world.status = undefined;
      assert.equal(await run("merge", "5"), 40);
      assert.equal(mergeCalls().length, 0);
    });

    it("status.contexts that is not an array is 40", async () => {
      record("merge");
      world.status = { contexts: "nope" };
      assert.equal(await run("merge", "5"), 40);
      assert.equal(mergeCalls().length, 0);
    });
  });

  it("a protected path is 30", async () => {
    record("merge");
    world.files = [".github/workflows/ci.yml"];
    assert.equal(await run("merge", "5"), 30);
    assert.equal(mergeCalls().length, 0);
  });

  it("pending checks wait until the 20 minute budget is used up, then 12, and record the wait", async () => {
    record("merge");
    world.checkRuns = [
      { name: "status-check", status: "IN_PROGRESS", conclusion: null },
    ];
    assert.equal(await run("merge", "5"), 12);
    const waited = wall - T0;
    assert.ok(waited >= 20 * 60_000 && waited <= 20 * 60_000 + 15_000);
    assert.equal(mergeCalls().length, 0);
    const entries = JSON.parse(readFileSync(waitsPath(home), "utf-8"))
      .entries as Record<string, string>;
    assert.deepEqual(Object.keys(entries), [`berlysia/dotfiles#5@${SHA_A}`]);
  });

  it("a slow gh cannot carry one call past 23 min + 10 s: per-call timeouts shrink and the run ends with 10", async () => {
    record("merge");
    world.checkRuns = [
      { name: "status-check", status: "IN_PROGRESS", conclusion: null },
    ];
    ghCost = 9000;
    assert.equal(await run("merge", "5"), 10);
    assert.ok(mono - 1000 <= 23 * 60_000 + 10_000, `elapsed ${mono - 1000}`);
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
    // The wall clock is held still so the budget is not crossed while waiting
    // and the call ends at its own deadline instead.
    wallAdvances = false;
    seed(20 * 60_000 - 1000);
    assert.equal(await run("merge", "5"), 10);
  });

  it("a broken waits file is rebuilt and the wait goes on", async () => {
    record("merge");
    world.checkRuns = [];
    mkdirSync(ledgerDir(home), { recursive: true });
    writeFileSync(waitsPath(home), "{not json");
    assert.equal(await run("merge", "5"), 12);
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
    assert.equal(await run("merge", "5"), 12);
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

  describe("a wait of up to 20 minutes in one call", () => {
    const START_MONO = 1000;
    const elapsed = () => wall - T0;
    const pending = () => {
      world.checkRuns = [
        { name: "status-check", status: "IN_PROGRESS", conclusion: null },
      ];
    };
    const green = () => {
      world.checkRuns = [
        { name: "status-check", status: "COMPLETED", conclusion: "SUCCESS" },
      ];
    };
    /** Runs `act` once, before the first gh call that `when` accepts. */
    const once = (when: (args: string[]) => boolean, act: () => void) => {
      let done = false;
      world.onCall.push((args) => {
        if (!done && when(args)) {
          done = true;
          act();
        }
      });
    };
    const isChecksRead = (args: string[]) =>
      args.join(" ").includes("checkSuites");
    /** Time spent before the first wait: repo, viewer and the first reads. */
    const setupTakes = (ms: number) =>
      once(
        (args) => args[0] === "repo",
        () => {
          wall += ms;
          mono += ms;
        },
      );
    const seedFirstWait = (msBeforeStart: number) => {
      mkdirSync(ledgerDir(home), { recursive: true });
      writeFileSync(
        waitsPath(home),
        JSON.stringify({
          v: 1,
          entries: {
            [`berlysia/dotfiles#5@${SHA_A}`]: new Date(
              T0 - msBeforeStart,
            ).toISOString(),
          },
        }),
      );
    };
    const transientLines = () =>
      out.split("\n").filter((l) => l.includes("waiting: transient error"));

    it("a 150 s setup still ends in 12, not 10 (the 3 minute margin)", async () => {
      record("merge");
      pending();
      setupTakes(150_000);
      assert.equal(await run("merge", "5"), 12);
      assert.match(lastLine() ?? "", /^delivery-policy: 12: /);
      assert.equal(mergeCalls().length, 0);
    });

    it("a head whose budget is nearly used by an earlier call waits once, then 12", async () => {
      record("merge");
      pending();
      seedFirstWait(19 * 60_000 + 20_000);
      setupTakes(30_000);
      assert.equal(await run("merge", "5"), 12);
      assert.equal(sleeps, 1);
    });

    it("pending for 5 minutes and then success merges in the same call", async () => {
      record("merge");
      pending();
      once(() => elapsed() >= 300_000, green);
      assert.equal(await run("merge", "5"), 0);
      assert.equal(mergeCalls().length, 1);
      assert.ok(sleeps >= 20);
    });

    it("a scope narrowed to pr after 3 minutes stops at the next round with 20", async () => {
      record("merge");
      pending();
      once(
        () => elapsed() >= 180_000,
        () => record("pr"),
      );
      assert.equal(await run("merge", "5"), 20);
      assert.ok(elapsed() >= 180_000 && elapsed() <= 195_000, `${elapsed()}`);
      assert.equal(mergeCalls().length, 0);
    });

    it("a ledger line broken after 3 minutes prints the invalid line and stops at the next round", async () => {
      record("merge");
      pending();
      once(
        () => elapsed() >= 180_000,
        () =>
          writeFileSync(
            ledgerPath(home),
            `${readFileSync(ledgerPath(home), "utf-8")}\n{broken`,
          ),
      );
      // decideLedger answers 40 for an invalid line, as it does at the start
      assert.equal(await run("merge", "5"), 40);
      assert.ok(elapsed() >= 180_000 && elapsed() <= 195_000, `${elapsed()}`);
      assert.match(out, /delivery-policy: invalid: 3: json/);
      assert.equal(mergeCalls().length, 0);
    });

    it("a scope already narrowed at the start is 20 in the first round, with one scope line", async () => {
      record("pr");
      assert.equal(await run("merge", "5"), 20);
      assert.equal(sleeps, 0);
      assert.equal(out.split("scope pr recorded").length - 1, 1);
      assert.equal(mergeCalls().length, 0);
    });

    it("a ledger that cannot be read in the middle of the wait is 40 without a retry", async () => {
      record("merge");
      pending();
      once(
        () => elapsed() >= 180_000,
        () => chmodSync(ledgerPath(home), 0),
      );
      assert.equal(await run("merge", "5"), 40);
      assert.match(lastLine() ?? "", /ledger cannot be read \(EACCES\)/);
      assert.equal(transientLines().length, 0);
      assert.equal(mergeCalls().length, 0);
    });

    it("a head that changes after 3 minutes is 11", async () => {
      record("merge");
      pending();
      once(
        () => elapsed() >= 180_000,
        () => {
          world.shas = [SHA_B];
        },
      );
      assert.equal(await run("merge", "5"), 11);
      assert.equal(mergeCalls().length, 0);
    });

    it("a required check that fails in the middle of the wait is 30", async () => {
      record("merge");
      pending();
      once(
        () => elapsed() >= 180_000,
        () => {
          world.checkRuns = [
            {
              name: "status-check",
              status: "COMPLETED",
              conclusion: "FAILURE",
            },
          ];
        },
      );
      assert.equal(await run("merge", "5"), 30);
      assert.equal(mergeCalls().length, 0);
    });

    it("three failed rounds and then a good one keep waiting, and success merges", async () => {
      record("merge");
      pending();
      world.checkOutcomes = ["fail", "fail", "fail", "ok"];
      once(() => sleeps >= 4, green);
      assert.equal(await run("merge", "5"), 0);
      assert.equal(transientLines().length, 3);
      assert.equal(mergeCalls().length, 1);
    });

    it("a good round counts the failures from zero again", async () => {
      record("merge");
      pending();
      world.checkOutcomes = [
        "fail",
        "fail",
        "ok",
        "fail",
        "fail",
        "fail",
        "ok",
      ];
      once(() => sleeps >= 6, green);
      assert.equal(await run("merge", "5"), 0);
      assert.equal(transientLines().length, 5);
    });

    it("four failed rounds in a row are 40 after three waits, and no wait is recorded", async () => {
      record("merge");
      world.checkOutcomes = ["fail", "fail", "fail", "fail"];
      assert.equal(await run("merge", "5"), 40);
      assert.equal(sleeps, 3);
      assert.deepEqual(
        transientLines().map((l) => /\((\d)\/4\)/.exec(l)?.[1]),
        ["1", "2", "3"],
      );
      assert.match(
        lastLine() ?? "",
        /^delivery-policy: 40: reading the check runs failed: boom/,
      );
      // a failed round only looks at the budget; it must not start one
      assert.equal(existsSync(waitsPath(home)), false);
      assert.equal(mergeCalls().length, 0);
    });

    it("failures from the first head read, with no sha to key a budget on, are 40 in the fourth round", async () => {
      record("merge");
      world.failOn = "headRefOid";
      assert.equal(await run("merge", "5"), 40);
      assert.equal(sleeps, 3);
      assert.equal(existsSync(waitsPath(home)), false);
    });

    it("failed rounds that use up the budget are 12, checked before the deadline and the count", async () => {
      record("merge");
      pending();
      world.checkOutcomes = ["ok", "fail", "fail", "fail", "fail"];
      let reads = 0;
      world.onCall.push((args) => {
        if (isChecksRead(args) && ++reads === 2) {
          // both the budget and the deadline are reached in this round
          wall += 1_190_000;
          mono += 1_350_000;
        }
      });
      assert.equal(await run("merge", "5"), 12);
      assert.match(
        lastLine() ?? "",
        /^delivery-policy: 12: reading the check runs failed: boom; the wait budget/,
      );
    });

    it("a fourth failure that arrives at the deadline is 10, not 40", async () => {
      record("merge");
      world.checkOutcomes = ["fail", "fail", "fail", "fail"];
      let reads = 0;
      world.onCall.push((args) => {
        if (isChecksRead(args) && ++reads === 4) mono += 1_350_000;
      });
      assert.equal(await run("merge", "5"), 10);
      assert.equal(sleeps, 3);
      assert.match(lastLine() ?? "", /^delivery-policy: 10: /);
    });

    it("a wait whose next 15 s would cross the deadline is 10", async () => {
      record("merge");
      pending();
      once(
        (args) => sleeps >= 2 && isChecksRead(args),
        () => {
          // 10 s left: every gh of this round still runs, the next wait does not fit
          mono = START_MONO + 1_370_000;
        },
      );
      assert.equal(await run("merge", "5"), 10);
      assert.equal(sleeps, 2);
      assert.doesNotMatch(lastLine() ?? "", /time limit/);
    });

    it("a gh called after the deadline is 10", async () => {
      record("merge");
      pending();
      once(
        (args) => sleeps >= 1 && isChecksRead(args),
        () => {
          mono = START_MONO + 1_381_000;
        },
      );
      assert.equal(await run("merge", "5"), 10);
      assert.match(lastLine() ?? "", /time limit of this call reached/);
    });
  });
});
