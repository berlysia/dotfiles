#!/usr/bin/env -S bun run --silent

/**
 * `hook-timing`: reads `$CLAUDE_LOGS_DIR/hook-timing.jsonl` (written by
 * `hook-timer.sh`, see hooks/README.md "Hook telemetry") and prints per-hook
 * and per-event timing stats.
 *
 * `runHookTimingCli` is a pure function over injected deps (no ambient
 * `process.env` / `fs` reads inside it), following the same split as
 * `cli/workflow.ts`: `node --test` can call it directly, and the
 * `import.meta.main` block below is the only place this file touches the
 * real process.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getHomeDir } from "../lib/path-utils.ts";
import {
  formatReport,
  parseHookTimingLines,
  summarizeBlocking,
  summarizeByHook,
} from "../lib/hook-timing-report.ts";

const USAGE =
  "usage: hook-timing [--since <N>h|<N>d] [--session <session-id-prefix>] [--json]\n";

const SINCE_PATTERN = /^(\d+)(h|d)$/;
const DEFAULT_SINCE = "24h";

export type CliArgs = {
  sinceMs: number;
  sessionPrefix: string | null;
  json: boolean;
};

function sinceToMs(value: string): number | null {
  const match = value.match(SINCE_PATTERN);
  if (!match) return null;
  const amount = Number(match[1]);
  const unitMs = match[2] === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return amount * unitMs;
}

export function parseArgs(argv: string[]): CliArgs | { error: string } {
  let since = DEFAULT_SINCE;
  let sessionPrefix: string | null = null;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--since") {
      const value = argv[++i];
      if (value === undefined)
        return { error: `${USAGE}--since requires a value\n` };
      since = value;
    } else if (arg === "--session") {
      const value = argv[++i];
      if (value === undefined)
        return { error: `${USAGE}--session requires a value\n` };
      sessionPrefix = value;
    } else if (arg === "--json") {
      json = true;
    } else {
      return { error: `${USAGE}unrecognized argument: ${arg}\n` };
    }
  }

  const sinceMs = sinceToMs(since);
  if (sinceMs === null) {
    return { error: `${USAGE}invalid --since value: ${since}\n` };
  }

  return { sinceMs, sessionPrefix, json };
}

export interface HookTimingCliDeps {
  logDir: string;
  now: Date;
  readFileIfExists: (path: string) => string | null;
}

export type HookTimingCliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * `hook-timing.jsonl` and its single rotated generation `.1` (K6) are
 * concatenated, oldest first, before filtering by `--since` / `--session`.
 */
export function runHookTimingCli(
  argv: string[],
  deps: HookTimingCliDeps,
): HookTimingCliResult {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    return { exitCode: 2, stdout: "", stderr: parsed.error };
  }

  const currentPath = resolve(deps.logDir, "hook-timing.jsonl");
  const rotatedPath = resolve(deps.logDir, "hook-timing.jsonl.1");
  const rotatedContent = deps.readFileIfExists(rotatedPath);
  const currentContent = deps.readFileIfExists(currentPath);
  if (rotatedContent === null && currentContent === null) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `no telemetry yet: ${currentPath} (hooks are wrapped after chezmoi apply)\n`,
    };
  }

  const { records } = parseHookTimingLines(
    `${rotatedContent ?? ""}${currentContent ?? ""}`,
  );

  const sinceCutoffMs = deps.now.getTime() - parsed.sinceMs;
  const filtered = records.filter((record) => {
    if (
      parsed.sessionPrefix &&
      !(record.session_id ?? "").startsWith(parsed.sessionPrefix)
    ) {
      return false;
    }
    const recordMs = Date.parse(record.ts);
    if (!Number.isNaN(recordMs) && recordMs < sinceCutoffMs) return false;
    return true;
  });

  const byHook = summarizeByHook(filtered);
  const blocking = summarizeBlocking(filtered);

  if (parsed.json) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ byHook, blocking })}\n`,
      stderr: "",
    };
  }

  // Excluded here, not in formatReport: summarizeByHook/summarizeBlocking
  // already dropped duration_ms===null records internally, so this count is
  // taken from the filtered records the report tables were built from.
  const excludedNoDuration = filtered.filter(
    (record) => record.duration_ms === null,
  ).length;
  const report = formatReport(byHook, blocking);
  return {
    exitCode: 0,
    stdout: `${report}\nexcluded (no duration): ${excludedNoDuration}\n`,
    stderr: "",
  };
}

if (import.meta.main) {
  const logDir =
    process.env.CLAUDE_LOGS_DIR || resolve(getHomeDir(), ".claude", "logs");
  const result = runHookTimingCli(process.argv.slice(2), {
    logDir,
    now: new Date(),
    readFileIfExists: (path) =>
      existsSync(path) ? readFileSync(path, "utf8") : null,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  // Not process.exit(): this CLI file lives under hooks/ so the repo's
  // no-process-exit lint rule (guarding against a Claude Code hook process
  // killing itself mid-flight, docs/decisions/0002) flags it there. Setting
  // exitCode and letting the event loop drain naturally achieves the same
  // observable exit status for a standalone CLI invocation without an
  // abrupt process.exit() call.
  process.exitCode = result.exitCode;
}
