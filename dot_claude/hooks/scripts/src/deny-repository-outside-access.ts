#!/usr/bin/env bun

/**
 * Deny access to files outside repository root
 * TypeScript conversion of deny-repository-outside-access.sh
 */

import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import {
  readHookInput,
  extractToolInfo,
  extractFilePaths,
  getWorkspaceRoot,
} from "./lib/hook-common.js";
import { outputDecision } from "./lib/decision-maker.js";
import type { PathValidationResult } from "./types/hooks-types.js";

/**
 * Resolve absolute paths safely
 */
function resolvePath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  
  try {
    // Use realpathSync to properly resolve relative paths and symlinks
    return realpathSync(path);
  } catch {
    // Fallback if path doesn't exist yet
    return resolve(process.cwd(), path);
  }
}

/**
 * Check if path is outside repository root
 */
function isOutsideRepo(path: string, repoRoot: string): PathValidationResult {
  const absPath = resolvePath(path);
  const homeDir = homedir();
  
  // Check if path starts with repository root
  if (absPath.startsWith(repoRoot)) {
    return {
      isAllowed: true,
      resolvedPath: absPath,
    };
  }
  
  // Check if path is in ~/.claude directory (allowed exception)
  if (absPath.startsWith(`${homeDir}/.claude`)) {
    return {
      isAllowed: true,
      resolvedPath: absPath,
    };
  }
  
  return {
    isAllowed: false,
    reason: `Path outside repository root: ${absPath}`,
    resolvedPath: absPath,
  };
}

/**
 * Extract potential paths from bash commands
 */
function extractPathsFromCommand(command: string): string[] {
  const paths: string[] = [];
  
  // Look for dangerous patterns in bash commands
  const dangerousPatterns = [
    /cd\s+\/[^\s]*/g,
    /cd\s+\.\.[^\s]*/g,
    /cd\s+~(?!\/\.claude)[^\s]*/g,
    /cp\s+[^\s]*\s+\/[^\s]*/g,
    /mv\s+[^\s]*\s+\/[^\s]*/g,
    /rm\s+[^\s]*\s+\/[^\s]*/g,
    /touch\s+\/[^\s]*/g,
    /mkdir\s+\/[^\s]*/g,
    /ln\s+[^\s]*\s+\/[^\s]*/g,
  ];
  
  const hasPatterns = dangerousPatterns.some(pattern => pattern.test(command));
  
  if (hasPatterns) {
    // Extract potential paths from command
    const pathMatches = command.match(/\/[^\s]+|\.\.[^\s]*|~[^\s]*/g);
    if (pathMatches) {
      paths.push(...pathMatches);
    }
  }
  
  return paths.filter(path => path.trim());
}

/**
 * Main execution function
 */
function main(): void {
  try {
    // Read and parse hook input
    const hookInput = readHookInput();
    const { toolName, toolInput } = extractToolInfo(hookInput);
    
    // Extract file paths from tool input
    const filePaths = extractFilePaths(toolInput);
    
    // Also extract command for bash tool analysis
    const command = toolInput.command || "";
    
    // Exit if no files to check
    if (filePaths.length === 0 && !command) {
      process.exit(0);
    }
    
    // Get repository root
    const repoRoot = getWorkspaceRoot();
    if (!repoRoot) {
      // Not in a git repository, allow access
      process.exit(0);
    }
    
    // Check for bash commands that might access files outside repo
    if (command) {
      const potentialPaths = extractPathsFromCommand(command);
      
      for (const path of potentialPaths) {
        const validation = isOutsideRepo(path, repoRoot);
        if (!validation.isAllowed) {
          outputDecision(
            "ask",
            `Bash command attempting to access path outside repository root: ${path}. Only ~/.claude directory is normally allowed as exception.`
          );
          process.exit(0);
        }
      }
    }
    
    // Check file paths directly
    for (const file of filePaths) {
      if (file) {
        const validation = isOutsideRepo(file, repoRoot);
        if (!validation.isAllowed) {
          outputDecision(
            "ask",
            `Attempting to access file outside repository root: ${file}. Only ~/.claude directory is normally allowed as exception.`
          );
          process.exit(0);
        }
      }
    }
    
    // All paths are allowed
    process.exit(0);
    
  } catch (error) {
    console.error(`Error in deny-repository-outside-access: ${error}`);
    process.exit(1);
  }
}

// Run main if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}