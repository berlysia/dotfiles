#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  EVALUATOR_QUERY_OPTIONS,
  parseLLMResponse,
  reasonToSkipLLM,
  SYSTEM_PROMPT,
} from "../../implementations/permission-llm-evaluator.ts";

describe("parseLLMResponse", () => {
  it("returns allow variant when JSON says allow: true", () => {
    const result = parseLLMResponse(
      '{"allow": true, "reason": "read-only command"}',
    );
    deepStrictEqual(result, {
      kind: "allow",
      reason: "read-only command",
    });
  });

  it("returns deny variant with confidence when JSON says allow: false", () => {
    const result = parseLLMResponse(
      '{"allow": false, "reason": "potential rm -rf", "confidence": "high"}',
    );
    deepStrictEqual(result, {
      kind: "deny",
      reason: "potential rm -rf",
      confidence: "high",
    });
  });

  it("defaults confidence to medium when missing on deny", () => {
    const result = parseLLMResponse('{"allow": false, "reason": "suspicious"}');
    deepStrictEqual(result, {
      kind: "deny",
      reason: "suspicious",
      confidence: "medium",
    });
  });

  it("defaults confidence to medium when invalid value supplied", () => {
    const result = parseLLMResponse(
      '{"allow": false, "reason": "x", "confidence": "extreme"}',
    );
    deepStrictEqual(result, {
      kind: "deny",
      reason: "x",
      confidence: "medium",
    });
  });

  it("returns parse-error when response is not JSON", () => {
    const raw = "I cannot comply with this request.";
    const result = parseLLMResponse(raw);
    strictEqual(result.kind, "parse-error");
    if (result.kind === "parse-error") {
      strictEqual(result.rawText, raw);
    }
  });

  it("returns parse-error when JSON fragment is malformed", () => {
    const result = parseLLMResponse("{allow: yes");
    strictEqual(result.kind, "parse-error");
  });

  it("returns parse-error when allow field is absent", () => {
    const result = parseLLMResponse('{"reason": "no decision"}');
    strictEqual(result.kind, "parse-error");
  });

  it("tolerates extra prose around the JSON block", () => {
    const result = parseLLMResponse(
      'Here is my decision:\n{"allow": true, "reason": "ok"}\nThanks.',
    );
    deepStrictEqual(result, { kind: "allow", reason: "ok" });
  });

  it("returns empty reason when reason is missing but allow is boolean", () => {
    const result = parseLLMResponse('{"allow": true}');
    deepStrictEqual(result, { kind: "allow", reason: "" });
  });
});

describe("EVALUATOR_QUERY_OPTIONS", () => {
  // The evaluator runs inside a PermissionRequest hook. If its subprocess
  // loads user settings, every evaluation starts a session that fires the
  // user's Stop hooks (voice, Discord, Slack) on its own.
  it("loads no filesystem settings so user hooks do not run in the evaluator session", () => {
    deepStrictEqual(EVALUATOR_QUERY_OPTIONS.settingSources, []);
  });
});

describe("SYSTEM_PROMPT deletion policy", () => {
  it("does not treat deletion as reversible", () => {
    ok(SYSTEM_PROMPT.includes("never cite reversibility as a reason to ALLOW"));
    ok(
      !SYSTEM_PROMPT.includes("ALLOW if removing project files (not rm -rf /)"),
    );
  });
});

describe("reasonToSkipLLM (spec K1, K4 principle 2)", () => {
  const input = (tool_name: string, tool_input: unknown) => ({
    session_id: "s",
    tool_name,
    tool_input,
    cwd: "/home/user/project",
  });
  const bash = (command: string) => reasonToSkipLLM(input("Bash", { command }));
  it("skips any command that names git", async () => {
    for (const command of [
      "git push origin main",
      "cd sub && git status",
      "command git log",
      "timeout 10 git fetch",
      "nice -n 5 git gc",
      "/usr/bin/git log",
    ]) {
      strictEqual(await bash(command), "skipped-llm: git-head", command);
    }
  });
  it("skips commands that set GIT_* variables, preferring git-env", async () => {
    for (const command of [
      "GIT_PAGER=cat git log",
      "export GIT_PAGER=cat",
      "env -i GIT_PAGER=cat make",
      "declare -x GIT_PAGER=cat",
    ]) {
      strictEqual(await bash(command), "skipped-llm: git-env", command);
    }
  });
  it("holds Edit to a dot path", async () => {
    const reason = await reasonToSkipLLM(
      input("Edit", { file_path: "/home/user/project/.claude/x.json" }),
    );
    strictEqual(reason?.startsWith("held: "), true);
  });
  it("lets other commands reach the LLM", async () => {
    strictEqual(await bash("pnpm install"), null);
    strictEqual(await bash("ls src"), null);
    strictEqual(
      await reasonToSkipLLM(
        input("Edit", { file_path: "/home/user/project/src/a.ts" }),
      ),
      null,
    );
  });
  it("holds a dot fragment without treating it as git-head", async () => {
    strictEqual(
      (await bash("cat .gitignore-notes"))?.startsWith("held: "),
      true,
    );
  });
});
