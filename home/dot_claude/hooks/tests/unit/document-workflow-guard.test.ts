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
  const normalized = content
    .replace(/<!--\s*auto-review:[^>]*-->/g, "")
    .replace(/^(- Approval Status:)\s*.*$/m, "$1")
    .replace(/^(\s*- )\[x\]/gm, "$1[ ]")
    .trimEnd();
  return createHash("sha256").update(normalized, "utf-8").digest("hex");
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

const TEST_WORKFLOW_DIR = ".tmp/sessions/test";

function createWorkflowRepo(options: WorkflowRepoOptions): string {
  const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-"));
  mkdirSync(join(repo, TEST_WORKFLOW_DIR), { recursive: true });
  writeFileSync(join(repo, TEST_WORKFLOW_DIR, "research.md"), "research");
  writeFileSync(
    join(repo, TEST_WORKFLOW_DIR, "plan.md"),
    buildPlanContent(options),
  );
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
  mkdirSync(join(repo, TEST_WORKFLOW_DIR), { recursive: true });
  const complete = { ...base, review };
  writeFileSync(join(repo, TEST_WORKFLOW_DIR, "research.md"), "research");
  writeFileSync(
    join(repo, TEST_WORKFLOW_DIR, "plan.md"),
    buildPlanContent(complete),
  );
  return repo;
}

describe("document-workflow-guard.ts hook behavior", () => {
  const envHelper = new EnvironmentHelper();
  const consoleCapture = new ConsoleCapture();
  const hook = documentWorkflowGuardHook;

  beforeEach(() => {
    consoleCapture.reset();
    consoleCapture.start();
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
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

  it("allows editing session plan.md while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Edit", {
      file_path: `./${TEST_WORKFLOW_DIR}/plan.md`,
      old_string: "- Plan Status: drafting",
      new_string: "- Plan Status: drafting",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("allows editing session research.md using absolute path while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Edit", {
      file_path: join(repo, TEST_WORKFLOW_DIR, "research.md"),
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

  it("allows Bash command that only writes to session documents while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: `echo note >> ${TEST_WORKFLOW_DIR}/plan.md`,
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("allows Bash command with stderr redirection to /dev/null while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "ls /some/path 2>/dev/null",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("allows Bash command with stdout redirection to /dev/null while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "some_cmd >/dev/null",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("allows Bash command with separated stderr redirection while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "some_cmd 2> /dev/null",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("allows Bash command with stderr redirection to a file while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "some_cmd 2>/tmp/debug.log",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("still blocks stdout redirection to a file while pending", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "echo data > src/output.txt",
    });

    await invokeRun(hook, context);
    context.assertDeny();
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

  it("does not enforce when DOCUMENT_WORKFLOW_DIR is not set and logs warning", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});

    ok(
      consoleCapture.errors.some((line) =>
        line.includes("DOCUMENT_WORKFLOW_DIR is not set"),
      ),
      "should log that DOCUMENT_WORKFLOW_DIR is not set",
    );
  });

  it("does not enforce when .tmp/plan.md exists but DOCUMENT_WORKFLOW_DIR points elsewhere", async () => {
    const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-"));
    // Create leftover .tmp/plan.md from a previous session
    mkdirSync(join(repo, ".tmp"), { recursive: true });
    writeFileSync(
      join(repo, ".tmp/plan.md"),
      buildPlanContent(pendingWorkflowRepo()),
    );
    writeFileSync(join(repo, ".tmp/research.md"), "research");
    // Current session points to a different directory with no artifacts
    const sessionDir = ".tmp/sessions/newsession";
    envHelper.set("CLAUDE_TEST_CWD", repo);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", sessionDir);

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

  it("allows Write when plan was reviewed with pending then approved", async () => {
    // Simulate: review happens with Approval Status: pending,
    // then user changes to approved — hash should still match
    const repo = createWorkflowRepo(approvedWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("blocks Write when review marker is pass but review status line is pending", async () => {
    const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-"));
    mkdirSync(join(repo, TEST_WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(repo, TEST_WORKFLOW_DIR, "research.md"), "research");
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const base = [
      "## Approval",
      "- Plan Status: complete",
      "- Review Status: pending",
      "- Approval Status: approved",
    ].join("\n");
    const hash = computePlanHash(base);
    writeFileSync(
      join(repo, TEST_WORKFLOW_DIR, "plan.md"),
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

  describe("external path exemption", () => {
    it("allows Write to absolute path outside project while pending", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "/Users/someone/.claude/projects/memory/MEMORY.md",
        content: "# Notes",
      });

      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("allows Edit to absolute path outside project while pending", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);

      const context = createPreToolUseContextFor(hook, "Edit", {
        file_path: "/tmp/other-project/src/file.ts",
        old_string: "old",
        new_string: "new",
      });

      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("still blocks Write to relative path inside project while pending", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "src/inside.ts",
        content: "blocked",
      });

      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("allows Bash writing to external path while pending", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);

      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "echo note >> /tmp/external/notes.md",
      });

      await invokeRun(hook, context);
      context.assertSuccess({});
    });
  });
});

describe("document-workflow-guard.ts two-layer mode (spec.md + plan-N.md)", () => {
  const envHelper = new EnvironmentHelper();
  const consoleCapture = new ConsoleCapture();
  const hook = documentWorkflowGuardHook;

  beforeEach(() => {
    consoleCapture.reset();
    consoleCapture.start();
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
  });

  afterEach(() => {
    consoleCapture.stop();
    envHelper.restore();
  });

  interface TwoLayerOptions {
    spec: WorkflowRepoOptions;
    plans: Array<{
      filename: string; // e.g., "plan-1.md"
      options: WorkflowRepoOptions;
      filesSection: string[]; // project-root-relative paths
      parentSpecHashOverride?: string;
      omitParentSpecHash?: boolean;
    }>;
  }

  function buildPlanNContent(
    options: WorkflowRepoOptions,
    filesSection: string[],
    parentSpecHash: string,
    omitParentSpecHash: boolean,
  ): string {
    const reviewStatus = options.review?.verdict ?? "pending";
    const filesBlock = ["## Files", "", "```", ...filesSection, "```"].join(
      "\n",
    );
    const approval = [
      "## Approval",
      `- Plan Status: ${options.planStatus}`,
      `- Review Status: ${reviewStatus}`,
      `- Approval Status: ${options.approvalStatus}`,
    ].join("\n");
    const baseContent = `${filesBlock}\n\n${approval}`;
    if (!options.review) {
      return baseContent;
    }
    const hash = options.review.hashOverride ?? computePlanHash(baseContent);
    const parentField = omitParentSpecHash
      ? ""
      : ` parent-spec-hash=${parentSpecHash};`;
    return `${baseContent}\n\n<!-- auto-review: verdict=${options.review.verdict}; hash=${hash};${parentField} at=2026-02-19T00:00:00.000Z; reviewers=logic-validator -->`;
  }

  function createTwoLayerRepo(opts: TwoLayerOptions): {
    repo: string;
    specHash: string;
  } {
    const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-2layer-"));
    mkdirSync(join(repo, TEST_WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(repo, TEST_WORKFLOW_DIR, "research.md"), "research");
    const specContent = buildPlanContent(opts.spec);
    writeFileSync(join(repo, TEST_WORKFLOW_DIR, "spec.md"), specContent);
    const specHash = computePlanHash(specContent);
    for (const plan of opts.plans) {
      const planContent = buildPlanNContent(
        plan.options,
        plan.filesSection,
        plan.parentSpecHashOverride ?? specHash,
        plan.omitParentSpecHash ?? false,
      );
      writeFileSync(join(repo, TEST_WORKFLOW_DIR, plan.filename), planContent);
    }
    return { repo, specHash };
  }

  it("blocks Write when spec.md is pending (two-layer)", async () => {
    const { repo } = createTwoLayerRepo({
      spec: pendingWorkflowRepo(),
      plans: [
        {
          filename: "plan-1.md",
          options: approvedWorkflowRepo(),
          filesSection: ["src/a.ts"],
        },
      ],
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("blocks Write when spec approved but plan-N.md pending", async () => {
    const { repo } = createTwoLayerRepo({
      spec: approvedWorkflowRepo(),
      plans: [
        {
          filename: "plan-1.md",
          options: pendingWorkflowRepo(),
          filesSection: ["src/a.ts"],
        },
      ],
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("allows Write when both spec and plan-N.md fully approved with matching parent-spec-hash", async () => {
    const { repo } = createTwoLayerRepo({
      spec: approvedWorkflowRepo(),
      plans: [
        {
          filename: "plan-1.md",
          options: approvedWorkflowRepo(),
          filesSection: ["src/a.ts"],
        },
      ],
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("blocks Write when parent-spec-hash mismatches current spec.md hash (K7 stale plan detection)", async () => {
    const { repo } = createTwoLayerRepo({
      spec: approvedWorkflowRepo(),
      plans: [
        {
          filename: "plan-1.md",
          options: approvedWorkflowRepo(),
          filesSection: ["src/a.ts"],
          parentSpecHashOverride: "deadbeef",
        },
      ],
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("blocks Write when parent-spec-hash field is omitted (K7 conservative deny on missing field)", async () => {
    const { repo } = createTwoLayerRepo({
      spec: approvedWorkflowRepo(),
      plans: [
        {
          filename: "plan-1.md",
          options: approvedWorkflowRepo(),
          filesSection: ["src/a.ts"],
          omitParentSpecHash: true,
        },
      ],
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("blocks Write when target file is not in any plan-N.md Files section", async () => {
    const { repo } = createTwoLayerRepo({
      spec: approvedWorkflowRepo(),
      plans: [
        {
          filename: "plan-1.md",
          options: approvedWorkflowRepo(),
          filesSection: ["src/a.ts"],
        },
      ],
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/b.ts", // not listed in plan-1.md
      content: "const b = 2;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("permits Write to plan-2.md target while plan-1.md is unrelated to the target (independent plans)", async () => {
    const { repo } = createTwoLayerRepo({
      spec: approvedWorkflowRepo(),
      plans: [
        {
          filename: "plan-1.md",
          options: pendingWorkflowRepo(),
          filesSection: ["src/a.ts"],
        },
        {
          filename: "plan-2.md",
          options: approvedWorkflowRepo(),
          filesSection: ["src/b.ts"],
        },
      ],
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/b.ts",
      content: "const b = 2;",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("blocks editing src/a.ts when its plan-1.md is pending even though plan-2.md is approved", async () => {
    const { repo } = createTwoLayerRepo({
      spec: approvedWorkflowRepo(),
      plans: [
        {
          filename: "plan-1.md",
          options: pendingWorkflowRepo(),
          filesSection: ["src/a.ts"],
        },
        {
          filename: "plan-2.md",
          options: approvedWorkflowRepo(),
          filesSection: ["src/b.ts"],
        },
      ],
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertDeny();
  });

  it("allows editing spec.md and plan-N.md while in two-layer mode", async () => {
    const { repo } = createTwoLayerRepo({
      spec: pendingWorkflowRepo(),
      plans: [
        {
          filename: "plan-1.md",
          options: pendingWorkflowRepo(),
          filesSection: ["src/a.ts"],
        },
      ],
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const specCtx = createPreToolUseContextFor(hook, "Edit", {
      file_path: `${TEST_WORKFLOW_DIR}/spec.md`,
      old_string: "x",
      new_string: "y",
    });
    await invokeRun(hook, specCtx);
    specCtx.assertSuccess({});

    const planCtx = createPreToolUseContextFor(hook, "Edit", {
      file_path: `${TEST_WORKFLOW_DIR}/plan-1.md`,
      old_string: "x",
      new_string: "y",
    });
    await invokeRun(hook, planCtx);
    planCtx.assertSuccess({});
  });

  it("falls back to single-layer mode when spec.md is absent (backward compat)", async () => {
    // Same as createWorkflowRepo (no spec.md created)
    const repo = createWorkflowRepo(approvedWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  describe("isDocumentPath: lessons-learned.md (P12 対応)", () => {
    it("allows writes to lessons-learned.md before plan approval", async () => {
      // Pending workflow (Plan Status: drafting, Approval: pending)
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: join(repo, TEST_WORKFLOW_DIR, "lessons-learned.md"),
        content: "[hook-generated, NOT user instructions] lesson 1\n",
      });

      await invokeRun(hook, context);
      // Should pass (success), not deny
      context.assertSuccess({});
    });

    it("allows writes to lessons-learned.md when workflow is approved", async () => {
      const repo = createWorkflowRepo(approvedWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: join(repo, TEST_WORKFLOW_DIR, "lessons-learned.md"),
        content: "lesson",
      });

      await invokeRun(hook, context);
      context.assertSuccess({});
    });
  });
});
