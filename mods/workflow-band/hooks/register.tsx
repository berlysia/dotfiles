import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { WorkflowFailure, WorkflowSnapshot } from "../types";
import { layoutBand } from "./layout";
import { toSnapshot } from "./parse";

const snapshot = atom(
  { plugin: "workflow-band", key: "snapshot" } as const,
  null,
);

const WORKFLOW_DOC_PATH = /\/\.tmp\/sessions\/[^/]+\//;

/**
 * Runs workflow-cli the way the Bash tool would: Claude Code hands its Bash
 * children CLAUDE_PROJECT_DIR and CLAUDE_CODE_SESSION_ID, while
 * `$.process.run` starts from the host process's own environment, which
 * lacks them (or, in a claude started from another session's Bash, holds the
 * parent's). Only those two are set here. DOCUMENT_WORKFLOW_DIR (a launch-time
 * pin) and CLAUDE_TEST_CWD are left to pass through from the host, so an
 * override the person started the session with keeps working.
 */
async function runWorkflowCli($: EngineInterface, args: string[]) {
  const [root, id] = await Promise.all([$.session.root(), $.session.id()]);
  return $.process.run(["workflow-cli", ...args], {
    cwd: root,
    env: { CLAUDE_PROJECT_DIR: root, CLAUDE_CODE_SESSION_ID: id },
    timeoutMs: 5000,
  });
}

async function readSnapshot(
  $: EngineInterface,
): Promise<WorkflowSnapshot | WorkflowFailure> {
  try {
    const [status, dir] = await Promise.all([
      runWorkflowCli($, ["status"]),
      runWorkflowCli($, ["dir"]),
    ]);
    return toSnapshot(status, dir);
  } catch (error) {
    // workflow-cli missing from PATH, or timed out.
    return {
      error: `workflow-cli could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function refresh($: EngineInterface): Promise<void> {
  const next = await readSnapshot($);
  await update($, snapshot, () => next);
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await refresh($);
    return result;
  });

  on("session.end", async ($, e, next) => {
    // After /clear the process goes on under a new session id and no
    // session.start follows; the old session's gate must not linger.
    if (e.reason === "clear") await update($, snapshot, () => null);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) await refresh($);
    return result;
  });

  // Mid-turn refreshes: a workflow document written, or workflow-cli run
  // (round / stamp / triage move the marker).
  on("tool.call", { tool: ["Write", "Edit"] }, async ($, e, next) => {
    const result = await next(e);
    const path = "file_path" in e ? String(e.file_path ?? "") : "";
    if (WORKFLOW_DOC_PATH.test(path)) await refresh($);
    return result;
  });
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const result = await next(e);
    if (String(e.command ?? "").includes("workflow-cli")) await refresh($);
    return result;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const current = await read($, snapshot);
    const rows = layoutBand(current, {
      columns: e.props.bodyColumns - 2,
      maxRows: e.props.maxRows,
    });
    if (e.props.hasSurvey || rows === null) return next(e);

    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="column" paddingX={1}>
        {rows.map((row, rowIndex) => (
          <Box key={rowIndex} flexDirection="row">
            {row.map((segment, index) => (
              <Text
                key={index}
                color={segment.color}
                bold={segment.bold}
                dimColor={segment.dim}
              >
                {segment.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    );
  });
};
