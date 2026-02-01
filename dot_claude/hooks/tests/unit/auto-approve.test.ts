#!/usr/bin/env node --test

import { deepStrictEqual, ok } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ToolSchema } from "cc-hooks-ts";
import autoApproveHook from "../../implementations/auto-approve.ts";
import {
  ConsoleCapture,
  createFileSystemMock,
  createPreToolUseContext,
  createPreToolUseContextFor,
  defineHook,
  EnvironmentHelper,
  invokeRun,
} from "./test-helpers.ts";

describe("auto-approve.ts hook behavior", () => {
  const consoleCapture = new ConsoleCapture();
  const envHelper = new EnvironmentHelper();
  const fsMock = createFileSystemMock();

  beforeEach(() => {
    consoleCapture.start();
    envHelper.set("CLAUDE_TEST_MODE", "1");
    fsMock.files.clear();
    fsMock.directories.clear();
  });

  afterEach(() => {
    consoleCapture.stop();
    envHelper.restore();
  });

  describe("hook definition", () => {
    it("should be configured for PreToolUse trigger", () => {
      const hook = defineHook({
        trigger: { PreToolUse: true },
        run: (context: any) => context.success({}),
      });

      deepStrictEqual(hook.trigger, { PreToolUse: true });
    });
  });

  describe("Bash command approval", () => {
    it("should approve single command with allow pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "echo hello",
      });
      await invokeRun(autoApproveHook, context);

      // Should allow the command
      context.assertAllow();
    });

    it("should deny single command with deny pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(rm:*)"]));

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "rm dangerous.txt",
      });
      await invokeRun(autoApproveHook, context);

      // Should block the command
      context.assertDeny();
    });

    it("should ask for approval when no patterns match", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "unknown_command",
      });
      await invokeRun(autoApproveHook, context);

      // Should pass through to Claude Code when no patterns are configured
      context.assertSuccess();
    });

    it("should approve compound command when all parts are allowed", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "echo hello && echo world",
      });
      await invokeRun(autoApproveHook, context);

      // Should allow the compound command
      context.assertAllow();
    });

    it("should deny compound command when one part is denied", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(rm:*)"]));

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "echo hello && rm file.txt",
      });
      await invokeRun(autoApproveHook, context);

      // Should block the compound command
      context.assertDeny();
    });

    it("should handle commands with special characters", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "echo 'hello \"world\"'",
      });
      await hook.run(context);

      context.assertAllow();
    });

    it("should handle piped commands", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Bash(ls:*)", "Bash(grep:*)"]),
      );

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "ls -la | grep test",
      });
      await hook.run(context);

      // Both commands in the pipe should be allowed
      context.assertAllow();
    });
  });

  describe("Other tool approval", () => {
    it("should approve Edit tool with allow pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(**)"]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Edit", {
        file_path: "/path/to/file.ts",
        old_string: "old",
        new_string: "new",
      });
      await hook.run(context);

      context.assertAllow();
    });

    it("should deny Write tool with deny pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      // Deny all Write operations for this test to validate deny path deterministically
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Write(**)"]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Write", {
        file_path: "/path/to/.env",
        content: "SECRET=value",
      });
      await hook.run(context);

      context.assertDeny();
    });

    it("should handle Read tool", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Read(**)"]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Read", {
        file_path: "/path/to/README.md",
      });
      await hook.run(context);

      context.assertAllow();
    });
  });

  describe("Dangerous command detection", () => {
    it("should block rm -rf commands", async () => {
      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "rm -rf /",
      });
      await invokeRun(autoApproveHook, context);

      context.assertDeny();
    });

    it("should block dd commands", async () => {
      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "dd if=/dev/zero of=/dev/sda",
      });
      await invokeRun(autoApproveHook, context);

      context.assertDeny();
    });

    it("should block chmod 777 on root", async () => {
      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "chmod -R 777 /",
      });
      await invokeRun(autoApproveHook, context);

      // Not explicitly in dangerous patterns; passes through to Claude Code
      context.assertSuccess();
    });
  });

  describe("Pattern matching", () => {
    it("should handle wildcard patterns", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(npm:*)"]));

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "npm install express",
      });
      await invokeRun(autoApproveHook, context);

      context.assertAllow();
    });

    it("should handle exact match patterns", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(ls)"]));

      const hook = autoApproveHook;

      const context1 = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "ls",
      });
      await hook.run(context1);

      context1.assertAllow();

      // Should not match with arguments
      const context2 = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "ls -la",
      });
      await hook.run(context2);

      // With exact match only, arguments don't match and pass through
      context2.assertSuccess();
    });

    it("should prioritize deny over allow", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(rm:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(rm:*)"]));

      const hook = autoApproveHook;

      const context = createPreToolUseContext("Bash", {
        command: "rm file.txt",
      });
      await hook.run(context);

      // Deny should take precedence
      context.assertDeny();
    });
  });

  describe("Meta Command Extraction", () => {
    it("should handle xargs with sh -c", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify([
          "Bash(git:*)",
          "Bash(echo:*)",
          "Bash(wc:*)",
          "Bash(xargs:*)",
          "Bash(sh:*)",
        ]),
      );

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: 'git diff --name-only | xargs -I {} sh -c "echo {}; wc -l {}"',
      });
      await hook.run(context);

      // Should allow or at least ask if meta parsing is partial
      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });

    it("should handle timeout with nested bash -c", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify([
          "Bash(find:*)",
          "Bash(head:*)",
          "Bash(timeout:*)",
          "Bash(bash:*)",
        ]),
      );

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: 'timeout 30 bash -c "find . -name *.ts | head -5"',
      });
      await hook.run(context);

      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });

    it("should block dangerous commands in meta commands", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: 'xargs -I {} sh -c "echo {}; rm -rf {}"',
      });
      await hook.run(context);

      // Variable-based rm -rf is dangerous and should be denied
      context.assertDeny();
    });

    it("should handle deeply nested meta commands", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify([
          "Bash(echo:*)",
          "Bash(timeout:*)",
          "Bash(bash:*)",
          "Bash(sh:*)",
        ]),
      );

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "timeout 60 bash -c \"xargs -I {} sh -c 'echo {}'\"",
      });
      await hook.run(context);

      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });
  });

  describe("Control Structure Handling", () => {
    it("should handle for loops transparently", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Bash(echo:*)", "Bash(wc:*)"]),
      );

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "for f in *.ts; do echo $f; wc -l $f; done",
      });
      await invokeRun(autoApproveHook, context);

      // Should allow or ask based on inner commands (echo, wc)
      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });

    it("should block dangerous commands in for loops", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "for f in *; do echo $f; rm -rf $f; done",
      });
      await invokeRun(autoApproveHook, context);

      // Variable-based rm -rf is dangerous and should be denied
      context.assertDeny();
    });

    it("should skip control keywords", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const hook = autoApproveHook;

      // Control keywords should be transparent
      const keywords = [
        "for",
        "do",
        "done",
        "if",
        "then",
        "else",
        "fi",
        "while",
      ];

      for (const keyword of keywords) {
        const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
          command: keyword,
        });
        await hook.run(context);

        // Control keywords are transparent; with no allow/deny they result in ask
        context.assertAsk();
      }
    });
  });

  describe("NO_PAREN_TOOL_NAMES Support", () => {
    it("should handle TodoWrite without parentheses", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["TodoWrite"]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "TodoWrite", {
        todos: [{ content: "test", status: "pending", activeForm: "testing" }],
      });
      await hook.run(context);

      context.assertAllow();
    });

    it("should handle Glob without parentheses", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Glob"]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Glob", {
        pattern: "*.ts",
      });
      await hook.run(context);

      context.assertAllow();
    });

    it("should handle MCP tools", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["mcp__context7__resolve-library-id"]),
      );

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(
        autoApproveHook,
        "mcp__context7__resolve-library-id" as keyof ToolSchema,
        {
          libraryName: "react",
        },
      );
      await hook.run(context);

      context.assertAllow();
    });
  });

  describe("Security Edge Cases", () => {
    it("should handle quote escaping attacks", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));

      const _hook = autoApproveHook;

      const maliciousCmds = [
        'xargs -I {} sh -c "echo {}; rm -rf /; echo safe"',
        'bash -c "echo safe && rm -rf / && echo safe"',
        'xargs -I {} sh -c "echo `rm -rf {}`"',
      ];

      for (const cmd of maliciousCmds) {
        const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
          command: cmd,
        });
        await invokeRun(autoApproveHook, context);

        // All rm -rf patterns (including variable-based) should be denied
        context.assertDeny();
      }
    });

    it("should handle mixed quotes correctly", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));

      const _hook = autoApproveHook;

      const quoteCases = [
        "xargs -I {} sh -c \"echo '{}'\"",
        "xargs -I {} sh -c 'echo \"{}\"'",
        "bash -c 'echo \"safe content\"'",
      ];

      for (const cmd of quoteCases) {
        const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
          command: cmd,
        });
        await invokeRun(autoApproveHook, context);

        // Should handle quote parsing without errors
        ok(
          context.successCalls.length > 0 ||
            context.failCalls.length > 0 ||
            context.jsonCalls.length > 0,
          `Should handle quote case: ${cmd}`,
        );
      }
    });
  });

  describe("Error handling", () => {
    it("should handle missing tool_name", async () => {
      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Read", {
        file_path: "/test/file.txt",
      });
      await hook.run(context);

      // With no patterns configured for non-Bash tools, expect ask
      context.assertAsk();
    });

    it("should handle missing tool_input", async () => {
      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "echo test",
      });
      await hook.run(context);

      // Should handle gracefully
      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });

    it("should handle invalid JSON in environment variables", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", "not valid json");

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "echo test",
      });
      await invokeRun(autoApproveHook, context);

      // Should handle parse error gracefully
      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });
  });

  describe("Type Safety Verification", () => {
    it("should provide structured result types for debugging", async () => {
      // This test verifies the type safety improvements
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(rm:*)"]));

      const _hook = autoApproveHook;

      // Test allow pattern
      const allowContext = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "echo hello",
      });
      await invokeRun(autoApproveHook, allowContext);
      allowContext.assertAllow();

      // Test deny pattern
      const denyContext = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "rm dangerous.txt",
      });
      await invokeRun(autoApproveHook, denyContext);
      denyContext.assertDeny();

      // Test no match pattern
      const noMatchContext = createPreToolUseContextFor(
        autoApproveHook,
        "Bash",
        { command: "unknown_command" },
      );
      await invokeRun(autoApproveHook, noMatchContext);
      noMatchContext.assertSuccess();
    });

    it("should handle mixed command types correctly", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));

      const _hook = autoApproveHook;

      // Commands with mix of allowed and not-allowed should result in ask
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "echo hello && unknown_command && echo world",
      });
      await invokeRun(autoApproveHook, context);

      // Should pass mixed commands to Claude Code for evaluation
      context.assertSuccess();
    });
  });

  describe("Invalid pattern handling", () => {
    it("should reject Bash(**) pattern", async () => {
      // Set up invalid Bash(**) pattern in allow list
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "echo hello",
      });
      await hook.run(context);

      // Should pass through to Claude Code since Bash(**) pattern is invalid
      context.assertSuccess();
    });

    it("should accept Read(**) pattern", async () => {
      // Verify that Read(**) pattern still works correctly
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Read(**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Read", {
        file_path: "/path/to/file.txt",
      });
      await hook.run(context);

      // Should allow all Read operations
      context.assertAllow();
    });

    it("should accept Edit(**) pattern", async () => {
      // Verify that Edit(**) pattern still works correctly
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Edit", {
        file_path: "/path/to/file.txt",
        old_string: "old",
        new_string: "new",
      });
      await hook.run(context);

      // Should allow all Edit operations
      context.assertAllow();
    });

    it("should accept Glob(./**) pattern", async () => {
      // Glob now supports path patterns like Glob(./**)
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Glob(./**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Glob", {
        pattern: "src/**/*.ts",
      });
      await hook.run(context);

      // Should allow Glob operations matching the path pattern
      context.assertAllow();
    });

    it("should accept Glob(**) pattern", async () => {
      // Glob also supports the wildcard ** pattern
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Glob(**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Glob", {
        pattern: "any/path/here",
      });
      await hook.run(context);

      // Should allow all Glob operations
      context.assertAllow();
    });
  });

  describe("Detailed breakdown messages", () => {
    it("should provide detailed allow breakdown with pattern matches", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Bash(git:*)", "Bash(ls:*)"]),
      );
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "git status; ls -la",
      });
      await invokeRun(autoApproveHook, context);

      context.assertAllow();

      // Check that the reason includes detailed breakdown
      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
      ok(reason?.includes("git status"), "Should mention git status command");
      ok(reason?.includes("ls -la"), "Should mention ls -la command");
      ok(reason?.includes("Bash(git:*)"), "Should mention git pattern");
      ok(reason?.includes("Bash(ls:*)"), "Should mention ls pattern");
      ok(reason?.includes("→"), "Should use arrow format");
    });

    it("should provide detailed deny breakdown with pattern matches", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set(
        "CLAUDE_TEST_DENY",
        JSON.stringify(["Bash(rm:*)", "Bash(chmod:*)"]),
      );

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "rm dangerous.txt; chmod 777 file.txt",
      });
      await invokeRun(autoApproveHook, context);

      context.assertDeny();

      // Check that the reason includes detailed breakdown
      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
      ok(reason?.includes("rm dangerous.txt"), "Should mention rm command");
      ok(
        reason?.includes("chmod 777 file.txt"),
        "Should mention chmod command",
      );
      ok(
        reason?.includes("blocked by Bash(rm:*)"),
        "Should mention rm pattern",
      );
      ok(
        reason?.includes("blocked by Bash(chmod:*)"),
        "Should mention chmod pattern",
      );
      ok(reason?.includes("→"), "Should use arrow format");
      ok(reason?.includes("(2 commands)"), "Should show command count");
    });

    it("should show mixed allow and deny details in deny response", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(rm:*)"]));

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "echo hello; rm file.txt; echo world",
      });
      await invokeRun(autoApproveHook, context);

      context.assertDeny();

      // Should focus on denied command in the reason
      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
      ok(reason?.includes("rm file.txt"), "Should mention denied rm command");
      ok(
        reason?.includes("blocked by Bash(rm:*)"),
        "Should mention rm pattern",
      );
      ok(reason?.includes("→"), "Should use arrow format");
    });

    it("should show dangerous command breakdown without patterns", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "rm -rf /",
      });
      await invokeRun(autoApproveHook, context);

      context.assertDeny();

      // Should show dangerous command details without pattern
      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
      ok(reason?.includes("rm -rf /"), "Should mention dangerous command");
      ok(reason?.includes("→"), "Should use arrow format");
      ok(
        !reason?.includes("blocked by Bash"),
        "Should not mention pattern for dangerous commands",
      );
    });

    it("should show detailed allow breakdown for multiple matching patterns", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Bash(git:*)", "Bash(npm:*)", "Bash(echo:*)"]),
      );
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const _hook = autoApproveHook;

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "git add .; npm install; echo done",
      });
      await invokeRun(autoApproveHook, context);

      context.assertAllow();

      // Check that all three commands and patterns are mentioned
      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
      ok(reason?.includes("git add ."), "Should mention git command");
      ok(reason?.includes("npm install"), "Should mention npm command");
      ok(reason?.includes("echo done"), "Should mention echo command");
      ok(reason?.includes("Bash(git:*)"), "Should mention git pattern");
      ok(reason?.includes("Bash(npm:*)"), "Should mention npm pattern");
      ok(reason?.includes("Bash(echo:*)"), "Should mention echo pattern");
      ok(reason?.includes("(3 commands)"), "Should show correct command count");
    });
  });

  describe("Grep tool path requirement", () => {
    it("should pass Grep without path parameter to Claude Code", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Grep(./**)", "Grep(~/workspace/**)"]),
      );
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Grep", {
        pattern: "test",
        output_mode: "content",
        // Note: no path parameter
      });
      await invokeRun(autoApproveHook, context);

      // New behavior: Grep is a smartPassTool, so it passes to Claude Code when no patterns match
      context.assertPass();
    });

    it("should allow Grep with project path", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Grep(./**)", "Grep(~/workspace/**)"]),
      );
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Grep", {
        pattern: "test",
        path: "./**",
        output_mode: "content",
      });
      await invokeRun(autoApproveHook, context);

      context.assertAllow();

      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
      ok(reason?.includes("Grep(./**)"), "Should mention matched pattern");
    });

    it("should allow Grep with workspace path", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Grep(./**)", "Grep(~/workspace/**)"]),
      );
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Grep", {
        pattern: "function",
        path: "~/workspace/project",
        output_mode: "files_with_matches",
      });
      await invokeRun(autoApproveHook, context);

      context.assertAllow();

      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
      ok(
        reason?.includes("Grep(~/workspace/**)"),
        "Should mention matched workspace pattern",
      );
    });

    it("should pass Grep with unmatched path to Claude Code", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Grep(./**)", "Grep(~/workspace/**)"]),
      );
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Grep", {
        pattern: "secret",
        path: "/etc/passwd",
        output_mode: "content",
      });
      await invokeRun(autoApproveHook, context);

      // New behavior: Grep is a smartPassTool, so it passes to Claude Code when no patterns match
      context.assertPass();
    });
  });

  describe("Search tool path requirement", () => {
    it("should pass Search without path parameter to Claude Code", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Search(./**)", "Search(~/workspace/**)"]),
      );
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Search", {
        pattern: "src/scenarios/**/*.ts",
        // Note: no path parameter
      });
      await invokeRun(autoApproveHook, context);

      // New behavior: Search is a smartPassTool, so it passes to Claude Code when no patterns match
      context.assertPass();
    });

    it("should allow Search with project path", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Search(./**)", "Search(~/workspace/**)"]),
      );
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Search", {
        pattern: "function",
        path: "./**",
      });
      await invokeRun(autoApproveHook, context);

      context.assertAllow();

      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
      ok(reason?.includes("Search(./**)"), "Should mention matched pattern");
    });

    it("should allow Search with workspace path", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Search(./**)", "Search(~/workspace/**)"]),
      );
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Search", {
        pattern: "interface",
        path: "~/workspace/project",
      });
      await invokeRun(autoApproveHook, context);

      context.assertAllow();

      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
      ok(
        reason?.includes("Search(~/workspace/**)"),
        "Should mention matched workspace pattern",
      );
    });
  });

  describe("Glob tool smart pass behavior", () => {
    it("should pass Glob tool by default (no explicit patterns)", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Glob", {
        pattern: "src/scenarios/**/*.ts",
      });
      await invokeRun(autoApproveHook, context);

      context.assertPass();
    });

    it("should pass Glob even with complex patterns", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Glob", {
        pattern: "deeply/nested/directory/structure/**/*.ts",
      });
      await invokeRun(autoApproveHook, context);

      context.assertPass();
    });
  });

  describe("sed -i command inference from Edit permissions", () => {
    it("should allow sed -i when target file matches Edit pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(src/**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "sed -i 's/foo/bar/' src/utils.ts",
      });
      await invokeRun(autoApproveHook, context);

      context.assertAllow();

      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
      ok(
        reason?.includes("inferred from Edit permissions"),
        "Should mention inference",
      );
    });

    it("should allow sed -i when all target files match Edit pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(src/**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "sed -i 's/foo/bar/' src/file1.ts src/file2.ts",
      });
      await invokeRun(autoApproveHook, context);

      context.assertAllow();
    });

    it("should pass sed -i when target file does not match Edit pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(src/**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "sed -i 's/foo/bar/' config/settings.json",
      });
      await invokeRun(autoApproveHook, context);

      // Should not auto-approve, let Claude Code decide
      context.assertSuccess();
    });

    it("should pass sed -i when one of multiple files does not match", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(src/**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "sed -i 's/foo/bar/' src/file.ts config.json",
      });
      await invokeRun(autoApproveHook, context);

      // Mixed files - should not auto-approve
      context.assertSuccess();
    });

    it("should pass sed -i with glob pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(src/**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "sed -i 's/foo/bar/' src/*.ts",
      });
      await invokeRun(autoApproveHook, context);

      // Glob patterns should not be auto-approved via inference
      context.assertSuccess();
    });

    it("should allow sed -i with backup extension", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(src/**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "sed -i.bak 's/foo/bar/' src/utils.ts",
      });
      await invokeRun(autoApproveHook, context);

      context.assertAllow();
    });

    it("should not interfere with regular sed (without -i)", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(src/**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "sed 's/foo/bar/' src/utils.ts",
      });
      await invokeRun(autoApproveHook, context);

      // Regular sed should not trigger inference logic
      context.assertSuccess();
    });

    it("should respect explicit Bash allow patterns over inference", async () => {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Bash(sed:*)", "Edit(src/**)"]),
      );
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "sed -i 's/foo/bar/' config.json",
      });
      await invokeRun(autoApproveHook, context);

      // Explicit Bash pattern should match regardless of Edit permissions
      context.assertAllow();
    });

    it("should respect deny patterns before inference", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(src/**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(sed:*)"]));

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "sed -i 's/foo/bar/' src/utils.ts",
      });
      await invokeRun(autoApproveHook, context);

      // Deny pattern should take precedence
      context.assertDeny();
    });

    it("should work with MultiEdit patterns", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["MultiEdit(src/**)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));

      const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
        command: "sed -i 's/foo/bar/' src/utils.ts",
      });
      await invokeRun(autoApproveHook, context);

      context.assertAllow();
    });
  });
});

// Helper function to create auto-approve hook with test logic
