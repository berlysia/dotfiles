#!/usr/bin/env -S bun run --silent

import { appendFileSync, existsSync } from "node:fs";
import { defineHook } from "cc-hooks-ts";
import {
  findUntrackedPlugins,
  INSTALLED_PLUGINS_PATH,
  loadDependencies,
  loadInstalledPlugins,
  PLUGIN_DEPENDENCIES_PATH,
} from "../../lib/plugin-utils.ts";
import { logEvent } from "../lib/centralized-logging.ts";

function checkSharedTaskList(): string | null {
  const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
  if (taskListId) {
    return `⚠️ CLAUDE_CODE_TASK_LIST_ID is set: ${taskListId}\n   This session shares a task list from another session. Tasks may be overwritten unintentionally.\n   To detach: unset CLAUDE_CODE_TASK_LIST_ID`;
  }
  return null;
}

function checkPluginSync(): string | null {
  if (
    !existsSync(PLUGIN_DEPENDENCIES_PATH) ||
    !existsSync(INSTALLED_PLUGINS_PATH)
  ) {
    return null;
  }

  try {
    const dependencies = loadDependencies();
    const installed = loadInstalledPlugins();
    const installedKeys = Array.from(installed);

    const untracked = findUntrackedPlugins(dependencies, installedKeys);

    if (untracked.length > 0) {
      const names = untracked.map((k) => k.split("@")[0]).join(", ");
      return `📦 New plugins detected: ${names}\n   Run: bun ~/.claude/scripts/sync-plugin-dependencies.ts`;
    }
  } catch {
    // ignore errors
  }
  return null;
}

/**
 * Session management hooks
 * Handles SessionStart events using centralized logging
 */
const hook = defineHook({
  trigger: { SessionStart: true },
  run: (context) => {
    try {
      // Log session start using centralized logger
      logEvent("SessionStart", context.input.session_id);

      // Export session info to CLAUDE_ENV_FILE for skills to consume
      const envFile = process.env.CLAUDE_ENV_FILE;
      if (envFile) {
        const sessionId = context.input.session_id;
        const transcriptPath = context.input.transcript_path;
        const projectHash = context.input.cwd
          .replace(/\//g, "-")
          .replace(/^-/, "");
        appendFileSync(envFile, `export CLAUDE_SESSION_ID="${sessionId}"\n`);
        appendFileSync(
          envFile,
          `export CLAUDE_TRANSCRIPT_PATH="${transcriptPath}"\n`,
        );
        appendFileSync(
          envFile,
          `export CLAUDE_PROJECT_HASH="${projectHash}"\n`,
        );

        const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
        if (taskListId) {
          appendFileSync(
            envFile,
            `export CLAUDE_TASK_LIST_ID="${taskListId}"\n`,
          );
        }
      }

      const taskListWarning = checkSharedTaskList();
      const pluginSyncMessage = checkPluginSync();
      const messages = [
        "🚀 Claude Code session started. Ready for development!",
      ];
      if (taskListWarning) {
        messages.push(taskListWarning);
      }
      if (pluginSyncMessage) {
        messages.push(pluginSyncMessage);
      }

      return context.success({
        messageForUser: messages.join("\n"),
      });
    } catch (error) {
      console.error(`Session start error: ${error}`);
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
