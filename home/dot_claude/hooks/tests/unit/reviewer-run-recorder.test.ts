#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import hook, {
  REVIEWER_SLUGS,
} from "../../implementations/reviewer-run-recorder.ts";
import {
  createPostToolUseContextFor,
  createWorkflowRepo,
  EnvironmentHelper,
  invokeRun,
  pendingWorkflowRepo,
  TEST_WORKFLOW_DIR,
} from "./test-helpers.ts";

describe("reviewer-run-recorder.ts", () => {
  const envHelper = new EnvironmentHelper();

  it("REVIEWER_SLUGS derives from the shared spec/plan/catalog rosters", () => {
    assert.ok(REVIEWER_SLUGS.has("logic-validator"));
    assert.ok(REVIEWER_SLUGS.has("scope-justification-reviewer"));
    assert.ok(REVIEWER_SLUGS.has("security-sentinel"));
    assert.ok(!REVIEWER_SLUGS.has("Explore"));
    assert.ok(!REVIEWER_SLUGS.has("general-purpose"));
  });

  it("records a reviewer Agent run to the ledger", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Agent", {
      subagent_type: "logic-validator",
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    const log = readFileSync(
      join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log"),
      "utf-8",
    );
    assert.match(log, /logic-validator/);
    envHelper.restore();
  });

  it("normalizes a plugin-namespaced subagent_type but records it raw", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Agent", {
      subagent_type: "compound-engineering:review:security-sentinel",
    });
    await invokeRun(hook, ctx);
    const log = readFileSync(
      join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log"),
      "utf-8",
    );
    assert.match(log, /compound-engineering:review:security-sentinel/);
    envHelper.restore();
  });

  it("ignores non-reviewer subagents (Explore)", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Agent", {
      subagent_type: "Explore",
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    assert.equal(
      existsSync(join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log")),
      false,
    );
    envHelper.restore();
  });

  it("ignores non-Agent tools", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPostToolUseContextFor(hook, "Bash", {
      command: "echo hi",
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    envHelper.restore();
  });

  it("does nothing when the workflow dir is unresolvable", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    envHelper.set("CLAUDE_TEST_CWD", "/tmp");
    const ctx = createPostToolUseContextFor(
      hook,
      "Agent",
      { subagent_type: "logic-validator" },
      {},
      { session_id: "" },
    );
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
    envHelper.restore();
  });

  it("caps the ledger at 200 lines (FIFO)", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    for (let i = 0; i < 205; i++) {
      const ctx = createPostToolUseContextFor(hook, "Agent", {
        subagent_type: "logic-validator",
      });
      await invokeRun(hook, ctx);
    }
    const log = readFileSync(
      join(repo, TEST_WORKFLOW_DIR, "reviewer-runs.log"),
      "utf-8",
    );
    const lines = log.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 200);
    envHelper.restore();
  });
});
