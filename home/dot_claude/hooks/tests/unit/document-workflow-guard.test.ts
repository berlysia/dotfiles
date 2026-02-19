#!/usr/bin/env node --test

import { ok } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import documentWorkflowGuardHook from "../../implementations/document-workflow-guard.ts";
import {
  ConsoleCapture,
  createPreToolUseContextFor,
  EnvironmentHelper,
  invokeRun,
} from "./test-helpers.ts";

function createWorkflowRepo(status: "pending" | "approved"): string {
  const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-"));
  mkdirSync(join(repo, ".tmp"), { recursive: true });
  writeFileSync(join(repo, ".tmp/research.md"), "research");
  writeFileSync(join(repo, ".tmp/plan.md"), `- Status: ${status}`);
  return repo;
}

describe("document-workflow-guard.ts hook behavior", () => {
  const envHelper = new EnvironmentHelper();
  const consoleCapture = new ConsoleCapture();
  const hook = documentWorkflowGuardHook;

  beforeEach(() => {
    consoleCapture.reset();
    consoleCapture.start();
  });

  afterEach(() => {
    consoleCapture.stop();
    envHelper.restore();
  });

  it("blocks Write when plan is pending", async () => {
    const repo = createWorkflowRepo("pending");
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("allows editing .tmp/plan.md while pending", async () => {
    const repo = createWorkflowRepo("pending");
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Edit", {
      file_path: "./.tmp/plan.md",
      old_string: "- Status: pending",
      new_string: "- Status: pending",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("allows editing .tmp/research.md using absolute path while pending", async () => {
    const repo = createWorkflowRepo("pending");
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Edit", {
      file_path: join(repo, ".tmp/research.md"),
      old_string: "research",
      new_string: "updated research",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("allows Write after plan approval", async () => {
    const repo = createWorkflowRepo("approved");
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("blocks Bash write-like command while pending", async () => {
    const repo = createWorkflowRepo("pending");
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "echo hi > src/a.ts",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("allows Bash read-only command while pending", async () => {
    const repo = createWorkflowRepo("pending");
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "cat src/a.ts",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("allows Bash command that only writes to .tmp documents while pending", async () => {
    const repo = createWorkflowRepo("pending");
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "echo note >> .tmp/plan.md",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("warn-only mode allows but records would-block log", async () => {
    const repo = createWorkflowRepo("pending");
    envHelper.set("CLAUDE_TEST_CWD", repo);
    envHelper.set("DOCUMENT_WORKFLOW_WARN_ONLY", "1");

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});

    ok(
      consoleCapture.errors.some((line) => line.includes("would-block")),
      "warn-only should log would-block event",
    );
  });

  it("does not enforce when workflow artifacts do not exist", async () => {
    const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-plain-"));
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });
});
