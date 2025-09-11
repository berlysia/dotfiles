import { describe, it } from "node:test";
import { strictEqual } from "node:assert";
import { checkPattern, matchGitignorePattern } from "../../lib/pattern-matcher.ts";

describe("Pattern matching validation", () => {
  it("should reject Bash(**) pattern", async () => {
    const result = await checkPattern("Bash(**)", "Bash", { command: "echo hello" });
    strictEqual(result, false, "Bash(**) should be rejected");
  });
  
  it("should accept valid Bash patterns", async () => {
    const result1 = await checkPattern("Bash(echo:*)", "Bash", { command: "echo hello world" });
    strictEqual(result1, true, "Bash(echo:*) should match echo commands");
    
    const result2 = await checkPattern("Bash(npm:*)", "Bash", { command: "npm install lodash" });
    strictEqual(result2, true, "Bash(npm:*) should match npm commands");
  });
  
  it("should accept Read(**) pattern", async () => {
    const result = await checkPattern("Read(**)", "Read", { file_path: "/any/path/file.txt" });
    strictEqual(result, true, "Read(**) should match all files");
  });
  
  it("should accept Edit(**) pattern", async () => {
    const result = await checkPattern("Edit(**)", "Edit", { 
      file_path: "/any/path/file.txt",
      old_string: "old",
      new_string: "new"
    });
    strictEqual(result, true, "Edit(**) should match all files");
  });
  
  it("should handle gitignore-style patterns correctly", async () => {
    // Test basic ** pattern
    strictEqual(matchGitignorePattern("/path/to/file.txt", "**"), true, "** should match everything");
    
    // Test directory patterns
    strictEqual(matchGitignorePattern("/src/components/Button.tsx", "src/**"), true, "src/** should match files in src/");
    strictEqual(matchGitignorePattern("/lib/utils.ts", "src/**"), false, "src/** should not match files outside src/");
    
    // Test file extension patterns
    strictEqual(matchGitignorePattern("/path/file.ts", "*.ts"), true, "*.ts should match TypeScript files");
    strictEqual(matchGitignorePattern("/path/file.js", "*.ts"), false, "*.ts should not match JavaScript files");
    
    // Test negation patterns
    const result = await checkPattern("Edit(!node_modules/**)", "Edit", { 
      file_path: "/project/node_modules/package/index.js",
      old_string: "old", 
      new_string: "new" 
    });
    strictEqual(result, false, "!node_modules/** should exclude node_modules files");
  });
  
  it("should handle tool name exact matching", async () => {
    const result1 = await checkPattern("Read", "Read", { file_path: "/path/file.txt" });
    strictEqual(result1, true, "Tool name should match exactly");
    
    const result2 = await checkPattern("Read", "Write", { file_path: "/path/file.txt" });
    strictEqual(result2, false, "Tool name should not match different tool");
  });
});