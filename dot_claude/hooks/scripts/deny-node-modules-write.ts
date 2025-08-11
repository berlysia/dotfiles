#!/usr/bin/env bun

/*
 * Hook script to deny node_modules write operations
 * Prevents modification of files in node_modules directories
 * TypeScript version with enhanced path processing and type safety
 */

import { resolve } from "path";
import { readHookInput } from "./lib/hook-common.js";
import type { HookInput } from "./types/hooks-types.js";

interface FileToolInput {
  file_path?: string;
  notebook_path?: string;
  [key: string]: unknown;
}

interface MultiEditToolInput {
  file_path?: string;
  [key: string]: unknown;
}

/**
 * Extract file paths from tool input based on tool type
 */
function extractFilePaths(toolInput: any): string[] {
  const paths: string[] = [];

  // Handle different tool input structures
  if (toolInput.file_path) {
    paths.push(toolInput.file_path);
  }
  
  if (toolInput.notebook_path) {
    paths.push(toolInput.notebook_path);
  }

  // For MultiEdit, the file_path is also in the main structure
  // (individual edits don't have separate file paths)

  return paths.filter(path => path && path.trim() !== "");
}

/**
 * Check if a path is within node_modules directory
 */
function isInNodeModules(filePath: string): boolean {
  try {
    // Resolve relative paths to absolute paths
    const absolutePath = resolve(process.cwd(), filePath);
    
    // Check if path contains node_modules directory
    return absolutePath.includes("/node_modules/");
  } catch (error) {
    // If path resolution fails, err on the side of caution
    console.error(`Error resolving path ${filePath}:`, error);
    return filePath.includes("node_modules");
  }
}

// Main execution
try {
  const input = readHookInput();

  // Only process file modification tools
  const fileModificationTools = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
  if (!fileModificationTools.includes(input.tool_name)) {
    process.exit(0);
  }

  const filePaths = extractFilePaths(input.tool_input);

  // Check each file path
  for (const filePath of filePaths) {
    if (isInNodeModules(filePath)) {
      console.error(`ERROR: Modification of files in node_modules is prohibited: ${filePath}`);
      console.error("Reading from node_modules is allowed, but writing/editing is not permitted.");
      process.exit(1);
    }
  }

  // Allow the operation to proceed
  process.exit(0);
} catch (error) {
  console.error("Error in deny-node-modules-write:", error);
  process.exit(1);
}