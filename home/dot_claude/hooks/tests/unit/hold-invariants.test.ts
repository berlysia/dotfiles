#!/usr/bin/env node --test
import { ok, strictEqual } from "node:assert";
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
import { decideStatic } from "../../implementations/permission-auto-approve.ts";
import { reasonToSkipLLM } from "../../implementations/permission-llm-evaluator.ts";
import {
  createPreToolUseContextFor,
  EnvironmentHelper,
  invokeRun,
} from "../support/test-helpers.ts";

// Inputs that every hook must keep away from auto-approval (spec K7). The first four paths are the
// same ones the `ask` rules in .settings.permissions.json name; plan-2 compares them with the rules.
const CWD = "/w/p";

describe("hold invariants across the three hooks", () => {
  const envHelper = new EnvironmentHelper();
  let home = "";
  beforeEach(() => {
    envHelper.set("CLAUDE_TEST_MODE", "1");
    // A mkdtemp home, not the real HOME.
    home = realpathSync(mkdtempSync(join(tmpdir(), "hold-inv-")));
    mkdirSync(join(home, ".local/share/chezmoi"), { recursive: true });
    writeFileSync(join(home, ".local/share/chezmoi/.chezmoiroot"), "home\n");
    envHelper.set("HOME", home);
  });
  afterEach(() => {
    envHelper.restore();
    rmSync(home, { recursive: true, force: true });
  });

  const inputs = (): Array<{
    label: string;
    tool: string;
    input: Record<string, unknown>;
  }> => [
    {
      label: "ask 1",
      tool: "Edit",
      input: { file_path: join(home, ".gitconfig") },
    },
    {
      label: "ask 2",
      tool: "Edit",
      input: { file_path: join(home, ".config/git/config") },
    },
    {
      label: "ask 3",
      tool: "Edit",
      input: {
        file_path: join(home, ".local/share/chezmoi/home/dot_gitconfig.tmpl"),
      },
    },
    {
      label: "ask 4",
      tool: "Edit",
      input: {
        file_path: join(
          home,
          ".local/share/chezmoi/home/private_dot_config/git/ignore",
        ),
      },
    },
    {
      label: "inside .git",
      tool: "Edit",
      input: { file_path: `${CWD}/.git/probe.txt` },
    },
    {
      label: "gitfile",
      tool: "Edit",
      input: { file_path: `${CWD}/vendor/sub/.git` },
    },
    { label: "tee", tool: "Bash", input: { command: "tee .claude/x.json" } },
    {
      label: "redirect",
      tool: "Bash",
      input: { command: "echo x > .vscode/a.json" },
    },
  ];

  it("PreToolUse never allows them, even with broad allow rules", async () => {
    for (const { label, tool, input } of inputs()) {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify(["Edit(//**)", "Bash(tee *)", "Bash(echo *)"]),
      );
      envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));
      const context = createPreToolUseContextFor(
        autoApproveHook,
        tool as "Edit",
        input,
        {
          cwd: CWD,
        },
      );
      await invokeRun(autoApproveHook, context);
      const allowed = context.jsonCalls.some(
        // biome-ignore lint/suspicious/noExplicitAny: hook JSON output
        (c: any) => c?.hookSpecificOutput?.permissionDecision === "allow",
      );
      strictEqual(allowed, false, label);
    }
  });

  it("the static layer does not allow them", async () => {
    for (const { label, tool, input } of inputs()) {
      const result = await decideStatic({
        session_id: "s",
        tool_name: tool,
        tool_input: input,
        cwd: CWD,
      });
      strictEqual(result.behavior === "allow", false, label);
    }
  });

  it("the LLM layer is skipped as held", async () => {
    for (const { label, tool, input } of inputs()) {
      const reason = await reasonToSkipLLM({
        session_id: "s",
        tool_name: tool,
        tool_input: input,
        cwd: CWD,
      });
      ok(reason?.startsWith("held: "), `${label}: ${reason}`);
    }
  });
});
