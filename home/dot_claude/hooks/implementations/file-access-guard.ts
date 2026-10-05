#!/usr/bin/env -S bun run --silent

import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import {
  formatChezmoiRedirectMessage,
  getChezmoiSourcePath,
  isDotfilesRepository,
} from "../lib/chezmoi-utils.ts";
import { createDenyResponse } from "../lib/context-helpers.ts";
import { getHomeDir, type MatchContext } from "../lib/path-utils.ts";
import {
  checkParentSegments,
  errnoOf,
  hasParentSegment,
  isUnderRoot,
  resolvePhysicalPath,
} from "../lib/path-containment.ts";
import { matchGitignorePattern } from "../lib/pattern-matcher.ts";
import { createMatchContext, getProjectRoot } from "../lib/project-root.ts";
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

      // Physical cwd, resolved once; undefined when it cannot be resolved.
      const cwdResolved = resolvePhysicalPath(
        process.env.CLAUDE_TEST_CWD || process.cwd(),
      );
      const cwdPhysical = cwdResolved.ok ? cwdResolved.path : undefined;

      const homeDir = getHomeDir();
      const ctx: JudgeContext = {
        category: TOOL_CATEGORY[tool_name],
        allowPatterns,
        repoRoot,
        homeDir,
        additionalDirs: additionalDirs.flatMap((addDir) => {
          if (addDir.startsWith("/")) return [resolve(addDir)];
          return cwdPhysical === undefined
            ? []
            : [resolve(cwdPhysical, addDir)];
        }),
        tempRoots: collectTempRoots(tmpdir(), realpathSync),
        workflowDirRoots,
        systemPaths: SYSTEM_PATHS,
        caseInsensitive: process.platform === "darwin",
        cwdPhysical,
        match: { ...createMatchContext(context.input.cwd), home: homeDir },
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

/**
 * Whether `absTarget` is provably inside a temp root, both as written and
 * after following every symlink on the way to where the write would land.
 *
 * `..` is rejected outright: Node's realpath collapses `sym/..` lexically,
 * while the OS resolves it through the symlink, so the physical location
 * cannot be trusted for such inputs. Legitimate scratchpad / mktemp writes
 * never need `..`.
 */
export function isWithinTempRoots(
  absTarget: string,
  roots: string[],
  realpath: (p: string) => string,
  lstat: (p: string) => { isSymbolicLink(): boolean },
): boolean {
  if (!absTarget.startsWith("/") || hasParentSegment(absTarget)) return false;
  if (!roots.some((root) => isUnderRoot(absTarget, root))) return false;
  const physical = resolvePhysicalPath(absTarget, { realpath, lstat });
  return physical.ok && roots.some((root) => isUnderRoot(physical.path, root));
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
  tempRoots: string[]; // written and realpath forms (collectTempRoots)
  workflowDirRoots: string[]; // written and realpath forms
  systemPaths: string[]; // SYSTEM_PATHS in production; tests may narrow it
  caseInsensitive: boolean; // process.platform === "darwin" in production
  cwdPhysical: string | undefined; // resolvePhysicalPath(CLAUDE_TEST_CWD || process.cwd()), undefined when it cannot be resolved
  match: MatchContext; // anchors for permission pattern matching; home follows homeDir
}

export interface Judgement {
  allowed: boolean;
  step: string;
  reason?: string;
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

// No cache: one invocation judges a handful of paths, and module-level state
// would leak between tests that rebuild symlinks under the same name.
function realpathOrUndefined(p: string): string | undefined {
  const resolved = resolvePhysicalPath(p);
  return resolved.ok ? resolved.path : undefined;
}

/** Rewrites a realpath(HOME) / realpath(repoRoot) prefix to the written root. */
function mapToWrittenRoots(form: string, ctx: JudgeContext): string {
  let best: { real: string; written: string } | undefined;
  // repoRoot first, so that it wins when both prefixes have the same length.
  for (const written of [ctx.repoRoot, ctx.homeDir]) {
    const real = realpathOrUndefined(written);
    if (real === undefined || real === written || !isUnderRoot(form, real))
      continue;
    if (best === undefined || real.length > best.real.length)
      best = { real, written };
  }
  return best === undefined
    ? form
    : best.written + form.slice(best.real.length);
}

// The written root, plus its realpath when judging the physical form. The
// written value is always kept, so a root that cannot be resolved still counts.
function rootCandidates(root: string, physical: boolean): string[] {
  if (!physical) return [root];
  const real = realpathOrUndefined(root);
  return real === undefined || real === root ? [root] : [root, real];
}

export function judge(
  form: string,
  ctx: JudgeContext,
  physical: boolean,
): Judgement {
  // 1. Repository -> always allowed
  if (isUnderRoot(form, ctx.repoRoot)) {
    return { allowed: true, step: "1-repo" };
  }

  // 1.5. Under an OS temp dir -> allowed, ahead of the system-directory deny.
  // On macOS os.tmpdir() is under /var/folders, unreachable after the blanket
  // /var deny. collectTempRoots returns the written and the realpath forms, so
  // one comparison serves both the lexical and the physical judgement.
  if (ctx.tempRoots.some((root) => isUnderRoot(form, root))) {
    return { allowed: true, step: "1.5-temp" };
  }

  // 1.6. The session's workflow dir. It stays under the project root even
  // when the repo root is a linked worktree (spec K10), so it is outside
  // repoRoot whenever work happens inside a worktree.
  if (ctx.workflowDirRoots.some((root) => isUnderRoot(form, root))) {
    return { allowed: true, step: "1.6-workflow" };
  }

  // 2. System directories -> always denied (an allow pattern cannot override)
  const subject = ctx.caseInsensitive ? form.toLowerCase() : form;
  for (const systemPath of ctx.systemPaths) {
    const candidates = [
      systemPath,
      ...(physical ? [realpathOrUndefined(systemPath)] : []),
    ].filter((c): c is string => c !== undefined);
    for (const candidate of candidates) {
      const cmp = ctx.caseInsensitive ? candidate.toLowerCase() : candidate;
      if (subject.startsWith(`${cmp}/`)) {
        return {
          allowed: false,
          step: "2-system",
          reason: `Access to system directory '${systemPath}' is always denied for security`,
        };
      }
    }
  }

  // 3. Always-safe paths
  const alwaysSafePaths = [join(ctx.homeDir, ".claude"), "/var/tmp"];
  for (const safePath of alwaysSafePaths) {
    if (
      rootCandidates(safePath, physical).some((root) => isUnderRoot(form, root))
    ) {
      return { allowed: true, step: "3-safe" };
    }
  }

  // 4. additionalDirectories: read is automatic, write needs an allow pattern
  for (const addDir of ctx.additionalDirs) {
    if (
      rootCandidates(addDir, physical).some((root) => isUnderRoot(form, root))
    ) {
      if (ctx.category === "read") {
        return { allowed: true, step: "4-additional" };
      }
      if (
        ctx.category === "write" &&
        checkAllowPatterns(form, ctx.allowPatterns, ctx.match)
      ) {
        return { allowed: true, step: "4-additional" };
      }
    }
  }

  // 5. Explicit permissions.allow match. Patterns are never realpath'd: a
  // symlink the agent can plant must not move the allowed range.
  if (checkAllowPatterns(form, ctx.allowPatterns, ctx.match)) {
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

interface DenyFields {
  message: string;
  lexical: string;
  physical?: string;
  unresolvable?: string;
  form?: "lexical" | "physical";
  step: string;
}

function deny(fields: DenyFields): PathValidationResult {
  const lines = [fields.message, `lexical=${fields.lexical}`];
  if (fields.physical !== undefined) lines.push(`physical=${fields.physical}`);
  if (fields.unresolvable !== undefined) {
    lines.push(`unresolvable=${fields.unresolvable}`);
  }
  if (fields.form !== undefined) lines.push(`denied-form=${fields.form}`);
  lines.push(`step=${fields.step}`);
  if (fields.form === "physical") {
    lines.push(
      `hint: the path resolves through a symlink to ${fields.physical}; to allow it, add that location to additionalDirectories or an allow pattern`,
    );
  } else if (fields.unresolvable === "EDANGLING") {
    lines.push(
      "hint: the path is a symlink whose target does not exist; create the target or remove the link",
    );
  } else if (fields.unresolvable === "ELOOP") {
    lines.push("hint: the path goes through a symlink loop; remove the loop");
  } else if (fields.unresolvable === "EACCES") {
    lines.push(
      "hint: a directory on the path cannot be read; check its permissions",
    );
  }
  return {
    isAllowed: false,
    resolvedPath: fields.physical ?? fields.lexical,
    reason: lines.join("\n"),
  };
}

function validatePath(path: string, ctx: JudgeContext): PathValidationResult {
  try {
    // 1. `..`
    const parent = checkParentSegments(path);
    if (!parent.ok) {
      return deny({
        message:
          parent.kind === "absolute"
            ? "An absolute path may not contain a .. segment. Write the path without .."
            : "A relative path may only start with .. segments. Collapse the .. or use an absolute path without ..",
        lexical: path,
        step: "parent-segment",
      });
    }

    // 2. lexical and physical forms
    const isAbsolute = path.startsWith("/");
    let lexical: string;
    if (isAbsolute) {
      lexical = stripTrailingSlash(posix.normalize(path));
    } else {
      if (ctx.cwdPhysical === undefined) {
        return deny({
          message: "The working directory cannot be resolved",
          lexical: path,
          unresolvable: "ECWD",
          step: "cwd",
        });
      }
      lexical = resolve(ctx.cwdPhysical, path);
    }
    const physical = resolvePhysicalPath(lexical);
    if (!physical.ok) {
      return deny({
        message:
          "The path cannot be resolved, so where it lands cannot be checked",
        lexical,
        unresolvable: physical.code,
        step: "resolve",
      });
    }

    // 3. map realpath(HOME) / realpath(repoRoot) prefixes back to the written form.
    // A relative path was resolved from the physical cwd, so it gets the same mapping.
    const physicalForm = mapToWrittenRoots(physical.path, ctx);
    const lexicalForm = isAbsolute ? lexical : mapToWrittenRoots(lexical, ctx);

    // 4-5. both forms must be allowed. The physical judgement is never skipped:
    // only it compares the deny list and the roots in their realpath form.
    const lexicalJudgement = judge(lexicalForm, ctx, false);
    if (!lexicalJudgement.allowed) {
      return deny({
        message: lexicalJudgement.reason ?? "Access is not allowed",
        lexical: lexicalForm,
        physical: physicalForm,
        form: "lexical",
        step: lexicalJudgement.step,
      });
    }
    const physicalJudgement = judge(physicalForm, ctx, true);
    if (!physicalJudgement.allowed) {
      return deny({
        message: physicalJudgement.reason ?? "Access is not allowed",
        lexical: lexicalForm,
        physical: physicalForm,
        form: "physical",
        step: physicalJudgement.step,
      });
    }
    return { isAllowed: true, resolvedPath: lexicalForm };
  } catch (error) {
    return deny({
      message: "The path could not be checked",
      lexical: path,
      unresolvable: errnoOf(error),
      step: "exception",
    });
  }
}

function checkAllowPatterns(
  filePath: string,
  allowPatterns: string[],
  match: MatchContext,
): boolean {
  for (const pattern of allowPatterns) {
    // Extract path pattern from tool pattern like "Read(path/pattern)"
    const extracted = pattern.match(/^[^(]+\((.+)\)$/);
    if (extracted?.[1]) {
      if (matchGitignorePattern(filePath, extracted[1], match, "grant")) {
        return true;
      }
    }
  }
  return false;
}

function join(...paths: string[]): string {
  return paths.join("/").replace(/\/+/g, "/");
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
