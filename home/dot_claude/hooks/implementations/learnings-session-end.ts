#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { runGit } from "../lib/agent-learnings/core/git.ts";
import {
  enqueueSessionEnd,
  spawnWorker,
} from "../lib/agent-learnings/claude/session-context.ts";
import { getHomeDir } from "../lib/path-utils.ts";

/**
 * SessionEnd hook: queue the finished session for the agent-learnings worker
 * and start the worker without waiting for it. Registered with `"async": true`.
 * A failure is reported on stderr and never blocks the session from ending.
 */
const hook = defineHook({
  trigger: { SessionEnd: true },
  run: (context) => {
    try {
      enqueueSessionEnd(context.input, {
        home: getHomeDir(),
        runGit,
        env: process.env,
        spawn: spawnWorker,
      });
    } catch (error) {
      console.error(`agent-learnings session-end failed: ${error}`);
    }
    return context.success({});
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
