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
