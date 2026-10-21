#!/usr/bin/env node --test

import { match, ok, strictEqual } from "node:assert";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import defaultHook from "../../implementations/workflow-bash-sync.ts";
import { deriveDefaultWorkflowDir } from "../../lib/workflow-paths.ts";
import {
  approvedWorkflowRepo,
  buildPlanNContent,
  buildSpecWithScope,
  computeWorkflowRepoPlanHash,
  createGitWorkflowRepo,
  createPostToolUseContextFor,
  draftPlanRepo,
  EnvironmentHelper,
  invokeRun,
  recordApprovalsForTest,
  TEST_SESSION_ID,
} from "../support/test-helpers.ts";
import {
  additionalContextOf,
  hook,
} from "../support/workflow-bash-sync-fixture.ts";
import { createBlockingGit } from "../support/fake-git.ts";

describe("workflow-bash-sync.ts: doc hash dispatch (K1)", () => {
  const envHelper = new EnvironmentHelper();

  beforeEach(() => {
    // The ambient shell (and this repo's own Document Workflow session) may
    // already export DOCUMENT_WORKFLOW_DIR. These fixtures rely on
    // session-id-derived resolution (`draftPlanRepo`/`createGitWorkflowRepo`
    // place their workflow dir at `.tmp/sessions/<TEST_SESSION_ID slice>`),
    // so an inherited pin pointing elsewhere would silently redirect
    // resolveWorkflowDir away from the fixture and make every assertion
    // below observe an empty, unrelated directory instead of a real failure.
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  });

  afterEach(() => {
    envHelper.restore();
  });

  it("emits a plan-review-automation recommendation when a wfDir plan hash changed (main loop)", async () => {
    const repo = draftPlanRepo();
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx);
    match(additionalContextOf(ctx), /plan-review-automation/);
    match(additionalContextOf(ctx), /plan\.md was updated/);
  });

  it("does not repeat the recommendation once the hash has been cached", async () => {
    const repo = draftPlanRepo();
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx1 = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx1);
    strictEqual(ctx1.jsonCalls.length, 1);

    const ctx2 = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx2);
    strictEqual(ctx2.jsonCalls.length, 0);
    ctx2.assertSuccess({});
  });
});

describe("workflow-bash-sync.ts: tripwire (K2)", () => {
  const envHelper = new EnvironmentHelper();
  const wfRel = deriveDefaultWorkflowDir(TEST_SESSION_ID);

  beforeEach(() => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  });

  afterEach(() => {
    envHelper.restore();
  });

  it("announces a re-arm (not silence) when no baseline exists yet", async () => {
    const repo = createGitWorkflowRepo();
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx);
    match(additionalContextOf(ctx), /re-armed/);
    ok(existsSync(join(repo, wfRel, ".tripwire-baseline")));
  });

  it("reports a gate-closed repo change outside wfDir, recorded via Bash-tripwire", async () => {
    const repo = createGitWorkflowRepo();
    envHelper.set("CLAUDE_TEST_CWD", repo);

    // First call: establishes the rolling baseline (re-arm).
    const ctx1 = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx1);

    // Gate-closed write made outside any guarded tool (e.g. a raw redirect
    // the guard's classifier missed, or a tool the guard doesn't cover).
    writeFileSync(join(repo, "src", "leaked.ts"), "export const x = 1;\n");

    const ctx2 = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx2);
    const inj = additionalContextOf(ctx2);
    match(inj, /src\/leaked\.ts/);
    match(inj, /off-plan-writes\.log/);

    const log = readFileSync(join(repo, wfRel, "off-plan-writes.log"), "utf-8");
    match(log, /tool=Bash-tripwire/);
    match(log, /leaked\.ts/);
  });

  it("runs the tripwire for an approved plan whose research.md is missing", async () => {
    const repo = createGitWorkflowRepo(approvedWorkflowRepo());
    recordApprovalsForTest(
      join(repo, deriveDefaultWorkflowDir(TEST_SESSION_ID)),
    );
    unlinkSync(join(repo, wfRel, "research.md"));
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const ctx1 = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx1);
    writeFileSync(join(repo, "src", "leaked.ts"), "export const x = 1;\n");
    const ctx2 = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx2);

    const log = readFileSync(join(repo, wfRel, "off-plan-writes.log"), "utf-8");
    match(log, /tool=Bash-tripwire/);
  });

  it("does not run the tripwire for an approved plan with research.md (implementation phase)", async () => {
    const repo = createGitWorkflowRepo(approvedWorkflowRepo());
    recordApprovalsForTest(
      join(repo, deriveDefaultWorkflowDir(TEST_SESSION_ID)),
    );
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const ctx1 = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx1);
    writeFileSync(join(repo, "src", "leaked.ts"), "export const x = 1;\n");
    const ctx2 = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx2);

    const logPath = join(repo, wfRel, "off-plan-writes.log");
    ok(
      !existsSync(logPath) ||
        !/Bash-tripwire/.test(readFileSync(logPath, "utf-8")),
    );
  });

  it("reports changes outside the Scope, and protected ones inside it, while only delegated plans are in effect", async () => {
    const repo = createGitWorkflowRepo(approvedWorkflowRepo());
    const wf = join(repo, deriveDefaultWorkflowDir(TEST_SESSION_ID));
    unlinkSync(join(wf, "plan.md"));
    const spec = buildSpecWithScope(approvedWorkflowRepo(), ["src/", "home/"]);
    writeFileSync(join(wf, "spec.md"), spec);
    writeFileSync(
      join(wf, "plan-1.md"),
      buildPlanNContent(
        { ...approvedWorkflowRepo(), approvalStatus: "pending" },
        ["src/a.ts"],
        computeWorkflowRepoPlanHash(spec),
      ),
    );
    recordApprovalsForTest(wf, { delegateSpec: true });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const arm = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, arm);

    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    mkdirSync(join(repo, "other"));
    writeFileSync(join(repo, "other", "leaked.ts"), "export const x = 1;\n");
    mkdirSync(join(repo, "home", "dot_claude"), { recursive: true });
    writeFileSync(
      join(repo, "home", "dot_claude", "x.ts"),
      "export const y = 1;\n",
    );
    const ctx = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx);

    const tripwire =
      additionalContextOf(ctx)
        .split("\n\n---\n\n")
        .find((section) => section.includes("tripwire")) ?? "";
    match(tripwire, /outside spec\.md's ## Scope/);
    match(tripwire, /other\/leaked\.ts/);
    match(tripwire, /home\/dot_claude\/x\.ts/);
    ok(!/src\/a\.ts/.test(tripwire), tripwire);
  });

  it("disables itself when git is unavailable and does not repeat the notice", async () => {
    const repo = createGitWorkflowRepo();
    envHelper.set("CLAUDE_TEST_CWD", repo);
    envHelper.set("PATH", "");

    const ctx1 = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx1);
    match(additionalContextOf(ctx1), /tripwire disabled/);
    ok(existsSync(join(repo, wfRel, ".tripwire-disabled")));

    // Second call: the doc recommendation was already cached by ctx1, and
    // the disabled marker suppresses another tripwire attempt -> nothing to
    // report at all.
    const ctx2 = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx2);
    strictEqual(ctx2.jsonCalls.length, 0);
    ctx2.assertSuccess({});
  });

  it("refuses to write through a symlinked baseline file", async () => {
    const repo = createGitWorkflowRepo();
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const wfAbs = join(repo, wfRel);
    const decoyTarget = join(repo, "decoy-baseline-target");
    writeFileSync(decoyTarget, "not a real baseline");
    symlinkSync(decoyTarget, join(wfAbs, ".tripwire-baseline"));

    const ctx = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx);

    const baselineStat = lstatSync(join(wfAbs, ".tripwire-baseline"));
    ok(
      baselineStat.isSymbolicLink(),
      "baseline path must remain a symlink (write refused)",
    );
    strictEqual(readFileSync(decoyTarget, "utf-8"), "not a real baseline");
  });

  it("disables itself when git status exceeds the production 200ms timeout", async () => {
    const repo = createGitWorkflowRepo();
    envHelper.set("CLAUDE_TEST_CWD", repo);
    // After the fixture: createGitWorkflowRepo runs the real git.
    const git = createBlockingGit("status");
    envHelper.set("PATH", `${git.binDir}:${process.env.PATH ?? ""}`);
    try {
      const ctx1 = createPostToolUseContextFor(defaultHook, "Bash", {
        command: "true",
      });
      await invokeRun(defaultHook, ctx1);
      match(additionalContextOf(ctx1), /tripwire disabled/);
      // The literal 200 pins the production default; do not derive it.
      match(
        readFileSync(join(repo, wfRel, ".tripwire-disabled"), "utf-8"),
        /git status timed out after 200ms/,
      );
      const blockedAfterFirst = git.blockedCalls();

      // The latch: the doc recommendation was cached by ctx1 and the disabled
      // marker skips the tripwire, so the second call reports nothing and does
      // not run git status again.
      const ctx2 = createPostToolUseContextFor(defaultHook, "Bash", {
        command: "true",
      });
      await invokeRun(defaultHook, ctx2);
      strictEqual(ctx2.jsonCalls.length, 0);
      strictEqual(git.blockedCalls(), blockedAfterFirst);
    } finally {
      git.cleanup();
    }
  });
});
