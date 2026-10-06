#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isWorkflowActive } from "../../lib/workflow-gate.ts";
import sessionHook, {
  auditAnswerRecorderWiring,
  auditGuardWiring,
  extractGuardMatcher,
  extractHookMatcher,
  isWorkflowArmedForTesting,
} from "../../implementations/session.ts";
import { matcherCoversGuardedTools } from "../../lib/guarded-tools.ts";
import { encodeSessionDirName } from "../../lib/project-root.ts";
import { resolveWorkflowPaths } from "../../lib/workflow-paths.ts";
import {
  createSessionStartContext,
  EnvironmentHelper,
  invokeRun,
} from "../support/test-helpers.ts";

describe("session.ts hook behavior", () => {
  let testDir: string;
  let logDir: string;
  let logFile: string;

  beforeEach(() => {
    // Create test directory
    // Date.now() はプロセス間で一意でない。並行実行時に同名ディレクトリを共有し、
    // 片方の afterEach の rmSync が他方の env-file を実行中に削除して ENOENT を起こす
    // （実測: 4 プロセス並行で 32/32 失敗）。mkdtemp は OS が一意性を保証する。
    testDir = mkdtempSync(join(tmpdir(), "session-test-"));
    logDir = join(testDir, ".config", "claude-companion", "logs");
    logFile = join(logDir, "hooks.jsonl");
    mkdirSync(logDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("log entry structure", () => {
    it("should create valid JSON log entries", () => {
      // Simulate what the hook would write
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "SessionStart",
        session_id: "test-session-123",
        user: process.env.USER || "unknown",
        cwd: process.cwd(),
      };

      const logLine = `${JSON.stringify(logEntry)}\n`;

      // Write to test file
      appendFileSync(logFile, logLine);

      // Read and verify
      const content = readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");
      strictEqual(lines.length, 1, "Should have one log line");

      const firstLine = lines[0];
      ok(firstLine, "Should have first line");
      const parsed = JSON.parse(firstLine);
      strictEqual(parsed.event, "SessionStart");
      strictEqual(parsed.session_id, "test-session-123");
      ok(parsed.timestamp, "Should have timestamp");
      ok(parsed.cwd, "Should have cwd");
      ok(parsed.user, "Should have user");
    });

    it("should handle multiple log entries", () => {
      // Write multiple entries
      for (let i = 0; i < 3; i++) {
        const logEntry = {
          timestamp: new Date().toISOString(),
          event: "SessionStart",
          session_id: `session-${i}`,
          user: "testuser",
          cwd: "/test/dir",
        };
        appendFileSync(logFile, `${JSON.stringify(logEntry)}\n`);
      }

      // Read and verify
      const content = readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");
      strictEqual(lines.length, 3, "Should have three log lines");

      // Each line should be valid JSON
      lines.forEach((line, index) => {
        const parsed = JSON.parse(line);
        strictEqual(parsed.session_id, `session-${index}`);
      });
    });

    it("should escape special characters in log entries", () => {
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "SessionStart",
        session_id: "test\nwith\nnewlines",
        user: 'user"with"quotes',
        cwd: "/path/with\\backslash",
      };

      const logLine = `${JSON.stringify(logEntry)}\n`;
      appendFileSync(logFile, logLine);

      // Read and parse back
      const content = readFileSync(logFile, "utf-8");
      const parsed = JSON.parse(content.trim());

      // JSON.stringify should have properly escaped everything
      strictEqual(parsed.session_id, "test\nwith\nnewlines");
      strictEqual(parsed.user, 'user"with"quotes');
      strictEqual(parsed.cwd, "/path/with\\backslash");
    });
  });

  describe("directory creation", () => {
    it("should handle nested directory creation", () => {
      const nestedDir = join(testDir, "deep", "nested", "path");
      mkdirSync(nestedDir, { recursive: true });

      ok(existsSync(nestedDir), "Nested directory should exist");
    });

    it("should not throw if directory already exists", () => {
      // Create directory
      mkdirSync(logDir, { recursive: true });

      // Try to create again - should not throw
      mkdirSync(logDir, { recursive: true });

      ok(existsSync(logDir), "Directory should still exist");
    });
  });

  describe("error scenarios", () => {
    it("should handle append to non-existent directory gracefully", () => {
      const nonExistentPath = join(
        testDir,
        "non",
        "existent",
        "path",
        "file.log",
      );

      try {
        appendFileSync(nonExistentPath, "test");
        ok(false, "Should have thrown error");
      } catch (error: any) {
        ok(error.code === "ENOENT", "Should get ENOENT error");
      }
    });

    it("should handle invalid JSON in log file", () => {
      // Write invalid JSON
      appendFileSync(logFile, "not valid json\n");

      const content = readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");

      try {
        const firstLine = lines[0];
        ok(firstLine, "Should have first line");
        JSON.parse(firstLine);
        ok(false, "Should have thrown error");
      } catch (error) {
        ok(error instanceof SyntaxError, "Should get JSON parse error");
      }
    });
  });

  describe("user-facing output channel", () => {
    const envHelper = new EnvironmentHelper();
    let envFilePath: string;

    beforeEach(() => {
      envFilePath = join(testDir, "env-file");
      appendFileSync(envFilePath, "");
      envHelper.set("CLAUDE_ENV_FILE", envFilePath);
      envHelper.set("CLAUDE_CODE_TASK_LIST_ID", undefined);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    });

    afterEach(() => {
      envHelper.restore();
    });

    it("T1: emits output via the json channel", async () => {
      const ctx = createSessionStartContext("cli");
      ctx.input.session_id = "abcdef1234567890";

      await invokeRun(sessionHook, ctx);

      strictEqual(ctx.jsonCalls.length, 1, "json() should be called once");
      strictEqual(ctx.successCalls.length, 0, "success() should not be called");
      strictEqual(
        typeof ctx.jsonCalls[0]?.systemMessage,
        "string",
        "systemMessage should be a string",
      );
      ok(
        ctx.jsonCalls[0].systemMessage.startsWith(
          "🚀 Claude Code session started. Ready for development!",
        ),
        "systemMessage should start with the session start message",
      );
    });

    it("T2: payload key set is systemMessage only (allowlist)", async () => {
      const ctx = createSessionStartContext("cli");
      ctx.input.session_id = "abcdef1234567890";

      await invokeRun(sessionHook, ctx);

      deepStrictEqual(Object.keys(ctx.jsonCalls[0]).sort(), ["systemMessage"]);
    });

    it("T4: task list warning appears in systemMessage when shared", async () => {
      envHelper.set("CLAUDE_CODE_TASK_LIST_ID", "shared-list-456");
      const ctx = createSessionStartContext("cli");
      ctx.input.session_id = "abcdef1234567890";

      await invokeRun(sessionHook, ctx);

      const systemMessage = ctx.jsonCalls[0]?.systemMessage ?? "";
      ok(
        systemMessage.includes("CLAUDE_CODE_TASK_LIST_ID"),
        "systemMessage should include the env var name",
      );
      ok(
        systemMessage.includes("shared-list-456"),
        "systemMessage should include the task list id",
      );
      ok(
        systemMessage.includes("unset CLAUDE_CODE_TASK_LIST_ID"),
        "systemMessage should include the detach instruction",
      );
    });

    it("T4: task list warning absent when CLAUDE_CODE_TASK_LIST_ID is unset", async () => {
      envHelper.set("CLAUDE_CODE_TASK_LIST_ID", undefined);
      const ctx = createSessionStartContext("cli");
      ctx.input.session_id = "abcdef1234567890";

      await invokeRun(sessionHook, ctx);

      const systemMessage = ctx.jsonCalls[0]?.systemMessage ?? "";
      ok(
        !systemMessage.includes("⚠️ CLAUDE_CODE_TASK_LIST_ID is set:"),
        "systemMessage should not include the task list warning",
      );
    });
  });

  describe("workflow dir resolution", () => {
    const envHelper = new EnvironmentHelper();
    let envFilePath: string;

    beforeEach(() => {
      envFilePath = join(testDir, "env-file");
      // Ensure file exists so appendFileSync can write
      appendFileSync(envFilePath, "");
      envHelper.set("CLAUDE_ENV_FILE", envFilePath);
      envHelper.set("CLAUDE_CODE_TASK_LIST_ID", undefined);
    });

    afterEach(() => {
      envHelper.restore();
    });

    it("derives the workflow dir from the session id and exports neither the dir nor the session id", async () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      const ctx = createSessionStartContext("cli");
      ctx.input.session_id = "abcdef1234567890";

      await invokeRun(sessionHook, ctx);

      const content = readFileSync(envFilePath, "utf-8");
      ok(
        !content.includes("DOCUMENT_WORKFLOW_DIR"),
        `unexpected export:\n${content}`,
      );
      ok(
        !content.includes("CLAUDE_SESSION_ID"),
        `unexpected export:\n${content}`,
      );
      const systemMessage = ctx.jsonCalls[0]?.systemMessage ?? "";
      ok(systemMessage.includes(".tmp/sessions/abcdef12/"));
      ok(!systemMessage.includes("(user-specified)"));
    });

    it("shows a startup pin as user-specified without re-exporting it", async () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/4dc42491");
      const ctx = createSessionStartContext("cli");
      ctx.input.session_id = "different-session-id";

      await invokeRun(sessionHook, ctx);

      ok(!readFileSync(envFilePath, "utf-8").includes("DOCUMENT_WORKFLOW_DIR"));
      const systemMessage = ctx.jsonCalls[0]?.systemMessage ?? "";
      ok(systemMessage.includes(".tmp/sessions/4dc42491/ (user-specified)"));
    });

    it("falls back to the session id when DOCUMENT_WORKFLOW_DIR is empty", async () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", "");
      const ctx = createSessionStartContext("cli");
      ctx.input.session_id = "fallback1234abcd";

      await invokeRun(sessionHook, ctx);

      ok(
        (ctx.jsonCalls[0]?.systemMessage ?? "").includes(
          ".tmp/sessions/fallback/",
        ),
      );
    });

    it("exports CLAUDE_PROJECT_DIR single-quoted so sourcing returns it verbatim", async () => {
      const weird = `/tmp/proj it's "q" $(touch x) \`id\``;
      envHelper.set("CLAUDE_PROJECT_DIR", weird);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      const ctx = createSessionStartContext("cli");
      ctx.input.session_id = "abcdef1234567890";
      await invokeRun(sessionHook, ctx);
      // A minimal env keeps the user's BASH_ENV / exported functions out of the
      // child shell, so only the env file decides what $CLAUDE_PROJECT_DIR is.
      const result = spawnSync(
        "bash",
        ["-c", `. "$1"; printf %s "$CLAUDE_PROJECT_DIR"`, "_", envFilePath],
        { encoding: "utf-8", env: { PATH: process.env.PATH ?? "" } },
      );
      strictEqual(result.status, 0);
      strictEqual(result.stdout, weird);
    });

    it("quotes the transcript path export the same way", async () => {
      const ctx = createSessionStartContext("cli", {
        transcript_path: `/tmp/t it's $(id).jsonl`,
      });
      ctx.input.session_id = "abcdef1234567890";
      await invokeRun(sessionHook, ctx);
      const result = spawnSync(
        "bash",
        ["-c", `. "$1"; printf %s "$CLAUDE_TRANSCRIPT_PATH"`, "_", envFilePath],
        { encoding: "utf-8", env: { PATH: process.env.PATH ?? "" } },
      );
      strictEqual(result.status, 0);
      strictEqual(result.stdout, `/tmp/t it's $(id).jsonl`);
    });
  });
});

describe("startup summary", () => {
  const envHelper = new EnvironmentHelper();

  beforeEach(() => {
    // Baseline reset. Individual `it`s below set only what they need to
    // exercise; without this, a value left behind by an earlier test (or the
    // ambient shell this test run happens to inherit) would leak in, and the
    // two cases below that differ only in whether CLAUDE_ENV_FILE is set /
    // broken are exactly the ones that would go undetected by that leak.
    envHelper.set("CLAUDE_ENV_FILE", undefined);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    envHelper.set("DOCUMENT_WORKFLOW_WARN_ONLY", undefined);
    envHelper.set("CLAUDE_CODE_TASK_LIST_ID", undefined);
  });

  afterEach(() => {
    envHelper.restore();
  });

  it("shows the resolution even when CLAUDE_ENV_FILE is unset", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sess-")));
    mkdirSync(join(cwd, ".tmp", "sessions", "abcd1234"), { recursive: true });
    envHelper.set("CLAUDE_ENV_FILE", undefined);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const context = createSessionStartContext("startup", {
        session_id: "abcd1234-0000-0000-0000-000000000000",
      });
      await invokeRun(sessionHook, context);
      const message = context.jsonCalls[0].systemMessage;
      ok(message.includes(join(cwd, ".tmp", "sessions", "abcd1234")));
      ok(message.includes("derived"));
    } finally {
      process.chdir(previous);
    }
  });

  it("names the file it audited and flags a matcher that misses a guarded tool", () => {
    strictEqual(
      extractGuardMatcher({
        hooks: {
          PreToolUse: [
            {
              matcher: "Write|Edit|NotebookEdit|Bash",
              hooks: [
                {
                  command:
                    "bun ~/.claude/hooks/implementations/document-workflow-guard.ts",
                },
              ],
            },
          ],
        },
      }),
      "Write|Edit|NotebookEdit|Bash",
    );
    deepStrictEqual(
      matcherCoversGuardedTools("Write|Edit|NotebookEdit|Bash").missing,
      ["AskUserQuestion", "CronCreate", "MultiEdit", "ScheduleWakeup"],
    );
  });

  it("returns null when no entry references the guard", () => {
    strictEqual(extractGuardMatcher({ hooks: { PreToolUse: [] } }), null);
    strictEqual(extractGuardMatcher({}), null);
    strictEqual(extractGuardMatcher(null), null);
  });

  it("names the failing check, not a cause, when the dir is unresolvable", async () => {
    // K2b: unresolvable の原因は複数あり、session_id を断定すると
    // .tmp/sessions の symlink を疑うべきユーザーを誤誘導する。
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sess-")));
    mkdirSync(join(cwd, "docs"), { recursive: true });
    mkdirSync(join(cwd, ".tmp"), { recursive: true });
    symlinkSync(join(cwd, "docs"), join(cwd, ".tmp", "sessions"));
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const context = createSessionStartContext("startup", {
        session_id: "abcd1234-0000-0000-0000-000000000000",
      });
      await invokeRun(sessionHook, context);
      const message = context.jsonCalls[0].systemMessage;
      ok(message.includes(".tmp/sessions"));
      ok(!message.includes("session id is malformed"));
    } finally {
      process.chdir(previous);
    }
  });

  it("warns about an unresolvable dir without entering the outer catch", async () => {
    // session_id が空でも throw はしない。resolveWorkflowDir が
    // { source: "unresolvable", reason: "invalid-session-id" } を返し、決定 5 の
    // 警告行として出る。**これは K5a の検証にはならない** — 外側 catch を
    // 一度も通らないため、catch が context.success({}) のままでも緑になる。
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sess-")));
    envHelper.set("CLAUDE_ENV_FILE", undefined);
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const context = createSessionStartContext("startup", { session_id: "" });
      await invokeRun(sessionHook, context);
      ok(context.jsonCalls[0].systemMessage.includes("session id"));
    } finally {
      process.chdir(previous);
    }
  });

  it("reports the failure through systemMessage when the run actually throws", async () => {
    // K5a の回帰ガード。誘発手段は CLAUDE_ENV_FILE の書き込み失敗にする —
    // appendFileSync は try の内側（session.ts:43-65）にあり、親ディレクトリが
    // 無ければ ENOENT で throw する。session_id は正常値にして unresolvable
    // 経路と混ざらないようにする。
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sess-")));
    mkdirSync(join(cwd, ".tmp", "sessions", "abcd1234"), { recursive: true });
    envHelper.set("CLAUDE_ENV_FILE", join(cwd, "no-such-dir", "env.sh"));
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const context = createSessionStartContext("startup", {
        session_id: "abcd1234-0000-0000-0000-000000000000",
      });
      await invokeRun(sessionHook, context);
      strictEqual(context.jsonCalls.length, 1);
      ok(
        context.jsonCalls[0].systemMessage.includes(
          "Session start hook failed",
        ),
      );
    } finally {
      process.chdir(previous);
    }
  });
});

describe("transcript directory name audit", () => {
  const envHelper = new EnvironmentHelper();
  const NOTICE = "does not match the name derived from the startup directory";

  beforeEach(() => {
    envHelper.set("CLAUDE_ENV_FILE", undefined);
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    envHelper.set("DOCUMENT_WORKFLOW_WARN_ONLY", undefined);
    envHelper.set("CLAUDE_CODE_TASK_LIST_ID", undefined);
  });
  afterEach(() => {
    envHelper.restore();
  });

  const startupMessage = async (
    source: string,
    cwd: string,
    transcript_path: string,
  ): Promise<string> => {
    const context = createSessionStartContext(source, { cwd, transcript_path });
    await invokeRun(sessionHook, context);
    return context.jsonCalls[0].systemMessage;
  };
  const transcriptFor = (root: string) =>
    `/home/u/.claude/projects/${encodeSessionDirName(root)}/s.jsonl`;

  it("says nothing when the transcript directory is named after the startup cwd", async () => {
    const message = await startupMessage(
      "startup",
      "/work/my.proj",
      transcriptFor("/work/my.proj"),
    );
    ok(!message.includes(NOTICE));
  });
  it("reports a transcript directory that is not named after the startup cwd", async () => {
    const message = await startupMessage(
      "startup",
      "/work/my.proj",
      "/home/u/.claude/projects/work-my.proj/s.jsonl",
    );
    ok(message.includes(NOTICE));
    ok(
      message.includes(
        '[session] the transcript directory name "work-my.proj" does not match the name derived from the startup directory "/work/my.proj"',
      ),
    );
    ok(message.includes("0027-permission-path-pattern-semantics.md"));
  });
  it("compares the normalized startup cwd", async () => {
    const message = await startupMessage(
      "startup",
      "/work/my.proj/",
      transcriptFor("/work/my.proj"),
    );
    ok(!message.includes(NOTICE));
  });
  it("escapes control characters in the values it prints", async () => {
    const message = await startupMessage(
      "startup",
      "/work/a\nb",
      "/home/u/.claude/projects/x/s.jsonl",
    );
    ok(message.includes('"/work/a\\nb"'));
  });
  it("checks only at startup", async () => {
    for (const source of ["resume", "clear", "compact", "fork"]) {
      const message = await startupMessage(
        source,
        "/work/my.proj",
        "/home/u/.claude/projects/other/s.jsonl",
      );
      ok(!message.includes(NOTICE), source);
    }
  });
  it("skips a cwd or a transcript path that is not absolute", async () => {
    ok(
      !(
        await startupMessage(
          "startup",
          "rel",
          "/home/u/.claude/projects/x/s.jsonl",
        )
      ).includes(NOTICE),
    );
    ok(
      !(
        await startupMessage("startup", "/work/my.proj", "projects/x/s.jsonl")
      ).includes(NOTICE),
    );
  });
});

describe("answer recorder wiring audit", () => {
  const envHelper = new EnvironmentHelper();
  const RECORDER_CMD =
    "bun ~/.claude/hooks/implementations/approval-answer-recorder.ts";
  const settingsWith = (matcher: string | undefined) => ({
    hooks: {
      PostToolUse: [
        { matcher: "Other", hooks: [{ command: "bun x/other.ts" }] },
        {
          ...(matcher === undefined ? {} : { matcher }),
          hooks: [{ command: RECORDER_CMD }],
        },
      ],
    },
  });

  function homeWithSettings(content: string): void {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "audit-home-")));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), content);
    envHelper.set("HOME", home);
  }

  afterEach(() => {
    envHelper.restore();
  });

  it("extractHookMatcher returns the matching entry's matcher or null", () => {
    strictEqual(
      extractHookMatcher(
        settingsWith("AskUserQuestion"),
        "PostToolUse",
        "approval-answer-recorder.ts",
      ),
      "AskUserQuestion",
    );
    strictEqual(
      extractHookMatcher(
        { hooks: { PostToolUse: [] } },
        "PostToolUse",
        "approval-answer-recorder.ts",
      ),
      null,
    );
    strictEqual(
      extractHookMatcher(null, "PostToolUse", "approval-answer-recorder.ts"),
      null,
    );
  });

  it("reports covers for AskUserQuestion and wildcard matchers", () => {
    for (const m of ["AskUserQuestion", "", "*"]) {
      homeWithSettings(JSON.stringify(settingsWith(m)));
      ok(auditAnswerRecorderWiring().includes("covers"), `matcher ${m}`);
    }
  });

  it("reports missing for a wrong matcher or no entry", () => {
    homeWithSettings(JSON.stringify(settingsWith("AskUserQuestions")));
    ok(auditAnswerRecorderWiring().includes("missing"));
    homeWithSettings(JSON.stringify({ hooks: { PostToolUse: [] } }));
    ok(auditAnswerRecorderWiring().includes("no PostToolUse entry"));
  });

  it("a broken settings file fails each audit independently", () => {
    homeWithSettings("{ not json");
    ok(auditAnswerRecorderWiring().includes("could not audit"));
    ok(auditGuardWiring().includes("could not audit"));
  });

  it("the startup summary includes the recorder audit line", async () => {
    homeWithSettings(JSON.stringify(settingsWith("AskUserQuestion")));
    envHelper.set("CLAUDE_ENV_FILE", undefined);
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sess-")));
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const context = createSessionStartContext("startup", {
        session_id: "abcd1234-0000-0000-0000-000000000000",
      });
      await invokeRun(sessionHook, context);
      ok(
        context.jsonCalls[0].systemMessage.includes("approval-answer-recorder"),
      );
    } finally {
      process.chdir(previous);
    }
  });
});

describe("armed predicate drift", () => {
  // K2 が禁じるのは重複ではなく食い違いが無言であること。session.ts の縮退した
  // 判定と guard の isWorkflowActive を同じ fixture 表に通し、一致（および
  // 既知の差）を固定する。
  it("agrees with the guard whenever workflow-state.json is absent", () => {
    for (const files of [
      [],
      ["research.md"],
      ["plan.md"],
      ["research.md", "plan.md"],
    ]) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "armed-")));
      for (const f of files) writeFileSync(join(dir, f), "x");
      const paths = resolveWorkflowPaths(dir);
      strictEqual(
        isWorkflowArmedForTesting(paths),
        isWorkflowActive(paths, null),
        files.join(",") || "(none)",
      );
    }
  });

  it("degrades conservatively when workflow-state.json marks the workflow active", () => {
    // 実測: workflow-state.json は本リポジトリにも他プロジェクトにも存在しない。
    // 存在する場合に session.ts が inactive 寄りに出ることを既知の差として固定する。
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "armed-")));
    const paths = resolveWorkflowPaths(dir);
    strictEqual(isWorkflowArmedForTesting(paths), false);
    strictEqual(isWorkflowActive(paths, { mode: "document-workflow" }), true);
  });
});

// 本ブロックは PATH 上の bun に依存する（node --test <file> の単体実行でも必要）。
// 起動形は .settings.hooks.json.tmpl の SessionStart エントリ
// "bun {{ .chezmoi.homeDir }}/.claude/hooks/implementations/session.ts" に対応する。
// in-process の検査は context.json に渡す JS オブジェクトしか見ないため、
// stdout が JSON として壊れる経路（壊れると生 stdout が hook_success.content として
// Claude のモデル入力に注入される）はここでしか検知できない。
describe("wire output (subprocess)", () => {
  const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-wire-"));
    const digestDir = join(tmp, ".claude", "logs", "insights");
    mkdirSync(digestDir, { recursive: true });
    writeFileSync(
      join(digestDir, "insight-digest.md"),
      "# Insight digest\n\nMARKER_LINE_FOR_TEST\n\n- entry one\n",
    );
    writeFileSync(join(tmp, "envfile"), "");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function runSessionHookWire(): string {
    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      cwd: REPO_ROOT,
      session_id: "abcdef1234567890",
      transcript_path: "/tmp/fake-transcript.jsonl",
      source: "startup",
    });

    const childEnv = { ...process.env };
    delete childEnv.DOCUMENT_WORKFLOW_DIR;
    // The suite-wide preload (tests/preload-test-env.mjs) sets this in the
    // parent test process; clear it here so the spawned session.ts process
    // derives its log dir from childEnv.HOME below, matching this test's intent.
    delete childEnv.CLAUDE_LOGS_DIR;
    childEnv.HOME = tmp;
    childEnv.CLAUDE_ENV_FILE = join(tmp, "envfile");
    childEnv.CLAUDE_CODE_TASK_LIST_ID = "shared-list-456";

    try {
      return execFileSync(
        "bun",
        [join(REPO_ROOT, "home/dot_claude/hooks/implementations/session.ts")],
        {
          cwd: REPO_ROOT,
          input,
          encoding: "utf-8",
          env: childEnv,
          timeout: 30_000,
        },
      );
    } catch (e: any) {
      throw new Error(
        `bun session.ts failed (status=${e.status}): ${e.stderr ?? "(no stderr)"}`,
      );
    }
  }

  it("T5: unread digest, systemMessage on the wire includes the body", () => {
    const stdout = runSessionHookWire();

    ok(stdout.length > 0, "stdout should not be empty");
    const parsed = JSON.parse(stdout);
    deepStrictEqual(Object.keys(parsed).sort(), ["systemMessage"]);
    ok(
      parsed.systemMessage.startsWith(
        "🚀 Claude Code session started. Ready for development!",
      ),
      "systemMessage should start with the session start message",
    );
    ok(
      parsed.systemMessage.includes("MARKER_LINE_FOR_TEST"),
      "systemMessage should include the digest marker line",
    );
    ok(
      parsed.systemMessage.includes("shared-list-456"),
      "systemMessage should include the task list id",
    );
  });

  it("T6: acked digest, body is not present", () => {
    writeFileSync(
      join(tmp, ".claude", ".last-insight-digest-acked"),
      String(Date.now() + 600_000),
    );

    const stdout = runSessionHookWire();
    const parsed = JSON.parse(stdout);

    ok(
      !parsed.systemMessage.includes("MARKER_LINE_FOR_TEST"),
      "systemMessage should not include the digest marker line once acked",
    );
    ok(
      parsed.systemMessage.startsWith(
        "🚀 Claude Code session started. Ready for development!",
      ),
      "systemMessage should start with the session start message",
    );
  });
});
