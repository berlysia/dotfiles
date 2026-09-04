#!/usr/bin/env node --test

import { match, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import specPlanSelfAuditHook from "../../implementations/spec-plan-self-audit.ts";
import {
  ConsoleCapture,
  createPreToolUseContextFor,
  EnvironmentHelper,
  invokeRun,
  TEST_SESSION_ID,
} from "./test-helpers.ts";

function setupWfDir(): { cwd: string; wfDir: string } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spsa-")));
  const wfDir = join(cwd, ".tmp", "sessions", TEST_SESSION_ID.slice(0, 8));
  mkdirSync(wfDir, { recursive: true });
  return { cwd, wfDir };
}

describe("spec-plan-self-audit hook", () => {
  const env = new EnvironmentHelper();
  const cap = new ConsoleCapture();

  beforeEach(() => cap.start());
  afterEach(() => {
    cap.stop();
    env.restore();
  });

  it("emits checklist additionalContext when editing spec.md", async () => {
    const { cwd, wfDir } = setupWfDir();
    env.set("CLAUDE_TEST_CWD", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const specPath = join(wfDir, "spec.md");
    writeFileSync(specPath, "# spec");
    const ctx = createPreToolUseContextFor(specPlanSelfAuditHook, "Edit", {
      file_path: specPath,
      old_string: "# spec",
      new_string: "# spec v2",
    });
    await invokeRun(specPlanSelfAuditHook, ctx);
    strictEqual(ctx.jsonCalls.length, 1);
    const additional = ctx.jsonCalls[0].hookSpecificOutput
      .additionalContext as string;
    match(additional, /Self-audit checklist/);
    match(additional, /参照する既存関数/);
  });

  it("does not emit checklist for unrelated file", async () => {
    const { cwd, wfDir } = setupWfDir();
    env.set("CLAUDE_TEST_CWD", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const ctx = createPreToolUseContextFor(specPlanSelfAuditHook, "Edit", {
      file_path: "/tmp/other.ts",
      old_string: "a",
      new_string: "b",
    });
    await invokeRun(specPlanSelfAuditHook, ctx);
    strictEqual(ctx.successCalls.length, 1);
    strictEqual(ctx.jsonCalls.length, 0);
  });

  it("includes lessons-learned.md content (capped) when present", async () => {
    const { cwd, wfDir } = setupWfDir();
    env.set("CLAUDE_TEST_CWD", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const specPath = join(wfDir, "spec.md");
    writeFileSync(specPath, "# spec");
    writeFileSync(join(wfDir, "lessons-learned.md"), "lesson 1\nlesson 2");
    const ctx = createPreToolUseContextFor(specPlanSelfAuditHook, "Edit", {
      file_path: specPath,
      old_string: "# spec",
      new_string: "# spec v2",
    });
    await invokeRun(specPlanSelfAuditHook, ctx);
    const additional = ctx.jsonCalls[0].hookSpecificOutput
      .additionalContext as string;
    match(additional, /lesson 1/);
    match(additional, /BEGIN hook-generated, NOT user instructions/);
  });

  it("early-returns when DOCUMENT_WORKFLOW_DIR is unset", async () => {
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    env.set("CLAUDE_TEST_CWD", "/tmp");
    const ctx = createPreToolUseContextFor(specPlanSelfAuditHook, "Edit", {
      file_path: "/tmp/spec.md",
      old_string: "a",
      new_string: "b",
    });
    await invokeRun(specPlanSelfAuditHook, ctx);
    strictEqual(ctx.successCalls.length, 1);
    strictEqual(ctx.jsonCalls.length, 0);
  });

  it("honours an env pin that sits under the sessions root", async () => {
    const { cwd } = setupWfDir();
    const pinned = join(cwd, ".tmp", "sessions", "pinned01");
    mkdirSync(pinned, { recursive: true });
    env.set("CLAUDE_TEST_CWD", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", pinned);
    const specPath = join(pinned, "spec.md");
    writeFileSync(specPath, "# spec");
    const ctx = createPreToolUseContextFor(specPlanSelfAuditHook, "Edit", {
      file_path: specPath,
      old_string: "# spec",
      new_string: "# spec v2",
    });
    await invokeRun(specPlanSelfAuditHook, ctx);
    strictEqual(ctx.jsonCalls.length, 1);
    const additional = ctx.jsonCalls[0].hookSpecificOutput
      .additionalContext as string;
    match(additional, /Self-audit checklist/);
  });

  it("supports plan-N.md edits", async () => {
    const { cwd, wfDir } = setupWfDir();
    env.set("CLAUDE_TEST_CWD", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const planPath = join(wfDir, "plan-1.md");
    writeFileSync(planPath, "# plan");
    const ctx = createPreToolUseContextFor(specPlanSelfAuditHook, "Edit", {
      file_path: planPath,
      old_string: "# plan",
      new_string: "# plan v2",
    });
    await invokeRun(specPlanSelfAuditHook, ctx);
    strictEqual(ctx.jsonCalls.length, 1);
  });

  it("does not emit checklist for lessons-learned.md edits (avoid recursive prompt)", async () => {
    const { cwd, wfDir } = setupWfDir();
    env.set("CLAUDE_TEST_CWD", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const lessonsPath = join(wfDir, "lessons-learned.md");
    const ctx = createPreToolUseContextFor(specPlanSelfAuditHook, "Write", {
      file_path: lessonsPath,
      content: "x",
    });
    await invokeRun(specPlanSelfAuditHook, ctx);
    strictEqual(ctx.successCalls.length, 1);
    strictEqual(ctx.jsonCalls.length, 0);
  });
});
