#!/usr/bin/env node

import { logEvent } from "../lib/centralized-logging.ts";
import { prepareDenyInput } from "../lib/deny-input.ts";
import { readStdinLimited } from "../lib/read-stdin-limited.ts";
import {
  createSkillGuideDeadline,
  evaluateSkillGuide,
  logSkillGuideEvent,
  resolveSkillGuidePaths,
  SKILL_GUIDE_HOOK_DEADLINE_MS,
  SKILL_GUIDE_SCAN_DEADLINE_MS,
  type SkillGuideDeadline,
  type SkillGuideDeps,
  type SkillGuideGateResult,
  type SkillGuideRequest,
} from "../lib/skill-guide.ts";

const MAX_STDIN_BYTES = 1024 * 1024;
const WATCHDOG_MS = 2000;
const LOG_TAG = "[skill-guide-gate]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logInternalError(): void {
  try {
    logEvent("Error", undefined, `${LOG_TAG} internal error`);
  } catch (error) {
    process.stderr.write(
      `${LOG_TAG} failed to log internal error: ${String(error)}\n`,
    );
  }
}

function buildReason(denied: SkillGuideGateResult["denied"]): string {
  const entries = denied
    .map(({ skill, words }) => `${skill}（${words.join(" ")}）`)
    .join("、");
  const operation = denied[0]?.words.join(" ") ?? "Bash";
  const detailed = `${operation} の前に ${entries}を読む`;
  if (detailed.length <= 120) return detailed;

  const compact = `Bash の前に ${entries}を読む`;
  if (compact.length <= 120) return compact;
  return compact.slice(0, 120);
}

/** The PreToolUse output to print, or null to pass the call through. */
export async function run(
  input: unknown,
  deps?: SkillGuideDeps,
  deadline: SkillGuideDeadline = createSkillGuideDeadline(),
): Promise<object | null> {
  try {
    if (!isRecord(input)) return null;
    if (input["hook_event_name"] !== "PreToolUse") return null;
    if (input["tool_name"] !== "Bash") return null;
    const agentId = input["agent_id"];
    if (typeof agentId === "string" && agentId.length > 0) return null;

    const toolInput = input["tool_input"];
    if (!isRecord(toolInput)) return null;
    const command = toolInput["command"];
    if (typeof command !== "string") return null;

    const { individualCommands } = await prepareDenyInput(command);
    const request: SkillGuideRequest = {
      ...(typeof input["session_id"] === "string"
        ? { sessionId: input["session_id"] }
        : {}),
      ...(typeof input["transcript_path"] === "string"
        ? { transcriptPath: input["transcript_path"] }
        : {}),
      commands: individualCommands,
    };
    const paths = resolveSkillGuidePaths();
    const resolvedDeps = deps ?? paths;
    const scanCap = Math.min(
      SKILL_GUIDE_SCAN_DEADLINE_MS,
      deps?.scan?.deadlineMs ?? SKILL_GUIDE_SCAN_DEADLINE_MS,
    );
    const scanBudgetMs = deadline.remaining(scanCap);
    if (scanBudgetMs <= 0) {
      logSkillGuideEvent("timeout");
      return null;
    }
    const result = evaluateSkillGuide(request, {
      ...resolvedDeps,
      scan: { ...(deps?.scan ?? {}), deadlineMs: scanBudgetMs },
    });
    if (deadline.expired()) {
      logSkillGuideEvent("timeout");
      return null;
    }
    if (result.status !== "deny") return null;

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: buildReason(result.denied),
      },
    };
  } catch {
    logInternalError();
    return null;
  }
}

if (import.meta.main) {
  const deadline = createSkillGuideDeadline(SKILL_GUIDE_HOOK_DEADLINE_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logSkillGuideEvent("timeout");
      resolve(null);
    }, WATCHDOG_MS);
    timer.unref();
  });

  try {
    const work = (async () => {
      const stdinBudgetMs = deadline.remaining(WATCHDOG_MS);
      if (stdinBudgetMs <= 0) {
        logSkillGuideEvent("timeout");
        return null;
      }
      const raw = await readStdinLimited(MAX_STDIN_BYTES, stdinBudgetMs);
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      return run(parsed, undefined, deadline);
    })();
    const output = await Promise.race([work, watchdog]);
    if (output !== null && !deadline.expired()) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
    logInternalError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
