#!/usr/bin/env node --test

import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert";
import blockTsxHook from "../../implementations/block-tsx.ts";
import { MockHookContext } from "./test-helpers.ts";

describe("block-tsx.ts extended patterns", () => {
  // Helper to create a test context with proper typing
  const createContext = (command: string) => {
    return new MockHookContext<{ PreToolUse: true }>({
      hook_event_name: "PreToolUse",
      cwd: "/test",
      session_id: "test-session",
      transcript_path: "/test/transcript",
      tool_name: "Bash",
      tool_input: { command }
    });
  };

  describe("find -exec patterns", () => {
    it("should block find with -exec tsx", () => {
      const context = createContext("find . -type f -exec tsx {} \\;");
      blockTsxHook.run(context);
      
      // Check that blocking error was called
      ok(context.failCalls.length > 0, "Should have blocking error calls");
      
      // Check error message content
      const errorMessage = context.failCalls[0];
      ok(typeof errorMessage === "string" && errorMessage.includes("find -exec"), "Error should mention find -exec");
    });

    it("should block find with -exec npx tsx", () => {
      const context = createContext("find . -type f -exec npx tsx {} +");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
    });

    it("should block find with -exec ts-node", () => {
      const context = createContext("find . -name '*.ts' -exec ts-node {} \\;");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
    });

    it("should allow find without tsx/ts-node", () => {
      const context = createContext("find . -name '*.tsx' -exec cat {} \\;");
      blockTsxHook.run(context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });
  });

  describe("xargs patterns", () => {
    it("should block xargs with tsx", () => {
      const context = createContext("ls *.ts | xargs tsx");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
      const errorMessage = context.failCalls[0];
      ok(typeof errorMessage === "string" && errorMessage.includes("xargs"), "Error should mention xargs");
    });

    it("should block xargs with npx tsx", () => {
      const context = createContext("find . -name '*.ts' | xargs npx tsx");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
    });

    it("should block xargs -I with tsx", () => {
      const context = createContext("ls | xargs -I {} tsx {}");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
    });

    it("should block xargs -n with ts-node", () => {
      const context = createContext("echo file.ts | xargs -n 1 ts-node");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
    });

    it("should allow xargs without tsx/ts-node", () => {
      const context = createContext("ls *.tsx | xargs cat");
      blockTsxHook.run(context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });
  });

  describe("timeout patterns", () => {
    it("should block timeout with tsx", () => {
      const context = createContext("timeout 10s tsx script.ts");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
      const errorMessage = context.failCalls[0];
      ok(typeof errorMessage === "string" && errorMessage.includes("timeout"), "Error should mention timeout");
    });

    it("should block timeout with npx tsx", () => {
      const context = createContext("timeout 5 npx tsx test.ts");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
    });

    it("should block timeout with ts-node", () => {
      const context = createContext("timeout 30s ts-node server.ts");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
    });

    it("should allow timeout without tsx/ts-node", () => {
      const context = createContext("timeout 10s node script.js");
      blockTsxHook.run(context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });
  });

  describe("time patterns", () => {
    it("should block time with tsx", () => {
      const context = createContext("time tsx benchmark.ts");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
      const errorMessage = context.failCalls[0];
      ok(typeof errorMessage === "string" && errorMessage.includes("time"), "Error should mention time");
    });

    it("should block time with npx tsx", () => {
      const context = createContext("time npx tsx test.ts");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
    });

    it("should block time with ts-node", () => {
      const context = createContext("time ts-node script.ts");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
    });

    it("should allow time without tsx/ts-node", () => {
      const context = createContext("time bun script.ts");
      blockTsxHook.run(context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });
  });

  describe("parallel patterns", () => {
    it("should block parallel with tsx", () => {
      const context = createContext("parallel tsx ::: *.ts");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
      const errorMessage = context.failCalls[0];
      ok(typeof errorMessage === "string" && errorMessage.includes("parallel"), "Error should mention parallel");
    });

    it("should block parallel with npx tsx", () => {
      const context = createContext("parallel npx tsx ::: file1.ts file2.ts");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
    });

    it("should allow parallel without tsx/ts-node", () => {
      const context = createContext("parallel bun ::: *.ts");
      blockTsxHook.run(context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });
  });

  describe("edge cases", () => {
    it("should allow searching for .tsx files", () => {
      const context = createContext("find . -name '*.tsx' -type f");
      blockTsxHook.run(context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });

    it("should allow timeout/time in other contexts", () => {
      const context = createContext("echo 'timeout and time are important'");
      blockTsxHook.run(context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });

    it("should block complex command chains", () => {
      const context = createContext("cd src && find . -type f -name '*.ts' -exec tsx {} \\;");
      blockTsxHook.run(context);
      ok(context.failCalls.length > 0, "Should have blocking error calls");
    });
  });
});