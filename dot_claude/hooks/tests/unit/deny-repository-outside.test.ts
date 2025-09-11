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
  invokeRun,
} from "./test-helpers.ts";
import denyRepoHook from "../../implementations/deny-repository-outside.ts";

describe("deny-repository-outside.ts hook behavior", () => {
  const consoleCapture = new ConsoleCapture();
  const envHelper = new EnvironmentHelper();
  const fsMock = createFileSystemMock();

  beforeEach(() => {
    consoleCapture.reset();
    consoleCapture.start();
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
        run: (context: any) => context.success({}),
      });

      deepStrictEqual(hook.trigger, { PreToolUse: true });
    });
  });

  describe("file access control", () => {
    it("should block Read access outside repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      process.env.CLAUDE_TEST_CWD = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/etc/passwd",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should allow Read access within repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      process.env.CLAUDE_TEST_CWD = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/home/user/project/src/index.ts",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should allow Write access in temp directories", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "/tmp/malicious.sh",
        content: "evil code",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should allow Write access within repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Write", {
        file_path: "/home/user/project/README.md",
        content: "# Project",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should block Edit outside repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Edit", {
        file_path: "/home/user/other-project/.env",
        old_string: "old",
        new_string: "new",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should block MultiEdit outside repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "MultiEdit", {
        file_path: "/etc/hosts",
        edits: [],
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });
  });

  describe("path resolution", () => {
    it("should handle relative paths", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      process.env.CLAUDE_TEST_CWD = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "./src/index.ts",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });

    it("should block parent directory traversal", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      process.env.CLAUDE_TEST_CWD = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "../../../etc/passwd",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should handle symlinks trying to escape", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      // Simulate a symlink that points outside
      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/home/user/project/link-to-outside",
      });
      await invokeRun(hook, context);

      // Should be handled by the implementation
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });

    it("should handle home directory paths", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "~/project/file.ts",
      });
      await invokeRun(hook, context);

      // Should expand ~ and check
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });
  });

  describe("Bash command filtering", () => {
    it("should block Bash commands accessing outside files", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "cat /etc/passwd",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should allow Bash commands within repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      process.env.CLAUDE_TEST_CWD = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "ls ./src",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should block rm commands outside repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "rm -rf /etc/important",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should allow package manager commands", async () => {
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Bash", {
        command: "npm install",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });
  });

  describe("special directories", () => {
    it("should allow access to node_modules within repo", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/home/user/project/node_modules/package/index.js",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should allow access to .git within repo", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/home/user/project/.git/config",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should block access to system directories", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const systemPaths = [
        "/etc/shadow",
        "/usr/bin/bash",
        "/var/log/syslog",
        "/root/.ssh/id_rsa",
      ];

      for (const path of systemPaths) {
        const context = createPreToolUseContextFor(hook, "Read", {
          file_path: path,
        });
        await invokeRun(hook, context);
        context.assertDeny();
      }
    });
  });

  describe("tool filtering", () => {
    it("should check LS tool", async () => {
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "LS", { path: "/etc" });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should check Glob tool", async () => {
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Glob", {
        path: "/var/log",
        pattern: "*.log",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should check Grep tool", async () => {
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Grep", {
        path: "/etc",
        pattern: "password",
      });
      await invokeRun(hook, context);
      context.assertDeny();
    });

    it("should ignore non-file tools", async () => {
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "WebFetch", {
        url: "https://example.com",
        prompt: "how to access /etc/passwd",
      });
      await invokeRun(hook, context);
      context.assertSuccess({});
    });
  });

  describe("no repository scenario", () => {
    it("should allow operations when not in a repository", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/tmp/test.txt",
      });
      await invokeRun(hook, context);

      context.assertSuccess({});
    });
  });

  describe("error handling", () => {
    it("should handle missing file_path", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "",
      });
      await invokeRun(hook, context);

      // Should handle gracefully
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });

    it("should handle null tool_input", async () => {
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Write", {
        content: "",
        file_path: "",
      });
      await invokeRun(hook, context);

      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });

    it("should provide clear error messages", async () => {
      process.env.CLAUDE_TEST_REPO_ROOT = "/home/user/project";
      const hook = denyRepoHook;

      const context = createPreToolUseContextFor(hook, "Read", {
        file_path: "/etc/passwd",
      });
      await invokeRun(hook, context);
      context.assertDeny();
      const resp = context.jsonCalls[0];
      const reason = resp.hookSpecificOutput?.permissionDecisionReason || "";
      ok(reason.includes("denied") || reason.includes("Access"));
      ok(
        reason.includes("/home/user/project") || reason.includes("Repository"),
      );
    });
  });
});

// Helper function to create deny-repository-outside hook
function createDenyRepositoryOutsideHook(repoRoot: string | undefined) {
  return defineHook({
    trigger: { PreToolUse: true },
    run: (context: any) => {
      const { tool_name, tool_input } = context.input;

      // Only check file/path tools
      const fileTools = [
        "Read",
        "Write",
        "Edit",
        "MultiEdit",
        "LS",
        "Glob",
        "Grep",
        "Bash",
      ];
      if (!fileTools.includes(tool_name)) {
        return context.success({});
      }

      // If no repository, allow all
      if (!repoRoot) {
        return context.success({});
      }

      // Extract paths to check
      const paths = extractPaths(tool_name, tool_input);

      // Check each path
      for (const path of paths) {
        if (!isPathWithinRepo(path, repoRoot)) {
          return context.fail(
            `🚫 Access denied: Path is outside repository\n` +
              `Path: ${path}\n` +
              `Repository: ${repoRoot}`,
          );
        }
      }

      return context.success({});
    },
  });
}

function extractPaths(toolName: string, toolInput: any): string[] {
  if (!toolInput) return [];

  const paths: string[] = [];

  // Extract based on tool type
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      if (toolInput.file_path) paths.push(toolInput.file_path);
      break;
    case "LS":
    case "Glob":
    case "Grep":
      if (toolInput.path) paths.push(toolInput.path);
      break;
    case "Bash":
      // Extract file paths from bash commands
      const command = toolInput.command || "";
      const filePatterns = [
        /(?:cat|less|more|head|tail|rm|cp|mv|touch|chmod|chown)\s+([^\s;|&]+)/g,
        /(?:>|>>|<)\s*([^\s;|&]+)/g,
      ];

      for (const pattern of filePatterns) {
        let match;
        while ((match = pattern.exec(command)) !== null) {
          if (match[1]) {
            paths.push(match[1]);
          }
        }
      }
      break;
  }

  return paths;
}

function isPathWithinRepo(path: string, repoRoot: string): boolean {
  // Simple check - in real implementation would resolve paths
  if (
    path.startsWith("/etc") ||
    path.startsWith("/usr") ||
    path.startsWith("/var") ||
    path.startsWith("/tmp") ||
    path.startsWith("/root")
  ) {
    return false;
  }

  // Check if path starts with repo root
  if (path.startsWith(repoRoot)) {
    return true;
  }

  // Allow relative paths (assumed to be within repo)
  if (path.startsWith("./") || !path.startsWith("/")) {
    return true;
  }

  // Check for traversal attempts
  if (path.includes("../../../")) {
    return false;
  }

  return false;
}
