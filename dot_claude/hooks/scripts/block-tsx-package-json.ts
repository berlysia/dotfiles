#!/usr/bin/env bun

/*
 * Hook script to block tsx/ts-node usage in package.json edits
 * TypeScript version with enhanced type safety and JSON processing
 */

import { readHookInput } from "./lib/hook-common.js";
import type { HookInput } from "./types/hooks-types.js";

interface PackageJsonContent {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface EditOperation {
  new_string?: string;
  [key: string]: unknown;
}

interface MultiEditToolInput {
  file_path?: string;
  edits?: EditOperation[];
  [key: string]: unknown;
}

interface EditWriteToolInput {
  file_path?: string;
  new_string?: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Check if a file path is a package.json file
 */
function isPackageJsonFile(filePath: string): boolean {
  return /package\.json$/.test(filePath);
}

/**
 * Safely parse JSON content
 */
function parseJsonSafe(content: string): PackageJsonContent | null {
  try {
    return JSON.parse(content) as PackageJsonContent;
  } catch {
    return null;
  }
}

/**
 * Check for tsx/ts-node patterns in script values using regex
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
 * Check for tsx/ts-node patterns in non-JSON content using regex fallback
 */
function checkNonJsonContent(content: string): boolean {
  // Check scripts section
  if (/\"scripts\"/.test(content)) {
    const scriptPattern = /\"[^\"]*\"\s*:\s*\"[^\"]*((^|[\s])(tsx|ts-node)([\s]|$))[^\"]*\"/;
    if (scriptPattern.test(content)) {
      return true;
    }
  }

  // Check dependencies sections
  if (/(\"dependencies\"|\"devDependencies\")/.test(content)) {
    const dependencyPattern = /\"(tsx|ts-node)\"\s*:\s*\"[^\"]*\"/;
    if (dependencyPattern.test(content)) {
      return true;
    }
  }

  return false;
}

/**
 * Check package.json content for tsx/ts-node usage
 */
function checkPackageJsonEdit(toolName: string, filePath: string, newContent: string): void {
  // Only check package.json files
  if (!isPackageJsonFile(filePath)) {
    return;
  }

  // Try to parse as JSON
  const jsonContent = parseJsonSafe(newContent);
  
  if (jsonContent === null) {
    // Fall back to regex for non-JSON content
    if (checkNonJsonContent(newContent)) {
      console.error("Adding tsx/ts-node to package.json scripts is prohibited. Use the existing TypeScript toolchain in the project.");
      process.exit(2);
    }
    return;
  }

  // Check scripts section
  if (jsonContent.scripts) {
    for (const [scriptName, scriptValue] of Object.entries(jsonContent.scripts)) {
      if (typeof scriptValue === "string" && checkScriptValue(scriptValue)) {
        console.error("Adding tsx/ts-node to package.json scripts is prohibited. Use the existing TypeScript toolchain in the project.");
        process.exit(2);
      }
    }
  }

  // Check dependencies sections
  const allDependencies = {
    ...jsonContent.dependencies,
    ...jsonContent.devDependencies
  };

  for (const packageName of Object.keys(allDependencies)) {
    if (packageName === "tsx" || packageName === "ts-node") {
      console.error("Adding tsx/ts-node to package.json dependencies is prohibited. Use the existing TypeScript toolchain in the project.");
      process.exit(2);
    }
  }
}

// Main execution
try {
  const input = readHookInput();
  const toolName = input.tool_name;

  // Only process Edit, MultiEdit, and Write commands
  if (!["Edit", "MultiEdit", "Write"].includes(toolName)) {
    process.exit(0);
  }

  const toolInput = input.tool_input;

  if (toolName === "MultiEdit") {
    const multiEditInput = toolInput as MultiEditToolInput;
    const filePath = multiEditInput.file_path || "";
    
    if (multiEditInput.edits) {
      for (const edit of multiEditInput.edits) {
        if (edit.new_string) {
          checkPackageJsonEdit(toolName, filePath, edit.new_string);
        }
      }
    }
  } else {
    const editWriteInput = toolInput as EditWriteToolInput;
    const filePath = editWriteInput.file_path || "";
    let newContent = "";

    if (toolName === "Edit" && editWriteInput.new_string) {
      newContent = editWriteInput.new_string;
    } else if (toolName === "Write" && editWriteInput.content) {
      newContent = editWriteInput.content;
    }

    if (newContent) {
      checkPackageJsonEdit(toolName, filePath, newContent);
    }
  }

  // Allow the operation to proceed
  process.exit(0);
} catch (error) {
  console.error("Error in block-tsx-package-json:", error);
  process.exit(1);
}