#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import autoApproveHook from "../../implementations/auto-approve.ts";
import { encodeSessionDirName } from "../../lib/project-root.ts";
import {
  createPreToolUseContextFor,
  EnvironmentHelper,
  invokeRun,
} from "../support/test-helpers.ts";

describe("a /path rule read from a settings file anchors at its source", () => {
  const envHelper = new EnvironmentHelper();
  const startedIn = process.cwd();
  let scratch: string | undefined;
  let tmpHome: string;
  let project: string;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "aa-anchor-")));
    tmpHome = join(scratch, "home");
    project = join(scratch, "proj");
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(join(project, "inner"));
    writeFileSync(
      join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: ["Edit(/x/**)"] } }),
    );
    writeFileSync(
      join(project, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: ["Edit(/sub/**)"] } }),
    );
    envHelper.set("HOME", tmpHome);
    envHelper.set("CLAUDE_TEST_MODE", undefined);
    envHelper.set("CLAUDE_TEST_CWD", undefined);
    envHelper.set("CLAUDE_PROJECT_DIR", project);
    process.chdir(project);
  });
  afterEach(() => {
    process.chdir(startedIn);
    envHelper.restore();
    // scratch is the mkdtemp result, never the real home.
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  // biome-ignore lint/suspicious/noExplicitAny: test context
  const isDenied = (context: any) =>
    context.jsonCalls.some(
      // biome-ignore lint/suspicious/noExplicitAny: hook JSON output
      (c: any) => c?.hookSpecificOutput?.permissionDecision === "deny",
    );
  const decide = async (
    tool: "Write" | "Edit",
    file_path: string,
    cwd: string,
    transcript_path?: string,
  ) => {
    const input =
      tool === "Write"
        ? { file_path, content: "x" }
        : { file_path, old_string: "a", new_string: "b" };
    const context = createPreToolUseContextFor(autoApproveHook, tool, input, {
      cwd,
      transcript_path,
    });
    await invokeRun(autoApproveHook, context);
    return isDenied(context);
  };

  it("denies Edit and Write under <project>/sub for the project rule /sub/**", async () => {
    strictEqual(
      await decide("Write", join(project, "sub", "x"), project),
      true,
    );
    strictEqual(await decide("Edit", join(project, "sub", "x"), project), true);
  });
  it("keeps that anchor when the hook input cwd has moved", async () => {
    const inner = join(project, "inner");
    strictEqual(await decide("Write", join(project, "sub", "x"), inner), true);
    strictEqual(await decide("Write", join(inner, "sub", "x"), inner), false);
  });
  it("does not deny /sub/x for the project rule", async () => {
    strictEqual(await decide("Write", "/sub/x", project), false);
  });
  it("denies <home>/.claude/x/a for the user rule /x/**, and neither /x/a nor <home>/x/a", async () => {
    strictEqual(
      await decide("Write", join(tmpHome, ".claude", "x", "a"), project),
      true,
    );
    strictEqual(await decide("Write", "/x/a", project), false);
    strictEqual(await decide("Write", join(tmpHome, "x", "a"), project), false);
  });
  it("moves the anchor into a worktree the transcript directory names", async () => {
    const worktree = join(project, ".claude", "worktrees", "w");
    const transcript = join(
      tmpHome,
      ".claude",
      "projects",
      encodeSessionDirName(worktree),
      "s.jsonl",
    );
    strictEqual(
      await decide("Write", join(worktree, "sub", "x"), worktree, transcript),
      true,
    );
    strictEqual(
      await decide("Write", join(project, "sub", "x"), worktree, transcript),
      false,
    );
  });
});
