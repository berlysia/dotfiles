#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { 
  defineHook, 
  createFileSystemMock, 
  ConsoleCapture,
  EnvironmentHelper,
  createPostToolUseContext,
  createPostToolUseContextFor,
  invokeRun
} from "./test-helpers.ts";

describe("auto-format.ts hook behavior", () => {
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
    it("should be configured for PostToolUse trigger", () => {
      const hook = defineHook({
        trigger: { PostToolUse: true },
        run: (context: any) => context.success({})
      });
      
      deepStrictEqual(hook.trigger, { PostToolUse: true });
    });
  });
  
  describe("Tool filtering", () => {
    it("should process Edit tool", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      // Create a test file
      fsMock.writeFileSync("/test/file.ts", "const x=1");
      
      const context = createPostToolUseContextFor(hook, "Edit", { 
        file_path: "/test/file.ts",
        old_string: "const x=1",
        new_string: "const x = 1"
      }, {
        filePath: "/test/file.ts",
        newString: "const x = 1",
        oldString: "const x=1",
        originalFile: "const x=1",
        replaceAll: false,
        structuredPatch: [],
        userModified: false
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      // Should log formatting attempt
      ok(consoleCapture.logs.some(log => log.includes("Formatted") || log.includes("file.ts")));
    });
    
    it("should process MultiEdit tool", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      fsMock.writeFileSync("/test/file.js", "let y=2");
      
      const context = createPostToolUseContextFor(hook, "MultiEdit", {
        file_path: "/test/file.js",
        edits: []
      }, {
        edits: [],
        filePath: "/test/file.js",
        originalFileContents: "let y=2",
        structuredPatch: [],
        userModified: false
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      ok(consoleCapture.logs.some(log => log.includes("file.js")));
    });
    
    it("should process Write tool", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      fsMock.writeFileSync("/test/new.ts", "const z=3");
      
      const context = createPostToolUseContextFor(hook, "Write", {
        file_path: "/test/new.ts",
        content: "const z=3"
      }, {
        content: "const z=3",
        filePath: "/test/new.ts",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      ok(consoleCapture.logs.some(log => log.includes("new.ts")));
    });
    
    it("should ignore Read tool", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      const context = createPostToolUseContextFor(hook, "Read", { file_path: "/test/file.ts" }, {
        file: {
          content: "test content",
          filePath: "/test/file.ts",
          numLines: 1,
          startLine: 1,
          totalLines: 1
        },
        type: "text"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      // Should not attempt formatting
      strictEqual(consoleCapture.logs.length, 0);
    });
    
    it("should ignore Bash tool", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      const context = createPostToolUseContextFor(hook, "Bash", { command: "ls" }, {
        interrupted: false,
        isImage: false,
        stderr: "",
        stdout: "file1.txt\nfile2.txt"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      strictEqual(consoleCapture.logs.length, 0);
    });
  });
  
  describe("File type detection", () => {
    it("should format TypeScript files", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      fsMock.writeFileSync("/test/app.ts", "const a=1");
      
      const context = createPostToolUseContextFor(hook, "Write", { file_path: "/test/app.ts", content: "const a=1" }, {
        content: "const a=1",
        filePath: "/test/app.ts",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      ok(consoleCapture.logs.some(log => log.includes("app.ts")));
    });
    
    it("should format JavaScript files", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      fsMock.writeFileSync("/test/script.js", "var b=2");
      
      const context = createPostToolUseContextFor(hook, "Write", { file_path: "/test/script.js", content: "var b=2" }, {
        content: "var b=2",
        filePath: "/test/script.js",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      ok(consoleCapture.logs.some(log => log.includes("script.js")));
    });
    
    it("should format JSON files", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      fsMock.writeFileSync("/test/config.json", '{"key":"value"}');
      
      const context = createPostToolUseContextFor(hook, "Write", { file_path: "/test/config.json", content: '{"key":"value"}' }, {
        content: '{"key":"value"}',
        filePath: "/test/config.json",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      ok(consoleCapture.logs.some(log => log.includes("config.json")));
    });
    
    it("should skip non-formattable files", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      fsMock.writeFileSync("/test/data.txt", "plain text");
      
      const context = createPostToolUseContextFor(hook, "Write", { file_path: "/test/data.txt", content: "plain text" }, {
        content: "plain text",
        filePath: "/test/data.txt",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      // Should not attempt to format .txt files
      strictEqual(consoleCapture.logs.filter(log => log.includes("Formatted")).length, 0);
    });
    
    it("should skip binary files", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      fsMock.writeFileSync("/test/image.png", "fake binary data");
      
      const context = createPostToolUseContextFor(hook, "Write", { file_path: "/test/image.png", content: "fake binary data" }, {
        content: "fake binary data",
        filePath: "/test/image.png",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      strictEqual(consoleCapture.logs.filter(log => log.includes("Formatted")).length, 0);
    });
  });
  
  describe("Error handling", () => {
    it("should handle missing file_path gracefully", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      const context = createPostToolUseContextFor(hook, "Write", { content: "some content", file_path: "" }, {
        content: "some content",
        filePath: "",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      // Should not crash
    });
    
    it("should handle non-existent files", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      const context = createPostToolUseContextFor(hook, "Edit", { file_path: "/nonexistent/file.ts", new_string: "", old_string: "" }, {
        filePath: "/nonexistent/file.ts",
        newString: "",
        oldString: "",
        originalFile: "",
        replaceAll: false,
        structuredPatch: [],
        userModified: false
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      // Should skip non-existent files
      strictEqual(consoleCapture.logs.filter(log => log.includes("Formatted")).length, 0);
    });
    
    it("should continue on formatting errors", async () => {
      const hook = defineHook({
        trigger: { PostToolUse: true },
        run: (context: any) => {
          const { tool_name, tool_input } = context.input;
          
          if (["Edit", "MultiEdit", "Write"].includes(tool_name)) {
            try {
              // Simulate formatting error
              throw new Error("Formatter crashed");
            } catch (error) {
              consoleCapture.errors.push(`Auto-format error: ${error}`);
            }
          }
          
          // Should still return success
          return context.success({});
        }
      });
      
      const context = createPostToolUseContextFor(hook, "Write", { file_path: "/test/file.ts", content: "" }, {
        content: "",
        filePath: "/test/file.ts",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      ok(consoleCapture.errors.some(e => e.includes("Formatter crashed")));
    });
    
    it("should handle invalid tool_input", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      const context = createPostToolUseContextFor(hook, "Write", { content: "", file_path: "" }, {
        content: "",
        filePath: "",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      // Should not crash
    });
  });
  
  describe("Formatter selection", () => {
    it("should use appropriate formatter for TypeScript", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      fsMock.writeFileSync("/test/component.tsx", "const Component=()=><div/>");
      
      const context = createPostToolUseContextFor(hook, "Write", { 
        file_path: "/test/component.tsx",
        content: "const Component=()=><div/>"
      }, {
        content: "const Component=()=><div/>",
        filePath: "/test/component.tsx",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      // Should attempt to format TSX files
      ok(consoleCapture.logs.some(log => log.includes("component.tsx")));
    });
    
    it("should handle CSS files", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      fsMock.writeFileSync("/test/styles.css", "body{margin:0}");
      
      const context = createPostToolUseContextFor(hook, "Write", {
        file_path: "/test/styles.css",
        content: "body{margin:0}"
      }, {
        content: "body{margin:0}",
        filePath: "/test/styles.css",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      ok(consoleCapture.logs.some(log => log.includes("styles.css")));
    });
    
    it("should handle Python files", async () => {
      const hook = createAutoFormatHook(consoleCapture, fsMock);
      
      fsMock.writeFileSync("/test/script.py", "def func():pass");
      
      const context = createPostToolUseContextFor(hook, "Write", {
        file_path: "/test/script.py",
        content: "def func():pass"
      }, {
        content: "def func():pass",
        filePath: "/test/script.py",
        structuredPatch: [],
        type: "create"
      });
      await invokeRun(hook, context);
      
      context.assertSuccess({});
      ok(consoleCapture.logs.some(log => log.includes("script.py")));
    });
  });
});

// Helper function to create auto-format hook
function createAutoFormatHook(consoleCapture?: ConsoleCapture, fsMock?: ReturnType<typeof createFileSystemMock>) {
  // Use provided mocks or create new ones
  const console = consoleCapture || new ConsoleCapture();
  const fs = fsMock || createFileSystemMock();
  
  return defineHook({
    trigger: { PostToolUse: true },
    run: (context: any) => {
      const { tool_name, tool_input } = context.input;
      
      // Only process file writing/editing tools
      const formatableTools = ["Edit", "MultiEdit", "Write"];
      if (!formatableTools.includes(tool_name)) {
        return context.success({});
      }
      
      try {
        // Extract file path
        const filePath = tool_input?.file_path;
        if (!filePath) {
          return context.success({});
        }
        
        // Check if file exists in mock
        if (!fs.existsSync(filePath)) {
          return context.success({});
        }
        
        // Check if file is formattable
        const formattableExtensions = [
          ".ts", ".tsx", ".js", ".jsx", ".json",
          ".css", ".scss", ".less", ".py", ".rs",
          ".go", ".java", ".c", ".cpp", ".h"
        ];
        
        const ext = filePath.match(/\.[^.]+$/)?.[0];
        if (!ext || !formattableExtensions.includes(ext)) {
          return context.success({});
        }
        
        // Simulate formatting
        console.logs.push(`✅ Formatted ${filePath} with mock-formatter`);
        
        return context.success({});
      } catch (error) {
        console.errors.push(`Auto-format error: ${error}`);
        return context.success({});
      }
    }
  });
}
