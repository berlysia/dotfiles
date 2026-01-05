#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { resolve, basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
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
      // Check if we're in a dotfiles repository (contains chezmoi config)
      const repoRoot = getRepositoryRoot();
      if (!repoRoot || !isDotfilesRepository(repoRoot)) {
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

/**
 * Check if the repository is a dotfiles repository managed by chezmoi.
 * We detect this by checking for chezmoi-specific files/directories.
 */
function isDotfilesRepository(repoRoot: string): boolean {
  const chezmoiIndicators = [
    ".chezmoi.toml.tmpl",
    ".chezmoiignore",
    ".chezmoiscripts",
    ".chezmoidata",
  ];

  return chezmoiIndicators.some((indicator) =>
    existsSync(join(repoRoot, indicator)),
  );
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
 * Chezmoi naming conventions:
 * - ~/.config/foo → dot_config/foo
 * - ~/.foo → dot_foo
 * - ~/.local/share/foo → dot_local/share/foo
 * - Templates: file.txt → file.txt.tmpl
 * - Private files: file → private_file
 * - Executable files: file → executable_file
 */
function getChezmoiRedirectPath(absPath: string, repoRoot: string): string | undefined {
  const homeDir = homedir();

  // Only process paths under home directory
  if (!absPath.startsWith(homeDir + "/")) {
    return undefined;
  }

  // Get the relative path from home directory
  const relativePath = absPath.slice(homeDir.length + 1);

  // Convert to chezmoi naming convention
  const segments = relativePath.split("/");
  const chezmoiSegments = segments.map((segment, index) => {
    if (index === 0 && segment.startsWith(".")) {
      // First segment: .config → dot_config, .local → dot_local, .zsh → dot_zsh
      return "dot_" + segment.slice(1);
    }
    return segment;
  });

  const basePath = join(repoRoot, ...chezmoiSegments);

  // Try multiple chezmoi path variations
  const pathVariations = generateChezmoiPathVariations(basePath, chezmoiSegments, repoRoot);

  for (const candidatePath of pathVariations) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  // Check if parent directory exists in chezmoi structure (for new files)
  const baseDir = dirname(basePath);
  if (existsSync(baseDir)) {
    // Parent exists, so this path would be valid for creating a new file
    return basePath;
  }

  return undefined;
}

/**
 * Generate possible chezmoi path variations for a given path.
 *
 * Chezmoi uses various prefixes and suffixes:
 * - dot_ : for dotfiles/directories
 * - private_ : for files with restricted permissions
 * - executable_ : for executable scripts
 * - .tmpl : for template files
 */
function generateChezmoiPathVariations(basePath: string, segments: string[], repoRoot: string): string[] {
  const variations: string[] = [];
  const fileName = basename(basePath);
  const dirPath = dirname(basePath);

  // 1. Basic path (already converted dot_ prefix for first segment)
  variations.push(basePath);

  // 2. Template variation (.tmpl suffix)
  variations.push(basePath + ".tmpl");

  // 3. Private file variation (private_ prefix on filename)
  variations.push(join(dirPath, "private_" + fileName));
  variations.push(join(dirPath, "private_" + fileName + ".tmpl"));

  // 4. Executable file variation (executable_ prefix on filename)
  variations.push(join(dirPath, "executable_" + fileName));
  variations.push(join(dirPath, "executable_" + fileName + ".tmpl"));

  // 5. Private executable variation
  variations.push(join(dirPath, "private_executable_" + fileName));
  variations.push(join(dirPath, "private_executable_" + fileName + ".tmpl"));

  // 6. Handle dot_ prefix for filenames (not just directories)
  // e.g., ~/.bashrc → dot_bashrc (when first segment doesn't start with .)
  const firstSegment = segments[0];
  if (segments.length === 1 && firstSegment && !firstSegment.startsWith("dot_")) {
    const dotFileName = "dot_" + fileName;
    variations.push(join(repoRoot, dotFileName));
    variations.push(join(repoRoot, dotFileName + ".tmpl"));
    variations.push(join(repoRoot, "private_" + dotFileName));
    variations.push(join(repoRoot, "private_" + dotFileName + ".tmpl"));
  }

  return variations;
}

export default hook;

// Export for testing
export {
  getChezmoiRedirectPath,
  generateChezmoiPathVariations,
  isDotfilesRepository,
};

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
