#!/usr/bin/env node --test

import { match, ok, strictEqual } from "node:assert";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import hook from "../../implementations/workflow-bash-sync.ts";
import { deriveDefaultWorkflowDir } from "../../lib/workflow-paths.ts";
import {
  createGitWorkflowRepo,
  createPostToolUseContextFor,
  draftPlanRepo,
  EnvironmentHelper,
  invokeRun,
  TEST_SESSION_ID,
} from "./test-helpers.ts";

function additionalContextOf(ctx: { jsonCalls: any[] }): string {
  return ctx.jsonCalls.at(-1)?.hookSpecificOutput?.additionalContext ?? "";
}

describe("workflow-bash-sync.ts: subagent gate", () => {
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

  it("early-returns for subagent-originated Bash (agent_id present) without touching the fs", async () => {
    const repo = draftPlanRepo();
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(
      hook,
      "Bash",
      { command: "echo hi" },
      {},
      { agent_id: "sub-1" },
    );
    await invokeRun(hook, ctx);
    strictEqual(ctx.jsonCalls.length, 0);
    ctx.assertSuccess({});
  });
});

describe("workflow-bash-sync.ts: wfDir resolution", () => {
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

  it("emits a one-line notice when the session id is malformed (unresolvable)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "workflow-bash-sync-"));
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(
      hook,
      "Bash",
      { command: "true" },
      {},
      { session_id: "short" },
    );
    await invokeRun(hook, ctx);
    match(additionalContextOf(ctx), /could not resolve the workflow directory/);
  });

  it("does nothing when no workflow document exists yet", async () => {
    const repo = mkdtempSync(join(tmpdir(), "workflow-bash-sync-"));
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
  });
});

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
});
