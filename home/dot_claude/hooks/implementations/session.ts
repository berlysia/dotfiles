#!/usr/bin/env -S bun run --silent

import { appendFileSync } from "node:fs";
import { defineHook } from "cc-hooks-ts";
import { logEvent } from "../lib/centralized-logging.ts";

function checkSharedTaskList(): string | null {
  const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
  if (taskListId) {
    return `⚠️ CLAUDE_CODE_TASK_LIST_ID is set: ${taskListId}\n   This session shares a task list from another session. Tasks may be overwritten unintentionally.\n   To detach: unset CLAUDE_CODE_TASK_LIST_ID`;
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

        // Set session-specific workflow directory for parallel Document Workflow
        const shortSessionId = sessionId.slice(0, 8);
        const workflowDir = `.tmp/sessions/${shortSessionId}`;
        appendFileSync(
          envFile,
          `export DOCUMENT_WORKFLOW_DIR="${workflowDir}"\n`,
        );
      }

      const taskListWarning = checkSharedTaskList();
      const messages = [
        "🚀 Claude Code session started. Ready for development!",
      ];
      if (envFile) {
        const shortId = context.input.session_id.slice(0, 8);
        messages.push(
          `Document Workflow directory: .tmp/sessions/${shortId}/`,
        );
      }
      if (taskListWarning) {
        messages.push(taskListWarning);
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
