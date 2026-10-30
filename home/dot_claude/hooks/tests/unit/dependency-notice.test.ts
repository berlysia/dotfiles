#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync as readFile,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildDependencyNotice,
  type DependencyNoticeFileSystem,
  type DependencyNoticeOptions,
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

function buildNotice(
  dir: string,
  options: DependencyNoticeOptions = {},
): string | null {
  return buildDependencyNotice(dir, undefined, {
    vmMarkerPath: null,
    ...options,
  });
}

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
    const notice = buildNotice(dir);
    ok(notice?.startsWith("[deps]"));
    ok(notice.includes(dir));
    ok(notice.includes("Dependencies are not installed"));
    ok(notice.includes("tests and typecheck will fail"));
    ok(notice.includes("bun install --frozen-lockfile"));
    strictEqual(notice.includes("\n"), false);
  });

  it("explains conflicting lockfiles and an install without a lockfile", () => {
    const conflictDir = createProject("{}", ["pnpm-lock.yaml", "yarn.lock"]);
    const conflictNotice = buildNotice(conflictDir);
    ok(conflictNotice?.includes("pnpm-lock.yaml, yarn.lock"));
    ok(conflictNotice?.includes("install with the project's package manager"));

    const noLockDir = createProject(
      JSON.stringify({ packageManager: "npm@10.0.0" }),
    );
    const noLockNotice = buildNotice(noLockDir);
    ok(noLockNotice?.includes("npm install"));
    ok(noLockNotice?.includes("would write a lockfile"));
  });

  it("stays silent when no manager can be inferred, as git-worktree-create does", () => {
    strictEqual(buildNotice(createProject("{}")), null);
  });

  it("returns null when the project or node_modules gate does not match", () => {
    strictEqual(buildNotice(createProject(null)), null);

    const dir = createProject("{}", ["yarn.lock"]);
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "left-pad"), "installed");
    strictEqual(buildNotice(dir), null);
  });

  it("returns null for control characters and filesystem errors", () => {
    strictEqual(buildNotice("/tmp/project\nname"), null);
    strictEqual(
      buildDependencyNotice(
        "/tmp/project",
        {
          statSync: () => {
            throw new Error("read failed");
          },
          readdirSync: () => [],
          readFileSync: () => {
            throw new Error("read failed");
          },
        },
        { vmMarkerPath: null },
      ),
      null,
    );
  });

  it("stays silent when node_modules cannot be read", () => {
    const dir = createProject("{}", ["pnpm-lock.yaml"]);
    mkdirSync(join(dir, "node_modules"));
    const fs: DependencyNoticeFileSystem = {
      statSync,
      readdirSync: () => {
        throw new Error("directory is unreadable");
      },
      readFileSync: readFile,
    };
    strictEqual(buildDependencyNotice(dir, fs, { vmMarkerPath: null }), null);
  });

  it("treats an empty node_modules directory as not installed", () => {
    const dir = createProject("{}", ["pnpm-lock.yaml"]);
    mkdirSync(join(dir, "node_modules"));
    ok(buildNotice(dir)?.includes("pnpm install --frozen-lockfile"));
  });

  it("uses the recovery command when an incomplete marker exists", () => {
    const dir = createProject("{}", ["pnpm-lock.yaml"]);
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "left-pad"), "partial");
    writeFileSync(
      join(dir, "node_modules", ".git-worktree-deps-incomplete"),
      "",
    );
    const notice = buildNotice(dir);
    ok(notice?.includes("git-worktree-deps '"));
    ok(notice?.includes("The previous install did not finish"));
  });

  it("waits for VM node_modules to be mounted before recommending install", () => {
    const dir = createProject("{}", ["pnpm-lock.yaml"]);
    mkdirSync(join(dir, "node_modules"));
    const marker = join(dir, "agent-vm-marker");
    writeFileSync(marker, "");
    const noMounts =
      "36 1 8:1 / / rw - ext4 /dev/sda1 rw\n37 36 0:6 / /proc rw - proc proc rw\n";
    const notice = buildNotice(dir, {
      vmMarkerPath: marker,
      mountinfo: noMounts,
    });
    ok(notice?.includes("agent-vm-node-modules attach"));
    ok(!notice?.includes("pnpm install"));
  });

  it("recommends install in a VM only when node_modules is mounted", () => {
    const dir = createProject("{}", ["pnpm-lock.yaml"]);
    mkdirSync(join(dir, "node_modules"));
    const marker = join(dir, "agent-vm-marker");
    writeFileSync(marker, "");
    const mountinfo = `36 1 8:1 / / rw - ext4 /dev/sda1 rw\n99 36 8:2 / ${join(dir, "node_modules")} rw - ext4 /dev/x rw\n`;
    const notice = buildNotice(dir, { vmMarkerPath: marker, mountinfo });
    ok(notice?.includes("pnpm install --frozen-lockfile"));
  });

  it("asks for VM attach when mountinfo cannot be read", () => {
    const dir = createProject("{}", ["pnpm-lock.yaml"]);
    const marker = join(dir, "agent-vm-marker");
    writeFileSync(marker, "");
    const fs: DependencyNoticeFileSystem = {
      statSync,
      readdirSync,
      readFileSync(path, encoding) {
        if (path === "/proc/self/mountinfo") throw new Error("unreadable");
        return readFile(path, encoding);
      },
    };
    const notice = buildDependencyNotice(dir, fs, { vmMarkerPath: marker });
    ok(notice?.includes("agent-vm-node-modules attach"));
    ok(!notice?.includes("pnpm install"));
  });

  it("limits subagent install advice to tests and typecheck", () => {
    const dir = createProject("{}", ["pnpm-lock.yaml"]);
    const notice = buildNotice(dir, { audience: "subagent" });
    ok(notice?.includes("When you need to run tests or typecheck"));
    ok(notice?.includes("pnpm install --frozen-lockfile"));
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
        AGENT_VM_MARKER: join(home, "agent-vm-marker"),
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
