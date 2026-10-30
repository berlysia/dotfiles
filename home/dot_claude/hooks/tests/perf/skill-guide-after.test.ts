#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { run } from "../../implementations/skill-guide-after.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "skill-guide-after-perf-")),
  );
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeEnv() {
  const home = tempDir();
  const cwd = join(home, "repo");
  const skillsRoot = join(home, ".claude", "skills");
  const stateDir = join(home, ".claude", "state", "skill-guide");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(skillsRoot, "delivery-policy"), { recursive: true });
  writeFileSync(
    join(skillsRoot, "delivery-policy", "SKILL.md"),
    "---\nname: delivery-policy\n---\n",
  );
  const transcriptPath = join(home, "transcript.jsonl");
  writeFileSync(transcriptPath, "");
  const fakeBin = join(home, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(home, "fake-git-calls.jsonl"), "");
  writeFileSync(
    join(fakeBin, "git"),
    [
      "#!/bin/sh",
      `printf '{"optionalLocks":"%s"}\\n' "$GIT_OPTIONAL_LOCKS" >> "$HOME/fake-git-calls.jsonl"`,
      "sleep 2",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  chmodSync(join(fakeBin, "git"), 0o755);
  return { home, cwd, skillsRoot, stateDir, transcriptPath, fakeBin };
}

function stopInput(env: ReturnType<typeof makeEnv>) {
  return {
    hook_event_name: "Stop",
    session_id: "session-perf",
    stop_hook_active: false,
    cwd: env.cwd,
    transcript_path: env.transcriptPath,
  };
}

async function withFakeGit<T>(
  env: ReturnType<typeof makeEnv>,
  work: () => Promise<T>,
): Promise<T> {
  const previousHome = process.env["HOME"];
  const previousPath = process.env["PATH"];
  process.env["HOME"] = env.home;
  process.env["PATH"] = `${env.fakeBin}:${previousPath ?? ""}`;
  try {
    return await work();
  } finally {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  }
}

describe("skill-guide-after performance limits", () => {
  it("cuts off a fake git that waits two seconds at about one second", async () => {
    const env = makeEnv();
    const started = performance.now();
    const output = await withFakeGit(env, () =>
      run(stopInput(env), {
        skillsRoot: env.skillsRoot,
        stateDir: env.stateDir,
      }),
    );
    const elapsedMs = performance.now() - started;
    strictEqual(output, null);
    ok(elapsedMs < 1800, `elapsed ${elapsedMs} ms`);
    const calls = readFileSync(join(env.home, "fake-git-calls.jsonl"), "utf8")
      .trim()
      .split("\n");
    strictEqual(calls.length, 1);
    strictEqual(
      (JSON.parse(calls[0] ?? "{}") as { optionalLocks?: string })
        .optionalLocks,
      "0",
    );
  });

  it("finishes the capped transcript scan and slow git under two seconds", async () => {
    const env = makeEnv();
    writeFileSync(env.transcriptPath, "null\n".repeat(2 * 1024 * 1024));
    const started = performance.now();
    const output = await withFakeGit(env, () =>
      run(stopInput(env), {
        skillsRoot: env.skillsRoot,
        stateDir: env.stateDir,
        scan: { chunkBytes: 64 },
      }),
    );
    const elapsedMs = performance.now() - started;
    strictEqual(output, null);
    ok(elapsedMs < 2000, `elapsed ${elapsedMs} ms`);
    ok(
      readFileSync(join(env.home, "fake-git-calls.jsonl"), "utf8").trim()
        .length > 0,
      "fake git should run before the bounded transcript scan",
    );
  });
});
