#!/usr/bin/env -S bun run --silent

import { createRunGit } from "../lib/agent-learnings/core/git.ts";
import { run } from "../lib/agent-learnings/codex/scene-hook.ts";
import { getHomeDir } from "../lib/path-utils.ts";
import { readStdinLimited } from "../lib/read-stdin-limited.ts";

/**
 * Codex PreToolUse (Bash / apply_patch) hook: put the learnings whose `on`
 * matches the moment into Codex's context. Output is `additionalContext` only;
 * this hook never decides anything, never exits non-zero, and a failure prints
 * nothing. The logic lives in lib/agent-learnings/codex/scene-hook.ts.
 */

const MAX_STDIN_BYTES = 1024 * 1024;
const WATCHDOG_MS = 2000;

if (import.meta.main) {
  try {
    const raw = await readStdinLimited(MAX_STDIN_BYTES, WATCHDOG_MS);
    if (raw !== null) {
      const output = run(JSON.parse(raw), {
        home: getHomeDir(),
        runGit: createRunGit(1000, { isolateGlobalConfig: true }),
        now: new Date(),
      });
      if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
    // 何も出さずに終える
  }
  process.exitCode = 0;
}
