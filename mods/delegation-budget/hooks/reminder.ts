// Weekly use at or above this percentage triggers the reminder. It is a
// judgment call set below the 94% that went unnoticed once, not a value
// derived from the burn rate; adjust here if it proves too early or too late.
export const WEEKLY_THRESHOLD_PERCENT = 80;

const HOUR_MS = 3_600_000;

/**
 * Returns the sentence to hand the model, or null when there is nothing to
 * say. Only validated numbers go into the sentence: strings from `rateLimits`
 * (kind, resetsAt) are parsed or compared, never copied, so a hostile value
 * cannot reach the model's context.
 */
export function buildReminder(rateLimits: unknown, now: number): string | null {
  try {
    if (!Array.isArray(rateLimits)) return null;
    const weekly: unknown = rateLimits.find(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { kind?: unknown }).kind === "seven_day",
    );
    if (weekly === undefined) return null;
    const { percentUsed, resetsAt } = weekly as {
      percentUsed?: unknown;
      resetsAt?: unknown;
    };
    if (
      typeof percentUsed !== "number" ||
      !Number.isFinite(percentUsed) ||
      percentUsed < 0 ||
      percentUsed > 100 ||
      percentUsed < WEEKLY_THRESHOLD_PERCENT
    ) {
      return null;
    }
    return `[delegation-budget] Claude の週次枠は ${percentUsed}% 使用済み${resetPhrase(resetsAt, now)}。Sonnet 相当の定型の委譲（実装・調査・機械的な読み）は、ai-usage codex opencode --summary で exhausted でないことを確かめてから外部モデルに回す。重要な委譲は Codex GPT-6.1 Terra（Agent の subagent_type "codex:codex-rescue"）、単純な実装は GLM-5.3（opencode run -m zai-coding-plan/glm-5.3）でもよい。渡せなければ sonnet に回す。設計判断・subagent 結果の採否はメインループに残す。`;
  } catch {
    return null;
  }
}

/** "（リセットまで約 N 時間）", or "" when the reset time is unusable. */
function resetPhrase(resetsAt: unknown, now: number): string {
  if (typeof resetsAt !== "string") return "";
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return "";
  return `（リセットまで約 ${Math.round((at - now) / HOUR_MS)} 時間）`;
}
