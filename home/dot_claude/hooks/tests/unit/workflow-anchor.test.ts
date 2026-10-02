#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import guardHook from "../../implementations/document-workflow-guard.ts";
import recorderHook from "../../implementations/reviewer-run-recorder.ts";
import { deriveDefaultWorkflowDir } from "../../lib/workflow-paths.ts";
import {
  createPostToolUseContextFor,
  createPreToolUseContextFor,
  draftPlanRepo,
  EnvironmentHelper,
  invokeRun,
  TEST_SESSION_ID,
} from "./test-helpers.ts";

describe("workflow dir anchors on CLAUDE_PROJECT_DIR, not the tool cwd", () => {
  const envHelper = new EnvironmentHelper();
  const originalCwd = process.cwd();
  let repo: string;

  beforeEach(() => {
    repo = realpathSync(draftPlanRepo());
    mkdirSync(join(repo, "sub"), { recursive: true });
    envHelper.set("CLAUDE_TEST_CWD", undefined);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    envHelper.set("CLAUDE_PROJECT_DIR", repo);
    process.chdir(join(repo, "sub"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    envHelper.restore();
  });

  it("document-workflow-guard denies an implementation write while the plan is pending", async () => {
    const ctx = createPreToolUseContextFor(guardHook, "Write", {
      file_path: join(repo, "src", "a.ts"),
      content: "x",
    });
    await invokeRun(guardHook, ctx);
    ctx.assertDeny();
  });

  it("reviewer-run-recorder writes the ledger under the project root", async () => {
    const ctx = createPostToolUseContextFor(recorderHook, "Agent", {
      subagent_type: "logic-validator",
    });
    await invokeRun(recorderHook, ctx);
    const ledger = join(
      repo,
      deriveDefaultWorkflowDir(TEST_SESSION_ID),
      "reviewer-runs.log",
    );
    assert.ok(existsSync(ledger), `ledger missing: ${ledger}`);
    assert.match(readFileSync(ledger, "utf-8"), /logic-validator/);
  });

  it("every workflow-dir hook imports getProjectRoot", () => {
    const implDir = join(import.meta.dirname, "../../implementations");
    for (const name of [
      "document-workflow-guard",
      "workflow-bash-sync",
      "spec-plan-placeholder-scan",
      "spec-plan-self-audit",
      "block-plan-mode",
      "reviewer-run-recorder",
      "resume-incomplete-work",
      "compaction-testament",
      "session",
    ]) {
      const source = readFileSync(join(implDir, `${name}.ts`), "utf-8");
      assert.match(
        source,
        /from "\.\.\/lib\/project-root\.ts"/,
        `${name}.ts does not import getProjectRoot`,
      );
    }
  });
});
