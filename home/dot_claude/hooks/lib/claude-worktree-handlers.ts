import {
  cleanupSubagentWorktree,
  createWorktree,
  removeWorktree,
} from "./claude-worktree.ts";
import type { Deps } from "./claude-worktree-git.ts";
import { stripControlChars } from "./claude-worktree-git.ts";

// Hook-level behaviour for the three events (spec K7 and its mapping table):
// parse the raw stdin JSON by hand, call the core, and turn the result into
// stdout / stderr / exit code. Entries only read stdin and write this result.
// Everything that reaches stderr passes through stripControlChars once, here,
// because it may carry git output and paths from the hook input.

export type HandlerResult = {
  stdout: string;
  stderr: string;
  exitCode: 0 | 1;
};

const SILENT_OK: HandlerResult = { stdout: "", stderr: "", exitCode: 0 };

function finish(
  exitCode: 0 | 1,
  stderrLines: readonly string[],
  stdout = "",
): HandlerResult {
  const stderr = stderrLines
    .map((line) => `${line.replace(/\r?\n/g, " ").trim()}\n`)
    .join("");
  return { stdout, stderr: stripControlChars(stderr), exitCode };
}

function parseObject(rawStdin: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStdin);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// WorktreeCreate: stdout is the worktree path on success and empty otherwise;
// exit 0 <=> success (I1). Every failure, including exceptions, exits 1.
export function handleWorktreeCreate(
  rawStdin: string,
  deps?: Deps,
): HandlerResult {
  const input = parseObject(rawStdin);
  if (!input) {
    return finish(1, ["WorktreeCreate: input is not a JSON object"]);
  }
  const name = nonEmptyString(input["name"]);
  const cwd = nonEmptyString(input["cwd"]);
  if (name === null || cwd === null) {
    return finish(1, [
      "WorktreeCreate: input needs string fields name and cwd",
    ]);
  }
  try {
    const result = createWorktree({ name, cwd }, deps);
    if (!result.ok) {
      return finish(1, [
        `worktree create failed (${result.reason}): ${result.message}`,
      ]);
    }
    return finish(0, result.warnings, `${result.path}\n`);
  } catch (error) {
    return finish(1, [`worktree create failed: ${errorText(error)}`]);
  }
}

// WorktreeRemove and SubagentStop share one entry and are told apart by
// hook_event_name. Input that cannot be classified does nothing and exits 0.
export function handleWorktreeCleanup(
  rawStdin: string,
  deps?: Deps,
): HandlerResult {
  const input = parseObject(rawStdin);
  if (!input) return SILENT_OK;
  switch (input["hook_event_name"]) {
    case "WorktreeRemove":
      return handleRemove(input, deps);
    case "SubagentStop":
      return handleSubagentStop(input, deps);
    default:
      return SILENT_OK;
  }
}

function handleRemove(
  input: Record<string, unknown>,
  deps?: Deps,
): HandlerResult {
  const worktreePath = nonEmptyString(input["worktree_path"]);
  if (worktreePath === null) {
    return finish(1, [
      "WorktreeRemove: input needs a string field worktree_path",
    ]);
  }
  // Claude Code always sends cwd; without it, fall back to the hook's own cwd.
  const cwd = nonEmptyString(input["cwd"]) ?? process.cwd();
  try {
    const result = removeWorktree({ worktreePath, cwd }, deps);
    if (!result.ok) {
      return finish(1, [
        `worktree remove refused (${result.reason}): ${result.message}`,
      ]);
    }
    const lines: string[] = [];
    if (result.keptBranch) {
      const { name, reason } = result.keptBranch;
      lines.push(`kept branch ${name}: ${reason}`);
      if (reason === "prunable" || reason === "remove-incomplete") {
        lines.push("to drop the stale registration, run: git worktree prune");
      }
    }
    return finish(0, lines);
  } catch (error) {
    return finish(1, [`worktree remove failed: ${errorText(error)}`]);
  }
}

// SubagentStop must never block the subagent's stop, so every path exits 0
// (an exit 2 here would keep the subagent running).
function handleSubagentStop(
  input: Record<string, unknown>,
  deps?: Deps,
): HandlerResult {
  const agentId = input["agent_id"];
  const cwd = nonEmptyString(input["cwd"]);
  if (typeof agentId !== "string" || cwd === null) {
    return finish(0, [
      "SubagentStop: agent_id or cwd is missing; nothing cleaned up",
    ]);
  }
  try {
    const result = cleanupSubagentWorktree({ agentId, cwd }, deps);
    switch (result.action) {
      case "none":
        return SILENT_OK;
      case "removed":
        return result.keptBranch
          ? finish(0, [
              `kept branch ${result.keptBranch.name}: ${result.keptBranch.reason}`,
            ])
          : SILENT_OK;
      case "kept":
        return finish(0, [`subagent worktree kept: ${result.detail}`]);
    }
  } catch (error) {
    return finish(0, [`subagent worktree cleanup failed: ${errorText(error)}`]);
  }
}
