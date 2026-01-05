#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { resolve, basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createDenyResponse } from "../lib/context-helpers.ts";
import "../types/tool-schemas.ts";

/**
 * Chezmoi Redirect Hook for Dotfiles Repository
 *
 * This hook is specifically designed for the dotfiles repository.
 * When Claude attempts to access files in the home directory that are managed by chezmoi,
 * this hook blocks the access and suggests the corresponding source file in the repository.
 *
 * Example:
 * - Access to ~/.config/mise/config.toml is blocked
 * - Suggestion: Use /home/user/dotfiles/dot_config/mise/config.toml instead
 */
const hook = defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;

    // Only process file/path-related tools
    const fileTools = ["Read", "Write", "Edit", "MultiEdit", "NotebookRead", "NotebookEdit"];
    if (!fileTools.includes(tool_name)) {
      return context.success({});
    }

    try {
      const repoRoot = getRepositoryRoot();
      if (!repoRoot) {
        return context.success({});
      }

      // Extract file path from tool input
      const filePath = extractFilePath(tool_name, tool_input);
      if (!filePath) {
        return context.success({});
      }

      // Resolve the path
      const absPath = resolvePath(filePath);
      const homeDir = homedir();

      // Only check paths under home directory (but not in the repo itself)
      if (!absPath.startsWith(homeDir + "/") || absPath.startsWith(repoRoot)) {
        return context.success({});
      }

      // Check if there's a corresponding chezmoi-managed file
      const chezmoiPath = getChezmoiRedirectPath(absPath, repoRoot);
      if (chezmoiPath) {
        return context.json(
          createDenyResponse(
            `🔄 Chezmoi Redirect Required\n\n` +
              `This file is managed by chezmoi. Please access the source file instead.\n\n` +
              `❌ Requested: ${absPath}\n` +
              `✅ Use this:  ${chezmoiPath}\n\n` +
              `The source file in the repository is the canonical version.\n` +
              `Changes should be made there and applied via 'chezmoi apply'.`,
          ),
        );
      }

      return context.success({});
    } catch (error) {
      // On error, allow the operation to proceed (fail open for this non-critical hook)
      return context.success({});
    }
  },
});

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

function extractFilePath(tool_name: string, tool_input: any): string | undefined {
  switch (tool_name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return tool_input?.file_path;
    case "NotebookRead":
    case "NotebookEdit":
      return tool_input?.notebook_path;
    default:
      return undefined;
  }
}

function resolvePath(path: string): string {
  const homeDir = homedir();

  // Expand tilde
  if (path.startsWith("~/")) {
    return join(homeDir, path.slice(2));
  }

  if (path.startsWith("/")) {
    return path;
  }

  // Relative path - resolve from cwd
  const cwd = process.env.CLAUDE_TEST_CWD || process.cwd();
  return resolve(cwd, path);
}

/**
 * Convert a home directory path to its chezmoi-managed equivalent in the repository.
 *
 * Instead of generating all possible prefix/suffix combinations,
 * we search the directory for files that match the target filename.
 */
function getChezmoiRedirectPath(absPath: string, repoRoot: string): string | undefined {
  const homeDir = homedir();

  // Only process paths under home directory
  if (!absPath.startsWith(homeDir + "/")) {
    return undefined;
  }

  // Get the relative path from home directory
  const relativePath = absPath.slice(homeDir.length + 1);
  const segments = relativePath.split("/");
  const targetFileName = segments[segments.length - 1];

  // Convert directory path to chezmoi naming (dot_ prefix for first segment)
  const chezmoiDirSegments = segments.slice(0, -1).map((segment, index) => {
    if (index === 0 && segment.startsWith(".")) {
      return "dot_" + segment.slice(1);
    }
    return segment;
  });

  // Handle files directly in home directory (e.g., ~/.bashrc → dot_bashrc)
  if (segments.length === 1) {
    const searchName = targetFileName.startsWith(".")
      ? targetFileName.slice(1)  // .bashrc → bashrc
      : targetFileName;
    return findChezmoiFile(repoRoot, searchName);
  }

  // Build the chezmoi directory path
  const chezmoiDir = join(repoRoot, ...chezmoiDirSegments);

  // Search for the file in the chezmoi directory
  const found = findChezmoiFile(chezmoiDir, targetFileName);
  if (found) {
    return found;
  }

  // Check if parent directory exists (for suggesting where to create new files)
  if (existsSync(chezmoiDir)) {
    return join(chezmoiDir, targetFileName);
  }

  return undefined;
}

/**
 * Find a chezmoi-managed file by searching the directory for files
 * that match the target filename (ignoring chezmoi prefixes/suffixes).
 */
function findChezmoiFile(dirPath: string, targetFileName: string): string | undefined {
  if (!existsSync(dirPath)) {
    return undefined;
  }

  try {
    const files = readdirSync(dirPath);

    for (const file of files) {
      const stripped = stripChezmoiAttributes(file);
      if (stripped === targetFileName) {
        return join(dirPath, file);
      }
    }
  } catch {
    // Directory read error - ignore
  }

  return undefined;
}

/**
 * Strip chezmoi prefixes and suffixes from a filename to get the target filename.
 *
 * Chezmoi attributes (in order):
 * - Prefixes: private_, empty_, readonly_, encrypted_, executable_, create_, modify_, remove_, run_, once_, onchange_, before_, after_, literal_, dot_
 * - Suffixes: .tmpl, .age, .asc, .literal
 */
function stripChezmoiAttributes(fileName: string): string {
  let name = fileName;

  // Strip suffixes first
  const suffixes = [".tmpl", ".age", ".asc", ".literal"];
  for (const suffix of suffixes) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break; // Only strip one suffix
    }
  }

  // Strip prefixes (order matters, but we just need to strip any of them)
  const prefixes = [
    "private_",
    "empty_",
    "readonly_",
    "encrypted_",
    "executable_",
    "create_",
    "modify_",
    "remove_",
    "run_once_",
    "run_onchange_",
    "run_before_",
    "run_after_",
    "run_",
    "once_",
    "onchange_",
    "before_",
    "after_",
    "symlink_",
    "literal_",
  ];

  // Keep stripping prefixes until none match
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (name.startsWith(prefix)) {
        name = name.slice(prefix.length);
        changed = true;
        break;
      }
    }
  }

  // Convert dot_ to leading dot
  if (name.startsWith("dot_")) {
    name = "." + name.slice(4);
  }

  return name;
}

export default hook;

// Export for testing
export {
  getChezmoiRedirectPath,
  findChezmoiFile,
  stripChezmoiAttributes,
};

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
