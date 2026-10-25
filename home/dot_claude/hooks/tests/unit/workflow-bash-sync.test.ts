#!/usr/bin/env node --test

import { match, strictEqual } from "node:assert";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createPostToolUseContextFor,
  draftPlanRepo,
  EnvironmentHelper,
  invokeRun,
} from "../support/test-helpers.ts";
import {
  additionalContextOf,
  hook,
} from "../support/workflow-bash-sync-fixture.ts";

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
    const repo = realpathSync(
      mkdtempSync(join(tmpdir(), "workflow-bash-sync-")),
    );
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
    const repo = realpathSync(
      mkdtempSync(join(tmpdir(), "workflow-bash-sync-")),
    );
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Bash", { command: "true" });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
  });
});
