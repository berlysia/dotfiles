#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { createDenyResponse } from "../lib/context-helpers.ts";

/**
 * Check for tsx/ts-node patterns in script values using precise regex
 */
function checkScriptValue(scriptValue: string): boolean {
  // Pattern 1: Direct command usage (tsx, ts-node at start or after separators)
  const directCommandPattern = /(^|[\s|&;])\s*(tsx|ts-node)([\s]|$)/;
  if (!directCommandPattern.test(scriptValue)) {
    return false; // No tsx/ts-node command found
  }

  // Allow common cases where tsx is file extension or safe option value
  // Check if it's in a context where tsx/ts-node is used as a command
  
  // Allow: --ext tsx, --extension tsx (file extension/option value)
  const optionValuePattern = /--[a-zA-Z-]*\s+(tsx|ts-node)/;
  if (optionValuePattern.test(scriptValue)) {
    return false;
  }

  // Allow: webpack src/App.tsx (file path)
  const webpackFilePattern = /webpack[^|&;]*\.(tsx|ts)([\s]|$)/;
  if (webpackFilePattern.test(scriptValue)) {
    return false;
  }

  // Block command execution patterns
  const commandExecutionPattern = /(^|[\s|&;])\s*(tsx|ts-node)([\s].*\.(ts|tsx|js|mjs)([\s]|$)|[\s]|$)/;
  if (commandExecutionPattern.test(scriptValue)) {
    return true;
  }

  // Block loader patterns
  const loaderPattern = /node[^|&;]*--[a-zA-Z-]*(loader|require)[^|&;]*(tsx|ts-node)/;
  if (loaderPattern.test(scriptValue)) {
    return true;
  }

  return false;
}

/**
 * Check for tsx/ts-node usage in package.json content with enhanced precision
 */
function hasTsxUsage(content: string): boolean {
  try {
    // Try JSON parsing first for precise checking
    const parsed = JSON.parse(content);
    
    // Check scripts section
    if (parsed.scripts) {
      for (const [, scriptValue] of Object.entries(parsed.scripts)) {
        if (typeof scriptValue === 'string' && checkScriptValue(scriptValue)) {
          return true;
        }
      }
    }

    // Check dependencies sections
    const depSections = ['dependencies', 'devDependencies', 'peerDependencies'];
    for (const section of depSections) {
      if (parsed[section]) {
        const deps = Object.keys(parsed[section]);
        if (deps.includes('tsx') || deps.includes('ts-node') || deps.includes('@types/tsx') || deps.includes('@types/ts-node')) {
          return true;
        }
      }
    }

    return false;
  } catch {
    // Fallback to regex if JSON parsing fails
    if (/\"scripts\"/.test(content)) {
      const scriptSectionMatch = content.match(/"scripts"\s*:\s*\{([^}]*)\}/);
      if (scriptSectionMatch && scriptSectionMatch[1]) {
        const scriptContent = scriptSectionMatch[1];
        const scriptValuePattern = /"[^"]*":\s*"([^"]*)"/g;
        let match;
        while ((match = scriptValuePattern.exec(scriptContent)) !== null) {
          const scriptValue = match[1];
          if (scriptValue && checkScriptValue(scriptValue)) {
            return true;
          }
        }
      }
    }

    // Check dependencies with regex fallback
    const depPattern = /"(tsx|ts-node|@types\/tsx|@types\/ts-node)"\s*:\s*"[^"]*"/;
    return depPattern.test(content);
  }
}

/**
 * Block tsx/ts-node usage in package.json modifications
 * Enhanced with precise detection logic from legacy implementation
 */
const hook = defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;

    // Only process file writing/editing tools
    const editTools = ["Write", "Edit", "MultiEdit"];
    if (!editTools.includes(tool_name)) {
      return context.success({});
    }

  try {
      // Narrow by discriminant tool_name for proper types
      let filePath = "";
      let contentToCheck = "";

      if (tool_name === "Write") {
        filePath = tool_input.file_path;
        contentToCheck = tool_input.content || "";
      } else if (tool_name === "Edit") {
        filePath = tool_input.file_path;
        contentToCheck = tool_input.new_string || "";
      } else if (tool_name === "MultiEdit") {
        filePath = tool_input.file_path;
        const edits = tool_input.edits || [];
        for (const edit of edits) {
          contentToCheck += (edit.new_string || "") + "\n";
        }
      } else {
        return context.success({});
      }
      
      // Only check package.json files
      if (!filePath.endsWith("/package.json") && !filePath.endsWith("package.json")) {
        return context.success({});
      }

      // Use precise script value checking logic from legacy implementation
      if (hasTsxUsage(contentToCheck)) {
        return context.json(createDenyResponse(
          `Use TypeScript-compatible runtime instead of 'tsx' or 'ts-node' in package.json scripts\n\nSuggestion: Replace tsx/ts-node commands with a TypeScript-compatible runtime (e.g., node, deno, bun)\n\nFile: ${filePath}`
        ));
      }

      // Allow if no problematic patterns found
      return context.success({});

    } catch (error) {
      return context.json(createDenyResponse(`Error in package.json tsx check: ${error}`));
    }
  }
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
