#!/usr/bin/env node --test
import { ok, strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  assessAutoApprovalHold,
  buildHoldContext,
} from "../../lib/auto-approval-hold.ts";
import {
  createPreToolUseContextFor,
  EnvironmentHelper,
  invokeRun,
} from "../support/test-helpers.ts";

// Inputs that every hook must keep away from auto-approval (spec K7). The Edit and Read rows
// labelled "ask" name paths the `ask` rules in .settings.permissions.json cover.
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
    {
      label: "ask Read .env",
      tool: "Read",
      input: { file_path: `${CWD}/.env` },
    },
    {
      label: "ask Read .env.*.local outside cwd",
      tool: "Read",
      input: { file_path: "/etc/app/.env.prod.local" },
    },
  ];

  it("PreToolUse never allows them, even with broad allow rules", async () => {
    for (const { label, tool, input } of inputs()) {
      envHelper.set(
        "CLAUDE_TEST_ALLOW",
        JSON.stringify([
          "Edit(//**)",
          "Read(//**)",
          "Bash(tee *)",
          "Bash(echo *)",
        ]),
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

describe("Read ask rules and the hold list", () => {
  const settings = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../.settings.permissions.json"),
      "utf8",
    ),
  ) as { ask: string[] };
  const readAskRules = settings.ask.filter((rule) => rule.startsWith("Read("));

  it("has the ten .env rules", () => {
    strictEqual(readAskRules.length, 10);
  });
  // A rule of another shape (a directory glob, a home-relative path) is not covered by a
  // name check; this fails so that the hold is extended together with the rule.
  it("every Read ask rule is //**/<name> and its name is held", async () => {
    const ctx = buildHoldContext({ cwd: "/w/p", home: "/home/u" });
    for (const rule of readAskRules) {
      const name = /^Read\(\/\/\*\*\/([^/]+)\)$/.exec(rule)?.[1];
      ok(name !== undefined, `unexpected shape: ${rule}`);
      const file_path = `/w/p/${name.replaceAll("*", "x")}`;
      const held = await assessAutoApprovalHold("Read", { file_path }, ctx);
      ok(held.hold, rule);
    }
  });
});
