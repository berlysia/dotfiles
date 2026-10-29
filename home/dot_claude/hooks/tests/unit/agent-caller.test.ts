import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { hasAgentEnv, isHumanCaller } from "../../lib/agent-caller.ts";

describe("hasAgentEnv", () => {
  for (const names of [
    ["PATH", "CLAUDECODE"],
    ["CLAUDE_CODE_ENTRYPOINT"],
    ["CODEX_SANDBOX_NETWORK_DISABLED"],
    ["AI_AGENT"],
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
