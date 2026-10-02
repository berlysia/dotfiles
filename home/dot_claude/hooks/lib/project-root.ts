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
