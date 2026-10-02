/**
 * The tools `document-workflow-guard` is registered for: the settings matcher
 * must list every one of them. The guard evaluates three different things:
 * writes (Write, Edit, MultiEdit, NotebookEdit, Bash), the prompt text of the
 * scheduling tools (CronCreate, ScheduleWakeup; an extension of K9: a
 * scheduled approval-shaped prompt is refused, issue J), and the content of an
 * AskUserQuestion (an approval-like question that already carries `answers` or
 * `annotations` is denied).
 *
 * Lives in lib/ rather than in the guard implementation for three reasons:
 * `session.ts` audits it against the settings matcher and must not depend on
 * the guard's module graph; a cross-implementation import would make K15
 * phase 2 order-sensitive for import resolution, not just semantics; and the
 * observer must not fail when the observed hook fails to load.
 *
 * This module imports nothing, so it cannot drag a broken dependency into
 * SessionStart.
 */
export const GUARDED_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "CronCreate",
  "ScheduleWakeup",
  "AskUserQuestion",
]);

export interface MatcherCoverage {
  covered: boolean;
  missing: string[];
}

const WILDCARD_MATCHERS = new Set(["", "*", ".*"]);
const LITERAL_ALTERNATION = /^[A-Za-z0-9_]+(\|[A-Za-z0-9_]+)*$/;

/**
 * Compare a settings.json matcher against a list of tool names.
 *
 * Contract: the matcher is either a wildcard (empty, `*`, `.*`, which Claude
 * Code treats as matching every tool) or a literal `|` alternation. Anything
 * else is reported as not covered rather than guessed at.
 *
 * Comparison is by literal alternative, never by regex match: the matcher is
 * unanchored, so `new RegExp("Write|Edit|NotebookEdit|Bash").test("MultiEdit")`
 * is true via the "Edit" alternative, and the one gap this check exists to
 * find would pass silently.
 */
export function matcherCoversTools(
  matcher: string,
  tools: readonly string[],
): MatcherCoverage {
  const trimmed = matcher.trim();
  if (WILDCARD_MATCHERS.has(trimmed)) {
    return { covered: true, missing: [] };
  }
  if (!LITERAL_ALTERNATION.test(trimmed)) {
    return { covered: false, missing: [...tools].sort() };
  }
  const listed = new Set(trimmed.split("|"));
  const missing = tools.filter((tool) => !listed.has(tool)).sort();
  return { covered: missing.length === 0, missing };
}

/** Compare a settings.json PreToolUse matcher against GUARDED_TOOLS. */
export function matcherCoversGuardedTools(matcher: string): MatcherCoverage {
  return matcherCoversTools(matcher, [...GUARDED_TOOLS]);
}
