#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import autoApproveHook from "../../implementations/auto-approve.ts";
import guardHook from "../../implementations/home-destruction-guard.ts";
import { MAX_COMMAND_CHARS } from "../../lib/bash-parser.ts";
import {
  ConsoleCapture,
  createPreToolUseContextFor,
  EnvironmentHelper,
  invokeRun,
} from "../support/test-helpers.ts";

const HOME_REASON = "Blocked recursive delete/move of the home directory";
const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "home-guard-test-")));
const project = join(tmpHome, "proj");
mkdirSync(project);
after(() => rmSync(tmpHome, { recursive: true, force: true }));

const env = new EnvironmentHelper();
const consoleCapture = new ConsoleCapture();
beforeEach(() => {
  consoleCapture.start();
  env.set("HOME", tmpHome);
  env.set("CLAUDE_TEST_MODE", "1");
  env.set("CLAUDE_TEST_ALLOW", JSON.stringify([]));
  env.set("CLAUDE_TEST_DENY", JSON.stringify([]));
});
afterEach(() => {
  consoleCapture.stop();
  env.restore();
});

type Hook = typeof guardHook | typeof autoApproveHook;
async function reasonOf(
  hook: Hook,
  command: string,
  cwd: string,
): Promise<string> {
  const context = createPreToolUseContextFor(
    hook,
    "Bash",
    { command },
    { cwd },
  );
  await invokeRun(hook, context);
  return (
    context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason ?? ""
  );
}

// Taken from the checkHomeDestruction cases in command-parsing.test.ts:335-405.
const homeDenied = [
  'rm -rf "$HOME"',
  "rm -rf ~/.claude",
  "cd ~ && rm -rf .",
  "cd ~ && rm -rf *",
  'mv "$HOME/.local" /tmp/',
];
const notHome = ["rm -rf ./dist", 'ls -la "$HOME"', "cd ~ && ls", "echo hello"];

describe("home-destruction-guard", () => {
  for (const command of homeDenied) {
    it(`denies with the home reason, as auto-approve does: ${command}`, async () => {
      const guard = await reasonOf(guardHook, command, project);
      const auto = await reasonOf(autoApproveHook, command, project);
      strictEqual(guard.includes(HOME_REASON), true);
      strictEqual(auto.includes(HOME_REASON), true);
      ok(guard.includes("\nCommand: "));
    });
  }

  for (const command of notHome) {
    it(`returns no decision, and auto-approve gives no home reason: ${command}`, async () => {
      const context = createPreToolUseContextFor(
        guardHook,
        "Bash",
        { command },
        { cwd: project },
      );
      await invokeRun(guardHook, context);
      context.assertSuccess();
      strictEqual(
        (await reasonOf(autoApproveHook, command, project)).includes(
          HOME_REASON,
        ),
        false,
      );
    });
  }

  it("denies a command the parser gives up on, with the same give-up reason as auto-approve", async () => {
    const command = `echo ${"a".repeat(MAX_COMMAND_CHARS + 1)}`;
    const guard = await reasonOf(guardHook, command, project);
    const auto = await reasonOf(autoApproveHook, command, project);
    ok(guard.includes("32,000 characters"));
    ok(auto.includes("32,000 characters"));
    strictEqual(guard.includes(HOME_REASON), false);
  });

  it("falls back to process.cwd() when the input has no cwd", async () => {
    const before = process.cwd();
    process.chdir(tmpHome);
    try {
      strictEqual(
        (await reasonOf(guardHook, "rm -rf *", "")).includes(HOME_REASON),
        true,
      );
      strictEqual(
        (await reasonOf(autoApproveHook, "rm -rf *", "")).includes(HOME_REASON),
        true,
      );
    } finally {
      process.chdir(before);
    }
  });

  it("returns no decision for tools other than Bash", async () => {
    const context = createPreToolUseContextFor(guardHook, "Read", {
      file_path: join(tmpHome, "x"),
    });
    await invokeRun(guardHook, context);
    context.assertSuccess();
  });

  it("denies when the check itself throws", async () => {
    const input = {
      get command(): string {
        throw new Error("boom");
      },
    };
    const context = createPreToolUseContextFor(
      guardHook,
      "Bash",
      input as never,
      { cwd: project },
    );
    await invokeRun(guardHook, context);
    context.assertDeny();
    ok(
      context.jsonCalls[0].hookSpecificOutput.permissionDecisionReason.includes(
        "Error in home destruction check",
      ),
    );
  });
});
