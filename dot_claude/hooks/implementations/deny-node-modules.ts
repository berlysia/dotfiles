#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { resolve } from "node:path";
import { createDenyResponse } from "../lib/context-helpers.ts";

/**
 * Deny writing to node_modules directories
 * Converted from deny-node-modules-write.ts using cc-hooks-ts
 */
const hook = defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;

    // Only process file writing tools
    const writeTools = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
    if (!writeTools.includes(tool_name)) {
      return context.success({});
    }

    try {
      // Extract file path from tool input
      const filePath = extractFilePath(tool_name, tool_input);
      if (!filePath) {
        return context.success({});
      }

      // Check if path is in node_modules
      const validation = validateNodeModulesAccess(filePath);
      if (!validation.isAllowed) {
        return context.json(createDenyResponse(
          `Write access denied: ${validation.reason}\nPath: ${validation.resolvedPath}`
        ));
      }

      return context.success({});

    } catch (error) {
      return context.json(createDenyResponse(`Error in node_modules access check: ${error}`));
    }
  }
});

interface NodeModulesValidationResult {
  isAllowed: boolean;
  resolvedPath: string;
  reason?: string;
}

function extractFilePath(tool_name: string, tool_input: any): string | null {
  switch (tool_name) {
    case "Write":
      return tool_input.file_path || null;
      
    case "Edit":
    case "MultiEdit":
      return tool_input.file_path || null;
      
    case "NotebookEdit":
      return tool_input.notebook_path || null;
      
    default:
      return null;
  }
}

function validateNodeModulesAccess(filePath: string): NodeModulesValidationResult {
  // Resolve to absolute path
  const resolvedPath = resolve(filePath);
  
  // Check if path contains node_modules
  if (resolvedPath.includes("/node_modules/")) {
    return {
      isAllowed: false,
      resolvedPath,
      reason: "Direct modification of node_modules files is not allowed. Use package manager commands instead."
    };
  }

  // Check if path is directly named node_modules
  if (resolvedPath.endsWith("/node_modules") || resolvedPath.includes("/node_modules")) {
    return {
      isAllowed: false,
      resolvedPath,
      reason: "Direct modification of node_modules directory is not allowed. Use package manager commands instead."
    };
  }

  // Allow all other paths
  return {
    isAllowed: true,
    resolvedPath
  };
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
