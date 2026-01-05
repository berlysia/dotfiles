#!/usr/bin/env -S bun run --silent

import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { createDenyResponse } from "../lib/context-helpers.ts";
import { expandTilde } from "../lib/path-utils.ts";
import { matchGitignorePattern } from "../lib/pattern-matcher.ts";
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
    const fileTools = [
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookRead",
      "NotebookEdit",
      "LS",
      "Glob",
      "Grep",
      "Bash",
    ];
    if (!fileTools.includes(tool_name)) {
      return context.success({});
    }

    try {
      // Get repository root and settings
      const repoRoot = getRepositoryRoot();
      if (!repoRoot) {
        // If not in a repository, allow all operations
        return context.success({});
      }

      const settingsFiles = getSettingsFiles(repoRoot);
      const additionalDirs = getAdditionalDirectories(settingsFiles);
      const allowPatterns = getAllowPatterns(settingsFiles, tool_name);

      // Extract file paths from tool input
      const filePaths = extractFilePaths(tool_name, tool_input);

      // Check each path
      for (const filePath of filePaths) {
        const validation = validatePath(
          filePath,
          repoRoot,
          tool_name,
          additionalDirs,
          allowPatterns,
        );
        if (!validation.isAllowed) {
          return context.json(
            createDenyResponse(
              `Access denied: ${validation.reason}\nPath: ${validation.resolvedPath || filePath}\nRepository: ${repoRoot}`,
            ),
          );
        }
      }

      return context.success({});
    } catch (error) {
      return context.json(
        createDenyResponse(`Error in repository access check: ${error}`),
      );
    }
  },
});

interface PathValidationResult {
  isAllowed: boolean;
  resolvedPath?: string;
  reason?: string;
}

interface SettingsFile {
  additionalDirectories?: string[];
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
}

function getRepositoryRoot(): string | undefined {
  if (process.env.CLAUDE_TEST_REPO_ROOT) {
    return process.env.CLAUDE_TEST_REPO_ROOT;
  }
  try {
    const result = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.trim();
  } catch {
    return undefined;
  }
}

function getSettingsFiles(workspaceRoot?: string): SettingsFile[] {
  const settingsFiles: SettingsFile[] = [];
  const homeDir = homedir();

  // Global settings
  const globalSettingsPath = resolve(homeDir, ".claude", "settings.json");
  if (existsSync(globalSettingsPath)) {
    try {
      const content = readFileSync(globalSettingsPath, "utf-8");
      settingsFiles.push(JSON.parse(content) as SettingsFile);
    } catch {
      // Ignore parse errors
    }
  }

  // Note: permissions are now integrated in settings.json
  // No need to read a separate permissions.json file

  // Workspace settings
  if (workspaceRoot) {
    const workspaceSettingsPath = resolve(
      workspaceRoot,
      ".claude",
      "settings.json",
    );
    if (existsSync(workspaceSettingsPath)) {
      try {
        const content = readFileSync(workspaceSettingsPath, "utf-8");
        settingsFiles.push(JSON.parse(content) as SettingsFile);
      } catch {
        // Ignore parse errors
      }
    }
  }

  return settingsFiles;
}

function getAdditionalDirectories(settingsFiles: SettingsFile[]): string[] {
  const directories: string[] = [];

  for (const file of settingsFiles) {
    if (Array.isArray(file.additionalDirectories)) {
      directories.push(...file.additionalDirectories);
    }
  }

  return directories;
}

function getAllowPatterns(
  settingsFiles: SettingsFile[],
  toolName: string,
): string[] {
  const patterns: string[] = [];

  for (const file of settingsFiles) {
    const allowList = file.permissions?.allow;
    if (Array.isArray(allowList)) {
      // Filter patterns for this tool
      const toolPatterns = allowList.filter(
        (pattern) => pattern === toolName || pattern.startsWith(`${toolName}(`),
      );
      patterns.push(...toolPatterns);
    }
  }

  return patterns;
}

function extractFilePaths(
  tool_name: string,
  tool_input: Record<string, unknown>,
): string[] {
  const paths: string[] = [];

  switch (tool_name) {
    case "Read":
    case "NotebookRead":
      if (tool_input.file_path || tool_input.notebook_path) {
        paths.push(
          (tool_input.file_path as string) ||
            (tool_input.notebook_path as string),
        );
      }
      break;

    case "Write":
      if (tool_input.file_path) {
        paths.push(tool_input.file_path as string);
      }
      break;

    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      if (tool_input.file_path || tool_input.notebook_path) {
        paths.push(
          (tool_input.file_path as string) ||
            (tool_input.notebook_path as string),
        );
      }
      break;

    case "LS":
      if (tool_input.path) {
        paths.push(tool_input.path as string);
      }
      break;

    case "Glob":
      if (tool_input.path) {
        paths.push(tool_input.path as string);
      }
      break;

    case "Grep":
      if (tool_input.path) {
        paths.push(tool_input.path as string);
      }
      break;

    case "Bash": {
      // For Bash commands, try to extract file paths from the command
      const command = (tool_input.command as string) || "";
      const extractedPaths = extractPathsFromBashCommand(command);
      paths.push(...extractedPaths);
      break;
    }
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
    // rm command (capture one or more path arguments, ignoring flags)
    /(?:^|\s)rm\s+(?:-[^\s]+\s+)*([\w./~][^\s"';|&]*)/g,
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
        if (capturedGroup && typeof capturedGroup === "string") {
          paths.push(capturedGroup);
        }
      }
    }
  }

  return paths.filter((path) => {
    // Filter out obvious non-paths
    return (
      !path.startsWith("-") && // Not flags
      path !== "." &&
      path !== ".." &&
      path.length > 0
    );
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
    const cwd = process.env.CLAUDE_TEST_CWD || process.cwd();
    return resolve(cwd, path);
  }
}

function validatePath(
  path: string,
  repoRoot: string,
  toolName: string,
  additionalDirs: string[],
  allowPatterns: string[],
): PathValidationResult {
  const absPath = resolvePath(path);
  const homeDir = homedir();

  // 1. Repository内 → 常に許可
  if (absPath.startsWith(repoRoot)) {
    return {
      isAllowed: true,
      resolvedPath: absPath,
    };
  }

  // 2. システムディレクトリ → 常に拒否（permissions.allowでも上書き不可）
  const systemPaths = [
    "/etc",
    "/usr",
    "/var",
    "/opt",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/boot",
    "/proc",
    "/sys",
    "/dev",
  ];
  for (const systemPath of systemPaths) {
    if (absPath.startsWith(`${systemPath}/`)) {
      return {
        isAllowed: false,
        resolvedPath: absPath,
        reason: `Access to system directory '${systemPath}' is always denied for security`,
      };
    }
  }

  // 3. 常に許可する安全なパス
  const alwaysSafePaths = [join(homeDir, ".claude"), "/tmp", "/var/tmp"];
  for (const safePath of alwaysSafePaths) {
    if (absPath.startsWith(`${safePath}/`) || absPath === safePath) {
      return {
        isAllowed: true,
        resolvedPath: absPath,
      };
    }
  }

  // 4. additionalDirectoriesのチェック
  for (const addDir of additionalDirs) {
    const resolvedAddDir = resolvePath(addDir);
    if (absPath.startsWith(resolvedAddDir)) {
      // Read/LSは自動許可、Edit/Writeは要permissions
      if (toolName === "Read" || toolName === "LS") {
        return {
          isAllowed: true,
          resolvedPath: absPath,
        };
      }
      if (
        toolName === "Edit" ||
        toolName === "Write" ||
        toolName === "MultiEdit"
      ) {
        // permissions.allowをチェック
        if (checkAllowPatterns(absPath, allowPatterns)) {
          return {
            isAllowed: true,
            resolvedPath: absPath,
          };
        }
      }
    }
  }

  // 5. permissions.allowの明示的マッチ
  if (checkAllowPatterns(absPath, allowPatterns)) {
    return {
      isAllowed: true,
      resolvedPath: absPath,
    };
  }

  // Default: deny access outside repository
  return {
    isAllowed: false,
    resolvedPath: absPath,
    reason: `File is outside repository root and not explicitly allowed`,
  };
}

function checkAllowPatterns(
  filePath: string,
  allowPatterns: string[],
): boolean {
  for (const pattern of allowPatterns) {
    // Extract path pattern from tool pattern like "Read(path/pattern)"
    const match = pattern.match(/^[^(]+\((.+)\)$/);
    if (match?.[1]) {
      const pathPattern = match[1];
      if (matchGitignorePattern(filePath, expandTilde(pathPattern))) {
        return true;
      }
    }
  }
  return false;
}

// expandTilde function is now imported from path-utils.ts to eliminate duplication

function join(...paths: string[]): string {
  return paths.join("/").replace(/\/+/g, "/");
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
