#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildDependencyNotice,
  resolveInstall,
} from "../../lib/dependency-notice.ts";

const tempDirs = new Set<string>();

function createProject(
  packageJson: string | null = "{}",
  lockfiles: readonly string[] = [],
): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dependency-notice-")));
  tempDirs.add(dir);
  if (packageJson !== null) {
    writeFileSync(join(dir, "package.json"), packageJson);
  }
  for (const lockfile of lockfiles) {
    writeFileSync(join(dir, lockfile), "");
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("resolveInstall", () => {
  const lockfileCases = [
    ["pnpm", "pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["bun", "bun.lock", "bun install --frozen-lockfile"],
    ["bun", "bun.lockb", "bun install --frozen-lockfile"],
    ["npm", "package-lock.json", "npm ci"],
    ["npm", "npm-shrinkwrap.json", "npm ci"],
    ["yarn", "yarn.lock", "yarn install"],
  ] as const;

  for (const [manager, lockfile, command] of lockfileCases) {
    it(`resolves ${lockfile} to ${manager}`, () => {
      const dir = createProject("{}", [lockfile]);
      deepStrictEqual(resolveInstall(dir), {
        kind: "install",
        manager,
        command,
        wouldWriteLockfile: false,
      });
    });
  }

  it("lets a declared packageManager override conflicting lockfiles", () => {
    const dir = createProject(
      JSON.stringify({ packageManager: "npm@10.0.0" }),
      ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
    );
    deepStrictEqual(resolveInstall(dir), {
      kind: "install",
      manager: "npm",
      command: "npm ci",
      wouldWriteLockfile: false,
    });
  });

  it("reports a conflict when lockfiles identify different managers", () => {
    const dir = createProject("{}", [
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
    ]);
    deepStrictEqual(resolveInstall(dir), {
      kind: "conflict",
      lockfiles: ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"],
    });
  });

  it("marks a declared manager without its lockfile as writing one", () => {
    const dir = createProject(
      JSON.stringify({ packageManager: "pnpm@10.0.0" }),
      ["yarn.lock"],
    );
    deepStrictEqual(resolveInstall(dir), {
      kind: "install",
      manager: "pnpm",
      command: "pnpm install",
      wouldWriteLockfile: true,
    });
  });

  it("does not treat a directory as a lockfile", () => {
    const dir = createProject(
      JSON.stringify({ packageManager: "pnpm@10.0.0" }),
    );
    mkdirSync(join(dir, "pnpm-lock.yaml"));
    deepStrictEqual(resolveInstall(dir), {
      kind: "install",
      manager: "pnpm",
      command: "pnpm install",
      wouldWriteLockfile: true,
    });
  });

  it("returns null when there is no package.json or supported manager", () => {
    strictEqual(resolveInstall(createProject(null, ["pnpm-lock.yaml"])), null);
    strictEqual(resolveInstall(createProject("{}")), null);
  });
});

describe("buildDependencyNotice", () => {
  it("names the directory and gives the frozen install command", () => {
    const dir = createProject("{}", ["bun.lock"]);
    const notice = buildDependencyNotice(dir);
    ok(notice?.startsWith("[deps]"));
    ok(notice.includes(dir));
    ok(notice.includes("Dependencies are not installed"));
    ok(notice.includes("tests and typecheck will fail"));
    ok(notice.includes("bun install --frozen-lockfile"));
    strictEqual(notice.includes("\n"), false);
  });

  it("explains conflicting lockfiles and an install without a lockfile", () => {
    const conflictDir = createProject("{}", ["pnpm-lock.yaml", "yarn.lock"]);
    const conflictNotice = buildDependencyNotice(conflictDir);
    ok(conflictNotice?.includes("pnpm-lock.yaml, yarn.lock"));
    ok(conflictNotice?.includes("install with the project's package manager"));

    const noLockDir = createProject(
      JSON.stringify({ packageManager: "npm@10.0.0" }),
    );
    const noLockNotice = buildDependencyNotice(noLockDir);
    ok(noLockNotice?.includes("npm install"));
    ok(noLockNotice?.includes("would write a lockfile"));
  });

  it("stays silent when no manager can be inferred, as git-worktree-create does", () => {
    strictEqual(buildDependencyNotice(createProject("{}")), null);
  });

  it("returns null when the project or node_modules gate does not match", () => {
    strictEqual(buildDependencyNotice(createProject(null)), null);

    const dir = createProject("{}", ["yarn.lock"]);
    mkdirSync(join(dir, "node_modules"));
    strictEqual(buildDependencyNotice(dir), null);
  });

  it("returns null for control characters and filesystem errors", () => {
    strictEqual(buildDependencyNotice("/tmp/project\nname"), null);
    strictEqual(
      buildDependencyNotice("/tmp/project", {
        statSync: () => {
          throw new Error("read failed");
        },
        readFileSync: () => {
          throw new Error("read failed");
        },
      }),
      null,
    );
  });
});

describe("worktree-deps-notice process", () => {
  const hookEntry = fileURLToPath(
    new URL("../../implementations/worktree-deps-notice.ts", import.meta.url),
  );

  function launch(input: Record<string, unknown>, root: string) {
    const home = join(root, "home");
    const xdg = join(home, "xdg");
    mkdirSync(xdg, { recursive: true });
    return spawnSync("bun", [hookEntry], {
      input: JSON.stringify(input),
      encoding: "utf8",
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(xdg, "config"),
        XDG_DATA_HOME: join(xdg, "data"),
        XDG_CACHE_HOME: join(xdg, "cache"),
        XDG_STATE_HOME: join(xdg, "state"),
      },
      timeout: 15000,
    });
  }

  it("adds the notice for EnterWorktree and ignores other tools", () => {
    const root = createProject();
    const projectDir = join(root, "worktree");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "package.json"), "{}");
    writeFileSync(join(projectDir, "pnpm-lock.yaml"), "");
    const input = {
      hook_event_name: "PostToolUse",
      session_id: "dependency-notice-process",
      transcript_path: join(root, "transcript.jsonl"),
      cwd: root,
      tool_name: "EnterWorktree",
      tool_use_id: "toolu_dependency_notice",
      tool_input: {},
      tool_response: { worktreePath: projectDir },
    };

    const enterWorktree = launch(input, root);
    strictEqual(
      enterWorktree.status,
      0,
      `spawn error: ${enterWorktree.error?.message ?? "none"}; stderr: ${enterWorktree.stderr}`,
    );
    ok(enterWorktree.stdout.includes("[deps]"));

    const otherTool = launch({ ...input, tool_name: "Bash" }, root);
    strictEqual(
      otherTool.status,
      0,
      `spawn error: ${otherTool.error?.message ?? "none"}; stderr: ${otherTool.stderr}`,
    );
    ok(!otherTool.stdout.includes("additionalContext"));
  });
});
