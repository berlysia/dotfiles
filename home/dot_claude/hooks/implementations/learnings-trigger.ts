#!/usr/bin/env -S bun run --silent

import { buildSceneContext } from "../lib/agent-learnings/claude/scene-context.ts";
import { createRunGit, type RunGit } from "../lib/agent-learnings/core/git.ts";
import { getHomeDir } from "../lib/path-utils.ts";

/**
 * PreToolUse (Bash / Edit / Write / MultiEdit / NotebookEdit) and
 * PostToolUseFailure (Bash) hook: put the learnings whose `on` matches the
 * moment into Claude's context. Output is `additionalContext` only; this hook
 * never decides anything, never exits non-zero, and a failure prints nothing.
 *
 * It is registered without run-guard.sh on purpose: run-guard turns a hook
 * failure into a deny (exit 2), and a learnings hint must never block work.
 */

const MAX_STDIN_BYTES = 1024 * 1024;
const WATCHDOG_MS = 2000;

export type TriggerDeps = {
  home: string;
  runGit: RunGit;
  now: Date;
  env: Readonly<Record<string, string | undefined>>;
};

export type TriggerOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse" | "PostToolUseFailure";
    additionalContext: string;
  };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const str = (obj: Record<string, unknown> | null, key: string) => {
  const value = obj?.[key];
  return typeof value === "string" ? value : undefined;
};

// input.error は読まない: 失敗の出力は信頼できない内容を含みうる
export function run(input: unknown, deps: TriggerDeps): TriggerOutput | null {
  try {
    const root = asRecord(input);
    const event = str(root, "hook_event_name");
    const tool = str(root, "tool_name");
    const toolInput = asRecord(root?.tool_input ?? null);
    const sessionId = str(root, "session_id");
    const cwd = str(root, "cwd");
    if (sessionId === undefined || cwd === undefined) return null;

    let scene:
      | { kind: "pre" | "fail"; command: string }
      | { kind: "path"; filePath: string };
    if (
      tool === "Bash" &&
      (event === "PreToolUse" || event === "PostToolUseFailure")
    ) {
      const command = str(toolInput, "command");
      if (command === undefined) return null;
      scene = { kind: event === "PreToolUse" ? "pre" : "fail", command };
    } else if (
      event === "PreToolUse" &&
      (tool === "Edit" ||
        tool === "Write" ||
        tool === "MultiEdit" ||
        tool === "NotebookEdit")
    ) {
      const filePath = str(
        toolInput,
        tool === "NotebookEdit" ? "notebook_path" : "file_path",
      );
      if (filePath === undefined) return null;
      scene = { kind: "path", filePath };
    } else {
      return null;
    }

    const agentId = str(root, "agent_id");
    const additionalContext = buildSceneContext({
      ...scene,
      home: deps.home,
      cwd,
      sessionId,
      ...(agentId === undefined ? {} : { agentId }),
      runGit: deps.runGit,
      now: deps.now,
      env: deps.env,
    });
    if (additionalContext === null) return null;
    return {
      hookSpecificOutput: { hookEventName: event, additionalContext },
    } as TriggerOutput;
  } catch {
    return null;
  }
}

// stdin を 1MB まで読む。超過・エラー・watchdog は null（何も出さない）。
// timer は unref し、終わったら必ず消す
function readStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
      if (value === null) process.stdin.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), WATCHDOG_MS);
    timer.unref();
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) return finish(null);
      chunks.push(chunk);
    });
    process.stdin.on("end", () =>
      finish(Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.on("error", () => finish(null));
  });
}

if (import.meta.main) {
  try {
    const raw = await readStdin();
    if (raw !== null) {
      const output = run(JSON.parse(raw), {
        home: getHomeDir(),
        runGit: createRunGit(1000),
        now: new Date(),
        env: process.env,
      });
      if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
    // 何も出さずに終える
  }
  process.exitCode = 0;
}
