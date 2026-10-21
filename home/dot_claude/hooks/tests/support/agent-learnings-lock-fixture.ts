// Shared by unit/agent-learnings-lock.test.ts and perf/agent-learnings-lock.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-learnings-lock-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export const DEAD_PID = 2 ** 22 + 12345; // Linux の pid_max の上限を超えるので存在しない
