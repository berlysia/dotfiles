#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import defaultHook from "../../implementations/compaction-testament.ts";
import { createBlockingGit } from "../support/fake-git.ts";
import {
  createPostToolUseContextFor,
  createPreCompactContext,
  createSessionStartContext,
  EnvironmentHelper,
  invokeRun,
} from "../support/test-helpers.ts";
import {
  additionalContextOf,
  anchorHookOnProjectDir,
  hook,
  installHookEnv,
  recordPath,
  restoreHookEnv,
  setupHookEnv,
  transcriptAt,
  type HookEnv,
} from "../support/compaction-testament-fixture.ts";

describe("compaction-testament hook", () => {
  const envHelper = new EnvironmentHelper();
  const dirs: string[] = [];

  beforeEach(() => installHookEnv(envHelper, dirs));
  afterEach(() => restoreHookEnv(envHelper, dirs));
  const setup = (opts: { git?: boolean; ignoreTmp?: boolean } = {}): HookEnv =>
    setupHookEnv(envHelper, dirs, (repo) => {
      if (!opts.git) return;
      execFileSync("git", ["init", "-q"], { cwd: repo });
      if (opts.ignoreTmp) writeFileSync(join(repo, ".gitignore"), ".tmp\n");
    });

  describe("project dir anchoring", () => {
    // A Bash `cd` moves the session cwd that every later hook receives, so the
    // workflow dir must not be derived from it. The drift target below is the
    // workflow dir itself, as observed on a real device.
    const anchorOnProjectDir = (env: HookEnv): void =>
      anchorHookOnProjectDir(envHelper, env);

    it("restores the testament after the session cwd drifts into a subdir", async () => {
      const env = setup();
      anchorOnProjectDir(env);
      writeFileSync(join(env.wfDir, "testament.md"), "DRIFT-SURVIVOR");
      const postCtx = createPostToolUseContextFor(
        hook,
        "Write",
        { file_path: join(env.wfDir, "testament.md"), content: "ignored" },
        {},
        { cwd: env.repo },
      );
      (postCtx.input as { transcript_path: string }).transcript_path =
        transcriptAt(env, 100_000);
      await invokeRun(hook, postCtx);
      assert.ok(existsSync(recordPath(env)));

      await invokeRun(
        hook,
        createPreCompactContext({
          cwd: env.wfDir,
          transcript_path: transcriptAt(env, 100_000),
        }),
      );
      const startCtx = createSessionStartContext("compact", { cwd: env.wfDir });
      await invokeRun(hook, startCtx);

      assert.match(additionalContextOf(startCtx), /DRIFT-SURVIVOR/);
      assert.equal(existsSync(recordPath(env)), false);
      assert.equal(existsSync(join(env.wfDir, ".tmp")), false);
    });
  });

  describe("PreCompact", () => {
    const compact = async (
      env: HookEnv,
      transcript: string,
      custom: string | null = null,
      target = hook,
    ) => {
      const ctx = createPreCompactContext({
        cwd: env.repo,
        transcript_path: transcript,
        custom_instructions: custom,
      });
      const result = await invokeRun(target, ctx);
      return { ctx, result };
    };
    const snapshotOf = (env: HookEnv): string =>
      readFileSync(join(env.wfDir, "snapshot.md"), "utf8");

    it("replaces an old snapshot, never blocks, and writes mode 0600", async () => {
      const env = setup({ git: true, ignoreTmp: true });
      writeFileSync(join(env.wfDir, "snapshot.md"), "OLD");
      const { ctx } = await compact(env, transcriptAt(env, 500_000));
      ctx.assertSuccess({});
      assert.doesNotMatch(snapshotOf(env), /OLD/);
      assert.equal(
        statSync(join(env.wfDir, "snapshot.md")).mode & 0o777,
        0o600,
      );
    });

    it("includes redacted utterances and instructions when the dir is ignored", async () => {
      const env = setup({ git: true, ignoreTmp: true });
      await compact(
        env,
        transcriptAt(env, 500_000),
        "keep API_KEY=hunter2 safe",
      );
      const snap = snapshotOf(env);
      assert.match(snap, /SECRET-UTTERANCE/);
      assert.doesNotMatch(snap, /sk-ant-a{30}/);
      assert.doesNotMatch(snap, /hunter2/);
    });

    it("includes utterances outside any git repository", async () => {
      const env = setup();
      await compact(env, transcriptAt(env, 500_000));
      assert.match(snapshotOf(env), /SECRET-UTTERANCE/);
    });

    it("omits utterances, instructions and file names when not ignored", async () => {
      const env = setup({ git: true });
      writeFileSync(join(env.repo, "untracked-file-name.txt"), "x");
      await compact(env, transcriptAt(env, 500_000), "CUSTOM-INSTR");
      const snap = snapshotOf(env);
      assert.doesNotMatch(
        snap,
        /SECRET-UTTERANCE|CUSTOM-INSTR|untracked-file-name/,
      );
      assert.match(snap, /ignore されていないため省略/);
    });

    it("treats a broken git dir (non not-a-repo failure) as not ignored", async () => {
      const env = setup({ git: true, ignoreTmp: true });
      writeFileSync(join(env.repo, ".git", "config"), "[[[garbage\n");
      await compact(env, transcriptAt(env, 500_000));
      assert.doesNotMatch(snapshotOf(env), /SECRET-UTTERANCE/);
    });

    it("treats a git check-ignore over the production 2000ms timeout as not ignored", async () => {
      const env = setup({ git: true, ignoreTmp: true });
      const git = createBlockingGit("check-ignore");
      envHelper.set("PATH", `${git.binDir}:${process.env.PATH ?? ""}`);
      try {
        await compact(env, transcriptAt(env, 500_000), null, defaultHook);
        const snap = snapshotOf(env);
        assert.doesNotMatch(snap, /SECRET-UTTERANCE/);
        assert.match(snap, /ignore されていないため省略/);
      } finally {
        git.cleanup();
      }
    });

    it("does not write through a symlink at snapshot.md", async () => {
      const env = setup({ git: true, ignoreTmp: true });
      const target = join(env.tdir, "victim.txt");
      writeFileSync(target, "UNTOUCHED");
      symlinkSync(target, join(env.wfDir, "snapshot.md"));
      await compact(env, transcriptAt(env, 500_000));
      assert.equal(readFileSync(target, "utf8"), "UNTOUCHED");
      assert.equal(statSync(join(env.wfDir, "snapshot.md")).isFile(), true);
    });
  });
});
