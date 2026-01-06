/**
 * Chezmoi utilities for path resolution and file management
 *
 * These utilities help with:
 * - Converting home directory paths to chezmoi source paths
 * - Detecting dotfiles repositories
 * - Stripping chezmoi attributes from filenames
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Check if the repository is a dotfiles/chezmoi repository
 *
 * Detection is based on chezmoi-specific files and directory patterns.
 *
 * @param repoRoot - Root directory of the repository
 * @returns true if the repository appears to be a chezmoi-managed dotfiles repository
 */
export function isDotfilesRepository(repoRoot: string): boolean {
  // Check for chezmoi configuration files
  const chezmoiIndicators = [
    ".chezmoi.toml.tmpl",
    ".chezmoi.yaml.tmpl",
    ".chezmoi.json.tmpl",
    ".chezmoiroot",
    ".chezmoiignore",
    ".chezmoiremove",
    ".chezmoiversion",
  ];

  for (const indicator of chezmoiIndicators) {
    if (existsSync(join(repoRoot, indicator))) {
      return true;
    }
  }

  // Check for dot_ prefixed directories (common chezmoi pattern)
  try {
    const files = readdirSync(repoRoot);
    const dotPrefixedCount = files.filter(
      (f) => f.startsWith("dot_") && !f.includes("."),
    ).length;
    // If there are multiple dot_ prefixed items, it's likely a chezmoi repo
    if (dotPrefixedCount >= 2) {
      return true;
    }
  } catch {
    // Ignore directory read errors
  }

  return false;
}

/**
 * Convert a home directory path to its chezmoi-managed equivalent in the repository.
 *
 * Instead of generating all possible prefix/suffix combinations,
 * we search the directory for files that match the target filename.
 *
 * @param absPath - Absolute path in home directory (e.g., ~/.bashrc)
 * @param repoRoot - Root of the chezmoi repository
 * @returns Corresponding source file path in the repository, or undefined if not found
 *
 * @example
 * getChezmoiSourcePath("/home/user/.bashrc", "/home/user/dotfiles")
 * // → "/home/user/dotfiles/dot_bashrc"
 *
 * getChezmoiSourcePath("/home/user/.config/mise/config.toml", "/home/user/dotfiles")
 * // → "/home/user/dotfiles/dot_config/mise/config.toml"
 */
export function getChezmoiSourcePath(
  absPath: string,
  repoRoot: string,
): string | undefined {
  const homeDir = homedir();

  // Only process paths under home directory
  if (!absPath.startsWith(homeDir + "/")) {
    return undefined;
  }

  // Get the relative path from home directory
  const relativePath = absPath.slice(homeDir.length + 1);
  const segments = relativePath.split("/");
  const targetFileName = segments.at(-1);

  // Guard: ensure we have a valid filename
  if (!targetFileName) {
    return undefined;
  }

  // Convert directory path to chezmoi naming (dot_ prefix for dotfiles)
  const chezmoiDirSegments = segments.slice(0, -1).map((segment, index) => {
    if (index === 0 && segment.startsWith(".")) {
      return "dot_" + segment.slice(1);
    }
    return segment;
  });

  // Handle files directly in home directory (e.g., ~/.bashrc → dot_bashrc)
  if (segments.length === 1) {
    const searchName = targetFileName.startsWith(".")
      ? targetFileName.slice(1) // .bashrc → bashrc
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
 *
 * @param dirPath - Directory to search in
 * @param targetFileName - Target filename without chezmoi attributes
 * @returns Full path to the chezmoi source file, or undefined if not found
 */
export function findChezmoiFile(
  dirPath: string,
  targetFileName: string,
): string | undefined {
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
 * - Prefixes: private_, empty_, readonly_, encrypted_, executable_, create_,
 *   modify_, remove_, run_, once_, onchange_, before_, after_, literal_, dot_
 * - Suffixes: .tmpl, .age, .asc, .literal
 *
 * @param fileName - Filename with potential chezmoi attributes
 * @returns Filename with chezmoi attributes stripped
 *
 * @example
 * stripChezmoiAttributes("private_dot_bashrc.tmpl") // → ".bashrc"
 * stripChezmoiAttributes("dot_config")               // → ".config"
 * stripChezmoiAttributes("run_once_setup.sh")        // → "setup.sh"
 */
export function stripChezmoiAttributes(fileName: string): string {
  let name = fileName;

  // Strip suffixes first
  const suffixes = [".tmpl", ".age", ".asc", ".literal"];
  for (const suffix of suffixes) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break; // Only strip one suffix
    }
  }

  // Strip prefixes (order matters for some combinations)
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

/**
 * Generate a chezmoi redirect message for deny responses
 *
 * @param requestedPath - Path that was requested
 * @param sourcePath - Corresponding chezmoi source path
 * @returns Formatted message for deny response
 */
export function formatChezmoiRedirectMessage(
  requestedPath: string,
  sourcePath: string,
): string {
  return (
    `🔄 Chezmoi Redirect Required\n\n` +
    `This file is managed by chezmoi. Please access the source file instead.\n\n` +
    `❌ Requested: ${requestedPath}\n` +
    `✅ Use this:  ${sourcePath}\n\n` +
    `The source file in the repository is the canonical version.\n` +
    `Changes should be made there and applied via 'chezmoi apply'.`
  );
}
