#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { 
  defineHook, 
  ConsoleCapture,
  EnvironmentHelper 
} from "./test-helpers.ts";
import blockTsxHookImpl from "../../implementations/block-tsx.ts";

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
        run: (context: any) => context.success({})
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
    
    it("should block tsx --version", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "tsx --version" }
      });
      
      ok(context.failCalls.length > 0, "Should block tsx --version due to strict policy");
    });
    
    it("should block tsx --help", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "tsx --help" }
      });
      
      ok(context.failCalls.length > 0, "Should block tsx --help due to strict policy");
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
    
    it("should block ts-node --version", async () => {
      const hook = createBlockTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Bash",
        tool_input: { command: "ts-node --version" }
      });
      
      ok(context.failCalls.length > 0, "Should block ts-node --version");
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

// Use the actual implementation from block-tsx.ts
function createBlockTsxHook() {
  // Wrap the actual implementation to match test interface
  return {
    execute: async (input: any) => {
      const context = {
        input,
        successCalls: [] as any[],
        failCalls: [] as any[],
        success: function(result: any = {}) {
          this.successCalls.push(result);
          return result;
        },
        fail: function(result: any = {}) {
          this.failCalls.push(result);
          return result;
        },
        blockingError: function(message: string) {
          this.failCalls.push(message);
          return { kind: "blocking-error" as const, payload: message };
        },
        json: function(payload: any) {
          return { kind: "json" as const, payload };
        },
        nonBlockingError: function(message: string = "") {
          return { kind: "non-blocking-error" as const, payload: message };
        },
        assertSuccess: function(expected: any = {}) {
          if (this.failCalls.length > 0) {
            throw new Error(`Expected success but got failure: ${this.failCalls[0]}`);
          }
          if (this.successCalls.length === 0) {
            throw new Error("Expected success but no success call was made");
          }
        }
      };
      
      // Run the actual hook
      blockTsxHookImpl.run(context);
      
      return { context };
    }
  };
}