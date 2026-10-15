#!/usr/bin/env -S bun run --silent

import { handleWorktreeCreate } from "../lib/claude-worktree-handlers.ts";
import { stripControlChars } from "../lib/claude-worktree-git.ts";

// WorktreeCreate hook. Deliberately not a defineHook script: Claude Code reads
// the last non-empty stdout line as the worktree path, so stdout must carry
// that path and nothing else (spec K7). Failures exit 1 with stdout empty.

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  try {
    const result = handleWorktreeCreate(await readStdin());
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    // Outside the handler (e.g. stdin could not be read): nothing on stdout.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${stripControlChars(`worktree-create failed: ${message}`.replace(/\n/g, " "))}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
