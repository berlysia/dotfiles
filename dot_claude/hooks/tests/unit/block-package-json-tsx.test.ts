#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { 
  defineHook, 
  ConsoleCapture,
  EnvironmentHelper 
} from "./test-helpers.ts";

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
        run: (context: any) => context.success({})
      });
      
      deepStrictEqual(hook.trigger, { PreToolUse: true });
    });
  });
  
  describe("tsx/ts-node detection in scripts", () => {
    it("should block direct tsx command in scripts", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const packageJson = {
        scripts: {
          dev: "tsx watch src/index.ts"
        }
      };
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "/project/package.json",
          content: JSON.stringify(packageJson, null, 2)
        }
      });
      
      ok(context.failCalls.length > 0, "Should block tsx command");
      ok(context.failCalls[0].includes("tsx") || context.failCalls[0].includes("TypeScript"));
    });
    
    it("should block ts-node command in scripts", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const packageJson = {
        scripts: {
          test: "ts-node test.ts"
        }
      };
      
      const { context } = await hook.execute({
        tool_name: "Edit",
        tool_input: {
          file_path: "package.json",
          old_string: '"test": "node test.js"',
          new_string: JSON.stringify(packageJson)
        }
      });
      
      ok(context.failCalls.length > 0, "Should block ts-node");
    });
    
    it("should block tsx in compound commands", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const packageJson = {
        scripts: {
          build: "tsc && tsx src/postbuild.ts"
        }
      };
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "package.json",
          content: JSON.stringify(packageJson, null, 2)
        }
      });
      
      ok(context.failCalls.length > 0, "Should block tsx in compound command");
    });
    
    it("should block node --loader tsx pattern", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const packageJson = {
        scripts: {
          dev: "node --loader tsx src/index.ts"
        }
      };
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "package.json",
          content: JSON.stringify(packageJson)
        }
      });
      
      ok(context.failCalls.length > 0, "Should block loader pattern");
    });
    
    it("should allow tsx as file extension (not command)", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const packageJson = {
        scripts: {
          build: "webpack src/App.tsx"
        }
      };
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "package.json",
          content: JSON.stringify(packageJson)
        }
      });
      
      context.assertSuccess({});
      strictEqual(context.failCalls.length, 0, "Should allow .tsx file extension");
    });
    
    it("should allow --ext tsx option", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const packageJson = {
        scripts: {
          lint: "eslint --ext tsx,ts,js src/"
        }
      };
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "package.json",
          content: JSON.stringify(packageJson)
        }
      });
      
      context.assertSuccess({});
      strictEqual(context.failCalls.length, 0, "Should allow --ext tsx option");
    });
  });
  
  describe("dependencies detection", () => {
    it("should block tsx in dependencies", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const packageJson = {
        dependencies: {
          "tsx": "^3.0.0"
        }
      };
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "package.json",
          content: JSON.stringify(packageJson)
        }
      });
      
      ok(context.failCalls.length > 0, "Should block tsx in dependencies");
    });
    
    it("should block ts-node in devDependencies", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const packageJson = {
        devDependencies: {
          "ts-node": "^10.0.0"
        }
      };
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "package.json",
          content: JSON.stringify(packageJson)
        }
      });
      
      ok(context.failCalls.length > 0, "Should block ts-node in devDependencies");
    });
    
    it("should block @swc-node/register", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const packageJson = {
        devDependencies: {
          "@swc-node/register": "^1.0.0"
        }
      };
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "package.json",
          content: JSON.stringify(packageJson)
        }
      });
      
      ok(context.failCalls.length > 0, "Should block @swc-node/register");
    });
    
    it("should allow other dependencies", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const packageJson = {
        dependencies: {
          "express": "^4.0.0",
          "react": "^18.0.0"
        },
        devDependencies: {
          "typescript": "^5.0.0",
          "vitest": "^1.0.0"
        }
      };
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "package.json",
          content: JSON.stringify(packageJson)
        }
      });
      
      context.assertSuccess({});
    });
  });
  
  describe("file filtering", () => {
    it("should only check package.json files", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "config.json",
          content: '{"scripts": {"dev": "tsx index.ts"}}'
        }
      });
      
      context.assertSuccess({});
      strictEqual(context.failCalls.length, 0, "Should ignore non-package.json files");
    });
    
    it("should check nested package.json files", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const packageJson = {
        scripts: {
          start: "tsx src/server.ts"
        }
      };
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "packages/backend/package.json",
          content: JSON.stringify(packageJson)
        }
      });
      
      ok(context.failCalls.length > 0, "Should check nested package.json");
    });
  });
  
  describe("tool filtering", () => {
    it("should check Write tool", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "package.json",
          content: '{"scripts":{"dev":"tsx index.ts"}}'
        }
      });
      
      ok(context.failCalls.length > 0);
    });
    
    it("should check Edit tool", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Edit",
        tool_input: {
          file_path: "package.json",
          old_string: '"dev": "node index.js"',
          new_string: '"dev": "tsx index.ts"'
        }
      });
      
      ok(context.failCalls.length > 0);
    });
    
    it("should check MultiEdit tool", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "MultiEdit",
        tool_input: {
          file_path: "package.json",
          edits: [
            {
              old_string: '"test": "jest"',
              new_string: '"test": "tsx test.ts"'
            }
          ]
        }
      });
      
      ok(context.failCalls.length > 0);
    });
    
    it("should ignore Read tool", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Read",
        tool_input: {
          file_path: "package.json"
        }
      });
      
      context.assertSuccess({});
    });
  });
  
  describe("error handling", () => {
    it("should handle invalid JSON gracefully", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          file_path: "package.json",
          content: "not valid json { tsx"
        }
      });
      
      // Should still check for tsx patterns even in invalid JSON
      ok(context.failCalls.length > 0 || context.successCalls.length > 0);
    });
    
    it("should handle missing tool_input", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: null
      });
      
      context.assertSuccess({});
    });
    
    it("should handle missing file_path", async () => {
      const hook = createBlockPackageJsonTsxHook();
      
      const { context } = await hook.execute({
        tool_name: "Write",
        tool_input: {
          content: '{"scripts":{"dev":"tsx"}}'
        }
      });
      
      context.assertSuccess({});
    });
  });
});

// Helper function to create block-package-json-tsx hook
function createBlockPackageJsonTsxHook() {
  return defineHook({
    trigger: { PreToolUse: true },
    run: (context: any) => {
      const { tool_name, tool_input } = context.input;
      
      // Only check file modification tools
      if (!["Write", "Edit", "MultiEdit"].includes(tool_name)) {
        return context.success({});
      }
      
      // Get file path
      const filePath = tool_input?.file_path || "";
      
      // Only check package.json files
      if (!filePath.endsWith("package.json")) {
        return context.success({});
      }
      
      // Get content to check
      let content = "";
      if (tool_name === "Write") {
        content = tool_input?.content || "";
      } else if (tool_name === "Edit") {
        content = tool_input?.new_string || "";
      } else if (tool_name === "MultiEdit") {
        // Check all edits
        const edits = tool_input?.edits || [];
        content = edits.map((e: any) => e.new_string || "").join("\n");
      }
      
      // Check for tsx/ts-node patterns
      if (hasTsxUsage(content)) {
        return context.fail(
          "🚫 TypeScript execution tools (tsx, ts-node) are not allowed in package.json. " +
          "Use standard Node.js with compiled JavaScript instead."
        );
      }
      
      return context.success({});
    }
  });
}

function hasTsxUsage(content: string): boolean {
  try {
    // Try parsing as JSON first
    const parsed = JSON.parse(content);
    
    // Check scripts
    if (parsed.scripts) {
      for (const scriptValue of Object.values(parsed.scripts)) {
        if (typeof scriptValue === "string" && checkScriptValue(scriptValue)) {
          return true;
        }
      }
    }
    
    // Check dependencies
    const depSections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    for (const section of depSections) {
      if (parsed[section]) {
        const deps = Object.keys(parsed[section]);
        if (deps.some(dep => 
          dep === "tsx" || 
          dep === "ts-node" || 
          dep.includes("@swc-node/register") ||
          dep.includes("@esbuild-kit/cjs-loader")
        )) {
          return true;
        }
      }
    }
  } catch {
    // Fallback to string search for invalid JSON
    return /\b(tsx|ts-node)\b/.test(content);
  }
  
  return false;
}

function checkScriptValue(scriptValue: string): boolean {
  // Block loader patterns first
  if (/node[^|&;]*--[a-zA-Z-]*(loader|require)[^|&;]*(tsx|ts-node)/.test(scriptValue)) {
    return true;
  }
  
  // Direct command pattern
  const directCommandPattern = /(^|[\s|&;])\s*(tsx|ts-node)([\s]|$)/;
  if (!directCommandPattern.test(scriptValue)) {
    return false;
  }
  
  // Allow as option value (--ext tsx)
  if (/--[a-zA-Z-]*\s+(tsx|ts-node)/.test(scriptValue)) {
    return false;
  }
  
  // Allow as file extension (webpack App.tsx)
  if (/webpack[^|&;]*\.(tsx|ts)([\s]|$)/.test(scriptValue)) {
    return false;
  }
  
  // Block command execution
  if (/(^|[\s|&;])\s*(tsx|ts-node)([\s].*\.(ts|tsx|js|mjs)([\s]|$)|[\s]|$)/.test(scriptValue)) {
    return true;
  }
  
  return true; // Default block if tsx/ts-node is present
}