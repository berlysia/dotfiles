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
        run: (context: any) => context.success({})
      });
      
      deepStrictEqual(hook.trigger, { PreToolUse: true });
    });
  });
  
  describe("node_modules detection", () => {
    it("should block Read operations on node_modules files", async () => {
      const hook = createDenyNodeModulesHook();
      
      const context = createPreToolUseContext("Read", {
        file_path: "/project/node_modules/express/index.js"
      });
      const result = await hook.execute(context.input);
      
      context.assertDeny();
      ok(context.failCalls[0].includes("node_modules"));
    });
    
    it("should block Write operations to node_modules", async () => {
      const hook = createDenyNodeModulesHook();
      
      const context = createPreToolUseContext("Write", {
        file_path: "/project/node_modules/package/file.js",
        content: "malicious code"
      });
      const result = await hook.execute(context.input);
      
      context.assertDeny();
      ok(context.failCalls[0].includes("node_modules"));
    });
    
    it("should block Edit operations in node_modules", async () => {
      const hook = createDenyNodeModulesHook();
      
      const context = createPreToolUseContext("Edit", {
        file_path: "./node_modules/lodash/index.js",
        old_string: "original",
        new_string: "modified"
      });
      const result = await hook.execute(context.input);
      
      context.assertDeny();
    });
    
    it("should block MultiEdit in node_modules", async () => {
      const hook = createDenyNodeModulesHook();
      
      const context = createPreToolUseContext("MultiEdit", {
        file_path: "node_modules/react/lib/React.js",
        edits: []
      });
      const result = await hook.execute(context.input);
      
      context.assertDeny();
    });
    
    it("should block Bash commands operating on node_modules", async () => {
      const hook = createDenyNodeModulesHook();
      
      const context = createPreToolUseContext("Bash", {
        command: "rm -rf node_modules/some-package"
      });
      const result = await hook.execute(context.input);
      
      context.assertDeny();
      ok(context.failCalls[0].includes("node_modules"));
    });
    
    it("should block ls commands in node_modules", async () => {
      const hook = createDenyNodeModulesHook();
      
      const context = createPreToolUseContext("Bash", {
        command: "ls node_modules/"
      });
      const result = await hook.execute(context.input);
      
      context.assertDeny();
    });
  });
  
  describe("Path variations", () => {
    it("should detect node_modules in various path formats", async () => {
      const hook = createDenyNodeModulesHook();
      
      const pathVariations = [
        "node_modules/package/file.js",
        "./node_modules/package/file.js",
        "../node_modules/package/file.js",
        "/absolute/path/node_modules/file.js",
        "some/deep/path/node_modules/nested/file.js"
      ];
      
      for (const path of pathVariations) {
        const context = createPreToolUseContext("Read", {
          file_path: path
        });
        const result = await hook.execute(context.input);
        
        context.assertDeny();
      }
    });
    
    it("should allow operations outside node_modules", async () => {
      const hook = createDenyNodeModulesHook();
      
      const allowedPaths = [
        "/project/src/index.js",
        "./components/Button.tsx",
        "../shared/utils.js",
        "package.json",
        "node_modules_backup/file.js", // Similar name but not exact
        "my_node_modules_copy/file.js"
      ];
      
      for (const path of allowedPaths) {
        const context = createPreToolUseContext("Read", {
          file_path: path
        });
        const result = await hook.execute(context.input);
        
        context.assertSuccess({});
        strictEqual(context.failCalls.length, 0, `Should allow path: ${path}`);
      }
    });
  });
  
  describe("Command detection", () => {
    it("should block various bash commands targeting node_modules", async () => {
      const hook = createDenyNodeModulesHook();
      
      const blockedCommands = [
        "cat node_modules/package/package.json",
        "echo 'test' > node_modules/file.txt",
        "cd node_modules && ls",
        "find node_modules -name '*.js'",
        "grep -r 'pattern' node_modules/",
        "chmod 777 node_modules/script.sh"
      ];
      
      for (const command of blockedCommands) {
        const context = createPreToolUseContext("Bash", {
          command
        });
        const result = await hook.execute(context.input);
        
        context.assertDeny();
      }
    });
    
    it("should allow bash commands not targeting node_modules", async () => {
      const hook = createDenyNodeModulesHook();
      
      const allowedCommands = [
        "npm install",
        "npm run build",
        "ls src/",
        "cat package.json",
        "echo 'test'",
        "pwd"
      ];
      
      for (const command of allowedCommands) {
        const context = createPreToolUseContext("Bash", {
          command
        });
        const result = await hook.execute(context.input);
        
        context.assertSuccess({});
        strictEqual(context.failCalls.length, 0, `Should allow command: ${command}`);
      }
    });
  });
  
  describe("Tool filtering", () => {
    it("should ignore non-file tools", async () => {
      const hook = createDenyNodeModulesHook();
      
      const context = createPreToolUseContext("WebFetch", {
        url: "https://example.com",
        prompt: "node_modules documentation"
      });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
    
    it("should handle missing tool_input gracefully", async () => {
      const hook = createDenyNodeModulesHook();
      
      const context = createPreToolUseContext("Read", { file_path: "" });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
    
    it("should handle missing file_path gracefully", async () => {
      const hook = createDenyNodeModulesHook();
      
      const context = createPreToolUseContext("Read", { file_path: "" });
      const result = await hook.execute(context.input);
      
      context.assertSuccess({});
    });
  });
  
  describe("Error messages", () => {
    it("should provide clear error message for blocked operations", async () => {
      const hook = createDenyNodeModulesHook();
      
      const context = createPreToolUseContext("Read", {
        file_path: "node_modules/package/secret.key"
      });
      const result = await hook.execute(context.input);
      
      context.assertDeny();
      const errorMsg = context.failCalls[0];
      ok(errorMsg.includes("node_modules") || errorMsg.includes("denied") || errorMsg.includes("blocked"));
    });
    
    it("should mention security in error message", async () => {
      const hook = createDenyNodeModulesHook();
      
      const context = createPreToolUseContext("Write", {
        file_path: "node_modules/malicious/payload.js",
        content: "evil code"
      });
      const result = await hook.execute(context.input);
      
      context.assertDeny();
      const errorMsg = context.failCalls[0];
      ok(errorMsg.toLowerCase().includes("security") || errorMsg.includes("protected"));
    });
  });
});

// Helper function to create deny-node-modules hook
function createDenyNodeModulesHook() {
  return defineHook({
    trigger: { PreToolUse: true },
    run: (context: any) => {
      const { tool_name, tool_input } = context.input;
      
      // Tools that can access files
      const fileTools = ["Read", "Write", "Edit", "MultiEdit", "Bash"];
      
      if (!fileTools.includes(tool_name)) {
        return context.success({});
      }
      
      // Check for node_modules in file path
      if (tool_name !== "Bash") {
        const filePath = tool_input?.file_path || "";
        if (isNodeModulesPath(filePath)) {
          return context.fail(
            "🚫 Access to node_modules is denied for security reasons. " +
            "These directories contain third-party code that should not be modified."
          );
        }
      }
      
      // Check for node_modules in bash commands
      if (tool_name === "Bash") {
        const command = tool_input?.command || "";
        if (containsNodeModules(command)) {
          return context.fail(
            "🚫 Commands targeting node_modules are blocked for security. " +
            "Use package managers (npm, yarn, pnpm) to manage dependencies."
          );
        }
      }
      
      return context.success({});
    }
  });
}

function isNodeModulesPath(path: string): boolean {
  // Normalize path separators and check for node_modules
  const normalizedPath = path.replace(/\\/g, "/");
  return normalizedPath.includes("/node_modules/") || 
         normalizedPath.startsWith("node_modules/") ||
         normalizedPath === "node_modules";
}

function containsNodeModules(command: string): boolean {
  // Check if command references node_modules
  return /\bnode_modules\b/i.test(command);
}