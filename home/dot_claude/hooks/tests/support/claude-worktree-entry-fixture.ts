// Shared by unit/claude-worktree-entry.test.ts and heavy/claude-worktree-entry.test.ts.
// Neither importing this file nor calling its functions starts git.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const hasBun =
  spawnSync("sh", ["-c", "command -v bun"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  }).status === 0;

export const hooksDir = join(import.meta.dirname, "..", "..");
export const createEntry = join(
  hooksDir,
  "implementations",
  "worktree-create.ts",
);
export const cleanupEntry = join(
  hooksDir,
  "implementations",
  "worktree-cleanup.ts",
);

export function runBun(entry: string, input: string) {
  return spawnSync("bun", [entry], {
    input,
    encoding: "utf8",
    env: process.env,
    timeout: 60_000,
  });
}
