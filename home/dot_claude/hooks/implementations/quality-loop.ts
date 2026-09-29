#!/usr/bin/env -S bun run --silent

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { logQuality } from "../lib/centralized-logging.ts";
import { runCustomRules } from "../lib/custom-rules.ts";
import "../types/tool-schemas.ts";

/**
 * PostToolUse quality feedback loop
 *
 * Runs linters/formatters on edited files and injects errors as additionalContext.
 * This implements the "deterministic quality feedback loop" pattern from
 * Harness Engineering best practices.
 */

const FILE_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit"]);

interface LintResult {
  tool: string;
  output: string;
  exitCode: number;
}

function getFilePath(
  tool_name: string,
  tool_input: Record<string, unknown>,
): string | null {
  if (!FILE_TOOL_NAMES.has(tool_name)) return null;
  const filePath =
    (tool_input.file_path as string) || (tool_input.path as string);
  return filePath || null;
}

export function isInsideRepo(filePath: string, repoRoot: string): boolean {
  try {
    const resolved = realpathSync(resolve(filePath));
    const root = realpathSync(repoRoot);
    return resolved.startsWith(root + sep);
  } catch {
    return false;
  }
}

/** Repo root of the edited file (not of the hook process's cwd). */
export function findRepoRoot(filePath: string): string | null {
  try {
    const dir = dirname(realpathSync(resolve(filePath)));
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Roots whose node_modules/.bin may be searched: the repo root and, when the
 * root is a linked worktree, the parent repo root. Nothing above them.
 */
export function findBinRoots(root: string): string[] {
  const roots = [root];
  try {
    const common = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--git-common-dir"],
      { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const commonDir = resolve(root, common);
    if (basename(commonDir) === ".git") {
      const parent = dirname(commonDir);
      if (parent !== root) roots.push(parent);
    }
  } catch {
    // not a git repo or git unavailable: root only
  }
  return roots;
}

export function findLocalBin(roots: string[], tool: string): string | null {
  for (const r of roots) {
    const candidate = join(r, "node_modules", ".bin", tool);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export type FormatterName = "oxfmt" | "biome" | "prettier";

function hasAny(root: string, names: string[]): boolean {
  return names.some((n) => existsSync(join(root, n)));
}

function hasPrettierKeyInPackageJson(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    return (
      typeof pkg === "object" && pkg !== null && "prettier" in (pkg as object)
    );
  } catch {
    return false;
  }
}

/** Formatters configured at the repo root, in priority order oxfmt > biome > prettier. */
export function detectFormatters(root: string): FormatterName[] {
  const found: FormatterName[] = [];
  if (hasAny(root, [".oxfmtrc.json", ".oxfmtrc.jsonc"])) found.push("oxfmt");
  if (hasAny(root, ["biome.json", "biome.jsonc"])) found.push("biome");
  let prettier = hasPrettierKeyInPackageJson(root);
  if (!prettier) {
    try {
      prettier = readdirSync(root).some(
        (n) => n.startsWith(".prettierrc") || n.startsWith("prettier.config."),
      );
    } catch {
      prettier = false;
    }
  }
  if (prettier) found.push("prettier");
  return found;
}

const COMMON_FORMAT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
]);
const YAML_EXTS = new Set([".yaml", ".yml"]);

export function isFormattable(tool: FormatterName, filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (COMMON_FORMAT_EXTS.has(ext)) return true;
  return YAML_EXTS.has(ext) && tool !== "biome";
}

export function formatArgs(
  tool: FormatterName,
  file: string,
  root: string,
): string[] {
  switch (tool) {
    case "oxfmt":
      return existsSync(join(root, ".oxfmtignore"))
        ? ["--write", "--ignore-path", ".oxfmtignore", file]
        : ["--write", file];
    case "prettier":
      return ["--write", "--ignore-unknown", file];
    case "biome":
      return ["format", "--write", "--no-errors-on-unmatched", file];
  }
}

const OXFMT_EXCLUDED_MESSAGE = "Expected at least one target file";
const STDERR_LIMIT = 300;

export function runFormat(
  filePath: string,
  root: string,
  timeoutMs = 10_000,
): LintResult | null {
  const candidates = detectFormatters(root).filter((t) =>
    isFormattable(t, filePath),
  );
  if (candidates.length === 0) return null;

  const roots = findBinRoots(root);
  let tool: FormatterName | undefined;
  let bin: string | null = null;
  for (const c of candidates) {
    bin = findLocalBin(roots, c);
    if (bin) {
      tool = c;
      break;
    }
  }
  if (!tool || !bin) {
    const first = candidates[0];
    return {
      tool: "formatter",
      output: `${first} is configured but not installed (node_modules/.bin/${first} not found)`,
      exitCode: 1,
    };
  }

  try {
    execFileSync(bin, formatArgs(tool, resolve(filePath), root), {
      cwd: root,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return null;
  } catch (error: unknown) {
    const err = error as {
      status?: number | null;
      stderr?: string | Buffer;
      code?: string;
      message?: string;
    };
    const stderr = String(err.stderr ?? "");
    // oxfmt reports a file excluded by the config as exit 2 with this message;
    // any other exit 2 (e.g. a config parse error) is a real failure.
    if (
      tool === "oxfmt" &&
      err.status === 2 &&
      stderr.includes(OXFMT_EXCLUDED_MESSAGE)
    ) {
      return null;
    }
    let detail = stderr.replace(/\s+/g, " ").trim();
    if (!detail) {
      detail =
        err.code === "ETIMEDOUT"
          ? `timed out after ${timeoutMs}ms`
          : `exit ${err.status ?? "unknown"}`;
    }
    return {
      tool: "formatter",
      output: `${tool} failed: ${detail.slice(0, STDERR_LIMIT)}`,
      exitCode: err.status || 1,
    };
  }
}

function runOxlint(filePath: string, repoRoot: string): LintResult | null {
  const bin = findLocalBin(findBinRoots(repoRoot), "oxlint");
  if (!bin) return null;
  try {
    execFileSync(bin, [resolve(filePath)], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return null;
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    const output = (err.stdout || "") + (err.stderr || "");
    if (output.trim()) {
      return {
        tool: "oxlint",
        output: output.trim(),
        exitCode: err.status || 1,
      };
    }
    return null;
  }
}

function runShellcheck(filePath: string): LintResult | null {
  try {
    execSync(`shellcheck --severity=warning "${filePath}"`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return null;
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    const output = (err.stdout || "") + (err.stderr || "");
    if (output.trim()) {
      return {
        tool: "shellcheck",
        output: output.trim(),
        exitCode: err.status || 1,
      };
    }
    return null;
  }
}

function runCustomLint(filePath: string): LintResult | null {
  try {
    const resolved = resolve(filePath);
    const content = readFileSync(resolved, "utf-8");
    const output = runCustomRules(resolved, content);
    if (output) {
      return { tool: "custom-rules", output, exitCode: 1 };
    }
    return null;
  } catch {
    return null;
  }
}

export function getLinters(
  filePath: string,
  repoRoot: string,
): (() => LintResult | null)[] {
  const ext = extname(filePath).toLowerCase();

  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
      return [
        () => runFormat(filePath, repoRoot),
        () => runOxlint(filePath, repoRoot),
      ];
    case ".mjs":
    case ".cjs":
    case ".mts":
    case ".cts":
      return [() => runFormat(filePath, repoRoot)];
    case ".json":
    case ".jsonc":
    case ".yaml":
    case ".yml":
      return [() => runFormat(filePath, repoRoot)];
    case ".sh":
      return [() => runShellcheck(filePath), () => runCustomLint(filePath)];
    case ".tmpl":
      return [() => runCustomLint(filePath)];
    default:
      return [];
  }
}

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: (context) => {
    const { tool_name, tool_input, session_id } = context.input;

    try {
      const filePath = getFilePath(
        tool_name,
        tool_input as Record<string, unknown>,
      );
      if (!filePath) return context.success({});

      // Only lint files that exist (Write creates new files, but file may have been deleted)
      if (!existsSync(filePath)) return context.success({});

      const repoRoot = findRepoRoot(filePath);
      if (!repoRoot) return context.success({});

      // Only lint files inside the repository
      if (!isInsideRepo(filePath, repoRoot)) return context.success({});

      const linters = getLinters(filePath, repoRoot);
      if (linters.length === 0) return context.success({});

      const errors: string[] = [];
      for (const runLinter of linters) {
        const result = runLinter();
        if (result) {
          errors.push(`[${result.tool}] ${result.output}`);
          logQuality(
            "quality-loop",
            result.tool,
            result.output,
            session_id,
            filePath,
          );
        }
      }

      if (errors.length > 0) {
        const head = errors.join("\n").split("\n").slice(0, 30).join("\n");
        return context.json({
          event: "PostToolUse",
          output: {
            hookSpecificOutput: {
              hookEventName: "PostToolUse" as const,
              additionalContext: `Quality loop found issues in ${filePath}:\n${head}`,
            },
          },
        });
      }

      return context.success({});
    } catch (error) {
      // Never block on quality loop errors
      console.error(`Quality loop error: ${error}`);
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
