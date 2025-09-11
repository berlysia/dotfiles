#!/usr/bin/env node --test

import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert";
import blockTsxHook from "../../implementations/block-tsx.ts";
import { createPreToolUseContext, invokeRun } from "./test-helpers.ts";

describe("block-tsx.ts extended patterns", () => {
  // Helper to create a test context with proper typing
  const createContext = (command: string) =>
    createPreToolUseContext("Bash", { command });

  describe("find -exec patterns", () => {
    it("should block find with -exec tsx", async () => {
      const context = createContext("find . -type f -exec tsx {} \\;");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
      const reason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("find -exec"), "Reason should mention find -exec");
    });

    it("should block find with -exec npx tsx", async () => {
      const context = createContext("find . -type f -exec npx tsx {} +");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
    });

    it("should block find with -exec ts-node", async () => {
      const context = createContext("find . -name '*.ts' -exec ts-node {} \\;");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
    });

    it("should allow find without tsx/ts-node", async () => {
      const context = createContext("find . -name '*.tsx' -exec cat {} \\;");
      await invokeRun(blockTsxHook, context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });
  });

  describe("xargs patterns", () => {
    it("should block xargs with tsx", async () => {
      const context = createContext("ls *.ts | xargs tsx");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
      const reason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("xargs"), "Reason should mention xargs");
    });

    it("should block xargs with npx tsx", async () => {
      const context = createContext("find . -name '*.ts' | xargs npx tsx");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
    });

    it("should block xargs -I with tsx", async () => {
      const context = createContext("ls | xargs -I {} tsx {}");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
    });

    it("should block xargs -n with ts-node", async () => {
      const context = createContext("echo file.ts | xargs -n 1 ts-node");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
    });

    it("should allow xargs without tsx/ts-node", async () => {
      const context = createContext("ls *.tsx | xargs cat");
      await invokeRun(blockTsxHook, context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });
  });

  describe("timeout patterns", () => {
    it("should block timeout with tsx", async () => {
      const context = createContext("timeout 10s tsx script.ts");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
      const reason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("timeout"), "Reason should mention timeout");
    });

    it("should block timeout with npx tsx", async () => {
      const context = createContext("timeout 5 npx tsx test.ts");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
    });

    it("should block timeout with ts-node", async () => {
      const context = createContext("timeout 30s ts-node server.ts");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
    });

    it("should allow timeout without tsx/ts-node", async () => {
      const context = createContext("timeout 10s node script.js");
      await invokeRun(blockTsxHook, context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });
  });

  describe("time patterns", () => {
    it("should block time with tsx", async () => {
      const context = createContext("time tsx benchmark.ts");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
      const reason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("time"), "Reason should mention time");
    });

    it("should block time with npx tsx", async () => {
      const context = createContext("time npx tsx test.ts");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
    });

    it("should block time with ts-node", async () => {
      const context = createContext("time ts-node script.ts");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
    });

    it("should allow time without tsx/ts-node", async () => {
      const context = createContext("time bun script.ts");
      await invokeRun(blockTsxHook, context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });
  });

  describe("parallel patterns", () => {
    it("should block parallel with tsx", async () => {
      const context = createContext("parallel tsx ::: *.ts");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
      const reason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("parallel"), "Reason should mention parallel");
    });

    it("should block parallel with npx tsx", async () => {
      const context = createContext("parallel npx tsx ::: file1.ts file2.ts");
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
    });

    it("should allow parallel without tsx/ts-node", async () => {
      const context = createContext("parallel bun ::: *.ts");
      await invokeRun(blockTsxHook, context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });
  });

  describe("edge cases", () => {
    it("should allow searching for .tsx files", async () => {
      const context = createContext("find . -name '*.tsx' -type f");
      await invokeRun(blockTsxHook, context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });

    it("should allow timeout/time in other contexts", async () => {
      const context = createContext("echo 'timeout and time are important'");
      await invokeRun(blockTsxHook, context);
      strictEqual(context.successCalls.length, 1, "Should have success call");
      strictEqual(context.failCalls.length, 0, "Should not have error calls");
    });

    it("should block complex command chains", async () => {
      const context = createContext(
        "cd src && find . -type f -name '*.ts' -exec tsx {} \\;",
      );
      await invokeRun(blockTsxHook, context);
      context.assertDeny();
    });
  });
});
