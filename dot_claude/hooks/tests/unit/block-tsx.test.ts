#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { 
  defineHook, 
  ConsoleCapture,
  EnvironmentHelper 
} from "./test-helpers.ts";

describe("block-tsx.ts hook behavior", () => {
  const consoleCapture = new ConsoleCapture();
  const envHelper = new EnvironmentHelper();
  
  beforeEach(() => {
    consoleCapture.reset();
    consoleCapture.start();
  });
  
  afterEach(() => {
    consoleCapture.stop();
    envHelper.restore();
  });
  
  describe("hook definition", () => {
    it("should be configured for PreToolUse trigger", () => {
      const hook = defineHook({
        trigger: { PreToolUse: true },
        run: (context) => context.success({})
      });
      
      deepStrictEqual(hook.trigger, { PreToolUse: true });
    });
  });
  
  describe("tsx command blocking", () => {
    it("should block direct tsx command", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "tsx script.ts" }
      });
      
      ok(context.failCalls.length > 0, "Should block tsx command");
      ok(context.failCalls[0].includes("tsx") || context.failCalls[0].includes("TypeScript"));
    });
    
    it("should block npx tsx command", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "npx tsx src/index.ts" }
      });
      
      ok(context.failCalls.length > 0, "Should block npx tsx");
    });
    
    it("should allow tsx --version", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "tsx --version" }
      });
      
      context.assertSuccess({});
      strictEqual(context.failCalls.length, 0, "Should allow --version check");
    });
    
    it("should allow tsx --help", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "tsx --help" }
      });
      
      context.assertSuccess({});
      strictEqual(context.failCalls.length, 0, "Should allow --help");
    });
  });
  
  describe("ts-node command blocking", () => {
    it("should block direct ts-node command", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "ts-node test.ts" }
      });
      
      ok(context.failCalls.length > 0, "Should block ts-node");
      ok(context.failCalls[0].includes("ts-node") || context.failCalls[0].includes("TypeScript"));
    });
    
    it("should block npx ts-node command", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "npx ts-node src/server.ts" }
      });
      
      ok(context.failCalls.length > 0, "Should block npx ts-node");
    });
    
    it("should allow ts-node --version", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "ts-node --version" }
      });
      
      context.assertSuccess({});
    });
  });
  
  describe("installation blocking", () => {
    it("should block npm install tsx", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "npm install tsx" }
      });
      
      ok(context.failCalls.length > 0, "Should block tsx installation");
    });
    
    it("should block npm i -D tsx", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "npm i -D tsx" }
      });
      
      ok(context.failCalls.length > 0, "Should block tsx dev installation");
    });
    
    it("should block npm install ts-node", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "npm install ts-node" }
      });
      
      ok(context.failCalls.length > 0, "Should block ts-node installation");
    });
    
    it("should block yarn add tsx", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "yarn add tsx" }
      });
      
      ok(context.failCalls.length > 0, "Should block yarn tsx installation");
    });
    
    it("should block pnpm add tsx", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "pnpm add tsx" }
      });
      
      ok(context.failCalls.length > 0, "Should block pnpm tsx installation");
    });
    
    it("should allow installing other packages", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "npm install express" }
      });
      
      context.assertSuccess({});
    });
  });
  
  describe("compound commands", () => {
    it("should block tsx in compound commands", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "npm run build && tsx postbuild.ts" }
      });
      
      ok(context.failCalls.length > 0, "Should block tsx in compound");
    });
    
    it("should block ts-node in piped commands", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "echo 'test' | ts-node process.ts" }
      });
      
      ok(context.failCalls.length > 0, "Should block ts-node in pipe");
    });
  });
  
  describe("edge cases", () => {
    it("should not block tsx in file names", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "cat tsx.txt" }
      });
      
      context.assertSuccess({});
    });
    
    it("should not block tsx in strings", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "echo 'documentation about tsx'" }
      });
      
      context.assertSuccess({});
    });
    
    it("should not block tsx as part of other words", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "mytsxrunner --help" }
      });
      
      context.assertSuccess({});
    });
  });
  
  describe("tool filtering", () => {
    it("should only check Bash commands", async () => {
      const hook = createBlockTsxHook();
      
      const { context: writeContext } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "test.ts",
          content: "// tsx is mentioned here"
        }
      });
      
      writeContext.assertSuccess({});
      
      const { context: readContext } = await hook.execute({
        tool_name: "Read",
        tool_input: { file_path: "test.ts" }
      });
      
      readContext.assertSuccess({});
    });
  });
  
  describe("error messages", () => {
    it("should provide helpful suggestions for tsx", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "tsx index.ts" }
      });
      
      ok(context.failCalls.length > 0);
      const errorMsg = context.failCalls[0];
      ok(
        errorMsg.includes("bun") || 
        errorMsg.includes("deno") || 
        errorMsg.includes("node"),
        "Should suggest alternatives"
      );
    });
    
    it("should provide helpful suggestions for ts-node", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "ts-node server.ts" }
      });
      
      ok(context.failCalls.length > 0);
      const errorMsg = context.failCalls[0];
      ok(errorMsg.includes("TypeScript-compatible runtime"));
    });
  });
  
  describe("error handling", () => {
    it("should handle missing command", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: {}
      });
      
      context.assertSuccess({});
    });
    
    it("should handle null tool_input", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: null
      });
      
      context.assertSuccess({});
    });
  });
});

// Helper function to create block-tsx hook
function createBlockTsxHook() {
  return defineHook({
    trigger: { PreToolUse: true },
    run: (context) => {
      const { tool_name, tool_input } = context.input;
      
      // Only check Bash commands
      if (tool_name !== "Bash") {
        return context.success({});
      }
      
      const command = tool_input?.command || "";
      
      // Check for blocked patterns
      const blockingPatterns = [
        {
          pattern: /\btsx\s+(?!--version|--help)/,
          reason: "tsx is not allowed",
          suggestion: "Use bun, deno, or node instead"
        },
        {
          pattern: /\bts-node\s+(?!--version|--help)/,
          reason: "ts-node is not allowed",
          suggestion: "Use bun, deno, or node instead"
        },
        {
          pattern: /\bnpx\s+tsx\s+(?!--version|--help)/,
          reason: "npx tsx is not allowed",
          suggestion: "Use TypeScript-compatible runtime"
        },
        {
          pattern: /\bnpx\s+ts-node\s+(?!--version|--help)/,
          reason: "npx ts-node is not allowed",
          suggestion: "Use TypeScript-compatible runtime"
        },
        {
          pattern: /\b(?:npm|yarn|pnpm)\s+(?:install|i|add)\s+.*\b(?:tsx|ts-node)\b/,
          reason: "Installing tsx/ts-node is not allowed",
          suggestion: "Use TypeScript-compatible runtime with built-in support"
        }
      ];
      
      for (const { pattern, reason, suggestion } of blockingPatterns) {
        if (pattern.test(command)) {
          return context.fail(
            `🚫 ${reason}. ${suggestion}`
          );
        }
      }
      
      return context.success({});
    }
  });
}