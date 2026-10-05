import { basename, dirname, isAbsolute, join } from "node:path";
import {
  getHomeDir,
  type MatchContext,
  normalizeAbsolute,
} from "./path-utils.ts";

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
 * The name Claude Code gives the transcript directory of a session whose
 * primary working directory is `path`: every UTF-16 unit that is not an ASCII
 * letter or digit becomes `-`, and runs of `-` are kept. Observed on Claude
 * Code 2.1.289; the rule is not documented. The name cannot be turned back
 * into a path, so callers encode candidate paths and compare names.
 */
export function encodeSessionDirName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The directories above `path`, nearest first, without the filesystem root. */
function listAncestors(path: string): string[] {
  const ancestors: string[] = [];
  let current = dirname(path);
  while (dirname(current) !== current) {
    ancestors.push(current);
    current = dirname(current);
  }
  return ancestors;
}

/**
 * The session's primary working directory, when one of the places it can be
 * encodes to the name of the transcript directory. The candidates are the
 * project dir (where the session started, or the worktree it was started in),
 * the hook input cwd and the directories above it (a worktree entered
 * mid-session, possibly after a Bash `cd` inside it). The root is left out:
 * a session started at `/` has `/` as its project dir, which is compared
 * first. Returns undefined when the transcript path is missing or relative,
 * or when no candidate matches; a relative transcript path is rejected so its
 * parent name cannot match a candidate by accident. Candidates are normalized
 * before they are encoded, and the normalized path is what is returned: the
 * pattern resolver normalizes its base the same way, so the path that matched
 * the name is the path rules are anchored at.
 */
export function findSessionRoot(
  transcriptPath: string | undefined,
  projectDir: string | undefined,
  cwd: string | undefined,
): string | undefined {
  if (transcriptPath === undefined || !isAbsolute(transcriptPath)) {
    return undefined;
  }
  const dirName = basename(dirname(transcriptPath));
  const normalized = [projectDir, cwd].map((candidate) =>
    candidate !== undefined && isAbsolute(candidate)
      ? normalizeAbsolute(candidate)
      : undefined,
  );
  const [project, current] = normalized;
  const candidates = [
    project,
    current,
    ...(current === undefined ? [] : listAncestors(current)),
  ];
  return candidates.find(
    (candidate) =>
      candidate !== undefined && encodeSessionDirName(candidate) === dirName,
  );
}

/**
 * Claude Code anchors a `/path` rule at a directory that depends on where the
 * rule was defined: `~/.claude` for user settings, and the session's primary
 * working directory for project settings, local settings and rules passed
 * without a file. That directory starts where the session started, stays put
 * across Bash `cd`, moves into a worktree on EnterWorktree and back on
 * ExitWorktree. No hook input carries it; the transcript directory is named
 * after it, so findSessionRoot checks the places it can be against that name.
 * Without a match the project dir is used, which is right unless the session
 * entered a worktree. CLAUDE_TEST_CWD is the test-only override and wins over
 * all of this. Candidates that are not absolute are skipped for the reason
 * createMatchContext skips them: a relative base has no absolute target under
 * it, so every `/path` deny would match nothing. home is used as given, as it
 * is for `~/` rules. Both input keys are required so that a caller cannot
 * leave the transcript path out without the type check noticing.
 */
export function createSettingsRoots(
  input: { cwd: string | undefined; transcriptPath: string | undefined },
  home: string = getHomeDir(),
): SettingsRoots {
  const isAbsolutePath = (candidate: string | undefined): candidate is string =>
    candidate !== undefined && isAbsolute(candidate);
  const testCwd = process.env["CLAUDE_TEST_CWD"];
  const projectDir = process.env["CLAUDE_PROJECT_DIR"];
  const project = isAbsolutePath(testCwd)
    ? testCwd
    : (findSessionRoot(input.transcriptPath, projectDir, input.cwd) ??
      [projectDir, input.cwd].find(isAbsolutePath) ??
      process.cwd());
  return { user: join(home, ".claude"), project };
}
