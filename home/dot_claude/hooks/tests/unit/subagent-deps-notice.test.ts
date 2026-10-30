#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
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

const tempDirs = new Set<string>();
const hookEntry = fileURLToPath(
  new URL("../../implementations/subagent-deps-notice.ts", import.meta.url),
);

function createProject(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "subagent-deps-notice-")),
  );
  tempDirs.add(dir);
  writeFileSync(join(dir, "package.json"), "{}\n");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "\n");
  return dir;
}

function launch(cwd: string) {
  const home = join(cwd, "isolated-home");
  const xdg = join(home, "xdg");
  mkdirSync(xdg, { recursive: true });
  return spawnSync("bun", [hookEntry], {
    input: JSON.stringify({
      hook_event_name: "SubagentStart",
      session_id: "subagent-dependency-notice",
      transcript_path: join(cwd, "transcript.jsonl"),
      cwd,
      agent_id: "agent-test",
      agent_type: "general-purpose",
    }),
    encoding: "utf8",
    cwd,
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

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("subagent-deps-notice process", () => {
  it("adds a test-time dependency notice on SubagentStart", () => {
    const project = createProject();
    mkdirSync(join(project, "node_modules"));

    const result = launch(project);
    strictEqual(
      result.status,
      0,
      `spawn error: ${result.error?.message ?? "none"}; stderr: ${result.stderr}`,
    );
    ok(result.stdout.includes("additionalContext"));
    ok(result.stdout.includes("When you need to run tests or typecheck"));
    ok(result.stdout.includes("pnpm install --frozen-lockfile"));
  });

  it("stays silent when node_modules contains dependencies", () => {
    const project = createProject();
    mkdirSync(join(project, "node_modules"));
    writeFileSync(join(project, "node_modules", "left-pad"), "installed");

    const result = launch(project);
    strictEqual(
      result.status,
      0,
      `spawn error: ${result.error?.message ?? "none"}; stderr: ${result.stderr}`,
    );
    ok(!result.stdout.includes("additionalContext"));
  });
});
