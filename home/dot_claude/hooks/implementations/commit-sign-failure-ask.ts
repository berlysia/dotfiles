#!/usr/bin/env -S bun run --silent

/**
 * When a commit-creating git command fails to sign, tells the model to ask the
 * user (AskUserQuestion, which fires Notification) instead of stopping
 * silently, and backs that up with one Stop block per failure.
 *
 * One definition serves PostToolUse(Bash|AskUserQuestion),
 * PostToolUseFailure(Bash) and Stop; the matcher in settings narrows the tool.
 * Detection and wording live in lib/commit-sign-failure.ts. The marker is per
 * session_id, which subagents share with the main loop, so a subagent's failure
 * is still visible to the main loop's Stop.
 */

import { readFileSync, statSync } from "node:fs";
import { defineHook } from "cc-hooks-ts";
import {
  buildSignFailureContext,
  clearMarker,
  detectSignFailure,
  hasMarker,
  isChezmoiUpdateCommand,
  isCommitCreatingCommand,
  signFailureMarkerDir,
  STOP_REASON,
  writeMarker,
} from "../lib/commit-sign-failure.ts";
import { isSafeSessionId } from "../lib/session-id.ts";
import "../types/tool-schemas.ts";

// Large Bash output reaches hooks cut to its first 30000 chars (stderr merged
// in), with the full text in the file at persistedOutputPath. A pre-commit run
// prints far more than that before git's signing error, so read the file too.
const PERSISTED_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

function readPersistedOutput(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    if (statSync(path).size > PERSISTED_OUTPUT_MAX_BYTES) return undefined;
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

export function createHook(getMarkerDir: () => string = signFailureMarkerDir) {
  return defineHook({
    trigger: { PostToolUse: true, PostToolUseFailure: true, Stop: true },
    run: (context) => {
      try {
        const input = context.input;
        const sessionId = input.session_id;
        const markerDir = getMarkerDir();

        if (input.hook_event_name === "Stop") {
          if (input.agent_id || input.stop_hook_active) {
            return context.success({});
          }
          if (!hasMarker(markerDir, sessionId)) return context.success({});
          clearMarker(markerDir, sessionId);
          return context.json({
            event: "Stop",
            output: { decision: "block" as const, reason: STOP_REASON },
          });
        }

        const isSubagent = Boolean(input.agent_id);
        const toolName = input.tool_name;

        if (
          input.hook_event_name === "PostToolUse" &&
          toolName === "AskUserQuestion"
        ) {
          if (!isSubagent) clearMarker(markerDir, sessionId);
          return context.success({});
        }

        if (toolName !== "Bash") return context.success({});

        const command = stringField(input.tool_input, "command") ?? "";
        const outputText =
          input.hook_event_name === "PostToolUseFailure"
            ? input.error
            : [
                stringField(input.tool_response, "stdout"),
                stringField(input.tool_response, "stderr"),
                readPersistedOutput(
                  stringField(input.tool_response, "persistedOutputPath"),
                ),
              ]
                .filter((s): s is string => s !== undefined)
                .join("\n");

        const labels = detectSignFailure(command, outputText);
        if (labels.length === 0) {
          // A commit-creating command that succeeded cleanly resolves an
          // earlier failure; only the main loop's own retry counts.
          if (
            input.hook_event_name === "PostToolUse" &&
            !isSubagent &&
            isCommitCreatingCommand(command)
          ) {
            clearMarker(markerDir, sessionId);
          }
          return context.success({});
        }

        if (!isSafeSessionId(sessionId)) {
          console.error(
            "[commit-sign-failure-ask] unsafe session_id; marker not written",
          );
        } else if (!writeMarker(markerDir, sessionId, labels)) {
          console.error(
            "[commit-sign-failure-ask] could not write marker; Stop backstop disabled for this failure",
          );
        }

        const additionalContext = buildSignFailureContext({
          labels,
          isSubagent,
          isChezmoiUpdate: isChezmoiUpdateCommand(command),
        });
        if (input.hook_event_name === "PostToolUseFailure") {
          return context.json({
            event: "PostToolUseFailure",
            output: {
              hookSpecificOutput: {
                hookEventName: "PostToolUseFailure" as const,
                additionalContext,
              },
            },
          });
        }
        return context.json({
          event: "PostToolUse",
          output: {
            hookSpecificOutput: {
              hookEventName: "PostToolUse" as const,
              additionalContext,
            },
          },
        });
      } catch (error) {
        console.error(
          `[commit-sign-failure-ask] ${error instanceof Error ? error.message : String(error)}`,
        );
        return context.success({});
      }
    },
  });
}

const hook = createHook();
export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
