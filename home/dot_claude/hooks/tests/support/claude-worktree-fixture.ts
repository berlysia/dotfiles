import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultRunGit } from "../../lib/claude-worktree-git.ts";
import type {
  Deps,
  GitKind,
  GitResult,
  GitRunner,
} from "../../lib/claude-worktree-git.ts";
import type { CreateResult } from "../../lib/claude-worktree.ts";

// Shared fixtures for the claude-worktree tests: temp repos built with real
// git, a runner wrapper that can inject behaviour around a git subcommand,
// and a helper that races createWorktree in separate processes.

const IDENTITY_ARGS = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
];

export type TempTracker = {
  make: (prefix: string) => string;
  cleanup: () => void;
};

export function createTempTracker(): TempTracker {
  const dirs: string[] = [];
  return {
    make(prefix) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      dirs.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of dirs.splice(0)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best effort: leftover temp dirs are harmless.
        }
      }
    },
  };
}

// Plain git for fixture setup and assertions (not the code under test).
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENTITY_ARGS, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

export type Repo = {
  dir: string;
  commonDir: string;
  baseSha: string;
  originSha: string | null;
};

function commitFile(dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
  git(dir, "add", "--", file);
  git(dir, "commit", "-q", "-m", `add ${file}`);
}

export function createRepo(
  temp: TempTracker,
  options: { origin?: boolean; localAhead?: boolean } = {},
): Repo {
  const dir = temp.make("cwt-repo-");
  git(dir, "init", "-q", "-b", "main");
  commitFile(dir, "a.txt", "a\n");
  let originSha: string | null = null;
  if (options.origin) {
    const originDir = temp.make("cwt-origin-");
    git(originDir, "init", "-q", "--bare", "-b", "main");
    git(dir, "remote", "add", "origin", originDir);
    git(dir, "push", "-q", "origin", "main");
    git(dir, "remote", "set-head", "origin", "main");
    originSha = git(dir, "rev-parse", "HEAD");
    if (options.localAhead) commitFile(dir, "b.txt", "b\n");
  }
  return {
    dir,
    commonDir: join(dir, ".git"),
    baseSha: git(dir, "rev-parse", "HEAD"),
    originSha,
  };
}

export function createEmptyRepo(temp: TempTracker): string {
  const dir = temp.make("cwt-empty-");
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

// A repo checked out at a path whose directory name contains a newline.
export function createRepoWithNewlinePath(temp: TempTracker): string {
  const parent = temp.make("cwt-nl-");
  const dir = join(parent, "a\nb");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  commitFile(dir, "a.txt", "a\n");
  return dir;
}

export function addLinkedWorktree(
  temp: TempTracker,
  repo: Repo,
  branch: string,
): string {
  const path = join(temp.make("cwt-linked-"), "lw");
  git(repo.dir, "worktree", "add", "-q", "-b", branch, path);
  return path;
}

// A bare repository with one linked worktree. With the user's global
// safe.bareRepository=explicit, git cannot be run from the bare dir itself, so
// the linked worktree is the cwd that makes the bare main entry observable.
export function createBareWithLinkedWorktree(temp: TempTracker): {
  bareDir: string;
  linkedDir: string;
} {
  const source = createRepo(temp);
  const parent = temp.make("cwt-bare-");
  const bareDir = join(parent, "bare.git");
  git(source.dir, "clone", "-q", "--bare", source.dir, bareDir);
  const linkedDir = join(parent, "lw");
  git(parent, "--git-dir", bareDir, "worktree", "add", "-q", linkedDir, "main");
  return { bareDir, linkedDir };
}

// Runs fn with the directory made read-only, then restores it.
export function withReadOnlyDir<T>(dir: string, fn: () => T): T {
  chmodSync(dir, 0o555);
  try {
    return fn();
  } finally {
    chmodSync(dir, 0o755);
  }
}

export type RecordedCall = {
  args: readonly string[];
  cwd: string;
  kind: GitKind;
  timeoutMs: number;
};

export type InterceptRule = {
  // Prefix of the argv (after the hardening flags), or a predicate.
  match: readonly string[] | ((call: RecordedCall) => boolean);
  before?: (call: RecordedCall) => void;
  after?: (call: RecordedCall, result: GitResult) => void;
  // When set, the real git is not run and this result is returned.
  replace?: GitResult | ((call: RecordedCall) => GitResult);
  // How many matching calls the rule applies to (default 1).
  times?: number;
};

function matches(rule: InterceptRule, call: RecordedCall): boolean {
  if (typeof rule.match === "function") return rule.match(call);
  const prefix = rule.match;
  return prefix.every((part, index) => call.args[index] === part);
}

// Wraps a real runner so tests can run code around a subcommand, replace its
// result, and read back every argv that was issued.
export function interceptGit(
  rules: readonly InterceptRule[] = [],
  options: { now?: () => number; base?: GitRunner } = {},
): { deps: Deps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const remaining = rules.map((rule) => rule.times ?? 1);
  const base = options.base ?? defaultRunGit;
  const runGit: GitRunner = (args, opts) => {
    const call: RecordedCall = { args, ...opts };
    calls.push(call);
    const index = rules.findIndex(
      (rule, i) => (remaining[i] ?? 0) > 0 && matches(rule, call),
    );
    const rule = index >= 0 ? rules[index] : undefined;
    if (!rule) return base(args, opts);
    remaining[index] = (remaining[index] ?? 1) - 1;
    rule.before?.(call);
    const result =
      rule.replace === undefined
        ? base(args, opts)
        : typeof rule.replace === "function"
          ? rule.replace(call)
          : rule.replace;
    rule.after?.(call, result);
    return result;
  };
  return { deps: { runGit, now: options.now ?? Date.now }, calls };
}

export const GIT_FAILURE: GitResult = {
  ok: false,
  status: 128,
  stderr: "fatal: injected failure",
  timedOut: false,
};
export const GIT_TIMEOUT: GitResult = {
  ok: false,
  status: null,
  stderr: "injected timeout",
  timedOut: true,
};

const CHILD_SCRIPT = `
import { createWorktree } from ${JSON.stringify(
  pathToFileURL(join(import.meta.dirname, "../../lib/claude-worktree.ts")).href,
)};
const input = JSON.parse(process.argv[2]);
const startAt = Number(process.argv[3]);
// Busy-wait so the children enter git at nearly the same instant.
while (Date.now() < startAt) {}
process.stdout.write(JSON.stringify(createWorktree(input)));
`;

// Runs createWorktree for each job in its own node process, all released at the
// same moment. lib's git calls are synchronous, so in-process Promise.all would
// serialize them.
export async function createWorktreesInParallel(
  temp: TempTracker,
  jobs: readonly { cwd: string; name: string }[],
): Promise<CreateResult[]> {
  const scriptDir = temp.make("cwt-child-");
  const script = join(scriptDir, "child.mjs");
  writeFileSync(script, CHILD_SCRIPT);
  const startAt = Date.now() + 800;
  return Promise.all(
    jobs.map(
      (job) =>
        new Promise<CreateResult>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [script, JSON.stringify(job), String(startAt)],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.on("error", reject);
          child.on("close", (code) => {
            if (code !== 0) {
              reject(new Error(`child exited ${code}: ${stderr}`));
              return;
            }
            try {
              resolve(JSON.parse(stdout) as CreateResult);
            } catch {
              reject(
                new Error(`unparseable child output: ${stdout} ${stderr}`),
              );
            }
          });
        }),
    ),
  );
}
