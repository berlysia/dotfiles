// Shared by heavy/agent-learnings-cli.test.ts and perf/agent-learnings-cli.test.ts.
// withEnv() runs `git init`: only heavy and perf import this file.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunLearningsCliDeps } from "../../cli/learnings.ts";
import { runGit } from "../../lib/agent-learnings/core/git.ts";

export async function withEnv(
  fn: (deps: RunLearningsCliDeps, root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "agent-learnings-cli-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "remote",
    "add",
    "origin",
    "https://github.com/foo/bar.git",
  ]);
  mkdirSync(join(root, "home"));
  const deps: RunLearningsCliDeps = {
    cwd: repo,
    home: join(root, "home"),
    now: new Date("2026-10-15T00:00:00Z"),
    readerEnv: undefined,
    isTty: true,
    agentEnv: false,
    lockWaitMs: 200,
    runGit,
    confirm: async () => true,
  };
  try {
    await fn(deps, root);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}
export const store = (deps: RunLearningsCliDeps) =>
  join(deps.home, ".local/share/agent-learnings");
