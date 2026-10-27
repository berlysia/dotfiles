import type { EngineInterface, Register, Timer } from "claude-code";
import { buildReminder } from "./reminder";

const CODEX_AGENT = "codex:codex-rescue";
// $.session.usage() answers from memory; if it is slow something is wrong, and
// a delegation must not wait on a reminder.
const USAGE_TIMEOUT_MS = 500;

// The engine follows `$` only into functions declared at the top level of the
// module, so the helper takes `$` as an argument.

/** The current rate limits, or null on a rejection or a timeout. */
async function readRateLimits($: EngineInterface): Promise<unknown> {
  let timer: Timer | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = $.clock.after(USAGE_TIMEOUT_MS, () => resolve(null));
  });
  try {
    return await Promise.race([
      $.session.usage().then((u) => u.rateLimits),
      timeout,
    ]);
  } catch {
    return null;
  } finally {
    timer?.cancel();
  }
}

export const register: Register = (on) => {
  on("tool.call", { tool: ["Agent", "Workflow"] }, async ($, e, next) => {
    // Never stops or rewrites the call; the reminder is added after it ran.
    const result = await next(e);
    if (result.deny !== undefined) return result;
    // Already delegated to Codex: nothing to redirect.
    if (
      e.tool === "Agent" &&
      (e as { subagent_type?: unknown }).subagent_type === CODEX_AGENT
    ) {
      return result;
    }
    try {
      const rateLimits = await readRateLimits($);
      if (rateLimits === null) return result;
      const reminder = buildReminder(rateLimits, await $.clock.now());
      if (reminder === null) return result;
      return { ...result, context: [...(result.context ?? []), reminder] };
    } catch {
      // This mod's failure must not fail the delegation.
      return result;
    }
  });
};
