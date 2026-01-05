/**
 * Path manipulation utilities for consistent path handling across hooks
 *
 * These utilities provide standardized path transformations to avoid code duplication
 * and ensure consistent behavior across different parts of the codebase.
 *
 * This module uses Branded Types (Opaque Types) to ensure type safety at compile time.
 * The branded types distinguish between:
 * - Raw string paths vs normalized paths
 * - File paths vs pattern strings
 * This prevents common errors like mixing up paths and patterns or double-normalization.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Branded type utility for creating opaque types
 *
 * This creates a nominal type that is incompatible with its base type,
 * preventing accidental mixing of different path states.
 */
type Brand<K, T> = K & { readonly __brand: T };

/**
 * Normalized file path - guaranteed to be processed by normalization functions
 *
 * Use this type for paths that have been through expandTilde/expandRelativePath/normalizePath.
 * This prevents accidental double-normalization and ensures paths are in expected format.
 */
export type NormalizedPath = Brand<string, "NormalizedPath">;

/**
 * Normalized pattern string - guaranteed to be processed by normalizePattern
 *
 * Use this type for pattern strings used in gitignore-style matching.
 * This prevents mixing up file paths and pattern strings.
 */
export type NormalizedPattern = Brand<string, "NormalizedPattern">;

/**
 * Convert a string to NormalizedPath
 *
 * This is a type-level cast that should only be used internally by normalization functions.
 * External code should use normalizePath() instead.
 *
 * @internal
 */
function toNormalizedPath(s: string): NormalizedPath {
  return s as NormalizedPath;
}

/**
 * Convert a string to NormalizedPattern
 *
 * This is a type-level cast that should only be used internally by normalizePattern().
 * External code should use normalizePattern() instead.
 *
 * @internal
 */
function toNormalizedPattern(s: string): NormalizedPattern {
  return s as NormalizedPattern;
}

/**
 * Expand tilde (~/) to absolute home directory path
 *
 * @param path - Path that may start with ~/
 * @returns Path with tilde expanded to home directory, or original path if no tilde
 *
 * @example
 * expandTilde("~/workspace/project") // → "/home/user/workspace/project"
 * expandTilde("/absolute/path")      // → "/absolute/path"
 * expandTilde("./relative/path")     // → "./relative/path"
 */
export function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Expand relative path (./) to absolute path
 *
 * @param path - Path that may start with ./
 * @param base - Base directory for relative paths (defaults to process.cwd())
 * @returns Absolute path, or original path if already absolute
 *
 * @example
 * expandRelativePath("./src/file.ts")         // → "/cwd/src/file.ts"
 * expandRelativePath("/absolute/path")        // → "/absolute/path"
 * expandRelativePath("src/file.ts", "/base") // → "/base/src/file.ts"
 */
export function expandRelativePath(
  path: string,
  base: string = process.cwd(),
): string {
  // Already absolute or tilde path
  if (path.startsWith("/") || path.startsWith("~/")) {
    return path;
  }

  // Handle ./ prefix
  if (path.startsWith("./")) {
    return join(base, path.slice(2));
  }

  // Bare relative path without ./
  if (!path.startsWith("/")) {
    return join(base, path);
  }

  return path;
}

/**
 * Comprehensive path normalization with configurable options
 *
 * Returns a NormalizedPath branded type to ensure type safety and prevent double-normalization.
 *
 * @param path - Path to normalize
 * @param options - Normalization options
 * @returns Normalized path with branded type
 *
 * @example
 * normalizePath("~/workspace/./file.ts")  // → NormalizedPath("/home/user/workspace/file.ts")
 * normalizePath("./file.ts", { makeAbsolute: true }) // → NormalizedPath("/cwd/file.ts")
 */
export function normalizePath(
  path: string,
  options: {
    expandTilde?: boolean;
    expandRelative?: boolean;
    makeAbsolute?: boolean;
  } = {},
): NormalizedPath {
  const {
    expandTilde: shouldExpandTilde = true,
    expandRelative: shouldExpandRelative = true,
    makeAbsolute = false,
  } = options;

  let result = path;

  // Expand tilde first
  if (shouldExpandTilde) {
    result = expandTilde(result);
  }

  // Expand relative paths
  if (shouldExpandRelative || makeAbsolute) {
    result = expandRelativePath(result);
  }

  return toNormalizedPath(result);
}

/**
 * Convert absolute path to cwd-relative path
 *
 * @param path - Absolute path to convert
 * @returns Relative path starting with ./ if within cwd, or null if outside cwd
 *
 * @example
 * makeRelativeToCwd("/cwd/src/file.ts")  // → "./src/file.ts"
 * makeRelativeToCwd("/cwd")              // → "."
 * makeRelativeToCwd("/other/path")       // → null
 */
export function makeRelativeToCwd(path: string): string | null {
  if (!path.startsWith("/")) {
    return null;
  }

  const cwd = process.cwd();

  if (path.startsWith(`${cwd}/`)) {
    return `./${path.slice(cwd.length + 1)}`;
  } else if (path === cwd) {
    return ".";
  }

  return null;
}

/**
 * Normalize path for pattern matching with special handling for gitignore-style patterns
 *
 * This function is designed for comparing file paths against patterns in the context
 * of permission checking (allow/deny lists). It handles special cases like ./** which
 * should remain as a gitignore-style pattern rather than being expanded.
 *
 * Returns a NormalizedPath branded type to ensure type safety when used with matchGitignorePattern.
 *
 * @param path - File path to normalize
 * @param pattern - Pattern being matched against (used to determine normalization strategy)
 * @param options - Additional options
 * @returns Normalized path with branded type suitable for matching
 *
 * @example
 * // Standard normalization
 * normalizePathForMatching("~/workspace/file.ts", "~/workspace/**")
 * // → NormalizedPath("/home/user/workspace/file.ts")
 *
 * // Avoids expanding ./** pattern
 * normalizePathForMatching("./src/file.ts", "./**")
 * // → NormalizedPath("./src/file.ts") (not expanded because pattern is a gitignore-style ./**)
 *
 * // Relative to absolute when pattern is absolute
 * normalizePathForMatching("src/file.ts", "/absolute/path/**")
 * // → NormalizedPath("/cwd/src/file.ts")
 */
export function normalizePathForMatching(
  path: string,
  pattern: string,
  options: {
    avoidGitignorePatterns?: boolean;
  } = {},
): NormalizedPath {
  const { avoidGitignorePatterns = true } = options;

  let result = path;

  // Always expand tilde in paths
  result = expandTilde(result);

  // Convert relative paths to absolute if pattern is absolute
  if (result && !result.startsWith("/") && !result.startsWith("~")) {
    if (pattern.startsWith("/") || pattern.startsWith("~/")) {
      result = expandRelativePath(result);
    }
  }

  // Convert absolute paths to relative if pattern is relative (but not tilde)
  if (
    result.startsWith("/") &&
    !pattern.startsWith("/") &&
    !pattern.startsWith("~/")
  ) {
    // Special handling: ./** is a gitignore pattern, not a file path
    if (avoidGitignorePatterns && pattern === "./**") {
      // Don't convert to relative for ./** pattern - it's a special gitignore pattern
      return toNormalizedPath(result);
    }

    const relativePath = makeRelativeToCwd(result);
    if (relativePath !== null) {
      result = relativePath;
    }
  }

  return toNormalizedPath(result);
}

/**
 * Normalize a pattern string (for comparing against file paths)
 *
 * Returns a NormalizedPattern branded type to ensure type safety and prevent
 * mixing up file paths and pattern strings.
 *
 * @param pattern - Pattern string that may contain tilde or relative paths
 * @param options - Additional options
 * @returns Normalized pattern with branded type
 *
 * @example
 * normalizePattern("~/workspace/**")  // → NormalizedPattern("/home/user/workspace/**")
 * normalizePattern("./src/**")        // → NormalizedPattern("/cwd/src/**")
 * normalizePattern("./**")            // → NormalizedPattern("./**") (preserved as gitignore pattern)
 */
export function normalizePattern(
  pattern: string,
  options: {
    preserveGitignorePatterns?: boolean;
  } = {},
): NormalizedPattern {
  const { preserveGitignorePatterns = true } = options;

  // Preserve special gitignore-style patterns
  if (preserveGitignorePatterns && pattern === "./**") {
    return toNormalizedPattern(pattern);
  }

  // Expand tilde
  if (pattern.startsWith("~/")) {
    return toNormalizedPattern(join(homedir(), pattern.slice(2)));
  }

  // Expand relative paths
  if (pattern.startsWith("./")) {
    // Skip ./** only if preserveGitignorePatterns is true
    if (pattern === "./**" && preserveGitignorePatterns) {
      return toNormalizedPattern(pattern);
    }
    return toNormalizedPattern(join(process.cwd(), pattern.slice(2)));
  }

  return toNormalizedPattern(pattern);
}
