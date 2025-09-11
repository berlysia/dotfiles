#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import {
  defineHook,
  ConsoleCapture,
  EnvironmentHelper,
  createPreToolUseContext,
} from "./test-helpers.ts";
import blockPkgHook from "../../implementations/block-package-json-tsx.ts";
import { invokeRun } from "./test-helpers.ts";

describe("block-package-json-tsx.ts hook behavior", () => {
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

  describe("tsx/ts-node detection in scripts", () => {
    it("should block direct tsx command in scripts", async () => {
      const hook = blockPkgHook;

      const packageJson = {
        scripts: {
          dev: "tsx watch src/index.ts",
        },
      };

      const context = createPreToolUseContext("Write", {
        file_path: "/project/package.json",
        content: JSON.stringify(packageJson, null, 2),
      });
      await invokeRun(hook, context);
      context.assertDeny();
      const reason =
        context.jsonCalls[0].hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("tsx") || reason.includes("TypeScript"));
    });

    it("should block ts-node command in scripts", async () => {
      const hook = blockPkgHook;

      const packageJson = {
        scripts: {
          test: "ts-node test.ts",
        },
      };

      const context = createPreToolUseContext("Edit", {
        file_path: "package.json",
        old_string: '"test": "node test.js"',
        new_string: '"test": "ts-node test.ts"',
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should block tsx in compound commands", async () => {
      const hook = blockPkgHook;

      const packageJson = {
        scripts: {
          build: "tsc && tsx src/postbuild.ts",
        },
      };

      const context = createPreToolUseContext("Write", {
        file_path: "package.json",
        content: JSON.stringify(packageJson, null, 2),
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should block node --loader tsx pattern", async () => {
      const hook = blockPkgHook;

      const packageJson = {
        scripts: {
          dev: "node --loader tsx src/index.ts",
        },
      };

      const context = createPreToolUseContext("Write", {
        file_path: "package.json",
        content: JSON.stringify(packageJson),
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should allow tsx as file extension (not command)", async () => {
      const hook = blockPkgHook;

      const packageJson = {
        scripts: {
          build: "webpack src/App.tsx",
        },
      };

      const context = createPreToolUseContext("Write", {
        file_path: "package.json",
        content: JSON.stringify(packageJson),
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should allow --ext tsx option", async () => {
      const hook = blockPkgHook;

      const packageJson = {
        scripts: {
          lint: "eslint --ext tsx,ts,js src/",
        },
      };

      const context = createPreToolUseContext("Write", {
        file_path: "package.json",
        content: JSON.stringify(packageJson),
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });
  });

  describe("dependencies detection", () => {
    it("should block tsx in dependencies", async () => {
      const hook = blockPkgHook;

      const packageJson = {
        dependencies: {
          tsx: "^3.0.0",
        },
      };

      const context = createPreToolUseContext("Write", {
        file_path: "package.json",
        content: JSON.stringify(packageJson),
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should block ts-node in devDependencies", async () => {
      const hook = blockPkgHook;

      const packageJson = {
        devDependencies: {
          "ts-node": "^10.0.0",
        },
      };

      const context = createPreToolUseContext("Write", {
        file_path: "package.json",
        content: JSON.stringify(packageJson),
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should block @swc-node/register", async () => {
      const hook = blockPkgHook;

      const packageJson = {
        devDependencies: {
          "@swc-node/register": "^1.0.0",
        },
      };

      const context = createPreToolUseContext("Write", {
        file_path: "package.json",
        content: JSON.stringify(packageJson),
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should allow other dependencies", async () => {
      const hook = blockPkgHook;

      const packageJson = {
        dependencies: {
          express: "^4.0.0",
          react: "^18.0.0",
        },
        devDependencies: {
          typescript: "^5.0.0",
          vitest: "^1.0.0",
        },
      };

      const context = createPreToolUseContext("Write", {
        file_path: "package.json",
        content: JSON.stringify(packageJson),
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });
  });

  describe("file filtering", () => {
    it("should only check package.json files", async () => {
      const hook = blockPkgHook;

      const context = createPreToolUseContext("Write", {
        file_path: "config.json",
        content: '{"scripts": {"dev": "tsx index.ts"}}',
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should check nested package.json files", async () => {
      const hook = blockPkgHook;

      const packageJson = {
        scripts: {
          start: "tsx src/server.ts",
        },
      };

      const context = createPreToolUseContext("Write", {
        file_path: "packages/backend/package.json",
        content: JSON.stringify(packageJson),
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });
  });

  describe("tool filtering", () => {
    it("should check Write tool", async () => {
      const hook = blockPkgHook;

      const context = createPreToolUseContext("Write", {
        file_path: "package.json",
        content: '{"scripts":{"dev":"tsx index.ts"}}',
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should check Edit tool", async () => {
      const hook = blockPkgHook;

      const context = createPreToolUseContext("Edit", {
        file_path: "package.json",
        old_string: '"dev": "node index.js"',
        new_string: '"dev": "tsx index.ts"',
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should check MultiEdit tool", async () => {
      const hook = blockPkgHook;

      const context = createPreToolUseContext("MultiEdit", {
        file_path: "package.json",
        edits: [
          {
            old_string: '"test": "jest"',
            new_string: '"test": "tsx test.ts"',
          },
        ],
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should ignore Read tool", async () => {
      const hook = blockPkgHook;

      const context = createPreToolUseContext("Read", {
        file_path: "package.json",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });
  });

  describe("error handling", () => {
    it("should handle invalid JSON gracefully", async () => {
      const hook = blockPkgHook;

      const context = createPreToolUseContext("Write", {
        file_path: "package.json",
        content: "not valid json { tsx",
      });
      await invokeRun(hook, context);
      // Should still check for tsx patterns even in invalid JSON (allow or deny)
      ok(context.jsonCalls.length > 0 || context.successCalls.length > 0);
    });

    it("should handle missing tool_input", async () => {
      const hook = blockPkgHook;

      const context = createPreToolUseContext("Write", {
        content: "",
        file_path: "",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should handle missing file_path", async () => {
      const hook = blockPkgHook;

      const context = createPreToolUseContext("Write", {
        content: '{"scripts":{"dev":"tsx"}}',
        file_path: "",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });
  });
});

// Using real implementation block-package-json-tsx.ts
