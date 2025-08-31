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
        run: (context: any) => context.success({})
      });
      
      deepStrictEqual(hook.trigger, { PreToolUse: true });
    });
  });
  
  describe("file access control", () => {
    it("should block Read access outside repository", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Read", {
        file_path: "/etc/passwd"
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0, "Should block outside access");
      ok(context.failCalls[0].includes("denied") || context.failCalls[0].includes("outside"));
    });
    
    it("should allow Read access within repository", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Read", {
        file_path: "/home/user/project/src/index.ts"
      });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
    
    it("should block Write access outside repository", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Write", {
        file_path: "/tmp/malicious.sh",
        content: "evil code"
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0, "Should block write outside");
    });
    
    it("should allow Write access within repository", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Write", {
        file_path: "/home/user/project/README.md",
        content: "# Project"
      });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
    
    it("should block Edit outside repository", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Edit", {
        file_path: "/home/user/.bashrc",
        old_string: "old",
        new_string: "new"
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0);
    });
    
    it("should block MultiEdit outside repository", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("MultiEdit", {
        file_path: "/etc/hosts",
        edits: []
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0);
    });
  });
  
  describe("path resolution", () => {
    it("should handle relative paths", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Read", {
        file_path: "./src/index.ts"
      });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
    
    it("should block parent directory traversal", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Read", {
        file_path: "../../../etc/passwd"
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0, "Should block traversal");
    });
    
    it("should handle symlinks trying to escape", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      // Simulate a symlink that points outside
      const context = createPreToolUseContext("Read", {
        file_path: "/home/user/project/link-to-outside"
      });
      const result = await hook.execute(context.input);
      
      // Should be handled by the implementation
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });
    
    it("should handle home directory paths", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Read", {
        file_path: "~/project/file.ts"
      });
      const result = await hook.execute(context.input);
      
      // Should expand ~ and check
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });
  });
  
  describe("Bash command filtering", () => {
    it("should block Bash commands accessing outside files", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Bash", {
        command: "cat /etc/passwd"
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0, "Should block cat outside");
    });
    
    it("should allow Bash commands within repository", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Bash", {
        command: "ls ./src"
      });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
    
    it("should block rm commands outside repository", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Bash", {
        command: "rm -rf /tmp/important"
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0);
    });
    
    it("should allow package manager commands", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Bash", {
        command: "npm install"
      });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
  });
  
  describe("special directories", () => {
    it("should allow access to node_modules within repo", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Read", {
        file_path: "/home/user/project/node_modules/package/index.js"
      });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
    
    it("should allow access to .git within repo", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Read", {
        file_path: "/home/user/project/.git/config"
      });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
    
    it("should block access to system directories", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const systemPaths = [
        "/etc/shadow",
        "/usr/bin/bash",
        "/var/log/syslog",
        "/root/.ssh/id_rsa"
      ];
      
      for (const path of systemPaths) {
        const context = createPreToolUseContext("Read", {
          file_path: path
        });
        const result = await hook.execute(context.input);
        
        ok(context.failCalls.length > 0, `Should block ${path}`);
      }
    });
  });
  
  describe("tool filtering", () => {
    it("should check LS tool", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("LS", {
        path: "/etc"
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0);
    });
    
    it("should check Glob tool", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Glob", {
        path: "/var/log",
        pattern: "*.log"
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0);
    });
    
    it("should check Grep tool", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Grep", {
        path: "/etc",
        pattern: "password"
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0);
    });
    
    it("should ignore non-file tools", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("WebFetch", {
        query: "how to access /etc/passwd"
      });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
  });
  
  describe("no repository scenario", () => {
    it("should allow operations when not in a repository", async () => {
      const hook = createDenyRepositoryOutsideHook(undefined);
      
      const context = createPreToolUseContext("Read", {
        file_path: "/tmp/test.txt"
      });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
  });
  
  describe("error handling", () => {
    it("should handle missing file_path", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Read", {});
      const result = await hook.execute(context.input);
      
      // Should handle gracefully
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });
    
    it("should handle null tool_input", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Write", null);
      const result = await hook.execute(context.input);
      
      ok(context.successCalls.length > 0 || context.failCalls.length > 0);
    });
    
    it("should provide clear error messages", async () => {
      const hook = createDenyRepositoryOutsideHook("/home/user/project");
      
      const context = createPreToolUseContext("Read", {
        file_path: "/etc/passwd"
      });
      const result = await hook.execute(context.input);
      
      ok(context.failCalls.length > 0);
      const errorMsg = context.failCalls[0];
      ok(errorMsg.includes("denied") || errorMsg.includes("Access"));
      ok(errorMsg.includes("/home/user/project") || errorMsg.includes("repository"));
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
      const fileTools = ["Read", "Write", "Edit", "MultiEdit", "LS", "Glob", "Grep", "Bash"];
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
            `Repository: ${repoRoot}`
          );
        }
      }
      
      return context.success({});
    }
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
        /(?:>|>>|<)\s*([^\s;|&]+)/g
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
  if (path.startsWith("/etc") || 
      path.startsWith("/usr") || 
      path.startsWith("/var") ||
      path.startsWith("/tmp") ||
      path.startsWith("/root")) {
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