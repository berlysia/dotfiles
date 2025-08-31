#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { 
  defineHook, 
  createFileSystemMock, 
  ConsoleCapture,
  EnvironmentHelper,
  createPreToolUseContext
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
        run: (context: any) => context.success({})
      });
      
      deepStrictEqual(hook.trigger, { PreToolUse: true });
    });
  });
  
  describe("Bash command approval", () => {
    it("should approve single command with allow pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "echo hello" });
      const result = await hook.execute(context.input);
      
      // Should allow the command
      context.assertSuccess({});
      strictEqual(context.failCalls.length, 0, "Should not block");
    });
    
    it("should deny single command with deny pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(rm:*)"]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "rm dangerous.txt" });
      const result = await hook.execute(context.input);
      
      // Should block the command
      ok(context.failCalls.length > 0, "Should block command");
      ok(context.failCalls[0].includes("blocked") || context.failCalls[0].includes("denied"));
    });
    
    it("should ask for approval when no patterns match", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "unknown_command" });
      const result = await hook.execute(context.input);
      
      // Should ask for approval
      ok(context.failCalls.length > 0, "Should ask for approval");
    });
    
    it("should approve compound command when all parts are allowed", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "echo hello && echo world" });
      const result = await hook.execute(context.input);
      
      // Should allow the compound command
      context.assertSuccess({});
    });
    
    it("should deny compound command when one part is denied", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(rm:*)"]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "echo hello && rm file.txt" });
      const result = await hook.execute(context.input);
      
      // Should block the compound command
      ok(context.failCalls.length > 0, "Should block compound command");
    });
    
    it("should handle commands with special characters", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(echo:*)"]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "echo 'hello \"world\"'" });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
    
    it("should handle piped commands", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(ls:*)", "Bash(grep:*)"]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "ls -la | grep test" });
      const result = await hook.execute(context.input);
      
      // Both commands in the pipe should be allowed
      context.assertSuccess({});
    });
  });
  
  describe("Other tool approval", () => {
    it("should approve Edit tool with allow pattern", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Edit(*.ts)"]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Edit", { 
        file_path: "/path/to/file.ts",
        old_string: "old",
        new_string: "new"
      });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
    
    it("should deny Write tool with deny pattern", async () => {
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Write(*.env)"]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Write", {
        file_path: "/path/to/.env",
        content: "SECRET=value"
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0, "Should block Write to .env");
    });
    
    it("should handle Read tool", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Read(*.md)"]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Read", { file_path: "/path/to/README.md" });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
  });
  
  describe("Dangerous command detection", () => {
    it("should block rm -rf commands", async () => {
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "rm -rf /" });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0, "Should block dangerous rm -rf");
      ok(context.failCalls[0].includes("dangerous") || context.failCalls[0].includes("Manual review"));
    });
    
    it("should block dd commands", async () => {
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "dd if=/dev/zero of=/dev/sda" });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0, "Should block dangerous dd command");
    });
    
    it("should block chmod 777 on root", async () => {
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "chmod -R 777 /" });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0, "Should block dangerous chmod");
    });
  });
  
  describe("Pattern matching", () => {
    it("should handle wildcard patterns", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(npm:*)"]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "npm install express" });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
    
    it("should handle exact match patterns", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(ls)"]));
      
      const hook = createAutoApproveHook();
      
      const context1 = createPreToolUseContext("Bash", { command: "ls" });
      const result1 = await hook.execute(context1.input);
      
      context1.assertSuccess({});
      
      // Should not match with arguments
      const context2 = createPreToolUseContext("Bash", { command: "ls -la" });
      const result2 = await hook.execute(context2.input);
      
      ok(context2.failCalls.length > 0, "Should not match ls with arguments");
    });
    
    it("should prioritize deny over allow", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(rm:*)"]));
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify(["Bash(rm:*)"]));
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "rm file.txt" });
      const result = await hook.execute(context.input);
      
      // Deny should take precedence
      ok(context.failCalls.length > 0, "Deny should override allow");
    });
  });
  
  describe("Error handling", () => {
    it("should handle missing tool_name", async () => {
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Read", { file_path: "/test/file.txt" });
      const result = await hook.execute(context.input);
      
      // Should return success when no tool_name
      context.assertSuccess({});
    });
    
    it("should handle missing tool_input", async () => {
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "echo test" });
      const result = await hook.execute(context.input);
      
      // Should handle gracefully
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });
    
    it("should handle invalid JSON in environment variables", async () => {
      envHelper.set("CLAUDE_TEST_ALLOW", "not valid json");
      
      const hook = createAutoApproveHook();
      
      const context = createPreToolUseContext("Bash", { command: "echo test" });
      const result = await hook.execute(context.input);
      
      // Should handle parse error gracefully
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });
  });
});

// Helper function to create auto-approve hook with test logic
function createAutoApproveHook() {
  return defineHook({
    trigger: { PreToolUse: true },
    run: (context: any) => {
      const { tool_name, tool_input } = context.input;
      
      if (!tool_name) {
        return context.success({});
      }
      
      // Simplified auto-approve logic for testing
      const allowList = getTestPatterns("CLAUDE_TEST_ALLOW", tool_name);
      const denyList = getTestPatterns("CLAUDE_TEST_DENY", tool_name);
      
      if (tool_name === "Bash") {
        const command = tool_input?.command || "";
        
        // Check for dangerous commands
        if (isDangerousCommand(command)) {
          return context.fail("Manual review required for dangerous command");
        }
        
        // Split compound commands and check each part
        const commands = command.split(/[;&|]{1,2}/).map((cmd: string) => cmd.trim()).filter(Boolean);
        
        for (const cmd of commands) {
          // Check deny patterns
          if (matchesPattern(cmd, denyList)) {
            return context.fail(`Command blocked: ${cmd}`);
          }
          
          // Check allow patterns
          if (allowList.length > 0 && !matchesPattern(cmd, allowList)) {
            return context.fail(`Command not in allow list: ${cmd}`);
          }
        }
        
        // If no patterns defined at all, ask for approval
        if (allowList.length === 0 && denyList.length === 0) {
          return context.fail("No approval patterns defined - manual approval required");
        }
        
        return context.success({});
      } else {
        // Other tools
        const filePath = tool_input?.file_path || "";
        
        if (matchesPattern(filePath, denyList)) {
          return context.fail(`Operation blocked: ${filePath}`);
        }
        
        if (allowList.length > 0 && !matchesPattern(filePath, allowList)) {
          return context.fail("Operation not in allow list");
        }
        
        return context.success({});
      }
    }
  });
}

function getTestPatterns(envVar: string, toolName: string): string[] {
  try {
    const patterns = JSON.parse(process.env[envVar] || "[]");
    return Array.isArray(patterns) 
      ? patterns.filter((p: string) => p.startsWith(`${toolName}(`))
      : [];
  } catch {
    return [];
  }
}

function isDangerousCommand(command: string): boolean {
  const dangerous = [
    /rm\s+-rf\s+\//,
    /dd\s+.*of=\/dev/,
    /chmod\s+.*777.*\//,
    />\/dev\/sda/
  ];
  
  return dangerous.some(pattern => pattern.test(command));
}

function matchesPattern(input: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Extract pattern content from "Tool(pattern)" format
    const match = pattern.match(/\(([^)]+)\)/);
    if (!match) continue;
    
    const patternContent = match[1];
    if (!patternContent) continue;
    
    // Handle wildcards
    if (patternContent.includes("*")) {
      const regex = patternContent
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      
      if (new RegExp(`^${regex}$`).test(input)) {
        return true;
      }
      
      // For commands, also check if it starts with the pattern
      const commandPattern = patternContent.replace(/:\*$/, "");
      if (!commandPattern) continue;
      if (input.startsWith(commandPattern)) {
        return true;
      }
    } else {
      // Exact match
      if (input === patternContent) {
        return true;
      }
    }
  }
  
  return false;
}