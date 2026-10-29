#!/usr/bin/env node --test

// The wrapper is the entry `Bash(claude-sessions *)` runs without a prompt, so
// these tests check that a hostile cwd (bunfig.toml preload, .env) does not
// reach bun, and that the default git wiring works end to end.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { notStrictEqual, ok, strictEqual } from "node:assert";
import type { SessionList } from "../../lib/sessions/types.ts";

const HOOKS = fileURLToPath(new URL("../..", import.meta.url));
const WRAPPER_SRC = fileURLToPath(
  new URL(
    "../../../../dot_local/bin/executable_claude-sessions",
    import.meta.url,
  ),
);

const root = realpathSync(
  mkdtempSync(join(tmpdir(), "claude-sessions-wrapper-")),
);
const home = join(root, "home");
const wrapper = join(home, ".local", "bin", "claude-sessions");
const sessionsDir = join(home, ".claude", "sessions");
after(() => rmSync(root, { recursive: true, force: true }));

before(() => {
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(sessionsDir);
  symlinkSync(HOOKS, join(home, ".claude", "hooks"));
  copyFileSync(WRAPPER_SRC, wrapper);
  chmodSync(wrapper, 0o755);
});

const launch = (cwd: string, args: string[] = ["--json"]) =>
  spawnSync(wrapper, args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "bun-cache"),
    },
  });

const makeCwd = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
};

const startTimeOfSelf = (): string => {
  const stat = readFileSync("/proc/self/stat", "utf8");
  return stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/)[19] as string;
};

describe("claude-sessions wrapper", () => {
  it("does not run a bunfig.toml preload from the cwd", () => {
    const cwd = makeCwd("bunfig");
    const marker = join(root, "preload-ran");
    writeFileSync(
      join(cwd, "pre.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`,
    );
    writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./pre.ts"]\n');
    const r = launch(cwd);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(existsSync(marker), false);
  });

  it("does not read a .env from the cwd", () => {
    const cwd = makeCwd("dotenv");
    writeFileSync(
      join(cwd, ".env"),
      "CLAUDE_SESSIONS_DIR=/nonexistent-claude-sessions-test\n",
    );
    const r = launch(cwd);
    strictEqual(r.status, 0, r.stderr);
  });

  it("reaches git through the default wiring", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = spawnSync(
      "git",
      [
        "-c",
        "safe.bareRepository=all",
        "-c",
        "commit.gpgsign=false",
        "-C",
        repo,
        "init",
        "-q",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    );
    strictEqual(git.status, 0, git.stderr);
    writeFileSync(
      join(sessionsDir, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: "00000000-0000-4000-8000-000000000042",
        cwd: repo,
        procStart: startTimeOfSelf(),
        name: "wired",
        status: "idle",
      }),
    );
    const r = launch(root);
    strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as SessionList;
    const row = out.sessions.find((s) => s.name === "wired");
    notStrictEqual(row, undefined);
    strictEqual(row?.repoStatus, "git");
    strictEqual(row?.repo, realpathSync(join(repo, ".git")));
    ok(row?.branch === null || typeof row?.branch === "string");
  });
});
