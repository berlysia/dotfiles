#!/usr/bin/env -S bun run --silent

import { execSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import {
  formatChezmoiRedirectMessage,
  getChezmoiSourcePath,
  isDotfilesRepository,
} from "../lib/chezmoi-utils.ts";
import { createDenyResponse } from "../lib/context-helpers.ts";
import { expandTilde } from "../lib/path-utils.ts";
import { matchGitignorePattern } from "../lib/pattern-matcher.ts";
import type {
  PathValidationResult,
  SettingsFile,
} from "../types/project-types.ts";
import "../types/tool-schemas.ts";

/**
 * File Access Guard
 *
 * Controls file access based on repository boundaries and context:
 * - Allows access within repository root
 * - Blocks system directories for security
 * - Supports additionalDirectories and permissions.allow patterns
 * - Special handling for dotfiles repositories (chezmoi integration)
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
      if (typeof tool_input !== "object" || tool_input === null) {
        return context.success({});
      }
      const filePaths = extractFilePaths(
        tool_name,
        tool_input as Record<string, unknown>,
      );

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

/**
 * Claude Code の権限モデルはツール単位ではなくカテゴリ単位で解決される。
 * `Edit(path)` が全ファイル編集ツールを、`Read(path)` が全ファイル読み取りツールを
 * カバーし、`Write(path)` / `NotebookEdit(path)` / `Glob(path)` のようなツール名固有の
 * パスルールはネイティブ側で無視される（設定を書いても効かない）。
 * 各ツールを代表カテゴリへ写像し、フック側の判定をネイティブと一致させる。
 */
const PERMISSION_CATEGORY: Record<string, string> = {
  Write: "Edit",
  MultiEdit: "Edit",
  NotebookEdit: "Edit",
  Glob: "Read",
  Grep: "Read",
  LS: "Read",
  NotebookRead: "Read",
};

export function getAllowPatterns(
  settingsFiles: SettingsFile[],
  toolName: string,
): string[] {
  const patterns: string[] = [];

  // 自身のツール名も残すことで、既存の Grep(...) 等の設定を失効させない
  const acceptedNames = new Set([toolName]);
  const category = PERMISSION_CATEGORY[toolName];
  if (category) {
    acceptedNames.add(category);
  }

  for (const file of settingsFiles) {
    const allowList = file.permissions?.allow;
    if (Array.isArray(allowList)) {
      // Filter patterns for this tool and the category that covers it
      const toolPatterns = allowList.filter((pattern) =>
        [...acceptedNames].some(
          (name) => pattern === name || pattern.startsWith(`${name}(`),
        ),
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
    let match: RegExpExecArray | null;
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

// os.tmpdir() follows $TMPDIR, which a project's .claude/settings.json `env` can
// override. Accepting only the exact macOS per-user shape keeps a hostile value
// (`/`, `/var`, `~/.ssh`, the `C/` cache dir, ...) from becoming a writable root.
const MACOS_USER_TMPDIR_SHAPE = /^\/(private\/)?var\/folders\/[^/]+\/[^/]+\/T$/;

function hasParentSegment(p: string): boolean {
  return p.split("/").includes("..");
}

/**
 * Directories the OS hands out for temporary files: `/tmp` and the per-user
 * tmpdir, each in literal and realpath form (macOS: /tmp -> /private/tmp,
 * /var -> /private/var), so a path is recognised however it was spelled.
 */
export function collectTempRoots(
  tmpdir: string,
  realpath: (p: string) => string,
): string[] {
  const roots = new Set<string>(["/tmp"]);
  const addRealpath = (p: string, accept: (form: string) => boolean): void => {
    try {
      const real = realpath(p);
      if (accept(real)) roots.add(real);
    } catch {
      // Only the literal form is kept when the path cannot be resolved.
    }
  };

  // /tmp is OS-owned, so its realpath is trusted without a shape check.
  addRealpath("/tmp", () => true);

  // Checked before resolve(): resolve("") / resolve("tmp") would silently become the cwd.
  if (tmpdir.startsWith("/") && !hasParentSegment(tmpdir)) {
    const literal = resolve(tmpdir); // strips the trailing slash macOS $TMPDIR carries
    const accepted = (form: string): boolean =>
      MACOS_USER_TMPDIR_SHAPE.test(form);
    if (accepted(literal)) roots.add(literal);
    addRealpath(literal, accepted);
  }

  return [...roots];
}

function isUnderRoot(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Whether `absTarget` is provably inside a temp root, both as written and
 * after following every symlink on the way to where the write would land.
 *
 * `..` is rejected outright: bun's realpathSync collapses `sym/..` lexically
 * (measured), while the OS resolves it through the symlink, so the physical
 * location cannot be trusted for such inputs. Legitimate scratchpad / mktemp
 * writes never need `..`.
 */
export function isWithinTempRoots(
  absTarget: string,
  roots: string[],
  realpath: (p: string) => string,
  lstat: (p: string) => { isSymbolicLink(): boolean },
): boolean {
  if (!absTarget.startsWith("/") || hasParentSegment(absTarget)) return false;
  if (!roots.some((root) => isUnderRoot(absTarget, root))) return false;

  // The target may not exist yet (Write creating a file), so resolve the
  // nearest existing ancestor and re-attach the missing tail.
  const tail: string[] = [];
  let current = absTarget;
  for (;;) {
    try {
      const physical = join(realpath(current), ...tail);
      return roots.some((root) => isUnderRoot(physical, root));
    } catch (error) {
      if (!isMissingPathError(error)) return false; // EACCES, ELOOP, ...: fail closed
    }

    // realpath reports ENOENT for a dangling symlink too; its target is
    // unknown, so the link could point anywhere.
    try {
      lstat(current);
      return false;
    } catch (error) {
      if (!isMissingPathError(error)) return false;
    }

    const parent = dirname(current);
    if (parent === current) return false; // reached "/" and it cannot be resolved
    tail.unshift(basename(current));
    current = parent;
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

  // 1.5. OS の一時ディレクトリ配下 → 許可（システムディレクトリ判定より前）
  // macOS では os.tmpdir() が /var/folders 配下にあり、/var 一括拒否の後では到達できない。
  // `..` を保持するため resolvePath を通さず、生の絶対パスで判定する。
  const rawAbs = path.startsWith("/")
    ? path
    : `${process.env.CLAUDE_TEST_CWD || process.cwd()}/${path}`;
  if (
    isWithinTempRoots(
      rawAbs,
      collectTempRoots(tmpdir(), realpathSync),
      realpathSync,
      lstatSync,
    )
  ) {
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
  const alwaysSafePaths = [join(homeDir, ".claude"), "/var/tmp"];
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

  // 6. Chezmoi handling for dotfiles repository
  // ホームディレクトリ配下のファイルに対する特別処理
  if (absPath.startsWith(`${homeDir}/`) && isDotfilesRepository(repoRoot)) {
    const chezmoiSourcePath = getChezmoiSourcePath(absPath, repoRoot);

    // 6a. 編集操作（Edit/Write/MultiEdit）→ chezmoi管理ファイルならリダイレクト案内
    const isWriteOperation =
      toolName === "Edit" ||
      toolName === "Write" ||
      toolName === "MultiEdit" ||
      toolName === "NotebookEdit";

    if (isWriteOperation && chezmoiSourcePath) {
      return {
        isAllowed: false,
        resolvedPath: absPath,
        reason: formatChezmoiRedirectMessage(absPath, chezmoiSourcePath),
      };
    }

    // 6b. 読み取り操作（Read/Glob/Grep/LS）→ 許可（chezmoiを意識させない）
    const isReadOperation =
      toolName === "Read" ||
      toolName === "Glob" ||
      toolName === "Grep" ||
      toolName === "LS" ||
      toolName === "NotebookRead";

    if (isReadOperation) {
      return {
        isAllowed: true,
        resolvedPath: absPath,
      };
    }
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
