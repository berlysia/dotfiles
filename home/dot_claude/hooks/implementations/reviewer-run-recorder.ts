#!/usr/bin/env -S bun run --silent

/**
 * PostToolUse(Agent) ledger for spec K5's `workflow-cli stamp` reviewer
 * verification: records that a reviewer subagent actually ran this session,
 * so `stamp` can refuse to write a verdict when the model claims reviews
 * happened but the Agent tool was never invoked with that subagent_type.
 *
 * Only reviewer-named subagents and the reframer are recorded
 * (`isRecordedAgentSlug`, derived from the same rosters
 * `workflow-review-core.ts` uses — no third copy of the reviewer set, spec K5
 * architecture-strategist finding). Explore / general-purpose / any other
 * subagent_type is ignored.
 */

import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import {
  isRecordedAgentSlug,
  REVIEWER_SLUGS,
} from "../lib/workflow-review-core.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";
import "../types/tool-schemas.ts";

const LEDGER_FILENAME = "reviewer-runs.log";
const LEDGER_MAX_LINES = 200;

/**
 * The reviewer slug set and the "is this launch ledgered" rule live in
 * `workflow-review-core.ts` so this hook cannot drift from the rosters it
 * exists to ledger runs for. A recorded `subagent_type` is normalized to its
 * last `:`-separated segment before lookup, so a plugin-namespaced run of a
 * same-named agent (e.g. `some-plugin:review:security-vulnerability-analyzer`)
 * is still counted — an accepted behaviour, not a plugin-agent allowance.
 * Re-exported for the existing tests.
 */
export { REVIEWER_SLUGS };

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: async (context) => {
    if (context.input.tool_name !== "Agent") {
      return context.success({});
    }

    const toolInput = context.input.tool_input as
      | { subagent_type?: unknown }
      | undefined;
    const subagentType = toolInput?.subagent_type;
    if (typeof subagentType !== "string" || subagentType.length === 0) {
      return context.success({});
    }
    if (!isRecordedAgentSlug(subagentType)) {
      return context.success({});
    }

    const cwd = process.env.CLAUDE_TEST_CWD || process.cwd();
    const resolution = resolveWorkflowDir({
      cwd,
      sessionId: context.input.session_id,
    });
    if (resolution.source === "unresolvable") {
      return context.success({});
    }

    appendReviewerRun(
      resolution.dir,
      `${context.input.session_id}\t${subagentType}\t${new Date().toISOString()}`,
    );
    return context.success({});
  },
});

/**
 * Append one line to `<wfDir>/reviewer-runs.log`, keeping only the most
 * recent `LEDGER_MAX_LINES` entries (FIFO cap). Refuses to follow a
 * symlinked ledger path (mirrors `workflow-bash-sync.ts`'s tripwire baseline
 * hardening) and is best-effort throughout: a ledger write failure must not
 * surface to the model or block the Agent call it is recording.
 */
function appendReviewerRun(wfDir: string, line: string): void {
  try {
    mkdirSync(wfDir, { recursive: true });
  } catch {
    // best-effort; fall through and let the open() below fail if it must
  }

  const logPath = resolve(wfDir, LEDGER_FILENAME);
  const existing = readExistingLinesSafely(logPath);
  if (existing === null) {
    return; // symlinked ledger: refuse rather than write through it
  }

  const all = [...existing, line];
  const capped =
    all.length > LEDGER_MAX_LINES
      ? all.slice(all.length - LEDGER_MAX_LINES)
      : all;

  try {
    const fd = openSync(
      logPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, `${capped.join("\n")}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort
  }
}

/** Returns `[]` when the ledger does not exist yet, `null` when it is a symlink. */
function readExistingLinesSafely(path: string): string[] | null {
  let st: ReturnType<typeof lstatSync> | null;
  try {
    st = lstatSync(path);
  } catch {
    return [];
  }
  if (st.isSymbolicLink()) {
    return null;
  }
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
