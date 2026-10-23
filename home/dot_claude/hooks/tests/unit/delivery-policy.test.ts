#!/usr/bin/env node --test

import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  appendLedger,
  buildDeliveryPolicyQuestion,
  decideMerge,
  DELIVERY_POLICY_QUESTION_PREFIX,
  guardedHomeDenyRules,
  GUARDED_HOME_PATHS,
  isDeliveryPolicyQuestion,
  isProtectedPath,
  ledgerPath,
  mergeRequiredContexts,
  parseLedger,
  passwdHome,
  readLedger,
  resolveRepo,
  type CheckRun,
  type Gh,
  type Ledger,
  type MergeState,
  type RepoInfo,
} from "../../lib/delivery-policy.ts";

const REPO: RepoInfo = {
  nameWithOwner: "berlysia/dotfiles",
  ownerLogin: "berlysia",
  isInOrganization: false,
  defaultBranch: "main",
  url: "https://github.com/berlysia/dotfiles",
};

const LINE = (scope: string, at = "2026-10-23T00:00:00.000Z") =>
  JSON.stringify({ v: 1, repo: REPO.nameWithOwner, scope, at });

function ledgerOf(...lines: string[]): Ledger {
  return parseLedger(lines.map((l) => `\n${l}`).join(""));
}

function passingState(overrides: Partial<MergeState> = {}): MergeState {
  return {
    ledger: ledgerOf(LINE("merge")),
    repo: REPO,
    viewer: "berlysia",
    pr: {
      state: "OPEN",
      author: "berlysia",
      baseRepository: "berlysia/dotfiles",
      baseRefName: "main",
      headRefName: "feat/x",
      isCrossRepository: false,
      changedFiles: 1,
      mergeStateStatus: "CLEAN",
    },
    files: [{ path: "docs/a.md" }],
    requiredContexts: [{ context: "status-check" }],
    checkRuns: [
      {
        name: "status-check",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        appId: 15368,
      },
    ],
    ...overrides,
  };
}

describe("ledger", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "delivery-policy-lib-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("the last valid line of a repo wins", () => {
    const ledger = ledgerOf(LINE("merge"), LINE("pr"));
    assert.equal(ledger.latest.get("berlysia/dotfiles")?.scope, "pr");
    assert.deepEqual(ledger.invalid, []);
  });

  it("a v:2 line after the writer's line is invalid at its physical line", () => {
    appendLedger(home, {
      repo: "berlysia/dotfiles",
      scope: "merge",
      at: "2026-10-23T00:00:00.000Z",
    });
    appendFileSync(
      ledgerPath(home),
      `\n${JSON.stringify({ v: 2, repo: "berlysia/dotfiles", scope: "pr", at: "x" })}`,
    );
    const ledger = readLedger(home);
    assert.deepEqual(ledger.invalid, [{ line: 3, reason: "version" }]);
    const decision = decideMerge(passingState({ ledger }));
    assert.deepEqual(
      decision.kind === "stop" && decision.code,
      40,
      JSON.stringify(decision),
    );
  });

  it("round trip: the writer's bytes are valid, and the first physical line is blank", () => {
    appendLedger(home, {
      repo: "a/b",
      scope: "pr",
      at: "2026-01-01T00:00:00Z",
    });
    appendLedger(home, {
      repo: "a/b",
      scope: "merge",
      at: "2026-01-02T00:00:00Z",
    });
    const text = readFileSync(ledgerPath(home), "utf-8");
    const lines = text.split("\n");
    assert.equal(lines[0], "");
    assert.equal(lines.length, 3);
    const ledger = readLedger(home);
    assert.deepEqual(ledger.invalid, []);
    assert.equal(ledger.latest.get("a/b")?.scope, "merge");
  });

  it("an invalid line is numbered by its position when the file is split on newlines", () => {
    const text = `\n${LINE("pr")}\n\n{not json\n${LINE("merge")}\n`;
    const ledger = parseLedger(text);
    // physical lines: 1 blank, 2 valid, 3 blank, 4 broken, 5 valid, 6 blank
    assert.deepEqual(ledger.invalid, [{ line: 4, reason: "json" }]);
    assert.equal(text.split("\n")[3], "{not json");
  });

  it("a truncated tail is invalid (json) and stops merge with 40", () => {
    const text = `\n${LINE("merge")}\n{"v":1,"repo":"berlysia/dot`;
    const ledger = parseLedger(text);
    assert.deepEqual(ledger.invalid, [{ line: 3, reason: "json" }]);
    const decision = decideMerge(passingState({ ledger }));
    assert.equal(decision.kind === "stop" && decision.code, 40);
  });

  it("a future at is valid; order, not the clock, decides", () => {
    const ledger = ledgerOf(LINE("merge", "2999-01-01T00:00:00.000Z"));
    assert.deepEqual(ledger.invalid, []);
    assert.equal(ledger.latest.get("berlysia/dotfiles")?.scope, "merge");
  });

  it("a line without at is invalid (shape)", () => {
    const ledger = ledgerOf(
      JSON.stringify({ v: 1, repo: "a/b", scope: "merge" }),
    );
    assert.deepEqual(ledger.invalid, [{ line: 2, reason: "shape" }]);
  });

  it("rejects an unknown scope, an empty repo and a non-object line as shape", () => {
    const ledger = ledgerOf(
      JSON.stringify({ v: 1, repo: "a/b", scope: "all", at: "x" }),
      JSON.stringify({ v: 1, repo: "", scope: "pr", at: "x" }),
      "5",
    );
    assert.deepEqual(ledger.invalid, [
      { line: 2, reason: "shape" },
      { line: 3, reason: "shape" },
      { line: 4, reason: "shape" },
    ]);
  });

  it("a missing ledger is empty, not an error", () => {
    const ledger = readLedger(home);
    assert.equal(ledger.latest.size, 0);
    assert.deepEqual(ledger.invalid, []);
    assert.equal(ledger.readError, undefined);
  });

  it("a ledger path that cannot be read is reported and stops merge with 40", () => {
    mkdirSync(ledgerPath(home), { recursive: true });
    const ledger = readLedger(home);
    assert.ok(ledger.readError);
    const decision = decideMerge(passingState({ ledger }));
    assert.equal(decision.kind === "stop" && decision.code, 40);
  });
});

describe("question", () => {
  it("carries the two fixed sentences and the remote URL", () => {
    const [question] = buildDeliveryPolicyQuestion(
      "berlysia/dotfiles",
      "https://github.com/berlysia/dotfiles",
    );
    assert.ok(question);
    assert.ok(question.question.startsWith(DELIVERY_POLICY_QUESTION_PREFIX));
    assert.ok(question.question.includes("berlysia/dotfiles"));
    assert.ok(
      question.question.includes("https://github.com/berlysia/dotfiles"),
    );
    assert.ok(
      question.question.includes(
        "merge を選ぶと、この repo では agent が自分の PR を、確認なしで default branch に merge する",
      ),
    );
    assert.ok(
      question.question.includes(
        "必須の check が無い repo では merge せず人間に戻す",
      ),
    );
    assert.deepEqual(
      question.options.map((o) => o.label),
      ["commit", "pr", "merge"],
    );
  });

  it("isDeliveryPolicyQuestion holds for the prefix whatever the repo name", () => {
    const other = buildDeliveryPolicyQuestion("x/y", "https://example.com/x/y");
    assert.equal(isDeliveryPolicyQuestion(other), true);
    assert.equal(
      isDeliveryPolicyQuestion([{ question: "進めてよいか", options: [] }]),
      false,
    );
    assert.equal(isDeliveryPolicyQuestion("x"), false);
    assert.equal(isDeliveryPolicyQuestion(null), false);
    const hostile = [
      {
        get question(): string {
          throw new Error("boom");
        },
      },
    ];
    assert.equal(isDeliveryPolicyQuestion(hostile), false);
  });
});

describe("resolveRepo", () => {
  const view = JSON.stringify({
    nameWithOwner: "Berlysia/Dotfiles",
    owner: { id: "x", login: "Berlysia" },
    isInOrganization: false,
    defaultBranchRef: { name: "main" },
    url: "https://github.com/Berlysia/dotfiles",
  });

  it("calls gh repo view once and lowercases the name and owner", async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      return { status: 0, stdout: view, stderr: "" };
    };
    const result = await resolveRepo(gh);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "repo",
      "view",
      "--json",
      "nameWithOwner,owner,isInOrganization,defaultBranchRef,url",
    ]);
    assert.deepEqual(result, {
      ok: true,
      repo: {
        nameWithOwner: "berlysia/dotfiles",
        ownerLogin: "berlysia",
        isInOrganization: false,
        defaultBranch: "main",
        url: "https://github.com/Berlysia/dotfiles",
      },
    });
  });

  it("fails on a non-zero status and on a malformed answer", async () => {
    const failed = await resolveRepo(async () => ({
      status: 1,
      stdout: "",
      stderr: "no remote",
    }));
    assert.equal(failed.ok, false);
    const malformed = await resolveRepo(async () => ({
      status: 0,
      stdout: "{}",
      stderr: "",
    }));
    assert.equal(malformed.ok, false);
  });
});

describe("decideMerge table", () => {
  it("merges when every condition holds", () => {
    assert.deepEqual(decideMerge(passingState()), { kind: "merge" });
  });

  it("scope other than merge (including unrecorded) is 20", () => {
    for (const ledger of [ledgerOf(LINE("pr")), ledgerOf()]) {
      const d = decideMerge(passingState({ ledger }));
      assert.equal(d.kind === "stop" && d.code, 20);
    }
  });

  it("an invalid line wins over a non-merge scope (row 1 before row 2)", () => {
    const d = decideMerge(
      passingState({ ledger: ledgerOf(LINE("pr"), "{broken") }),
    );
    assert.equal(d.kind === "stop" && d.code, 40);
  });

  it("each row-3 condition alone gives 30, each with its own reason", () => {
    const base = passingState();
    const cases: Array<[string, Partial<MergeState>]> = [
      ["viewer", { viewer: "someone-else" }],
      ["org", { repo: { ...REPO, isInOrganization: true } }],
      ["author", { pr: { ...base.pr, author: "other" } }],
      ["state", { pr: { ...base.pr, state: "CLOSED" } }],
      ["baseRepo", { pr: { ...base.pr, baseRepository: "x/y" } }],
      ["base", { pr: { ...base.pr, baseRefName: "release" } }],
      ["head", { pr: { ...base.pr, headRefName: "main" } }],
      ["fork", { pr: { ...base.pr, isCrossRepository: true } }],
    ];
    const reasons = new Set<string>();
    for (const [name, override] of cases) {
      const d = decideMerge({ ...base, ...override });
      assert.ok(
        d.kind === "stop" && d.code === 30,
        `${name}: ${JSON.stringify(d)}`,
      );
      reasons.add(d.reason);
    }
    assert.equal(reasons.size, cases.length);
  });

  it("compares the viewer and owner logins without case", () => {
    const d = decideMerge(passingState({ viewer: "BerLysia" }));
    assert.deepEqual(d, { kind: "merge" });
  });

  it("a protected path is 30 even while checks are pending (row 4 before 7)", () => {
    const d = decideMerge(
      passingState({
        files: [{ path: ".github/workflows/ci.yml" }],
        checkRuns: [],
      }),
    );
    assert.equal(d.kind === "stop" && d.code, 30);
  });

  it("zero required contexts is 30", () => {
    const d = decideMerge(passingState({ requiredContexts: [] }));
    assert.equal(d.kind === "stop" && d.code, 30);
  });

  it("a failure wins over a pending check (row 6 before 7)", () => {
    const d = decideMerge(
      passingState({
        requiredContexts: [{ context: "a" }, { context: "b" }],
        checkRuns: [
          { name: "a", status: "IN_PROGRESS", conclusion: null, appId: 1 },
          { name: "b", status: "COMPLETED", conclusion: "FAILURE", appId: 1 },
        ],
      }),
    );
    assert.equal(d.kind === "stop" && d.code, 30);
  });

  it("all checks pass: UNKNOWN waits, BLOCKED is 30 naming the value, CLEAN merges", () => {
    const state = passingState();
    const unknown = decideMerge({
      ...state,
      pr: { ...state.pr, mergeStateStatus: "UNKNOWN" },
    });
    assert.equal(unknown.kind, "wait");
    const blocked = decideMerge({
      ...state,
      pr: { ...state.pr, mergeStateStatus: "BLOCKED" },
    });
    assert.ok(blocked.kind === "stop" && blocked.code === 30);
    assert.match(blocked.reason, /BLOCKED/);
  });

  it("an in-progress run waits, a cancelled run is 30, lowercase success passes", () => {
    const run = (r: Partial<CheckRun>): CheckRun => ({
      name: "status-check",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      appId: 15368,
      ...r,
    });
    const waiting = decideMerge(
      passingState({
        checkRuns: [run({ status: "IN_PROGRESS", conclusion: null })],
      }),
    );
    assert.equal(waiting.kind, "wait");
    const cancelled = decideMerge(
      passingState({ checkRuns: [run({ conclusion: "CANCELLED" })] }),
    );
    assert.equal(cancelled.kind === "stop" && cancelled.code, 30);
    const lower = decideMerge(
      passingState({
        checkRuns: [run({ status: "completed", conclusion: "success" })],
      }),
    );
    assert.deepEqual(lower, { kind: "merge" });
  });

  it("counts check-runs per required context", () => {
    const run = (name: string, conclusion: string | null, appId = 15368) => ({
      name,
      status: conclusion === null ? "QUEUED" : "COMPLETED",
      conclusion,
      appId,
    });
    const mixed = decideMerge(
      passingState({
        checkRuns: [
          run("status-check", "SUCCESS"),
          run("status-check", "FAILURE"),
        ],
      }),
    );
    assert.equal(mixed.kind === "stop" && mixed.code, 30);
    const soft = decideMerge(
      passingState({
        checkRuns: [
          run("status-check", "NEUTRAL"),
          run("status-check", "SKIPPED"),
        ],
      }),
    );
    assert.deepEqual(soft, { kind: "merge" });
    // commit statuses are not check-runs: nothing is reported, so it waits
    const none = decideMerge(passingState({ checkRuns: [] }));
    assert.equal(none.kind, "wait");
    // the required context pins the app; a run from another app does not count
    const pinned = decideMerge(
      passingState({
        requiredContexts: [{ context: "status-check", integrationId: 15368 }],
        checkRuns: [run("status-check", "SUCCESS", 999)],
      }),
    );
    assert.equal(pinned.kind, "wait");
    const pinnedOk = decideMerge(
      passingState({
        requiredContexts: [{ context: "status-check", integrationId: 15368 }],
        checkRuns: [run("status-check", "SUCCESS", 15368)],
      }),
    );
    assert.deepEqual(pinnedOk, { kind: "merge" });
  });
});

describe("mergeRequiredContexts", () => {
  it("asks for both the ruleset's and the classic protection's contexts", () => {
    const merged = mergeRequiredContexts(
      [{ context: "a" }],
      [{ context: "b" }],
    );
    assert.deepEqual(merged.map((c) => c.context).sort(), ["a", "b"]);
  });

  it("a classic protection that is absent (404) contributes nothing", () => {
    assert.deepEqual(mergeRequiredContexts([{ context: "a" }], null), [
      { context: "a" },
    ]);
  });

  it("the entry with an integration id replaces the one without", () => {
    const merged = mergeRequiredContexts(
      [{ context: "a", integrationId: 15368 }],
      [{ context: "a" }],
    );
    assert.deepEqual(merged, [{ context: "a", integrationId: 15368 }]);
    const reversed = mergeRequiredContexts(
      [{ context: "a" }],
      [{ context: "a", integrationId: 15368 }],
    );
    assert.deepEqual(reversed, [{ context: "a", integrationId: 15368 }]);
  });
});

describe("protected paths", () => {
  it("matches prefixes, globs and exact paths, on the new and the old path", () => {
    assert.equal(isProtectedPath(".github/workflows/ci.yml"), true);
    assert.equal(isProtectedPath("mods/x/hooks.ts"), true);
    assert.equal(isProtectedPath("home/.chezmoiexternal.toml.tmpl"), true);
    assert.equal(
      isProtectedPath("home/dot_claude/hooks/lib/delivery-policy.ts"),
      true,
    );
    assert.equal(isProtectedPath("home/dot_claude/rules/workflow.md"), false);
    assert.equal(isProtectedPath("docs/a.md"), false);
    const d = decideMerge(
      passingState({
        files: [
          {
            path: "home/dot_claude/hooks/lib/renamed.ts",
            previousPath: "home/dot_claude/hooks/lib/delivery-policy.ts",
          },
        ],
      }),
    );
    assert.equal(d.kind === "stop" && d.code, 30);
  });
});

describe("guarded home paths", () => {
  it("lists each path as a Write and an Edit deny rule", () => {
    const rules = guardedHomeDenyRules();
    for (const path of GUARDED_HOME_PATHS) {
      const pattern = path.endsWith("/") ? `~/${path}**` : `~/${path}`;
      assert.ok(rules.includes(`Edit(${pattern})`), path);
      assert.ok(rules.includes(`Write(${pattern})`), path);
    }
    assert.equal(rules.length, GUARDED_HOME_PATHS.length * 2);
  });
});

describe("passwdHome", () => {
  it("reads the 6th field of the passwd entry for the current uid", () => {
    const calls: string[][] = [];
    const home = passwdHome((file, args) => {
      calls.push([file, ...args]);
      return "me:x:1000:1000:Me:/home/me:/bin/bash\n";
    });
    if (process.platform !== "darwin") {
      assert.equal(home, "/home/me");
      assert.deepEqual(calls[0], [
        "/usr/bin/getent",
        "passwd",
        String(process.getuid?.()),
      ]);
    }
  });

  it("is null, never HOME, when the lookup fails or answers a relative path", () => {
    assert.equal(
      passwdHome(() => null),
      null,
    );
    assert.equal(
      passwdHome(() => "me:x:1000:1000::relative:/bin/sh\n"),
      null,
    );
  });

  it("the real lookup does not follow HOME", () => {
    const real = passwdHome();
    assert.ok(real === null || real.startsWith("/"));
  });
});
