#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";
import { resolve } from "node:path";

/**
 * Deny writing to node_modules directories
 * Converted from deny-node-modules-write.ts using cc-hooks-ts
 */
export default defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { toolName, toolInput } = context.event;

    // Only process file writing tools
    const writeTools = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
    if (!writeTools.includes(toolName)) {
      return context.success({});
    }

    try {
      // Extract file path from tool input
      const filePath = extractFilePath(toolName, toolInput);
      if (!filePath) {
        return context.success({});
      }

      // Check if path is in node_modules
      const validation = validateNodeModulesAccess(filePath);
      if (!validation.isAllowed) {
        return context.blockingError(
          `Write access denied: ${validation.reason}\nPath: ${validation.resolvedPath}`
        );
      }

      return context.success({});

    } catch (error) {
      return context.blockingError(`Error in node_modules access check: ${error}`);
    }
  }
});

interface NodeModulesValidationResult {
  isAllowed: boolean;
  resolvedPath: string;
  reason?: string;
}

function extractFilePath(toolName: string, toolInput: any): string | null {
  switch (toolName) {
    case "Write":
      return toolInput.file_path || null;
      
    case "Edit":
    case "MultiEdit":
      return toolInput.file_path || null;
      
    case "NotebookEdit":
      return toolInput.notebook_path || null;
      
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
}