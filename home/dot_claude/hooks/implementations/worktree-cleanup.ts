#!/usr/bin/env -S bun run --silent

import { handleWorktreeCleanup } from "../lib/claude-worktree-handlers.ts";
import { stripControlChars } from "../lib/claude-worktree-git.ts";

// WorktreeRemove and SubagentStop hook (told apart by hook_event_name).
// Deliberately not a defineHook script: cc-hooks-ts turns invalid input into
// exit 1, but SubagentStop must always exit 0 (spec K7, I6).

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  try {
    const result = handleWorktreeCleanup(await readStdin());
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    // Outside the handler the event is unknown, so never fail the caller.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${stripControlChars(`worktree-cleanup failed: ${message}`.replace(/\n/g, " "))}\n`,
    );
    process.exitCode = 0;
  }
}

if (import.meta.main) {
  await main();
}
