import { isAbsolute, join } from "node:path";
import { getHomeDir, type MatchContext } from "./path-utils.ts";

/**
 * The project root that workflow identity anchors on. Claude Code sets
 * CLAUDE_PROJECT_DIR to the directory the session started in and keeps it
 * there across Bash `cd` and worktree entry, so the workflow dir does not move
 * with the tool cwd. CLAUDE_TEST_CWD is the test-only override the hooks
 * already honour; it wins even in production if it leaks into the
 * environment. inputCwd is kept for callers that used it before.
 */
export function getProjectRoot(inputCwd?: string): string {
  return (
    process.env["CLAUDE_TEST_CWD"] ||
    process.env["CLAUDE_PROJECT_DIR"] ||
    inputCwd ||
    process.cwd()
  );
}

/**
 * Anchors for permission path matching. Relative patterns follow the tool cwd,
 * as Claude Code documents ("relative to current directory"), so this does not
 * read CLAUDE_PROJECT_DIR. CLAUDE_TEST_CWD is the same test-only override
 * getProjectRoot honours. createSettingsRoots below is the other place matching reads the environment.
 */
export function createMatchContext(inputCwd?: string): MatchContext {
  // A relative cwd would anchor every relative deny at a relative base that no
  // absolute target is under; skip such a value instead of trusting it.
  const cwd =
    [process.env["CLAUDE_TEST_CWD"], inputCwd].find(
      (candidate) => candidate !== undefined && isAbsolute(candidate),
    ) ?? process.cwd();
  return { cwd, home: getHomeDir() };
}

/** Where a `/path` rule anchors, per kind of settings source. Built once per hook run. */
export interface SettingsRoots {
  /** Rules from the user settings file: the directory that holds it. */
  user: string;
  /** Rules from project and local settings, and rules with no file behind them. */
  project: string;
}

/**
 * Claude Code anchors a `/path` rule at a directory that depends on where the
 * rule was defined: `~/.claude` for user settings, and the directory the
 * session started in for project settings, local settings and rules passed
 * without a file. CLAUDE_PROJECT_DIR is that directory; it stays put across
 * Bash `cd`, unlike the hook input cwd. Candidates that are not absolute are
 * skipped for the reason createMatchContext skips them: a relative base has no
 * absolute target under it, so every `/path` deny would match nothing.
 * home is used as given, as it is for `~/` rules.
 */
export function createSettingsRoots(
  inputCwd?: string,
  home: string = getHomeDir(),
): SettingsRoots {
  const project =
    [
      process.env["CLAUDE_TEST_CWD"],
      process.env["CLAUDE_PROJECT_DIR"],
      inputCwd,
    ].find((candidate) => candidate !== undefined && isAbsolute(candidate)) ??
    process.cwd();
  return { user: join(home, ".claude"), project };
}
