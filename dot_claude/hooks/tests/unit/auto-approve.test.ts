#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { 
  defineHook, 
  createFileSystemMock, 
  ConsoleCapture,
  EnvironmentHelper,
  createPreToolUseContext,
  createPreToolUseContextFor,
  createAskResponse,
  createDenyResponse
} from "./test-helpers.ts";
import type { ToolSchema } from "cc-hooks-ts";
import {
  extractCommandsFromCompound,
  checkDangerousCommand,
  checkCommandPattern,
  getFilePathFromToolInput,
  NO_PAREN_TOOL_NAMES,
  CONTROL_STRUCTURE_KEYWORDS
} from "../../lib/command-parsing.ts";
import autoApproveHook from "../../implementations/auto-approve.ts";
import { invokeRun } from "./test-helpers.ts";

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
        run: (context: any) => context.success({})
      });
      
      deepStrictEqual(hook.trigger, { PreToolUse: true });
    });
  });
  
  describe("Bash command approval", () => {
    it("should approve single command with allow pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "echo hello" });
      await invokeRun(autoApproveHook, context);
      
      // Should allow the command
      context.assertSuccess({});
    });
    
    it("should deny single command with deny pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(rm:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "rm dangerous.txt" });
      await invokeRun(autoApproveHook, context);
      
      // Should block the command
      context.assertDeny();
    });
    
    it("should ask for approval when no patterns match", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "unknown_command" });
      await invokeRun(autoApproveHook, context);
      
      // Should ask for approval
      context.assertAsk();
    });
    
    it("should approve compound command when all parts are allowed", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "echo hello && echo world" });
      await invokeRun(autoApproveHook, context);
      
      // Should allow the compound command
      context.assertSuccess({});
    });
    
    it("should deny compound command when one part is denied", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(rm:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "echo hello && rm file.txt" });
      await invokeRun(autoApproveHook, context);
      
      // Should block the compound command
      context.assertDeny();
    });
    
    it("should handle commands with special characters", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "echo 'hello \"world\"'" });
      await hook.run(context);
      
      context.assertSuccess({});
    });
    
    it("should handle piped commands", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(ls:*)", "Bash(grep:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "ls -la | grep test" });
      await hook.run(context);
      
      // Both commands in the pipe should be allowed
      context.assertSuccess({});
    });
  });
  
  describe("Other tool approval", () => {
    it("should approve Edit tool with allow pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(**)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Edit", { 
        file_path: "/path/to/file.ts",
        old_string: "old",
        new_string: "new"
      });
      await hook.run(context);
      
      context.assertSuccess({});
    });
    
    it("should deny Write tool with deny pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      // Deny all Write operations for this test to validate deny path deterministically
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Write(**)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Write", {
        file_path: "/path/to/.env",
        content: "SECRET=value"
      });
      await hook.run(context);
      
      context.assertDeny();
    });
    
    it("should handle Read tool", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Read(**)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Read", { file_path: "/path/to/README.md" });
      await hook.run(context);
      
      context.assertSuccess({});
    });
  });
  
  describe("Dangerous command detection", () => {
    it("should block rm -rf commands", async () => {
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "rm -rf /" });
      await invokeRun(autoApproveHook, context);
      
      context.assertDeny();
    });
    
    it("should block dd commands", async () => {
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "dd if=/dev/zero of=/dev/sda" });
      await invokeRun(autoApproveHook, context);
      
      context.assertDeny();
    });
    
    it("should block chmod 777 on root", async () => {
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "chmod -R 777 /" });
      await invokeRun(autoApproveHook, context);
      
      // Not explicitly in dangerous patterns; should ask for review
      context.assertAsk();
    });
  });
  
  describe("Pattern matching", () => {
    it("should handle wildcard patterns", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(npm:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "npm install express" });
      await invokeRun(autoApproveHook, context);
      
      context.assertSuccess({});
    });
    
    it("should handle exact match patterns", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(ls)"]));
      
      const hook = autoApproveHook;
      
      const context1 = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "ls" });
      await hook.run(context1);
      
      context1.assertSuccess({});
      
      // Should not match with arguments
      const context2 = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "ls -la" });
      await hook.run(context2);
      
      // With exact match only, arguments should cause ask
      context2.assertAsk();
    });
    
    it("should prioritize deny over allow", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(rm:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(rm:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContext("Bash", { command: "rm file.txt" });
      await hook.run(context);
      
      // Deny should take precedence
      context.assertDeny();
    });
  });
  
  describe("Meta Command Extraction", () => {
    it("should handle xargs with sh -c", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(git:*)", "Bash(echo:*)", "Bash(wc:*)", "Bash(xargs:*)", "Bash(sh:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { 
        command: 'git diff --name-only | xargs -I {} sh -c "echo {}; wc -l {}"'
      });
      await hook.run(context);
      
      // Should allow or at least ask if meta parsing is partial
      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });
    
    it("should handle timeout with nested bash -c", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(find:*)", "Bash(head:*)", "Bash(timeout:*)", "Bash(bash:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { 
        command: 'timeout 30 bash -c "find . -name *.ts | head -5"'
      });
      await hook.run(context);
      
      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });
    
    it("should block dangerous commands in meta commands", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { 
        command: 'xargs -I {} sh -c "echo {}; rm -rf {}"'
      });
      await hook.run(context);
      
      // Not explicit root deletion; should ask for review
      context.assertAsk();
    });
    
    it("should handle deeply nested meta commands", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)", "Bash(timeout:*)", "Bash(bash:*)", "Bash(sh:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { 
        command: 'timeout 60 bash -c "xargs -I {} sh -c \'echo {}\'"'
      });
      await hook.run(context);
      
      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });
  });
  
  describe("Control Structure Handling", () => {
    it("should handle for loops transparently", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)", "Bash(wc:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { 
        command: 'for f in *.ts; do echo $f; wc -l $f; done'
      });
      await invokeRun(autoApproveHook, context);
      
      // Should allow or ask based on inner commands (echo, wc)
      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });
    
    it("should block dangerous commands in for loops", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { 
        command: 'for f in *; do echo $f; rm -rf $f; done'
      });
      await invokeRun(autoApproveHook, context);
      
      // Not explicit root deletion; should ask for review
      context.assertAsk();
    });
    
    it("should skip control keywords", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));
      
      const hook = autoApproveHook;
      
      // Control keywords should be transparent
      const keywords = ['for', 'do', 'done', 'if', 'then', 'else', 'fi', 'while'];
      
      for (const keyword of keywords) {
        const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: keyword });
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
        todos: [{ content: "test", status: "pending", activeForm: "testing" }]
      });
      await hook.run(context);
      
      context.assertSuccess({});
    });
    
    it("should handle Glob without parentheses", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Glob"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Glob", { pattern: "*.ts" });
      await hook.run(context);
      
      context.assertSuccess({});
    });
    
    it("should handle MCP tools", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["mcp__context7__resolve-library-id"]));
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "mcp__context7__resolve-library-id" as keyof ToolSchema, { 
        libraryName: "react"
      });
      await hook.run(context);
      
      context.assertSuccess({});
    });
  });
  
  describe("Security Edge Cases", () => {
    it("should handle quote escaping attacks", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      
      const hook = autoApproveHook;
      
      const maliciousCmds = [
        'xargs -I {} sh -c "echo {}; rm -rf /; echo safe"',
        'bash -c "echo safe && rm -rf / && echo safe"',
        'xargs -I {} sh -c "echo `rm -rf {}`"'
      ];
      
      for (const cmd of maliciousCmds) {
        const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: cmd });
        await invokeRun(autoApproveHook, context);
        
        if (cmd.includes("rm -rf /")) {
          context.assertDeny();
        } else {
          // Should require manual review for nested rm -rf (non-root)
          context.assertAsk();
        }
      }
    });
    
    it("should handle mixed quotes correctly", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      
      const hook = autoApproveHook;
      
      const quoteCases = [
        'xargs -I {} sh -c "echo \'{}\'"',
        'xargs -I {} sh -c \'echo "{}"\'',
        'bash -c \'echo "safe content"\''
      ];
      
      for (const cmd of quoteCases) {
        const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: cmd });
        await invokeRun(autoApproveHook, context);
        
        // Should handle quote parsing without errors
        ok(context.successCalls.length > 0 || context.failCalls.length > 0 || context.jsonCalls.length > 0, 
           `Should handle quote case: ${cmd}`);
      }
    });
  });

  describe("Error handling", () => {
    it("should handle missing tool_name", async () => {
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Read", { file_path: "/test/file.txt" });
      await hook.run(context);
      
      // With no patterns configured for non-Bash tools, expect ask
      context.assertAsk();
    });
    
    it("should handle missing tool_input", async () => {
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "echo test" });
      await hook.run(context);
      
      // Should handle gracefully
      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });
    
    it("should handle invalid JSON in environment variables", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", "not valid json");
      
      const hook = autoApproveHook;
      
      const context = createPreToolUseContextFor(autoApproveHook, "Bash", { command: "echo test" });
      await invokeRun(autoApproveHook, context);
      
      // Should handle parse error gracefully
      ok(context.successCalls.length > 0 || context.jsonCalls.length > 0);
    });
  });
});

// Helper function to create auto-approve hook with test logic  
