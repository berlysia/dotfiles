#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { runGit } from "../lib/run-git.ts";
import {
  enqueueSessionJob,
  jobInputFromHook,
  spawnWorker,
} from "../lib/agent-learnings/claude/session-context.ts";
import { getHomeDir } from "../lib/path-utils.ts";

/**
 * SessionEnd / PreCompact hook: queue the session for the agent-learnings
 * worker and start the worker without waiting for it. Registered with
 * `"async": true`. A failure is reported on stderr and never blocks the session.
 *
 * The file keeps its "session-end" name because the settings template and its
 * test refer to it by that name.
 */
const hook = defineHook({
  trigger: { SessionEnd: true, PreCompact: true },
  run: (context) => {
    try {
      enqueueSessionJob(jobInputFromHook(context.input), {
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
