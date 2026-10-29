import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  detectAgent,
  hasAgentEnv,
  isHumanCaller,
} from "../../lib/agent-caller.ts";

describe("hasAgentEnv", () => {
  for (const names of [
    ["PATH", "CLAUDECODE"],
    ["CLAUDE_CODE_ENTRYPOINT"],
    ["CODEX_SANDBOX_NETWORK_DISABLED"],
    ["AI_AGENT"],
    ["OPENCODE"],
    ["OPENCODE_SESSION_ID"],
    ["OPENCODE_TERMINAL"],
  ]) {
    it(`recognizes ${names.join(", ")}`, () => {
      strictEqual(hasAgentEnv(names), true);
    });
  }
  for (const names of [
    ["PATH", "HOME", "CLAUDECODEX"],
    ["MY_AI_AGENT"],
    ["CLAUDE_CODE"],
    [],
  ]) {
    it(`ignores ${JSON.stringify(names)}`, () => {
      strictEqual(hasAgentEnv(names), false);
    });
  }
});

describe("isHumanCaller", () => {
  for (const isTty of [true, false]) {
    for (const agentEnv of [true, false]) {
      it(`classifies isTty=${isTty}, agentEnv=${agentEnv}`, () => {
        strictEqual(isHumanCaller({ isTty, agentEnv }), isTty && !agentEnv);
      });
    }
  }
});

describe("detectAgent", () => {
  for (const [names, agent] of [
    [["OPENCODE"], "opencode"],
    [["OPENCODE_SESSION_ID"], "opencode"],
    [["OPENCODE_TERMINAL"], "opencode"],
    [["CODEX_SANDBOX"], "codex"],
    [["CODEX_SANDBOX_NETWORK_DISABLED"], "codex"],
    [["CLAUDECODE"], "claude"],
    [["CLAUDE_CODE_ENTRYPOINT"], "claude"],
    [["AI_AGENT"], "codex"],
    [["AI_AGENT", "CLAUDECODE"], "claude"],
    [["CLAUDE_CODE_ENTRYPOINT", "AI_AGENT"], "claude"],
    [["AI_AGENT", "CLAUDECODE", "CODEX_SANDBOX"], "codex"],
    [["AI_AGENT", "CLAUDECODE", "CODEX_SANDBOX", "OPENCODE"], "opencode"],
    [["PATH", "AGENT", "MY_OPENCODE"], "human"],
    [[], "human"],
  ] as const) {
    it(`detects ${JSON.stringify(names)} as ${agent}`, () => {
      strictEqual(detectAgent(names), agent);
      strictEqual(hasAgentEnv(names), agent !== "human");
      strictEqual(detectAgent([...names].reverse()), agent);
    });
  }
});
