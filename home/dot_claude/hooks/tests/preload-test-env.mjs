// Preloaded via `node --import` before every test file's own module graph
// loads (see package.json "test" script). `node --test` runs each matched
// file in its own child process, and `--import` re-runs for each of those
// child processes, so this sets a fresh, isolated CLAUDE_LOGS_DIR per file.
//
// Why this exists: hook implementations (auto-approve.ts, session.ts, etc.)
// call into lib/centralized-logging.ts, whose log directory defaults to
// `join(homedir(), ".claude", "logs")`. Several tests invoke those hooks'
// `run()` directly without mocking the filesystem, so without this preload
// their log writes (e.g. session_id "test-session" decisions) land in the
// developer's real ~/.claude/logs/*.jsonl.
//
// centralized-logging.ts reads CLAUDE_LOGS_DIR (an override in the same
// shape as DOCUMENT_WORKFLOW_DIR) at module load time, so this must run
// before that module is first imported by anything in the test file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Git exports repository-local variables to hooks (GIT_DIR, GIT_INDEX_FILE,
// ...). When the test suite runs from the pre-commit hook, every `git` a test
// spawns -- even with `cwd` set to a mkdtemp fixture -- inherits them and acts
// on the repository being committed instead. From a linked worktree this
// rewrote the worktree index and, through the shared common config, set
// `core.bare=true`, `user.*` and `commit.gpgsign=false` on the main
// repository. The list is `git rev-parse --local-env-vars` (git 2.50).
for (const name of [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]) {
  delete process.env[name];
}

// The SessionStart hook exports CLAUDE_PROJECT_DIR into the Bash environment
// this suite is often started from. Hooks under test read it through
// getProjectRoot(), so a leaked value would anchor every fixture on the real
// repository instead of the process.chdir() / CLAUDE_TEST_CWD the test set up.
delete process.env.CLAUDE_PROJECT_DIR;

if (!process.env.CLAUDE_LOGS_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "claude-hooks-test-logs-"));
  process.env.CLAUDE_LOGS_DIR = dir;

  // Each `node --test` child process gets its own dir (see comment above);
  // without this it would accumulate under /tmp across every test run.
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; leftover temp dirs are harmless.
    }
  });
}

// lib/bash-parser.ts gives up on a parse after 100ms of wall clock. Under a
// loaded run that trips on ordinary commands and flips allow into deny, so
// every test process gets a patient budget. Tests that mean to cut a parse
// set 0 around that call (tests/support/parse-budget.ts). Imported last: the
// module has no static runtime imports, so loading it here initialises
// neither tree-sitter nor logging.
const { setParseBudgetMs } = await import("../lib/bash-parser.ts");
setParseBudgetMs(10_000);
