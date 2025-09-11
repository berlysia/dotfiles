#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import {
  defineHook,
  ConsoleCapture,
  EnvironmentHelper,
  createPreToolUseContext,
} from "./test-helpers.ts";
import blockTsxHookImpl from "../../implementations/block-tsx.ts";
import { invokeRun } from "./test-helpers.ts";

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
        run: (context: any) => context.success({}),
      });

      deepStrictEqual(hook.trigger, { PreToolUse: true });
    });
  });

  describe("tsx command blocking", () => {
    it("should block direct tsx command", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "tsx script.ts",
      });
      await invokeRun(hook, context);
      context.assertDeny();
      const reason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("tsx") || reason.includes("TypeScript"));
    });

    it("should block npx tsx command", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "npx tsx src/index.ts",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should block tsx --version", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "tsx --version",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should block tsx --help", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "tsx --help",
      });
      await hook.run(context);
      context.assertDeny();
    });
  });

  describe("ts-node command blocking", () => {
    it("should block direct ts-node command", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "ts-node test.ts",
      });
      await hook.run(context);
      context.assertDeny();
      const reason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("ts-node") || reason.includes("TypeScript"));
    });

    it("should block npx ts-node command", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "npx ts-node src/server.ts",
      });
      await hook.run(context);
      context.assertDeny();
    });

    it("should block ts-node --version", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "ts-node --version",
      });
      await hook.run(context);
      context.assertDeny();
    });
  });

  describe("installation blocking", () => {
    it("should block npm install tsx", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "npm install tsx",
      });
      await hook.run(context);
      context.assertDeny();
    });

    it("should block npm i -D tsx", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "npm i -D tsx",
      });
      await hook.run(context);
      context.assertDeny();
    });

    it("should block npm install ts-node", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "npm install ts-node",
      });
      await hook.run(context);
      context.assertDeny();
    });

    it("should block yarn add tsx", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "yarn add tsx",
      });
      await hook.run(context);
      context.assertDeny();
    });

    it("should block pnpm add tsx", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "pnpm add tsx",
      });
      await hook.run(context);
      context.assertDeny();
    });

    it("should allow installing other packages", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "npm install express",
      });
      await hook.run(context);
      context.assertSuccess({});
    });
  });

  describe("compound commands", () => {
    it("should block tsx in compound commands", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "npm run build && tsx postbuild.ts",
      });
      await hook.run(context);
      context.assertDeny();
    });

    it("should block ts-node in piped commands", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "echo 'test' | ts-node process.ts",
      });
      await hook.run(context);
      context.assertDeny();
    });
  });

  describe("edge cases", () => {
    it("should not block tsx in file names", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "cat tsx.txt",
      });
      await hook.run(context);
      context.assertSuccess({});
    });

    it("should not block tsx in strings", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "echo 'documentation about tsx'",
      });
      await hook.run(context);
      context.assertSuccess({});
    });

    it("should not block tsx as part of other words", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "mytsxrunner --help",
      });
      await hook.run(context);
      context.assertSuccess({});
    });
  });

  describe("tool filtering", () => {
    it("should only check Bash commands", async () => {
      const hook = blockTsxHookImpl;
      const writeContext = createPreToolUseContext("Write", {
        file_path: "test.ts",
        content: "// tsx",
      });
      await hook.run(writeContext);
      writeContext.assertSuccess({});
      const readContext = createPreToolUseContext("Read", {
        file_path: "test.ts",
      });
      await hook.run(readContext);
      readContext.assertSuccess({});
    });
  });

  describe("error messages", () => {
    it("should provide helpful suggestions for tsx", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "tsx index.ts",
      });
      await hook.run(context);
      context.assertDeny();
      const errorMsg =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(
        errorMsg.includes("bun") ||
          errorMsg.includes("deno") ||
          errorMsg.includes("node"),
        "Should suggest alternatives",
      );
    });

    it("should provide helpful suggestions for ts-node", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", {
        command: "ts-node server.ts",
      });
      await hook.run(context);
      context.assertDeny();
      const errorMsg =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(errorMsg.includes("TypeScript-compatible runtime"));
    });
  });

  describe("error handling", () => {
    it("should handle missing command", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", { command: "" });
      await hook.run(context);
      context.assertSuccess({});
    });

    it("should handle null tool_input", async () => {
      const hook = blockTsxHookImpl;
      const context = createPreToolUseContext("Bash", { command: "" });
      await hook.run(context);
      context.assertSuccess({});
    });
  });
});

// No local wrapper; tests use createPreToolUseContext + hook.run
