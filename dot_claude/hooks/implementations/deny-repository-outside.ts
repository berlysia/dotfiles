#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { createDenyResponse } from "../lib/context-helpers.ts";
import "../types/tool-schemas.ts";

/**
 * Deny access to files outside repository root
 * Converted from deny-repository-outside-access.ts using cc-hooks-ts
 */
const hook = defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;

    // Only process file/path-related tools
    const fileTools = ["Read", "Write", "Edit", "MultiEdit", "NotebookRead", "NotebookEdit", "LS", "Glob", "Grep", "Bash"];
    if (!fileTools.includes(tool_name)) {
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
      const filePaths = extractFilePaths(tool_name, tool_input);

      // Check each path
      for (const filePath of filePaths) {
        const validation = validatePath(filePath, repoRoot);
        if (!validation.isAllowed) {
          return context.json(createDenyResponse(
            `Access denied: ${validation.reason}\nPath: ${validation.resolvedPath || filePath}\nRepository: ${repoRoot}`
          ));
        }
      }

      return context.success({});

    } catch (error) {
      return context.json(createDenyResponse(`Error in repository access check: ${error}`));
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

function extractFilePaths(tool_name: string, tool_input: any): string[] {
  const paths: string[] = [];

  switch (tool_name) {
    case "Read":
    case "NotebookRead":
      if (tool_input.file_path || tool_input.notebook_path) {
        paths.push(tool_input.file_path || tool_input.notebook_path);
      }
      break;

    case "Write":
      if (tool_input.file_path) {
        paths.push(tool_input.file_path);
      }
      break;

    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      if (tool_input.file_path || tool_input.notebook_path) {
        paths.push(tool_input.file_path || tool_input.notebook_path);
      }
      break;

    case "LS":
      if (tool_input.path) {
        paths.push(tool_input.path);
      }
      break;

    case "Glob":
      if (tool_input.path) {
        paths.push(tool_input.path);
      }
      break;

    case "Grep":
      if (tool_input.path) {
        paths.push(tool_input.path);
      }
      break;

    case "Bash":
      // For Bash commands, try to extract file paths from the command
      const command = tool_input.command || "";
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
        const capturedGroup = match[i];
        if (capturedGroup && typeof capturedGroup === 'string') {
          paths.push(capturedGroup);
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

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
