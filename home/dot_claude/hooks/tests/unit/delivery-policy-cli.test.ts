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
  abortableSleep,
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
  mergeStderr: string;
  /** The required check's name; check runs are matched against it. */
  context: string;
  /** The stderr of a gh call that failOn or checkOutcomes make fail. */
  failStderr: string;
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
    mergeStderr: "",
    context: "status-check",
    failStderr: "boom",
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
  let controller: AbortController;
  /** Runs inside a fake sleep, before the abort is looked at. */
  let sleepHook: (() => void) | null;

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
    controller = new AbortController();
    sleepHook = null;
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
      return { status: 1, stdout: "", stderr: world.failStderr };
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
      return {
        status: world.mergeStatus,
        stdout: "",
        stderr: world.mergeStderr,
      };
    }
    if (args[0] === "api" && args[1] === "user") {
      return ok(JSON.stringify({ login: world.viewer }));
    }
    if (args[0] === "api" && args[1] === "graphql") {
      if (text.includes("headRefOid")) {
        const sha = world.shas.length > 1 ? world.shas.shift() : world.shas[0];
        return ok(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: { headRefOid: sha, state: world.pr.state },
              },
            },
          }),
        );
      }
      if (text.includes("checkSuites")) {
        if (world.checkOutcomes.shift() === "fail") {
          return { status: 1, stdout: "", stderr: world.failStderr };
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
              required_status_checks: [{ context: world.context }],
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
    // Like the real one: an abort ends the sleep early, without rejecting.
    sleep: async (ms, signal) => {
      sleeps++;
      sleepHook?.();
      if (signal.aborted) return;
      if (wallAdvances) wall += ms;
      mono += ms;
    },
    signal: controller.signal,
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
      assert.match(out, /wait <PR number>/);
      for (const code of ["10", "11", "12", "20", "30", "31", "40"])
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

  describe("a protected path asks the user instead of merging", () => {
    const CONFIRM_COMMAND = `gh pr merge 5 -R berlysia/dotfiles --merge --match-head-commit ${SHA_A}`;
    const nearDeadlineAtSecondHeadRead = () => {
      let reads = 0;
      world.onCall.push((args) => {
        if (args.join(" ").includes("headRefOid") && ++reads === 2) {
          mono = 1000 + 23 * 60_000 - 5_000;
        }
      });
    };
    const pendingChecks = () => {
      world.checkRuns = [
        { name: "status-check", status: "IN_PROGRESS", conclusion: null },
      ];
    };

    it("all checks passed and CLEAN is 31 with the command and the head sha, and gh pr merge is never started", async () => {
      record("merge");
      world.files = [".github/workflows/ci.yml"];
      assert.equal(await run("merge", "5"), 31);
      assert.equal(mergeCalls().length, 0);
      assert.equal(
        lastLine(),
        `delivery-policy: 31: ${CONFIRM_COMMAND}; base main; touches .github/workflows/ci.yml`,
      );
    });

    it("a 600 character path cuts only the tail: the command and the 40 digit sha stay", async () => {
      record("merge");
      world.files = [`.github/workflows/${"a".repeat(600)}`];
      assert.equal(await run("merge", "5"), 31);
      const line = lastLine() ?? "";
      assert.ok(Array.from(line).length <= 500, `${line.length}`);
      assert.ok(
        line.startsWith(`delivery-policy: 31: ${CONFIRM_COMMAND};`),
        line,
      );
    });

    it("a pending check waits (10 when the call's time is used up), it is not 30 or 31", async () => {
      record("merge");
      world.files = [".github/workflows/ci.yml"];
      pendingChecks();
      nearDeadlineAtSecondHeadRead();
      assert.equal(await run("merge", "5"), 10);
      assert.equal(mergeCalls().length, 0);
    });

    it("a failed required check is 30", async () => {
      record("merge");
      world.files = [".github/workflows/ci.yml"];
      world.checkRuns = [
        { name: "status-check", status: "COMPLETED", conclusion: "FAILURE" },
      ];
      assert.equal(await run("merge", "5"), 30);
      assert.doesNotMatch(lastLine() ?? "", /gh pr merge/);
    });

    it("BLOCKED is 30 with no gh pr merge, UNKNOWN waits and is not 31", async () => {
      record("merge");
      world.files = [".github/workflows/ci.yml"];
      world.pr.mergeStateStatus = "BLOCKED";
      assert.equal(await run("merge", "5"), 30);
      assert.equal(mergeCalls().length, 0);

      out = "";
      world.pr.mergeStateStatus = "UNKNOWN";
      nearDeadlineAtSecondHeadRead();
      assert.equal(await run("merge", "5"), 10);
      assert.doesNotMatch(out, /delivery-policy: 31:/);
    });

    it("zero required contexts is 30", async () => {
      record("merge");
      world.files = [".github/workflows/ci.yml"];
      world.context = "";
      const realGh = gh;
      const noRules: typeof gh = async (args, options) =>
        (args[1] ?? "").includes("/rules/branches/")
          ? ok("[]")
          : realGh(args, options);
      assert.equal(
        await runDeliveryPolicyCli(["merge", "5"], { ...deps(), gh: noRules }),
        30,
      );
    });

    it("only previousPath being protected still asks, and names that path", async () => {
      record("merge");
      const realGh = gh;
      const renamed: typeof gh = async (args, options) =>
        /\/pulls\/\d+\/files\?/.test(args[1] ?? "")
          ? ok(
              JSON.stringify([
                {
                  filename: "docs/new.md",
                  previous_filename: ".github/workflows/ci.yml",
                },
              ]),
            )
          : realGh(args, options);
      assert.equal(
        await runDeliveryPolicyCli(["merge", "5"], { ...deps(), gh: renamed }),
        31,
      );
      assert.match(lastLine() ?? "", /touches \.github\/workflows\/ci\.yml$/);
      assert.equal(mergeCalls().length, 0);
    });

    it("a ledger of pr is 20", async () => {
      record("pr");
      world.files = [".github/workflows/ci.yml"];
      assert.equal(await run("merge", "5"), 20);
    });

    it("a scope narrowed after the checks passed is 20, not 31", async () => {
      record("merge");
      world.files = [".github/workflows/ci.yml"];
      let reads = 0;
      world.onCall.push((args) => {
        if (args.join(" ").includes("headRefOid") && ++reads === 2) {
          record("pr");
        }
      });
      assert.equal(await run("merge", "5"), 20);
    });

    it("a file that is not protected still merges as before", async () => {
      record("merge");
      assert.equal(await run("merge", "5"), 0);
      assert.equal(mergeCalls().length, 1);
    });
  });

  describe("wait", () => {
    const pending = () => {
      world.checkRuns = [
        { name: "status-check", status: "IN_PROGRESS", conclusion: null },
      ];
    };
    const DEADLINE = 1000 + 23 * 60_000;
    const isHeadRead = (args: string[]) =>
      args.join(" ").includes("headRefOid");

    it("all checks passed is 0 with the head sha, and gh pr merge is never started", async () => {
      assert.equal(await run("wait", "5"), 0);
      assert.equal(mergeCalls().length, 0);
      assert.equal(
        lastLine(),
        `delivery-policy: 0: required checks passed at ${SHA_A}`,
      );
    });

    it("works with a ledger of commit, an unrecorded one, and even an unreadable one", async () => {
      assert.equal(await run("wait", "5"), 0);
      record("commit");
      assert.equal(await run("wait", "5"), 0);
      writeFileSync(ledgerPath(home), "{broken\n");
      assert.equal(await run("wait", "5"), 0);
      assert.equal(mergeCalls().length, 0);
    });

    it("a protected PR with BLOCKED or UNKNOWN is 0 at once, without waiting", async () => {
      world.files = [".github/workflows/ci.yml"];
      for (const status of ["BLOCKED", "UNKNOWN"]) {
        world.pr.mergeStateStatus = status;
        assert.equal(await run("wait", "5"), 0, status);
      }
      assert.equal(sleeps, 0);
      assert.equal(mergeCalls().length, 0);
    });

    it("a failed required check is 30, zero required contexts is 30", async () => {
      world.checkRuns = [
        { name: "status-check", status: "COMPLETED", conclusion: "FAILURE" },
      ];
      assert.equal(await run("wait", "5"), 30);
      world = freshWorld();
      const realGh = gh;
      const noRules: typeof gh = async (args, options) =>
        (args[1] ?? "").includes("/rules/branches/")
          ? ok("[]")
          : realGh(args, options);
      assert.equal(
        await runDeliveryPolicyCli(["wait", "5"], { ...deps(), gh: noRules }),
        30,
      );
    });

    it("a pending check, then success, waits and then is 0", async () => {
      pending();
      sleepHook = () => {
        world.checkRuns = [
          { name: "status-check", status: "COMPLETED", conclusion: "SUCCESS" },
        ];
      };
      assert.equal(await run("wait", "5"), 0);
      assert.equal(sleeps, 1);
      assert.equal(mergeCalls().length, 0);
    });

    it("a head that changes while waiting is 11", async () => {
      pending();
      sleepHook = () => {
        world.shas = [SHA_B];
      };
      assert.equal(await run("wait", "5"), 11);
    });

    it("pending at the end of the call's time is 10", async () => {
      pending();
      let reads = 0;
      world.onCall.push((args) => {
        if (isHeadRead(args) && ++reads === 2) mono = DEADLINE - 5_000;
      });
      assert.equal(await run("wait", "5"), 10);
    });

    it("a used up wait budget for the head is 12", async () => {
      pending();
      assert.equal(await run("wait", "5"), 12);
      assert.equal(mergeCalls().length, 0);
    });

    it("a CLOSED PR whose checks passed is 30", async () => {
      world.pr.state = "CLOSED";
      assert.equal(await run("wait", "5"), 30);
    });

    it("a gh read that keeps failing is 40", async () => {
      world.failOn = "checkSuites";
      assert.equal(await run("wait", "5"), 40);
    });

    it("a PR merged at the start is 0, and one merged at the same head while waiting is 0", async () => {
      world.pr.state = "MERGED";
      assert.equal(await run("wait", "5"), 0);
      assert.match(lastLine() ?? "", /already merged at/);

      world = freshWorld();
      pending();
      sleepHook = () => {
        world.pr.state = "MERGED";
      };
      assert.equal(await run("wait", "5"), 0);
      assert.match(lastLine() ?? "", /already merged at/);
      assert.equal(mergeCalls().length, 0);
    });

    it("a read that finds the PR merged at the same head is 0, at another head 11 (merge)", async () => {
      record("merge");
      let reads = 0;
      world.onCall.push((args) => {
        if (isHeadRead(args) && ++reads === 2) world.pr.state = "MERGED";
      });
      assert.equal(await run("merge", "5"), 0);
      assert.match(lastLine() ?? "", /already merged at/);
      assert.equal(mergeCalls().length, 0);

      world = freshWorld();
      world.shas = [SHA_A, SHA_B];
      reads = 0;
      world.onCall.push((args) => {
        if (isHeadRead(args) && ++reads === 2) world.pr.state = "MERGED";
      });
      assert.equal(await run("merge", "5"), 11);
      assert.equal(mergeCalls().length, 0);
    });

    it("rejects a missing, zero or extra argument with 2", async () => {
      assert.equal(await run("wait"), 2);
      assert.equal(await run("wait", "0"), 2);
      assert.equal(await run("wait", "5", "--x"), 2);
      assert.equal(calls.length, 0);
    });
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

  describe("merged PRs, the deadline before merging, interruption and output", () => {
    const DEADLINE = 1000 + 23 * 60_000;
    const elapsed = () => wall - T0;
    const pending = () => {
      world.checkRuns = [
        { name: world.context, status: "IN_PROGRESS", conclusion: null },
      ];
    };
    const once = (when: (args: string[]) => boolean, act: () => void) => {
      let done = false;
      world.onCall.push((args) => {
        if (!done && when(args)) {
          done = true;
          act();
        }
      });
    };
    const isHeadRead = (args: string[]) =>
      args.join(" ").includes("headRefOid");
    const isChecksRead = (args: string[]) =>
      args.join(" ").includes("checkSuites");
    const isMerge = (args: string[]) => args[0] === "pr" && args[1] === "merge";
    /** Runs `act` before the nth head read of the call. */
    const onNthHeadRead = (n: number, act: () => void) => {
      let reads = 0;
      world.onCall.push((args) => {
        if (isHeadRead(args) && ++reads === n) act();
      });
    };
    const finalLines = () =>
      out.split("\n").filter((l) => /^delivery-policy: \d+: /.test(l));
    const INTERRUPTED =
      "delivery-policy: 10: interrupted; run the same command again";

    it("success read with 5 s left is 10 without calling gh pr merge, and promises no merge", async () => {
      record("merge");
      onNthHeadRead(2, () => {
        mono = DEADLINE - 5_000;
      });
      assert.equal(await run("merge", "5"), 10);
      assert.equal(mergeCalls().length, 0);
      assert.match(lastLine() ?? "", /^delivery-policy: 10: /);
      assert.doesNotMatch(lastLine() ?? "", /will be merged|merges/);
    });

    it("the ledger is re-read before the remaining time: narrowed with 5 s left is 20", async () => {
      record("merge");
      onNthHeadRead(2, () => {
        mono = DEADLINE - 5_000;
        record("pr");
      });
      assert.equal(await run("merge", "5"), 20);
      assert.equal(mergeCalls().length, 0);
    });

    it("a PR already merged at the checked head is 0 and calls no merge", async () => {
      record("merge");
      world.pr.state = "MERGED";
      assert.equal(await run("merge", "5"), 0);
      assert.equal(
        lastLine(),
        `delivery-policy: 0: already merged at ${SHA_A.slice(0, 12)}; merger not determined`,
      );
      assert.equal(mergeCalls().length, 0);
    });

    it("MERGED is judged before the ledger: a scope narrowed from the start still gives 0", async () => {
      record("pr");
      world.pr.state = "MERGED";
      assert.equal(await run("merge", "5"), 0);
      assert.match(lastLine() ?? "", /already merged at/);
      assert.equal(mergeCalls().length, 0);
    });

    it("a failed gh pr merge on a PR that is merged at the head is 0", async () => {
      record("merge");
      world.mergeStatus = 1;
      once(isMerge, () => {
        world.pr.state = "MERGED";
      });
      assert.equal(await run("merge", "5"), 0);
      assert.match(
        lastLine() ?? "",
        /already merged at aaaaaaaaaaaa; merger not determined/,
      );
    });

    it("the re-read after a failed gh pr merge is not held to the deadline", async () => {
      record("merge");
      world.mergeStatus = 1;
      once(isMerge, () => {
        world.pr.state = "MERGED";
        mono = DEADLINE + 60_000;
      });
      assert.equal(await run("merge", "5"), 0);
      assert.match(lastLine() ?? "", /already merged at/);
    });

    it("a failed gh pr merge on a PR merged at another sha is 40", async () => {
      record("merge");
      world.mergeStatus = 1;
      once(isMerge, () => {
        world.pr.state = "MERGED";
        world.shas = [SHA_B];
      });
      assert.equal(await run("merge", "5"), 40);
    });

    it("a failed gh pr merge on a CLOSED or OPEN PR is 40", async () => {
      for (const state of ["CLOSED", "OPEN"]) {
        out = "";
        world = freshWorld();
        world.mergeStatus = 1;
        world.mergeStderr = "denied";
        record("merge");
        once(isMerge, () => {
          world.pr.state = state;
        });
        assert.equal(await run("merge", "5"), 40, state);
        assert.match(
          lastLine() ?? "",
          /^delivery-policy: 40: gh pr merge failed: denied/,
        );
      }
    });

    it("a gh pr merge that timed out on a PR that reads OPEN is 40 and says the merge state is unknown", async () => {
      record("merge");
      world.mergeStatus = Number.NaN;
      const realGh = gh;
      const timedOut: typeof gh = async (args, options) => {
        const result = await realGh(args, options);
        return isMerge(args) ? { ...result, status: null } : result;
      };
      assert.equal(
        await runDeliveryPolicyCli(["merge", "5"], { ...deps(), gh: timedOut }),
        40,
      );
      assert.match(
        lastLine() ?? "",
        /^delivery-policy: 40: .*merge state is unknown/,
      );
      assert.doesNotMatch(lastLine() ?? "", /^delivery-policy: 10/);
    });

    it("a failed re-read after a failed gh pr merge is 40 and keeps the original stderr", async () => {
      record("merge");
      world.mergeStatus = 1;
      world.mergeStderr = "denied";
      once(isMerge, () => {
        world.failOn = "headRefOid";
      });
      assert.equal(await run("merge", "5"), 40);
      assert.match(lastLine() ?? "", /gh pr merge failed: denied.*boom/);
    });

    const EVIL = "ESC\u001b NL\n NEL\u0085 LS  RLO‮ ZW​ TAG\u{e0041} END";
    const EVIL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

    it("output lines carry none of Cc, Cf, Zl, Zp and are cut at 500 characters", async () => {
      record("merge");
      world.context = `${EVIL}${"x".repeat(2000)}`;
      pending();
      world.failStderr = EVIL;
      world.checkOutcomes = ["ok", "fail"];
      assert.equal(await run("merge", "5"), 12);
      const lines = out.trimEnd().split("\n");
      assert.ok(lines.some((l) => l.includes("waiting: transient error")));
      for (const line of lines) {
        assert.doesNotMatch(line, EVIL_CHARS);
        assert.ok(Array.from(line).length <= 500, `${line.length}`);
      }
      assert.ok(out.includes("ESC  NL  NEL  LS  RLO  ZW  TAG  END"));
    });

    it("a newline in a check name cannot start a fake result line", async () => {
      record("merge");
      world.context = "x\ndelivery-policy: 0: merged #1";
      pending();
      assert.equal(await run("merge", "5"), 12);
      assert.deepEqual(
        out.split("\n").filter((l) => l.startsWith("delivery-policy: 0:")),
        [],
      );
      assert.match(out, /x delivery-policy: 0: merged #1/);
    });

    it("an abort in the middle of the 15 s sleep ends it at once with 10 and no merge", async () => {
      record("merge");
      pending();
      sleepHook = () => controller.abort();
      assert.equal(await run("merge", "5"), 10);
      assert.equal(lastLine(), INTERRUPTED);
      assert.equal(mergeCalls().length, 0);
      assert.equal(sleeps, 1);
      assert.ok(elapsed() < 15_000, `${elapsed()}`);
    });

    it("abortableSleep resolves on abort and leaves no timer behind", async () => {
      const timers = () =>
        process.getActiveResourcesInfo().filter((n) => n === "Timeout").length;
      const before = timers();
      const abort = new AbortController();
      const sleeping = abortableSleep(60_000, abort.signal);
      assert.equal(timers(), before + 1);
      abort.abort();
      const winner = await Promise.race([
        sleeping.then(() => "done"),
        new Promise((resolve) => setImmediate(() => resolve("hung"))),
      ]);
      assert.equal(winner, "done");
      assert.equal(timers(), before);
      await abortableSleep(60_000, abort.signal);
    });

    it("an abort during the second gh of a round stops before the next gh and before any waiting line", async () => {
      record("merge");
      pending();
      once(isChecksRead, () => controller.abort());
      assert.equal(await run("merge", "5"), 10);
      assert.equal(lastLine(), INTERRUPTED);
      assert.equal(isChecksRead(calls.at(-1) ?? []), true);
      assert.doesNotMatch(out, /waiting:/);
      assert.equal(sleeps, 0);
    });

    it("an abort before the first gh of the fourth round is not counted as a failed read", async () => {
      record("merge");
      world.checkOutcomes = ["fail", "fail", "fail", "fail"];
      sleepHook = () => {
        if (sleeps === 3) controller.abort();
      };
      assert.equal(await run("merge", "5"), 10);
      assert.equal(lastLine(), INTERRUPTED);
      assert.equal(
        out.split("\n").filter((l) => l.includes("transient error")).length,
        3,
      );
      assert.doesNotMatch(out, /\(4\/4\)/);
    });

    it("a PR merged at another head while waiting is 11: the head is compared before MERGED", async () => {
      record("merge");
      pending();
      once(
        () => elapsed() >= 180_000,
        () => {
          world.pr.state = "MERGED";
          world.shas = [SHA_B];
        },
      );
      assert.equal(await run("merge", "5"), 11);
      assert.equal(mergeCalls().length, 0);
    });

    it("an abort while gh pr merge runs lets it finish: 0, one final line", async () => {
      record("merge");
      once(isMerge, () => controller.abort());
      assert.equal(await run("merge", "5"), 0);
      assert.match(lastLine() ?? "", /^delivery-policy: 0: merged #5 at /);
      assert.equal(finalLines().length, 1);
    });

    // The pre-merge abort check is the only one gh pr merge may meet. A signal
    // object that turns true right after it catches a merge sent through the
    // reads' wrapper, which would look at the signal once more.
    it("gh pr merge does not go through the abort check of the reads", async () => {
      record("merge");
      let reads = 0;
      let trueFrom = Number.POSITIVE_INFINITY;
      const signal = {
        get aborted() {
          return ++reads >= trueFrom;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as AbortSignal;
      assert.equal(
        await runDeliveryPolicyCli(["merge", "5"], { ...deps(), signal }),
        0,
      );
      // One look per read through the wrapper, plus the check just before the
      // merge. The signal turns true on the look after that one, which only a
      // merge sent through the wrapper would make.
      const readCalls = calls.filter((c) => !isMerge(c)).length;
      reads = 0;
      trueFrom = readCalls + 2;
      calls = [];
      out = "";
      assert.equal(
        await runDeliveryPolicyCli(["merge", "5"], { ...deps(), signal }),
        0,
      );
      assert.equal(mergeCalls().length, 1);
    });

    it("an abort raised while the final line is written adds no line", async () => {
      record("merge");
      const base = deps();
      const lines: string[] = [];
      const code = await runDeliveryPolicyCli(["merge", "5"], {
        ...base,
        out: (text) => {
          lines.push(text);
          if (text.startsWith("delivery-policy: 0:")) controller.abort();
        },
      });
      assert.equal(code, 0);
      assert.equal(
        lines.filter((l) => /^delivery-policy: \d+:/.test(l)).length,
        1,
      );
    });
  });
});
