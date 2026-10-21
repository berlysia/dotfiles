// Shared by unit/agent-learnings-queue.test.ts and heavy/agent-learnings-queue.test.ts.
// Constants and a builder only; the git-backed store fixture lives in the heavy file.
export const SID = "0f0e0d0c-0000-4000-8000-000000000001";
export const NOW = new Date("2026-10-15T12:00:00Z");
export const input = (sessionId = SID) => ({
  sessionId,
  transcriptPath: "/x/y.jsonl",
  cwd: "/repo",
  repoKey: "github.com/a/b",
  reason: "other",
});
