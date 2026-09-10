#!/usr/bin/env node --test

import { afterEach, beforeEach, describe, it } from "node:test";
import documentWorkflowGuardHook from "../../implementations/document-workflow-guard.ts";
import {
  ConsoleCapture,
  createPreToolUseContextFor,
  createWorkflowRepo,
  EnvironmentHelper,
  invokeRun,
  pendingWorkflowRepo,
  TEST_WORKFLOW_DIR,
} from "./test-helpers.ts";

describe("document-workflow-guard.ts: interpreter inline-script write classification (spec K3)", () => {
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

  it("denies a python3 -c write to a non-scratch relative path while gate closed", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPreToolUseContextFor(hook, "Bash", {
      command: `python3 -c "open('src/x.ts','w').write('h')"`,
    });
    await invokeRun(hook, ctx);
    ctx.assertDeny();
  });

  it("allows a node -e write confined to /tmp", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPreToolUseContextFor(hook, "Bash", {
      command: `node -e "require('fs').writeFileSync('/tmp/probe','x')"`,
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
  });

  it("allows a read-only python3 -c invocation (no write indicator)", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPreToolUseContextFor(hook, "Bash", {
      command: `python3 -c "print(open('x').read())"`,
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
  });

  it("denies /tmpx/e as outside /tmp (segment-boundary, not prefix)", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPreToolUseContextFor(hook, "Bash", {
      command: `python3 -c "open('/tmpx/e','w')"`,
    });
    await invokeRun(hook, ctx);
    ctx.assertDeny();
  });

  it("denies a heredoc write to a workflow doc (wfDir is excluded from scratch)", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPreToolUseContextFor(hook, "Bash", {
      command: `python3 - <<'PY'\nopen('${TEST_WORKFLOW_DIR}/plan.md','a').write('x')\nPY`,
    });
    await invokeRun(hook, ctx);
    ctx.assertDeny();
  });

  it("does not flag a plain file-argument invocation (python3 script.py) as interpreter-write", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPreToolUseContextFor(hook, "Bash", {
      command: `python3 script.py`,
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
  });

  it("allows ruby/php interpreters unconditionally (intentionally out of the trigger set)", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPreToolUseContextFor(hook, "Bash", {
      command: `ruby -e "File.open('src/x.ts','w').write('h')"`,
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
  });

  it("still allows interpreter writes once the gate is open (approved plan)", async () => {
    const repo = createWorkflowRepo({
      planStatus: "complete",
      approvalStatus: "approved",
      review: { verdict: "pass" },
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const ctx = createPreToolUseContextFor(hook, "Bash", {
      command: `python3 -c "open('src/x.ts','w').write('h')"`,
    });
    await invokeRun(hook, ctx);
    ctx.assertSuccess({});
  });
});
