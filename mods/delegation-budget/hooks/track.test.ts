import { describe, expect, test } from "claude-code/testing";
import {
  bashReason,
  classifyAgentResult,
  durationArg,
  isTrackedAgent,
  isBashCandidate,
  pushBounded,
  truncateUtf8,
} from "./track";

// Keep the subagent_type table identical to BAD_NAMES in
// tests/delegation-capture.test.mjs: the regex is copied, not shared.
const BAD_SUBAGENT_TYPES = [
  "../x",
  "a/b",
  "a.b",
  "Logic",
  "Explore",
  "plugin:x",
  "a_b",
  "a".repeat(41),
  "",
  "a\0b",
  "a\nb",
  "x\n",
];

describe("track", () => {
  test("isTrackedAgent: model-less agents are candidates, other models are not", () => {
    expect(isTrackedAgent({ subagent_type: "logic-validator" })).toBe(true);
    expect(isTrackedAgent({ model: "sonnet", subagent_type: "Explore" })).toBe(
      true,
    );
    expect(isTrackedAgent({ subagent_type: "codex:codex-rescue" })).toBe(true);
    for (const model of ["haiku", "", 3]) {
      expect(isTrackedAgent({ model, subagent_type: "logic-validator" })).toBe(
        false,
      );
    }
    for (const t of BAD_SUBAGENT_TYPES) {
      expect(isTrackedAgent({ subagent_type: t })).toBe(false);
    }
    expect(isTrackedAgent({})).toBe(false);
  });

  test("isBashCandidate looks at the head of each section", () => {
    expect(isBashCandidate("cd x && opencode run -m y")).toBe(true);
    expect(isBashCandidate("echo hi | codex exec")).toBe(true);
    expect(isBashCandidate("bun a.ts")).toBe(true);
    expect(isBashCandidate("ls\nbun x")).toBe(true);
    expect(isBashCandidate("echo opencode")).toBe(false);
    expect(isBashCandidate(undefined)).toBe(false);
  });

  test("isBashCandidate accepts delegation offload by basename and subcommand", () => {
    expect(isBashCandidate("delegation offload --model x")).toBe(true);
    expect(isBashCandidate("/home/u/.local/bin/delegation offload --x")).toBe(
      true,
    );
    expect(isBashCandidate("cd x && delegation offload")).toBe(true);
    expect(isBashCandidate("delegation route --kind impl")).toBe(false);
    expect(isBashCandidate("delegation record d-1")).toBe(false);
    expect(isBashCandidate("ls delegation")).toBe(false);
    expect(isBashCandidate("mydelegation offload")).toBe(false);
  });

  test("classifyAgentResult follows the probe", () => {
    expect(
      classifyAgentResult({ status: "async_launched", agentId: "a1" }),
    ).toEqual({
      kind: "background",
      agentId: "a1",
    });
    expect(classifyAgentResult({ isAsync: true, agentId: "a1" }).kind).toBe(
      "background",
    );
    // A foreground result carries agentId too.
    expect(
      classifyAgentResult({ status: "completed", agentId: "a1", content: [] })
        .kind,
    ).toBe("foreground");
    expect(classifyAgentResult({ agentId: "a1" }).kind).toBe("unknown");
    expect(
      classifyAgentResult({ status: "async_launched", agentId: "../x" }).kind,
    ).toBe("unknown");
    expect(classifyAgentResult("text").kind).toBe("unknown");
  });

  test("bashReason", () => {
    expect(bashReason(true)).toBe("error");
    expect(bashReason(undefined)).toBe("answer");
  });

  test("truncateUtf8 cuts on a character boundary", () => {
    expect(truncateUtf8("あいう", 7)).toBe("あい");
    expect(truncateUtf8("abc", 2)).toBe("ab");
  });

  test("pushBounded drops the oldest", () => {
    expect(pushBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  test("durationArg is a non-negative integer", () => {
    expect(durationArg(100, 1334.4)).toBe("1234");
    expect(durationArg(200, 100)).toBe("0");
  });
});
