#!/usr/bin/env node --test

import { ok } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

interface ReviewMarkerOptions {
  verdict: "pass" | "needs-work" | "blocker";
  hashOverride?: string;
}

interface WorkflowRepoOptions {
  planStatus: "drafting" | "complete";
  approvalStatus: "pending" | "approved";
  review?: ReviewMarkerOptions;
}

function computePlanHash(content: string): string {
  return createHash("sha256").update(content.trimEnd(), "utf-8").digest("hex");
}

function buildPlanContent(options: WorkflowRepoOptions): string {
  const reviewStatus = options.review?.verdict ?? "pending";
  const base = [
    "## Approval",
    `- Plan Status: ${options.planStatus}`,
    `- Review Status: ${reviewStatus}`,
    `- Approval Status: ${options.approvalStatus}`,
  ].join("\n");
  if (!options.review) {
    return base;
  }

  const hash = options.review.hashOverride ?? computePlanHash(base);
  return `${base}\n\n<!-- auto-review: verdict=${options.review.verdict}; hash=${hash}; at=2026-02-19T00:00:00.000Z; reviewers=logic-validator -->`;
}

function createWorkflowRepo(options: WorkflowRepoOptions): string {
  const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-"));
  mkdirSync(join(repo, ".tmp"), { recursive: true });
  writeFileSync(join(repo, ".tmp/research.md"), "research");
  writeFileSync(join(repo, ".tmp/plan.md"), buildPlanContent(options));
  return repo;
}

function approvedWorkflowRepo(): WorkflowRepoOptions {
  return {
    planStatus: "complete",
    approvalStatus: "approved",
    review: { verdict: "pass" },
  };
}

function pendingWorkflowRepo(): WorkflowRepoOptions {
  return {
    planStatus: "drafting",
    approvalStatus: "pending",
  };
}

function buildRepoWithReview(
  base: WorkflowRepoOptions,
  review: ReviewMarkerOptions | undefined,
): string {
  const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-"));
  mkdirSync(join(repo, ".tmp"), { recursive: true });
  const complete = { ...base, review };
  writeFileSync(join(repo, ".tmp/research.md"), "research");
  writeFileSync(join(repo, ".tmp/plan.md"), buildPlanContent(complete));
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
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("allows editing .tmp/plan.md while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Edit", {
      file_path: "./.tmp/plan.md",
      old_string: "- Plan Status: drafting",
      new_string: "- Plan Status: drafting",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("allows editing .tmp/research.md using absolute path while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
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
    const repo = createWorkflowRepo(approvedWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("blocks Write when approved but auto-review marker is missing", async () => {
    const repo = createWorkflowRepo({
      planStatus: "complete",
      approvalStatus: "approved",
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("blocks Write when auto-review marker hash mismatches", async () => {
    const repo = buildRepoWithReview(
      {
        planStatus: "complete",
        approvalStatus: "approved",
      },
      { verdict: "pass", hashOverride: "deadbeef" },
    );
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("blocks Write when auto-review verdict is needs-work", async () => {
    const repo = buildRepoWithReview(
      {
        planStatus: "complete",
        approvalStatus: "approved",
      },
      { verdict: "needs-work" },
    );
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("blocks Bash write-like command while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "echo hi > src/a.ts",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("allows Bash read-only command while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "cat src/a.ts",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("allows Bash command that only writes to .tmp documents while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "echo note >> .tmp/plan.md",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("warn-only mode allows but records would-block log", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
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

  it("blocks Write when review passes but plan status is not complete", async () => {
    const repo = createWorkflowRepo({
      planStatus: "drafting",
      approvalStatus: "approved",
      review: { verdict: "pass" },
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  describe("session-specific workflow directory (DOCUMENT_WORKFLOW_DIR)", () => {
    function createSessionWorkflowRepo(
      sessionDir: string,
      options: WorkflowRepoOptions,
    ): string {
      const repo = mkdtempSync(
        join(tmpdir(), "document-workflow-guard-session-"),
      );
      mkdirSync(join(repo, sessionDir), { recursive: true });
      writeFileSync(join(repo, sessionDir, "research.md"), "research");
      writeFileSync(
        join(repo, sessionDir, "plan.md"),
        buildPlanContent(options),
      );
      return repo;
    }

    it("blocks Write when session-specific plan is pending", async () => {
      const sessionDir = ".tmp/sessions/abcd1234";
      const repo = createSessionWorkflowRepo(sessionDir, pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", sessionDir);

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "src/a.ts",
        content: "const a = 1;",
      });

      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("allows Write when session-specific plan is approved", async () => {
      const sessionDir = ".tmp/sessions/abcd1234";
      const repo = createSessionWorkflowRepo(
        sessionDir,
        approvedWorkflowRepo(),
      );
      envHelper.set("CLAUDE_TEST_CWD", repo);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", sessionDir);

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "src/a.ts",
        content: "const a = 1;",
      });

      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("allows editing session-specific plan.md while pending", async () => {
      const sessionDir = ".tmp/sessions/abcd1234";
      const repo = createSessionWorkflowRepo(sessionDir, pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", sessionDir);

      const context = createPreToolUseContextFor(hook, "Edit", {
        file_path: `./${sessionDir}/plan.md`,
        old_string: "- Plan Status: drafting",
        new_string: "- Plan Status: drafting",
      });

      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("does not activate when default .tmp has no artifacts but session dir does", async () => {
      const repo = mkdtempSync(
        join(tmpdir(), "document-workflow-guard-session-"),
      );
      const sessionDir = ".tmp/sessions/abcd1234";
      mkdirSync(join(repo, sessionDir), { recursive: true });
      writeFileSync(
        join(repo, sessionDir, "plan.md"),
        buildPlanContent(pendingWorkflowRepo()),
      );
      writeFileSync(join(repo, sessionDir, "research.md"), "research");
      envHelper.set("CLAUDE_TEST_CWD", repo);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", sessionDir);

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "src/a.ts",
        content: "const a = 1;",
      });

      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("does not block when session dir has no artifacts", async () => {
      const repo = mkdtempSync(
        join(tmpdir(), "document-workflow-guard-session-"),
      );
      envHelper.set("CLAUDE_TEST_CWD", repo);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/empty1234");

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "src/a.ts",
        content: "const a = 1;",
      });

      await invokeRun(hook, context);
      context.assertSuccess({});
    });
  });

  it("blocks Write when review marker is pass but review status line is pending", async () => {
    const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-"));
    mkdirSync(join(repo, ".tmp"), { recursive: true });
    writeFileSync(join(repo, ".tmp/research.md"), "research");
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const base = [
      "## Approval",
      "- Plan Status: complete",
      "- Review Status: pending",
      "- Approval Status: approved",
    ].join("\n");
    const hash = computePlanHash(base);
    writeFileSync(
      join(repo, ".tmp/plan.md"),
      [
        base,
        "",
        `<!-- auto-review: verdict=pass; hash=${hash}; at=2026-02-19T00:00:00.000Z; reviewers=logic-validator -->`,
      ].join("\n"),
    );

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });
});
