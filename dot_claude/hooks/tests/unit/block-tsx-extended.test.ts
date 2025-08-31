#!/usr/bin/env node --test

import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert";
import blockTsxHook from "../../implementations/block-tsx.ts";

describe("block-tsx.ts extended patterns", () => {
  // Helper to create a test context
  const createContext = (command: string) => ({
    input: {
      tool_name: "Bash",
      tool_input: { command }
    },
    success: () => ({ status: "success" }),
    blockingError: (msg: string) => ({ status: "blocked", message: msg })
  });

  describe("find -exec patterns", () => {
    it("should block find with -exec tsx", () => {
      const context = createContext("find . -type f -exec tsx {} \\;");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block find -exec tsx");
      ok(result.message.includes("find -exec"));
    });

    it("should block find with -exec npx tsx", () => {
      const context = createContext("find . -type f -exec npx tsx {} +");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block find -exec npx tsx");
    });

    it("should block find with -exec ts-node", () => {
      const context = createContext("find . -name '*.ts' -exec ts-node {} \\;");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block find -exec ts-node");
    });

    it("should allow find without tsx/ts-node", () => {
      const context = createContext("find . -name '*.tsx' -exec cat {} \\;");
      const result = blockTsxHook.run(context) as any;
      strictEqual(result.status, "success", "Should allow find without tsx/ts-node");
    });
  });

  describe("xargs patterns", () => {
    it("should block xargs with tsx", () => {
      const context = createContext("ls *.ts | xargs tsx");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block xargs tsx");
      ok(result.message.includes("xargs"));
    });

    it("should block xargs with npx tsx", () => {
      const context = createContext("find . -name '*.ts' | xargs npx tsx");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block xargs npx tsx");
    });

    it("should block xargs -I with tsx", () => {
      const context = createContext("ls | xargs -I {} tsx {}");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block xargs -I tsx");
    });

    it("should block xargs -n with ts-node", () => {
      const context = createContext("echo file.ts | xargs -n 1 ts-node");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block xargs -n ts-node");
    });

    it("should allow xargs without tsx/ts-node", () => {
      const context = createContext("ls *.tsx | xargs cat");
      const result = blockTsxHook.run(context) as any;
      strictEqual(result.status, "success", "Should allow xargs without tsx/ts-node");
    });
  });

  describe("timeout patterns", () => {
    it("should block timeout with tsx", () => {
      const context = createContext("timeout 10s tsx script.ts");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block timeout tsx");
      ok(result.message.includes("timeout"));
    });

    it("should block timeout with npx tsx", () => {
      const context = createContext("timeout 5 npx tsx test.ts");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block timeout npx tsx");
    });

    it("should block timeout with ts-node", () => {
      const context = createContext("timeout 30s ts-node server.ts");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block timeout ts-node");
    });

    it("should allow timeout without tsx/ts-node", () => {
      const context = createContext("timeout 10s node script.js");
      const result = blockTsxHook.run(context) as any;
      strictEqual(result.status, "success", "Should allow timeout without tsx/ts-node");
    });
  });

  describe("time patterns", () => {
    it("should block time with tsx", () => {
      const context = createContext("time tsx benchmark.ts");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block time tsx");
      ok(result.message.includes("time"));
    });

    it("should block time with npx tsx", () => {
      const context = createContext("time npx tsx test.ts");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block time npx tsx");
    });

    it("should block time with ts-node", () => {
      const context = createContext("time ts-node script.ts");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block time ts-node");
    });

    it("should allow time without tsx/ts-node", () => {
      const context = createContext("time bun script.ts");
      const result = blockTsxHook.run(context) as any;
      strictEqual(result.status, "success", "Should allow time without tsx/ts-node");
    });
  });

  describe("parallel patterns", () => {
    it("should block parallel with tsx", () => {
      const context = createContext("parallel tsx ::: *.ts");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block parallel tsx");
      ok(result.message.includes("parallel"));
    });

    it("should block parallel with npx tsx", () => {
      const context = createContext("parallel npx tsx ::: file1.ts file2.ts");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block parallel npx tsx");
    });

    it("should allow parallel without tsx/ts-node", () => {
      const context = createContext("parallel bun ::: *.ts");
      const result = blockTsxHook.run(context) as any;
      strictEqual(result.status, "success", "Should allow parallel without tsx/ts-node");
    });
  });

  describe("edge cases", () => {
    it("should allow searching for .tsx files", () => {
      const context = createContext("find . -name '*.tsx' -type f");
      const result = blockTsxHook.run(context) as any;
      strictEqual(result.status, "success", "Should allow searching for .tsx files");
    });

    it("should allow timeout/time in other contexts", () => {
      const context = createContext("echo 'timeout and time are important'");
      const result = blockTsxHook.run(context) as any;
      strictEqual(result.status, "success", "Should allow timeout/time in strings");
    });

    it("should block complex command chains", () => {
      const context = createContext("cd src && find . -type f -name '*.ts' -exec tsx {} \\;");
      const result = blockTsxHook.run(context) as any;
      ok(result.status === "blocked", "Should block tsx in complex commands");
    });
  });
});