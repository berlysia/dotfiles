#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";

/**
 * Block tsx/ts-node usage in package.json modifications
 * Converted from block-tsx-package-json.ts using cc-hooks-ts
 */
export default defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { toolName, toolInput } = context.event;

    // Only process file writing/editing tools
    const editTools = ["Write", "Edit", "MultiEdit"];
    if (!editTools.includes(toolName)) {
      return context.success({});
    }

    try {
      // Extract file path
      const filePath = toolInput.file_path || "";
      
      // Only check package.json files
      if (!filePath.endsWith("/package.json") && !filePath.endsWith("package.json")) {
        return context.success({});
      }

      // Get content to check
      let contentToCheck = "";
      
      if (toolName === "Write") {
        contentToCheck = toolInput.content || "";
      } else if (toolName === "Edit") {
        contentToCheck = toolInput.new_string || "";
      } else if (toolName === "MultiEdit") {
        // Check all edits
        const edits = toolInput.edits || [];
        for (const edit of edits) {
          contentToCheck += (edit.new_string || "") + "\n";
        }
      }

      // Check for tsx/ts-node usage patterns
      const blockingPatterns = [
        {
          pattern: /["']\s*tsx\s+/,
          reason: "Use 'bun' instead of 'tsx' in package.json scripts",
          suggestion: "Replace 'tsx script.ts' with 'bun script.ts'"
        },
        {
          pattern: /["']\s*ts-node\s+/,
          reason: "Use 'bun' instead of 'ts-node' in package.json scripts",
          suggestion: "Replace 'ts-node script.ts' with 'bun script.ts'"
        },
        {
          pattern: /["']\s*npx\s+tsx\s+/,
          reason: "Use 'bun' instead of 'npx tsx' in package.json scripts",
          suggestion: "Replace 'npx tsx script.ts' with 'bun script.ts'"
        },
        {
          pattern: /["']\s*npx\s+ts-node\s+/,
          reason: "Use 'bun' instead of 'npx ts-node' in package.json scripts",
          suggestion: "Replace 'npx ts-node script.ts' with 'bun script.ts'"
        },
        {
          pattern: /"tsx":\s*["']/,
          reason: "Adding 'tsx' as dependency is discouraged. Use 'bun' for TypeScript execution",
          suggestion: "Remove tsx dependency. Bun provides built-in TypeScript support"
        },
        {
          pattern: /"ts-node":\s*["']/,
          reason: "Adding 'ts-node' as dependency is discouraged. Use 'bun' for TypeScript execution",
          suggestion: "Remove ts-node dependency. Bun provides built-in TypeScript support"
        },
        {
          pattern: /"@types\/tsx":\s*["']/,
          reason: "Types for 'tsx' are not needed when using 'bun'",
          suggestion: "Remove @types/tsx dependency"
        },
        {
          pattern: /"@types\/ts-node":\s*["']/,
          reason: "Types for 'ts-node' are not needed when using 'bun'",
          suggestion: "Remove @types/ts-node dependency"
        },
      ];

      // Check each pattern
      for (const { pattern, reason, suggestion } of blockingPatterns) {
        if (pattern.test(contentToCheck)) {
          const matchedContent = contentToCheck.match(pattern)?.[0] || "unknown";
          return context.blockingError(
            `${reason}\n\nSuggestion: ${suggestion}\n\nMatched content: ${matchedContent}\nFile: ${filePath}`
          );
        }
      }

      // Allow if no problematic patterns found
      return context.success({});

    } catch (error) {
      return context.blockingError(`Error in package.json tsx check: ${error}`);
    }
  }
});