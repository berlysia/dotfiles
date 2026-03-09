#!/usr/bin/env -S bun run --silent

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
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

function isInsideRepo(filePath: string, repoRoot: string): boolean {
  const resolved = resolve(filePath);
  return resolved.startsWith(repoRoot);
}

function findRepoRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

function runBiomeFormat(filePath: string, repoRoot: string): LintResult | null {
  try {
    execSync(`npx biome format --write "${filePath}"`, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return null; // format succeeded silently
  } catch {
    return null; // format errors are non-blocking
  }
}

function runBiomeCheck(filePath: string, repoRoot: string): LintResult | null {
  try {
    execSync(`npx biome check "${filePath}"`, {
      cwd: repoRoot,
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
        tool: "biome check",
        output: output.trim(),
        exitCode: err.status || 1,
      };
    }
    return null;
  }
}

function runOxlint(filePath: string, repoRoot: string): LintResult | null {
  try {
    execSync(`npx oxlint "${filePath}"`, {
      cwd: repoRoot,
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

function getLinters(
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
        () => runBiomeFormat(filePath, repoRoot),
        () => runBiomeCheck(filePath, repoRoot),
        () => runOxlint(filePath, repoRoot),
      ];
    case ".json":
      return [
        () => runBiomeFormat(filePath, repoRoot),
        () => runBiomeCheck(filePath, repoRoot),
      ];
    case ".sh":
      return [() => runShellcheck(filePath)];
    default:
      return [];
  }
}

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;

    try {
      const filePath = getFilePath(
        tool_name,
        tool_input as Record<string, unknown>,
      );
      if (!filePath) return context.success({});

      // Only lint files that exist (Write creates new files, but file may have been deleted)
      if (!existsSync(filePath)) return context.success({});

      const repoRoot = findRepoRoot();
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
