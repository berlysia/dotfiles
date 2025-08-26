#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";

// Custom tool definitions for file/path operations
declare module "cc-hooks-ts" {
  interface ToolSchema {
    Read: {
      input: {
        file_path: string;
        limit?: number;
        offset?: number;
      };
      response: {
        content: string;
      };
    };
    Write: {
      input: {
        file_path: string;
        content: string;
      };
      response: {
        success: boolean;
      };
    };
    Edit: {
      input: {
        file_path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      };
      response: {
        success: boolean;
      };
    };
    MultiEdit: {
      input: {
        file_path: string;
        edits: Array<{
          old_string: string;
          new_string: string;
          replace_all?: boolean;
        }>;
      };
      response: {
        success: boolean;
      };
    };
    LS: {
      input: {
        path: string;
        ignore?: string[];
      };
      response: {
        files: string[];
      };
    };
    Glob: {
      input: {
        pattern: string;
        path?: string;
      };
      response: {
        files: string[];
      };
    };
    Grep: {
      input: {
        pattern: string;
        path?: string;
        glob?: string;
        output_mode?: "content" | "files_with_matches" | "count";
      };
      response: {
        matches: string[];
      };
    };
    NotebookRead: {
      input: {
        notebook_path: string;
      };
      response: {
        content: string;
      };
    };
    NotebookEdit: {
      input: {
        notebook_path: string;
        new_source: string;
        cell_id?: string;
        cell_type?: "code" | "markdown";
        edit_mode?: "replace" | "insert" | "delete";
      };
      response: {
        success: boolean;
      };
    };
    Bash: {
      input: {
        command: string;
        description?: string;
        run_in_background?: boolean;
        timeout?: number;
      };
      response: {
        stdout: string;
        stderr: string;
        exit_code: number;
      };
    };
  }
}

/**
 * Deny access to files outside repository root
 * Converted from deny-repository-outside-access.ts using cc-hooks-ts
 */
export default defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { toolName, toolInput } = context.event;

    // Only process file/path-related tools
    const fileTools = ["Read", "Write", "Edit", "MultiEdit", "NotebookRead", "NotebookEdit", "LS", "Glob", "Grep", "Bash"];
    if (!fileTools.includes(toolName)) {
      return context.success({});
    }

    try {
      // Get repository root
      const repoRoot = getRepositoryRoot();
      if (!repoRoot) {
        // If not in a repository, allow all operations
        return context.success({});
      }

      // Extract file paths from tool input
      const filePaths = extractFilePaths(toolName, toolInput);
      
      // Check each path
      for (const filePath of filePaths) {
        const validation = validatePath(filePath, repoRoot);
        if (!validation.isAllowed) {
          return context.blockingError(
            `Access denied: ${validation.reason}\nPath: ${validation.resolvedPath || filePath}\nRepository: ${repoRoot}`
          );
        }
      }

      return context.success({});

    } catch (error) {
      return context.blockingError(`Error in repository access check: ${error}`);
    }
  }
});

interface PathValidationResult {
  isAllowed: boolean;
  resolvedPath?: string;
  reason?: string;
}

function getRepositoryRoot(): string | undefined {
  try {
    const result = execSync("git rev-parse --show-toplevel", { 
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"] 
    });
    return result.trim();
  } catch {
    return undefined;
  }
}

function extractFilePaths(toolName: string, toolInput: any): string[] {
  const paths: string[] = [];

  switch (toolName) {
    case "Read":
    case "NotebookRead":
      if (toolInput.file_path || toolInput.notebook_path) {
        paths.push(toolInput.file_path || toolInput.notebook_path);
      }
      break;
      
    case "Write":
      if (toolInput.file_path) {
        paths.push(toolInput.file_path);
      }
      break;
      
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      if (toolInput.file_path || toolInput.notebook_path) {
        paths.push(toolInput.file_path || toolInput.notebook_path);
      }
      break;
      
    case "LS":
      if (toolInput.path) {
        paths.push(toolInput.path);
      }
      break;
      
    case "Glob":
      if (toolInput.path) {
        paths.push(toolInput.path);
      }
      break;
      
    case "Grep":
      if (toolInput.path) {
        paths.push(toolInput.path);
      }
      break;
      
    case "Bash":
      // For Bash commands, try to extract file paths from the command
      const command = toolInput.command || "";
      const extractedPaths = extractPathsFromBashCommand(command);
      paths.push(...extractedPaths);
      break;
  }

  return paths.filter(Boolean);
}

function extractPathsFromBashCommand(command: string): string[] {
  const paths: string[] = [];
  
  // Simple heuristics to extract file paths from bash commands
  // This is a simplified version - could be enhanced
  
  // Look for file path patterns in common commands
  const patterns = [
    // cat, head, tail, less, more
    /(?:cat|head|tail|less|more)\s+(?:["']?)([^\s"']+)(?:["']?)/g,
    // cp, mv (source and destination)
    /(?:cp|mv)\s+(?:["']?)([^\s"']+)(?:["']?)\s+(?:["']?)([^\s"']+)(?:["']?)/g,
    // chmod, chown
    /(?:chmod|chown)\s+\S+\s+(?:["']?)([^\s"']+)(?:["']?)/g,
    // ls with paths
    /ls\s+(?:[^\s]*\s+)*(?:["']?)([^\s"']+)(?:["']?)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(command)) !== null) {
      // Add all captured groups (excluding the full match)
      for (let i = 1; i < match.length; i++) {
        if (match[i]) {
          paths.push(match[i]);
        }
      }
    }
  }

  return paths.filter(path => {
    // Filter out obvious non-paths
    return !path.startsWith("-") && // Not flags
           path !== "." && 
           path !== ".." &&
           path.length > 0;
  });
}

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

function validatePath(path: string, repoRoot: string): PathValidationResult {
  const absPath = resolvePath(path);
  const homeDir = homedir();
  
  // Check if path starts with repository root
  if (absPath.startsWith(repoRoot)) {
    return {
      isAllowed: true,
      resolvedPath: absPath,
    };
  }
  
  // Allow access to home directory configuration files
  const allowedHomePaths = [
    join(homeDir, ".claude"),
    join(homeDir, ".gitconfig"),
    join(homeDir, ".gitignore_global"),
    join(homeDir, ".zshrc"),
    join(homeDir, ".bashrc"),
    join(homeDir, ".config"),
    join(homeDir, ".local"),
    join(homeDir, ".ssh/config"),
    join(homeDir, ".ssh/known_hosts"),
  ];
  
  for (const allowedPath of allowedHomePaths) {
    if (absPath.startsWith(allowedPath)) {
      return {
        isAllowed: true,
        resolvedPath: absPath,
      };
    }
  }
  
  // Allow temporary directories
  if (absPath.startsWith("/tmp/") || absPath.startsWith("/var/tmp/")) {
    return {
      isAllowed: true,
      resolvedPath: absPath,
    };
  }
  
  // Deny access to system directories
  const systemPaths = ["/etc", "/usr", "/var", "/opt", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/proc", "/sys", "/dev"];
  for (const systemPath of systemPaths) {
    if (absPath.startsWith(systemPath + "/")) {
      return {
        isAllowed: false,
        resolvedPath: absPath,
        reason: `Access to system directory '${systemPath}' is not allowed`
      };
    }
  }
  
  // Default: deny access outside repository
  return {
    isAllowed: false,
    resolvedPath: absPath,
    reason: `File is outside repository root`
  };
}

function join(...paths: string[]): string {
  return paths.join("/").replace(/\/+/g, "/");
}