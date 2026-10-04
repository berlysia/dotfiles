#!/usr/bin/env -S bun run --silent

import { execSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import {
  formatChezmoiRedirectMessage,
  getChezmoiSourcePath,
  isDotfilesRepository,
} from "../lib/chezmoi-utils.ts";
import { createDenyResponse } from "../lib/context-helpers.ts";
import { expandTilde, getHomeDir } from "../lib/path-utils.ts";
import { hasParentSegment, isUnderRoot } from "../lib/path-containment.ts";
import { matchGitignorePattern } from "../lib/pattern-matcher.ts";
import { getProjectRoot } from "../lib/project-root.ts";
import { collectTempRoots } from "../lib/temp-roots.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";
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
      const workflowDirRoots = getWorkflowDirRoots(context.input.session_id);

      // Extract file paths from tool input
      if (typeof tool_input !== "object" || tool_input === null) {
        return context.success({});
      }
      const filePaths = extractFilePaths(
        tool_name,
        tool_input as Record<string, unknown>,
      );

      const ctx: JudgeContext = {
        category: TOOL_CATEGORY[tool_name],
        allowPatterns,
        repoRoot,
        homeDir: getHomeDir(),
        additionalDirs: additionalDirs.map((addDir) =>
          resolve(resolvePath(addDir)),
        ),
        tempRoots: collectTempRoots(tmpdir(), realpathSync),
        workflowDirRoots,
        systemPaths: SYSTEM_PATHS,
        caseInsensitive: process.platform === "darwin",
      };

      // Check each path
      for (const filePath of filePaths) {
        const validation = validatePath(filePath, ctx);
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
  const homeDir = getHomeDir();

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

/**
 * The session's workflow dir, both as resolved and physically, for the
 * isWithinTempRoots check. Empty when it cannot be resolved: the hook then
 * judges paths exactly as before K10.
 */
function getWorkflowDirRoots(sessionId: string): string[] {
  try {
    const resolution = resolveWorkflowDir({ cwd: getProjectRoot(), sessionId });
    if (resolution.source === "unresolvable") return [];
    const roots = [resolution.dir];
    try {
      roots.push(realpathSync(resolution.dir));
    } catch {
      // Not created yet: the lexical root is all there is to compare with.
    }
    return [...new Set(roots)];
  } catch (error) {
    console.error(
      `file-access-guard: workflow dir not resolved: ${String(error)}`,
    );
    return [];
  }
}

type Category = "read" | "write";

// Maps each tool to the kind of access it performs. Bash has no entry: steps 4
// and 6 skip it and it falls to the default deny, exactly as before.
// PERMISSION_CATEGORY above answers a different question (which allow-pattern
// prefix covers a tool); keep the two in step when a tool is added.
const TOOL_CATEGORY: Record<string, Category> = {
  Read: "read",
  NotebookRead: "read",
  LS: "read",
  Glob: "read",
  Grep: "read",
  Write: "write",
  Edit: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
};

const SYSTEM_PATHS = [
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

export interface JudgeContext {
  category: Category | undefined;
  allowPatterns: string[];
  repoRoot: string;
  homeDir: string;
  additionalDirs: string[]; // already absolute, no trailing slash
  tempRoots: string[]; // T4: read by validatePath (step 1.5). T5: read by judge
  workflowDirRoots: string[]; // T4: read by validatePath (step 1.6). T5: read by judge
  systemPaths: string[]; // SYSTEM_PATHS in production; tests may narrow it
  caseInsensitive: boolean; // process.platform === "darwin" in production
}

export interface Judgement {
  allowed: boolean;
  step: string;
  reason?: string;
}

export function judge(form: string, ctx: JudgeContext): Judgement {
  // 1. Repository -> always allowed
  if (isUnderRoot(form, ctx.repoRoot)) {
    return { allowed: true, step: "1-repo" };
  }

  // 2. System directories -> always denied (an allow pattern cannot override)
  for (const systemPath of ctx.systemPaths) {
    if (form.startsWith(`${systemPath}/`)) {
      return {
        allowed: false,
        step: "2-system",
        reason: `Access to system directory '${systemPath}' is always denied for security`,
      };
    }
  }

  // 3. Always-safe paths
  const alwaysSafePaths = [join(ctx.homeDir, ".claude"), "/var/tmp"];
  for (const safePath of alwaysSafePaths) {
    if (form.startsWith(`${safePath}/`) || form === safePath) {
      return { allowed: true, step: "3-safe" };
    }
  }

  // 4. additionalDirectories: read is automatic, write needs an allow pattern
  for (const addDir of ctx.additionalDirs) {
    if (isUnderRoot(form, addDir)) {
      if (ctx.category === "read") {
        return { allowed: true, step: "4-additional" };
      }
      if (
        ctx.category === "write" &&
        checkAllowPatterns(form, ctx.allowPatterns)
      ) {
        return { allowed: true, step: "4-additional" };
      }
    }
  }

  // 5. Explicit permissions.allow match
  if (checkAllowPatterns(form, ctx.allowPatterns)) {
    return { allowed: true, step: "5-pattern" };
  }

  // 6. Chezmoi handling for the dotfiles repository
  if (
    form.startsWith(`${ctx.homeDir}/`) &&
    isDotfilesRepository(ctx.repoRoot)
  ) {
    const chezmoiSourcePath = getChezmoiSourcePath(form, ctx.repoRoot);

    // 6a. Writes to a chezmoi-managed file are redirected to its source
    if (ctx.category === "write" && chezmoiSourcePath) {
      return {
        allowed: false,
        step: "6-chezmoi",
        reason: formatChezmoiRedirectMessage(form, chezmoiSourcePath),
      };
    }

    // 6b. Reads are allowed without exposing chezmoi
    if (ctx.category === "read") {
      return { allowed: true, step: "6-chezmoi" };
    }
  }

  // Default: deny access outside repository
  return {
    allowed: false,
    step: "default",
    reason: "File is outside repository root and not explicitly allowed",
  };
}

function validatePath(path: string, ctx: JudgeContext): PathValidationResult {
  const absPath = resolvePath(path);

  // 1.5. Under an OS temp dir -> allowed, ahead of the system-directory deny.
  // On macOS os.tmpdir() is under /var/folders, unreachable after the blanket
  // /var deny. `..` must survive, so the raw absolute path is used, not absPath.
  const rawAbs = path.startsWith("/")
    ? path
    : `${process.env.CLAUDE_TEST_CWD || process.cwd()}/${path}`;

  // The repository check comes first in the original order; judge repeats it,
  // so only the temp-root steps need to run before it when the repo misses.
  if (!isUnderRoot(absPath, ctx.repoRoot)) {
    if (isWithinTempRoots(rawAbs, ctx.tempRoots, realpathSync, lstatSync)) {
      return { isAllowed: true, resolvedPath: absPath };
    }

    // 1.6. The session's workflow dir. It stays under the project root even
    // when the repo root is a linked worktree (spec K10), so it is outside
    // repoRoot whenever work happens inside a worktree.
    if (
      ctx.workflowDirRoots.length > 0 &&
      isWithinTempRoots(rawAbs, ctx.workflowDirRoots, realpathSync, lstatSync)
    ) {
      return { isAllowed: true, resolvedPath: absPath };
    }
  }

  const judgement = judge(absPath, ctx);
  return {
    isAllowed: judgement.allowed,
    resolvedPath: absPath,
    ...(judgement.reason === undefined ? {} : { reason: judgement.reason }),
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
