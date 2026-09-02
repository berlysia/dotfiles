/**
 * The tools `document-workflow-guard` evaluates.
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
]);

export interface MatcherCoverage {
  covered: boolean;
  missing: string[];
}

const WILDCARD_MATCHERS = new Set(["", "*", ".*"]);
const LITERAL_ALTERNATION = /^[A-Za-z0-9_]+(\|[A-Za-z0-9_]+)*$/;

/**
 * Compare a settings.json PreToolUse matcher against GUARDED_TOOLS.
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
export function matcherCoversGuardedTools(matcher: string): MatcherCoverage {
  const trimmed = matcher.trim();
  if (WILDCARD_MATCHERS.has(trimmed)) {
    return { covered: true, missing: [] };
  }
  if (!LITERAL_ALTERNATION.test(trimmed)) {
    return { covered: false, missing: [...GUARDED_TOOLS].sort() };
  }
  const listed = new Set(trimmed.split("|"));
  const missing = [...GUARDED_TOOLS].filter((tool) => !listed.has(tool)).sort();
  return { covered: missing.length === 0, missing };
}
