#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import documentWorkflowGuardHook from "../../implementations/document-workflow-guard.ts";
import {
  APPROVAL_QUESTION_TEXT,
  buildApprovalQuestions,
} from "../../lib/workflow-approval.ts";
import {
  computeDocumentHash,
  SPEC_NORMALIZERS,
} from "../../lib/document-hash.ts";
import {
  approvedWorkflowRepo,
  buildPlanContent,
  buildPlanNContent,
  computeWorkflowRepoPlanHash as computePlanHash,
  ConsoleCapture,
  createPreToolUseContextFor,
  createWorkflowRepo,
  EnvironmentHelper,
  invokeRun,
  pendingWorkflowRepo,
  recordApprovalsForTest,
  TEST_SESSION_ID,
  TEST_WORKFLOW_DIR,
  type ReviewMarkerOptions,
  type WorkflowRepoOptions,
} from "./test-helpers.ts";

function createSessionWorkflowRepo(
  sessionDir: string,
  options: WorkflowRepoOptions,
): string {
  const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-session-"));
  mkdirSync(join(repo, sessionDir), { recursive: true });
  writeFileSync(join(repo, sessionDir, "research.md"), "research");
  writeFileSync(join(repo, sessionDir, "plan.md"), buildPlanContent(options));
  recordApprovalsForTest(join(repo, sessionDir));
  return repo;
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

  it("classifies a workflow-cli invocation as a wfDir document write and allows it", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command:
        "workflow-cli stamp plan-1.md --verdict pass --reviewers logic-validator",
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
  });

  it("classifies a `bun .../cli/workflow.ts round <doc>` invocation the same way", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "bun /home/x/.claude/hooks/cli/workflow.ts round spec.md",
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

  it("enforces using the derived dir when DOCUMENT_WORKFLOW_DIR is not set", async () => {
    // env の配送に依存しなくなったことの回帰ガード。この it は元々
    // 「env 不在なら enforce しない」を assert しており、恒常的な無言 skip を
    // 緑で保証していた（spec K7）。
    const sessionId = "abcd1234-0000-0000-0000-000000000000";
    const cwd = createSessionWorkflowRepo(
      join(".tmp", "sessions", "abcd1234"),
      pendingWorkflowRepo(),
    );
    envHelper.set("CLAUDE_TEST_CWD", cwd);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);

    const context = createPreToolUseContextFor(
      hook,
      "Write",
      { file_path: join(cwd, "src", "a.ts"), content: "x" },
      { session_id: sessionId },
    );
    await invokeRun(hook, context);

    const reason =
      context.jsonCalls[0].hookSpecificOutput.permissionDecisionReason;
    // deny したことだけでなく、deny 文中の dir が導出値であることまで assert する。
    // さもないと `(unknown)` 劣化のような別要因の deny でも緑になる（spec K7）。
    ok(reason.includes(".tmp/sessions/abcd1234"));
  });

  it("says which check failed when the session id is malformed", async () => {
    const cwd = createSessionWorkflowRepo(
      join(".tmp", "sessions", "abcd1234"),
      pendingWorkflowRepo(),
    );
    envHelper.set("CLAUDE_TEST_CWD", cwd);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const context = createPreToolUseContextFor(
      hook,
      "Write",
      { file_path: join(cwd, "src", "a.ts"), content: "x" },
      { session_id: "" },
    );
    await invokeRun(hook, context);
    const message = context.jsonCalls[0].systemMessage;
    ok(message.includes("session id"));
    // deny ではないこと（fail-open のまま）
    strictEqual(context.jsonCalls[0].hookSpecificOutput, undefined);
  });

  it("names the containment check, not a cause, when the sessions root is redirected", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "guard-")));
    mkdirSync(join(cwd, "docs"), { recursive: true });
    mkdirSync(join(cwd, ".tmp"), { recursive: true });
    symlinkSync(join(cwd, "docs"), join(cwd, ".tmp", "sessions"));
    envHelper.set("CLAUDE_TEST_CWD", cwd);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const context = createPreToolUseContextFor(
      hook,
      "Write",
      { file_path: join(cwd, "src", "a.ts"), content: "x" },
      { session_id: "abcd1234-0000-0000-0000-000000000000" },
    );
    await invokeRun(hook, context);
    const message = context.jsonCalls[0].systemMessage;
    ok(message.includes(".tmp/sessions"));
    ok(!message.includes("session id"));
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

  describe("test-helpers session id override", () => {
    it("uses the default session id when no override is given", () => {
      const ctx = createPreToolUseContextFor(hook, "Write", {
        file_path: "/x",
        content: "",
      });
      strictEqual(ctx.input.session_id, TEST_SESSION_ID);
    });

    it("uses the override when one is given", () => {
      const ctx = createPreToolUseContextFor(
        hook,
        "Write",
        { file_path: "/x", content: "" },
        { session_id: "abcd1234-override" },
      );
      strictEqual(ctx.input.session_id, "abcd1234-override");
    });
  });

  describe("guard exception visibility and empty-target handling", () => {
    // 内部例外を自然入力で誘発するテストは置かない。resolveWorkflowDir /
    // workflow-fs / guard の 6 ヘルパがいずれも throw しないため、到達経路が無い。
    // K10 の catch は「将来 throw する変更が入ったときに無言にしない」ための保険であり、
    // 現時点で検証できるのはコードの存在までである。人工的な throw 注入は、
    // テストの意図（本物の障害で catch が動く）を満たさないので採らない。
    it.skip("reports an internal exception through systemMessage and still allows", async () => {
      // fail-open は cc-hooks-ts 元来の挙動であり本変更では変えない。
      // 変えるのは「無言で通る」ことだけ（spec K10）。
      const cwd = createSessionWorkflowRepo(
        join(".tmp", "sessions", "abcd1234"),
        pendingWorkflowRepo(),
      );
      envHelper.set("CLAUDE_TEST_CWD", cwd);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      // wfDir を辿れない状態を作って内部例外を誘発する。誘発手段は実装時に
      // 既存ヘルパの構造を読んで決める（chmod ではなく、読めないパスを仕込む形にする）。
      const context = createPreToolUseContextFor(
        hook,
        "Write",
        { file_path: join(cwd, "src", "a.ts"), content: "x" },
        { session_id: "abcd1234-0000-0000-0000-000000000000" },
      );
      await invokeRun(hook, context);
      const message = context.jsonCalls[0].systemMessage;
      ok(message.includes("document-workflow-guard"));
      // deny ではないこと（fail-open のまま）
      strictEqual(context.jsonCalls[0].hookSpecificOutput, undefined);
    });

    it("denies a write-like Bash command whose targets could not be extracted", async () => {
      const cwd = createSessionWorkflowRepo(
        join(".tmp", "sessions", "abcd1234"),
        pendingWorkflowRepo(),
      );
      envHelper.set("CLAUDE_TEST_CWD", cwd);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      const context = createPreToolUseContextFor(
        hook,
        "Bash",
        // write-like と判定されるが対象パスを 1 つも取り出せない形。実測で到達する
        // のは対象位置に空文字クォート引数がある場合だけ（touch "" / rm "" /
        // mkdir -p "" / cp src.txt "" / mv a ""）。`tee` 単体は files.length > 0 を
        // 満たさず isWriteLike にすらならないので使えない。
        { command: 'touch ""' },
        { session_id: "abcd1234-0000-0000-0000-000000000000" },
      );
      await invokeRun(hook, context);
      const reason =
        context.jsonCalls[0].hookSpecificOutput.permissionDecisionReason;
      ok(reason.includes("could not determine"));
    });

    it("still honours warn-only for a command whose targets could not be extracted", async () => {
      // この修正の回帰ガード。空チェックを if (researched) の内側に置くと
      // ここから return して warnOnly の脱出路を飛び越える。直した箇所こそ、
      // 次に壊れたときに気づけない箇所なので固定する。
      const cwd = createSessionWorkflowRepo(
        join(".tmp", "sessions", "abcd1234"),
        pendingWorkflowRepo(),
      );
      envHelper.set("CLAUDE_TEST_CWD", cwd);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      envHelper.set("DOCUMENT_WORKFLOW_WARN_ONLY", "1");
      const context = createPreToolUseContextFor(
        hook,
        "Bash",
        { command: 'touch ""' },
        { session_id: "abcd1234-0000-0000-0000-000000000000" },
      );
      await invokeRun(hook, context);
      // deny せず allow に降格し、would-block が stderr に出ること
      strictEqual(context.jsonCalls.length, 0);
      ok(consoleCapture.errors.some((e) => e.includes("would-block")));
    });
  });

  describe("deny hint for throwaway writes", () => {
    // session 115e2d54 では、プロジェクト外にリテラルパスで書けば通るのに、
    // deny 文が承認手順しか示さなかったため 3 回続けて止まった。
    // hint は判定を変えず、どの deny にも無条件で付く。
    function denyReasonOf(
      context: ReturnType<typeof createPreToolUseContextFor>,
    ): string {
      return context.jsonCalls[0].hookSpecificOutput.permissionDecisionReason;
    }

    it("appends the hint to a Write deny after the existing diagnosis", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "src/a.ts",
        content: "x",
      });
      await invokeRun(hook, context);
      context.assertDeny();
      const reason = denyReasonOf(context);
      ok(reason.includes("Plan Status"));
      ok(reason.includes("hint:"));
      ok(reason.includes("mktemp -d"));
    });

    it("appends the hint when the Bash target hides behind a shell variable", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Bash", {
        command: 'P=$(mktemp -d); mkdir -p "$P/src"',
      });
      await invokeRun(hook, context);
      context.assertDeny();
      ok(denyReasonOf(context).includes("hint:"));
    });

    it("appends the hint when the Bash target is relative to a cd", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "cd .tmp && mkdir -p probe2/src",
      });
      await invokeRun(hook, context);
      context.assertDeny();
      ok(denyReasonOf(context).includes("hint:"));
    });

    it("appends the hint to the empty-target deny without replacing it", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Bash", {
        command: 'touch ""',
      });
      await invokeRun(hook, context);
      context.assertDeny();
      const reason = denyReasonOf(context);
      // 空 target の判定は理由文の同一性比較で行われるので、hint を先に
      // 連結すると診断 deny に化ける。その回帰をここで捕まえる。
      ok(reason.includes("could not determine"));
      ok(reason.includes("hint:"));
    });

    it("still allows a literal write outside the project", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "mkdir -p /var/folders/xx/probe/src",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("still allows a workflow note inside the workflow dir", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: join(TEST_WORKFLOW_DIR, "notes.md"),
        content: "x",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("still denies a write under the project .tmp", async () => {
      // .tmp/ はプロジェクト内なので免除しない（免除すると .tmp/sessions を
      // 守りきれないことがレビューで分かっている）。
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: ".tmp/probe/a.txt",
        content: "x",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("does not add the hint to the warn-only would-block line", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      envHelper.set("DOCUMENT_WORKFLOW_WARN_ONLY", "1");
      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "src/a.ts",
        content: "x",
      });
      await invokeRun(hook, context);
      strictEqual(context.jsonCalls.length, 0);
      const wouldBlock = consoleCapture.errors.filter((e) =>
        e.includes("would-block"),
      );
      ok(wouldBlock.length > 0);
      ok(wouldBlock.every((e) => !e.includes("hint:")));
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
    recordApprovalsForTest(join(repo, TEST_WORKFLOW_DIR));
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

  it("warns and audit-logs Write when target file is not in any plan-N.md Files section (implementation-phase relaxation)", async () => {
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
    // Implementation phase active (spec + plan-1.md fully approved + valid).
    // Off-plan write is allowed with warn + audit log instead of deny.
    context.assertSuccess({});
    const logPath = join(repo, TEST_WORKFLOW_DIR, "off-plan-writes.log");
    ok(
      readFileSync(logPath, "utf-8").includes('path="src/b.ts"'),
      "off-plan-writes.log should record the off-plan Write target",
    );
  });

  it("blocks Write to off-plan target when implementation phase is not active (no plan-N.md approved)", async () => {
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
      file_path: "src/b.ts", // not listed; and no plan is fully approved yet
      content: "const b = 2;",
    });

    await invokeRun(hook, context);
    // Implementation phase NOT active → off-plan target still denies (strict during design phase).
    context.assertDeny();
  });

  it("warns and audit-logs Bash off-plan redirect target under implementation-phase relaxation", async () => {
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

    const context = createPreToolUseContextFor(hook, "Bash", {
      command: "echo 'data' > src/c.ts", // not in plan-1.md Files
    });

    await invokeRun(hook, context);
    context.assertSuccess({});
    const logPath = join(repo, TEST_WORKFLOW_DIR, "off-plan-writes.log");
    ok(
      readFileSync(logPath, "utf-8").includes('path="src/c.ts"'),
      "off-plan-writes.log should record Bash off-plan redirect target",
    );
  });

  it("still denies off-plan target when owning plan has hash drift (deny-other, not no-plan-owner)", async () => {
    const { repo } = createTwoLayerRepo({
      spec: approvedWorkflowRepo(),
      plans: [
        {
          filename: "plan-1.md",
          options: {
            planStatus: "complete",
            approvalStatus: "approved",
            review: { verdict: "pass", hashOverride: "deadbeef" },
          },
          filesSection: ["src/a.ts"],
        },
      ],
    });
    envHelper.set("CLAUDE_TEST_CWD", repo);

    // src/a.ts IS owned by plan-1.md, but plan-1.md hash is drifted.
    // This is "deny-other", not "no-plan-owner", so relaxation must NOT apply.
    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: "src/a.ts",
      content: "const a = 1;",
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

  it("matches a Files entry against the linked worktree the target lives in (spec K2)", async () => {
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
    mkdirSync(join(repo, ".git", "worktrees", "b"), { recursive: true });
    const worktree = join(repo, ".git", "worktree", "b");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${join(repo, ".git", "worktrees", "b")}\n`,
    );
    envHelper.set("CLAUDE_TEST_CWD", repo);

    const context = createPreToolUseContextFor(hook, "Write", {
      file_path: join(worktree, "src", "a.ts"),
      content: "x",
    });
    await invokeRun(hook, context);
    context.assertSuccess({});
    ok(
      !existsSync(join(repo, TEST_WORKFLOW_DIR, "off-plan-writes.log")),
      "the worktree target was treated as off-plan",
    );
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

  describe("isDocumentPath: ad-hoc markdown in the workflow directory", () => {
    it("allows writing a handoff note before plan approval", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: join(repo, TEST_WORKFLOW_DIR, "NEXT-SESSION.md"),
        content: "## Handoff\n\n- resume from task 3\n",
      });

      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("allows a heredoc Bash write to a handoff note before plan approval", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);

      const context = createPreToolUseContextFor(hook, "Bash", {
        command: `cat > ${join(repo, TEST_WORKFLOW_DIR, "NEXT-SESSION.md")} <<'EOF'\nhandoff\nEOF`,
      });

      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("does not read write targets in a data heredoc body before plan approval (F3b)", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Bash", {
        command: `cat > ${join(repo, TEST_WORKFLOW_DIR, "NEXT-SESSION.md")} <<'EOF'\nthen run: echo x > src/a.ts\nEOF`,
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("still denies the write target of a data heredoc before plan approval (F3b)", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Bash", {
        command: `cat > src/a.ts <<'EOF'\nexport const x = 1;\nEOF`,
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("still checks an interpreter heredoc body before plan approval (F3b)", async () => {
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Bash", {
        command: `python3 - <<'EOF'\nopen('src/a.ts', 'w').write('x')\nEOF`,
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("denies a Write for an approved plan without research.md and names the missing file", async () => {
      const repo = createWorkflowRepo(approvedWorkflowRepo());
      unlinkSync(join(repo, TEST_WORKFLOW_DIR, "research.md"));
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "src/a.ts",
        content: "const a = 1;",
      });
      await invokeRun(hook, context);
      context.assertDeny();
      const reason =
        context.jsonCalls[0].hookSpecificOutput.permissionDecisionReason;
      ok(/✗ research\.md/.test(reason), reason);
      ok(!/satisfied/.test(reason), reason);
    });

    it("checks an interpreter heredoc body when only research.md is missing", async () => {
      const repo = createWorkflowRepo(approvedWorkflowRepo());
      unlinkSync(join(repo, TEST_WORKFLOW_DIR, "research.md"));
      envHelper.set("CLAUDE_TEST_CWD", repo);
      const context = createPreToolUseContextFor(hook, "Bash", {
        command: `python3 - <<'EOF'\nopen('src/a.ts', 'w').write('x')\nEOF`,
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("denies writes to hook-managed non-markdown state in the workflow directory", async () => {
      // plan-review.cache.json gates review skipping; a tool-driven write would
      // let a stale verdict be forged, so the markdown widening must not reach it.
      const repo = createWorkflowRepo(pendingWorkflowRepo());
      envHelper.set("CLAUDE_TEST_CWD", repo);

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: join(repo, TEST_WORKFLOW_DIR, "plan-review.cache.json"),
        content: '{"planHash":"forged"}',
      });

      await invokeRun(hook, context);
      context.assertDeny();
    });
  });
});

describe("document-workflow-guard.ts approval writes (spec K9)", () => {
  const envHelper = new EnvironmentHelper();
  const hook = documentWorkflowGuardHook;

  afterEach(() => {
    envHelper.restore();
  });

  function repoWith(options: WorkflowRepoOptions): {
    repo: string;
    wf: string;
  } {
    const repo = realpathSync(createWorkflowRepo(options));
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    envHelper.set("CLAUDE_TEST_CWD", repo);
    return { repo, wf: join(repo, TEST_WORKFLOW_DIR) };
  }

  async function run(
    tool: "Write" | "Edit" | "MultiEdit",
    input: Record<string, unknown>,
  ) {
    const ctx = createPreToolUseContextFor(hook, tool, input);
    await invokeRun(hook, ctx);
    return ctx;
  }

  it("denies an Edit or MultiEdit that turns the Approval line to approved", async () => {
    const { wf } = repoWith(pendingWorkflowRepo());
    (
      await run("Edit", {
        file_path: join(wf, "plan.md"),
        old_string: "- Approval Status: pending",
        new_string: "- Approval Status: approved",
      })
    ).assertDeny();
    (
      await run("MultiEdit", {
        file_path: join(wf, "plan.md"),
        edits: [
          {
            old_string: "- Approval Status: pending",
            new_string: "- Approval Status: approved",
          },
        ],
      })
    ).assertDeny();
  });

  it("denies a Write that creates or rewrites a document as approved, even without the hyphen", async () => {
    const { wf } = repoWith(pendingWorkflowRepo());
    (
      await run("Write", {
        file_path: join(wf, "plan-9.md"),
        content: "- Approval Status: approved\n",
      })
    ).assertDeny();
    (
      await run("Write", {
        file_path: join(wf, "plan.md"),
        content: "Approval Status: approved\n",
      })
    ).assertDeny();
  });

  it("allows revoking and rewriting an approved document without changing the value", async () => {
    const { wf } = repoWith(approvedWorkflowRepo());
    const approved = readFileSync(join(wf, "plan.md"), "utf-8");
    (
      await run("Write", {
        file_path: join(wf, "plan.md"),
        content: `${approved}\n`,
      })
    ).assertSuccess({});
    (
      await run("Edit", {
        file_path: join(wf, "plan.md"),
        old_string: "- Approval Status: approved",
        new_string: "- Approval Status: pending",
      })
    ).assertSuccess({});
  });

  it("denies tool writes to this or another session's approvals.log, in any letter case", async () => {
    const { repo, wf } = repoWith(approvedWorkflowRepo());
    for (const path of [
      join(wf, "approvals.log"),
      join(wf, "APPROVALS.LOG"),
      join(repo, ".tmp", "sessions", "otherses", "approvals.log"),
      join(repo, ".tmp", "sessions", "a", "b", "approvals.log"),
      join(repo, ".TMP", "SESSIONS", "otherses", "approvals.log"),
    ]) {
      (await run("Write", { file_path: path, content: "{}\n" })).assertDeny();
    }
  });

  it("judges a document path written with different letter case the same way", async () => {
    // Approved workflow: an off-plan write is only warned about, so K9 is the
    // only thing that can deny. Two approved lines exceed the existing one
    // whether the upper-case path aliases plan.md (macOS) or is new (Linux).
    const { repo } = repoWith(approvedWorkflowRepo());
    const upper = join(repo, TEST_WORKFLOW_DIR.toUpperCase(), "PLAN.MD");
    (
      await run("Write", {
        file_path: upper,
        content: "- Approval Status: approved\n- Approval Status: approved\n",
      })
    ).assertDeny();
  });

  it("refuses an Edit whose old_string is not found but whose new_string adds approval", async () => {
    const { wf } = repoWith(pendingWorkflowRepo());
    (
      await run("Edit", {
        file_path: join(wf, "plan.md"),
        old_string: "- Approval Status: “pending”",
        new_string: "- Approval Status: approved",
      })
    ).assertDeny();
  });
});

describe("document-workflow-guard.ts scheduled approval prompts (issue J)", () => {
  const envHelper = new EnvironmentHelper();
  const hook = documentWorkflowGuardHook;

  afterEach(() => {
    envHelper.restore();
  });

  function repoWith(options: WorkflowRepoOptions): void {
    const repo = realpathSync(createWorkflowRepo(options));
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    envHelper.set("CLAUDE_TEST_CWD", repo);
  }

  async function schedule(
    tool: "CronCreate" | "ScheduleWakeup",
    input: unknown,
    overrides: { session_id?: string } = {},
  ) {
    // The tool schemas of cc-hooks-ts do not list the scheduling tools.
    const ctx = createPreToolUseContextFor(
      hook,
      tool as never,
      input,
      overrides,
    );
    await invokeRun(hook, ctx);
    return ctx;
  }

  it("denies a prompt that is only an approval, with a reason that points to ask-approval and approve", async () => {
    repoWith(pendingWorkflowRepo());
    for (const [tool, input] of [
      [
        "CronCreate",
        { cron: "42 18 2 10 *", prompt: "承認", recurring: false },
      ],
      ["CronCreate", { prompt: "承認 plan-99.md" }],
      ["ScheduleWakeup", { delaySeconds: 60, prompt: "  Approve!  " }],
      ["ScheduleWakeup", { delaySeconds: 60, prompt: "承認　spec.md。" }],
      ["CronCreate", { prompt: "承認\n" }],
      ["CronCreate", { prompt: "承認！" }],
      ["CronCreate", { prompt: "﻿承認" }],
      ["CronCreate", { prompt: " 承認 " }],
      // The recorder would not record these as typed, but a normalizing
      // front-end could turn them into an approval at firing time.
      ["CronCreate", { prompt: "承​認" }],
      ["CronCreate", { prompt: "ＡＰＰＲＯＶＥ" }],
    ] as const) {
      const ctx = await schedule(tool, input);
      ctx.assertDeny();
      const reason: string =
        ctx.jsonCalls[0].hookSpecificOutput.permissionDecisionReason;
      ok(reason.includes("ask-approval"));
      ok(reason.includes("approve"));
    }
  });

  it("allows prompts that are not an approval, a stop, and inputs without a string prompt", async () => {
    repoWith(pendingWorkflowRepo());
    for (const [tool, input] of [
      ["ScheduleWakeup", { prompt: "承認します、ただし…" }],
      ["CronCreate", { prompt: "J-probe" }],
      ["ScheduleWakeup", { stop: true }],
      ["CronCreate", { prompt: 123 }],
      ["CronCreate", { prompt: "承認\nfoo" }],
      ["CronCreate", null],
    ] as const) {
      (await schedule(tool, input)).assertSuccess({});
    }
  });

  it("denies when reading the prompt throws (fail-closed)", async () => {
    repoWith(pendingWorkflowRepo());
    const input = {
      get prompt(): string {
        throw new Error("boom");
      },
    };
    (await schedule("CronCreate", input)).assertDeny();
  });

  it("decides on the prompt alone, even when no workflow dir can be resolved", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    (
      await schedule(
        "CronCreate",
        { prompt: "承認" },
        { session_id: "../not-a-session" },
      )
    ).assertDeny();
  });
});

describe("document-workflow-guard.ts AskUserQuestion (spec K4)", () => {
  const envHelper = new EnvironmentHelper();
  const hook = documentWorkflowGuardHook;
  const H = "a".repeat(64);

  afterEach(() => {
    envHelper.restore();
  });

  function repoWith(options: WorkflowRepoOptions): void {
    const repo = realpathSync(createWorkflowRepo(options));
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
    envHelper.set("CLAUDE_TEST_CWD", repo);
  }

  async function ask(input: unknown, overrides: { session_id?: string } = {}) {
    // The tool schemas of cc-hooks-ts may not list AskUserQuestion's input shape.
    const ctx = createPreToolUseContextFor(
      hook,
      "AskUserQuestion" as never,
      input,
      overrides,
    );
    await invokeRun(hook, ctx);
    return ctx;
  }

  const approvalQuestions = () =>
    buildApprovalQuestions([{ name: "spec.md", hash: H }]);

  const generalQuestions = () => [
    {
      question: "進めてよいか",
      header: "確認",
      multiSelect: false,
      options: [
        { label: "はい", description: "" },
        { label: "いいえ", description: "" },
      ],
    },
  ];

  it("denies an approval question that already carries answers, naming the field", async () => {
    repoWith(pendingWorkflowRepo());
    const ctx = await ask({
      questions: approvalQuestions(),
      answers: { [APPROVAL_QUESTION_TEXT]: "spec.md" },
    });
    ctx.assertDeny();
    const reason: string =
      ctx.jsonCalls[0].hookSpecificOutput.permissionDecisionReason;
    ok(reason.includes("answers"));
    ok(reason.includes("ask-approval"));
  });

  it("denies when answers or annotations is present in any form", async () => {
    repoWith(pendingWorkflowRepo());
    for (const extra of [
      { answers: {} },
      { answers: "" },
      { answers: null },
      { annotations: [] },
      { annotations: { x: { notes: "n" } } },
    ]) {
      (await ask({ questions: approvalQuestions(), ...extra })).assertDeny();
    }
  });

  it("allows an approval question with neither answers nor annotations", async () => {
    repoWith(pendingWorkflowRepo());
    (await ask({ questions: approvalQuestions() })).assertSuccess({});
    (
      await ask({ questions: approvalQuestions(), answers: undefined })
    ).assertSuccess({});
  });

  it("looks at every question, not only the first", async () => {
    repoWith(pendingWorkflowRepo());
    (
      await ask({
        questions: [...generalQuestions(), ...approvalQuestions()],
        answers: { x: "y" },
      })
    ).assertDeny();
  });

  it("allows a general question that carries answers", async () => {
    repoWith(pendingWorkflowRepo());
    (
      await ask({
        questions: generalQuestions(),
        answers: { 進めてよいか: "はい" },
      })
    ).assertSuccess({});
  });

  it("allows an input that has no questions", async () => {
    repoWith(pendingWorkflowRepo());
    (await ask("x")).assertSuccess({});
    (await ask(null)).assertSuccess({});
  });

  it("denies when reading questions throws and answers is present, warns when it is not", async () => {
    repoWith(pendingWorkflowRepo());
    const throwing = (extra: Record<string, unknown>) => {
      const input = { ...extra };
      Object.defineProperty(input, "questions", {
        enumerable: true,
        get() {
          throw new Error("boom");
        },
      });
      return input;
    };
    (await ask(throwing({ answers: { x: "y" } }))).assertDeny();
    const ctx = await ask(throwing({}));
    strictEqual(ctx.jsonCalls.length, 1);
    ok(
      String(ctx.jsonCalls[0].systemMessage ?? "").includes(
        "document-workflow-guard",
      ),
    );
    ok(!JSON.stringify(ctx.jsonCalls[0]).includes('"deny"'));
  });

  it("denies when both questions and answers throw on read", async () => {
    repoWith(pendingWorkflowRepo());
    const input = {};
    for (const key of ["questions", "answers"]) {
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          throw new Error("boom");
        },
      });
    }
    (await ask(input)).assertDeny();
  });

  it("decides before the workflow dir is resolved", async () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    (
      await ask(
        {
          questions: approvalQuestions(),
          answers: { [APPROVAL_QUESTION_TEXT]: "spec.md" },
        },
        { session_id: "../bad" },
      )
    ).assertDeny();
  });
});
