#!/usr/bin/env -S bun run --silent

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { logQuality } from "../lib/centralized-logging.ts";
import "../types/tool-schemas.ts";

/**
 * Stop hook that runs tests/typecheck before allowing completion.
 *
 * If the project has its own Stop hooks in .claude/settings.json,
 * this hook skips execution to avoid redundant test/typecheck runs.
 *
 * Uses a file-based retry counter (.tmp/.completion-gate-retries) to
 * prevent infinite loops. After MAX_RETRIES failures, switches to
 * warning-only mode.
 */

const MAX_RETRIES = 3;
const COUNTER_FILENAME = ".completion-gate-retries";

function getCounterPath(): string {
  const cwd = process.cwd();
  return join(cwd, ".tmp", COUNTER_FILENAME);
}

function getRetryCount(): number {
  const counterPath = getCounterPath();
  try {
    if (existsSync(counterPath)) {
      const content = readFileSync(counterPath, "utf-8").trim();
      const count = Number.parseInt(content, 10);
      return Number.isNaN(count) ? 0 : count;
    }
  } catch {
    // ignore read errors
  }
  return 0;
}

function incrementRetryCount(): number {
  const counterPath = getCounterPath();
  const newCount = getRetryCount() + 1;
  try {
    const dir = dirname(counterPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(counterPath, String(newCount), "utf-8");
  } catch {
    // ignore write errors
  }
  return newCount;
}

function resetRetryCount(): void {
  const counterPath = getCounterPath();
  try {
    if (existsSync(counterPath)) unlinkSync(counterPath);
  } catch {
    // ignore unlink errors
  }
}

function hasScript(scriptName: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
    return Boolean(pkg.scripts?.[scriptName]);
  } catch {
    return false;
  }
}

/**
 * Check if the project's .claude/settings.json has its own Stop hooks.
 * If so, the project handles completion checks itself and this hook
 * should skip to avoid redundant execution.
 */
function projectHasStopHooks(): boolean {
  try {
    const settingsPath = join(process.cwd(), ".claude", "settings.json");
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const stopHooks = settings?.hooks?.Stop;
    return Array.isArray(stopHooks) && stopHooks.length > 0;
  } catch {
    return false;
  }
}

function runCheck(command: string, label: string): string | null {
  try {
    execSync(command, {
      encoding: "utf-8",
      timeout: 120000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return null;
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string };
    const output = ((err.stdout || "") + (err.stderr || "")).trim();
    const lines = output.split("\n");
    const tail = lines.slice(-20).join("\n");
    return `${label} failed:\n${tail}`;
  }
}

const hook = defineHook({
  trigger: { Stop: true, UserPromptSubmit: true },
  run: (context) => {
    try {
      // 新しいユーザー入力 = 新しいターン。カウンタを reset しないと
      // 一度 MAX に到達した時点で永続無効化される。
      if (context.input.hook_event_name === "UserPromptSubmit") {
        resetRetryCount();
        return context.success({});
      }

      if (projectHasStopHooks()) {
        console.error(
          "[completion-gate] Project has its own Stop hooks. Skipping to avoid redundant execution.",
        );
        return context.success({});
      }

      const { session_id } = context.input;
      const retryCount = getRetryCount();

      if (retryCount >= MAX_RETRIES) {
        console.error(
          `[completion-gate] Max retries (${MAX_RETRIES}) reached. Allowing completion with warning.`,
        );
        return context.success({});
      }

      const errors: string[] = [];

      if (hasScript("typecheck")) {
        const result = runCheck("pnpm typecheck", "typecheck");
        if (result) {
          errors.push(result);
          logQuality("completion-gate", "typecheck", result, session_id);
        }
      }

      if (hasScript("test")) {
        const result = runCheck("pnpm test", "test");
        if (result) {
          errors.push(result);
          logQuality("completion-gate", "test", result, session_id);
        }
      }

      if (errors.length === 0) {
        return context.success({});
      }

      const count = incrementRetryCount();
      const remaining = MAX_RETRIES - count;

      return context.json({
        event: "Stop",
        output: {
          decision: "block" as const,
          reason: `COMPLETION BLOCKED (attempt ${count}/${MAX_RETRIES}, ${remaining} remaining):\n\n${errors.join("\n\n")}\n\nFix these issues before completing.`,
        },
      });
    } catch (error) {
      console.error(`[completion-gate] Error: ${error}`);
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
