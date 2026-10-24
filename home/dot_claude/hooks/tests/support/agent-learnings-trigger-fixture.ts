import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGit } from "../../lib/agent-learnings/core/git.ts";
import {
  COMMON_KEY,
  type LearningEntry,
} from "../../lib/agent-learnings/core/learnings-file.ts";
import {
  defaultStoreDir,
  initStore,
  writeLearnings,
} from "../../lib/agent-learnings/core/store.ts";

// learnings-trigger.ts をプロセスとして起動するテストの共通部品。
// HOME は子プロセスの env にだけ渡し、テストを走らせるシェルの HOME は変えない

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../implementations/learnings-trigger.ts",
);
export const REPO_KEY = "github.com/berlysia/foo";

export const learning = (n: number, on: string): LearningEntry => ({
  id: `L-${n.toString(16).padStart(12, "0")}`,
  title: `title ${n}`,
  body: `body ${n}`,
  seen: 1,
  repos: [REPO_KEY],
  updated: "2026-10-01",
  extra: [["on", on]],
});

export type World = { root: string; home: string; repo: string };

export function makeWorld(entries: LearningEntry[]): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "trigger-hook-proc-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "remote",
    "add",
    "origin",
    "https://github.com/berlysia/foo.git",
  ]);
  const store = defaultStoreDir(home);
  initStore(store, runGit);
  for (const [key, list] of [
    [REPO_KEY, entries],
    [COMMON_KEY, []],
  ] as const)
    writeLearnings(store, { format: 1, key, readOnly: false, entries: list });
  return { root, home, repo };
}

export const removeWorld = (world: World): void =>
  rmSync(world.root, { recursive: true, force: true });

export const bashInput = (
  world: World,
  command: string,
  sessionId = "sess1",
): Record<string, unknown> => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
  session_id: sessionId,
  cwd: world.repo,
});

export function runHookProcess(world: World, stdin: string) {
  const started = performance.now();
  const result = spawnSync("bun", [HOOK], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, HOME: world.home },
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    elapsedMs: performance.now() - started,
  };
}
