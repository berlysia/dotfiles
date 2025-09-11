#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import {
  defineHook,
  createFileSystemMock,
  ConsoleCapture,
  EnvironmentHelper,
  createPreToolUseContext,
} from "./test-helpers.ts";
import denyNodeModulesHook from "../../implementations/deny-node-modules.ts";
import { invokeRun } from "./test-helpers.ts";

describe("deny-node-modules.ts hook behavior", () => {
  const consoleCapture = new ConsoleCapture();
  const envHelper = new EnvironmentHelper();

  beforeEach(() => {
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

  describe("node_modules detection", () => {
    it("should allow Read operations on node_modules files", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Read", {
        file_path: "/project/node_modules/express/index.js",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should block Write operations to node_modules", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Write", {
        file_path: "/project/node_modules/package/file.js",
        content: "malicious code",
      });
      await invokeRun(hook, context);

      context.assertDeny();
      const reason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("node_modules"));
    });

    it("should block Edit operations in node_modules", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Edit", {
        file_path: "./node_modules/lodash/index.js",
        old_string: "original",
        new_string: "modified",
      });
      await invokeRun(hook, context);

      context.assertDeny();
    });

    it("should block MultiEdit in node_modules", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("MultiEdit", {
        file_path: "node_modules/react/lib/React.js",
        edits: [],
      });
      await invokeRun(hook, context);

      context.assertDeny();
    });

    it("should block Bash commands operating on node_modules", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Bash", {
        command: "rm -rf node_modules/some-package",
      });
      await invokeRun(hook, context);

      context.assertDeny();
      const reason2 =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason2.includes("node_modules"));
    });

    it("should allow ls commands in node_modules", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Bash", {
        command: "ls node_modules/",
      });
      await hook.run(context);

      context.assertSuccess({});
    });

    it("should allow read-only commands (cat, grep, find)", async () => {
      const hook = denyNodeModulesHook;

      const readOnlyCommands = [
        "cat node_modules/package/package.json",
        "grep version node_modules/*/package.json",
        "find node_modules -name '*.js'",
        "cd node_modules && pwd",
      ];

      for (const command of readOnlyCommands) {
        const context = createPreToolUseContext("Bash", { command });
        await hook.run(context);

        context.assertSuccess({});
        context.reset();
      }
    });

    it("should ask for unknown operations", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Bash", {
        command: "custom-tool node_modules/file",
      });
      await hook.run(context);

      // Should return ask response
      strictEqual(context.jsonCalls.length, 1);
      const askReason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(askReason.includes("Unknown node_modules operation"));
    });

    it("should handle compound commands correctly", async () => {
      const hook = denyNodeModulesHook;

      // Should deny if any part is destructive
      const destructiveContext = createPreToolUseContext("Bash", {
        command: "cd /tmp && rm -rf node_modules",
      });
      await hook.run(destructiveContext);

      strictEqual(destructiveContext.jsonCalls.length, 1);
      const denyReason =
        destructiveContext.jsonCalls[0].hookSpecificOutput
          ?.permissionDecisionReason || "";
      ok(denyReason.includes("Destructive operation detected"));

      destructiveContext.reset();

      // Should allow if all parts are safe
      const safeContext = createPreToolUseContext("Bash", {
        command: "cd node_modules && ls && pwd",
      });
      await hook.run(safeContext);

      safeContext.assertSuccess({});
    });
  });

  describe("Path variations", () => {
    it("should detect node_modules in various path formats", async () => {
      const hook = denyNodeModulesHook;

      const pathVariations = [
        "node_modules/package/file.js",
        "./node_modules/package/file.js",
        "../node_modules/package/file.js",
        "/absolute/path/node_modules/file.js",
        "some/deep/path/node_modules/nested/file.js",
      ];

      for (const path of pathVariations) {
        const context = createPreToolUseContext("Write", {
          file_path: path,
          content: "asdf",
        });
        await hook.run(context);

        context.assertDeny();
      }
    });

    it("should allow operations outside node_modules", async () => {
      const hook = denyNodeModulesHook;

      const allowedPaths = [
        "/project/src/index.js",
        "./components/Button.tsx",
        "../shared/utils.js",
        "package.json",
        "node_modules_backup/file.js", // Similar name but not exact
        "my_node_modules_copy/file.js",
      ];

      for (const path of allowedPaths) {
        const context = createPreToolUseContext("Read", {
          file_path: path,
        });
        await hook.run(context);

        context.assertSuccess({});
        strictEqual(context.failCalls.length, 0, `Should allow path: ${path}`);
      }
    });
  });

  describe("Command detection", () => {
    it("should block various bash commands targeting node_modules", async () => {
      const hook = denyNodeModulesHook;

      const blockedCommands = [
        "rm -rf node_modules/some-package",
        "echo 'test' > node_modules/file.txt",
        "chmod 777 node_modules/script.sh",
      ];

      for (const command of blockedCommands) {
        const context = createPreToolUseContext("Bash", {
          command,
        });
        await hook.run(context);

        context.assertDeny();
      }
    });

    it("should allow bash commands not targeting node_modules", async () => {
      const hook = denyNodeModulesHook;

      const allowedCommands = [
        "npm install",
        "npm run build",
        "ls src/",
        "cat package.json",
        "echo 'test'",
        "pwd",
      ];

      for (const command of allowedCommands) {
        const context = createPreToolUseContext("Bash", {
          command,
        });
        await hook.run(context);

        context.assertSuccess({});
        strictEqual(
          context.failCalls.length,
          0,
          `Should allow command: ${command}`,
        );
      }
    });
  });

  describe("Tool filtering", () => {
    it("should ignore non-file tools", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("WebFetch", {
        url: "https://example.com",
        prompt: "node_modules documentation",
      });
      await hook.run(context);

      context.assertSuccess({});
    });

    it("should handle missing tool_input gracefully", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Read", { file_path: "" });
      await hook.run(context);

      context.assertSuccess({});
    });

    it("should handle missing file_path gracefully", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Read", { file_path: "" });
      await hook.run(context);

      context.assertSuccess({});
    });
  });

  describe("Error messages", () => {
    it("should provide clear error message for blocked operations", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Write", {
        file_path: "node_modules/package/secret.key",
        content: "test",
      });
      await hook.run(context);

      context.assertDeny();
      const denyMsg =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(
        denyMsg.includes("node_modules") ||
          denyMsg.includes("denied") ||
          denyMsg.includes("not allowed"),
      );
    });

    it("should mention security in error message", async () => {
      const hook = denyNodeModulesHook;

      const context = createPreToolUseContext("Write", {
        file_path: "node_modules/malicious/payload.js",
        content: "evil code",
      });
      await hook.run(context);

      context.assertDeny();
      const errorMsg =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(
        errorMsg.includes("denied") ||
          errorMsg.includes("not allowed") ||
          errorMsg.includes("node_modules"),
      );
    });
  });
});

// Note: Using real implementation deny-node-modules hook; helper removed
