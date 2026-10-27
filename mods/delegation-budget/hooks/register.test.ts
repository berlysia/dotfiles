import type { On } from "claude-code";
import { describe, expect, test } from "claude-code/testing";
import { mock } from "claude-code/testing";
import { buildReminder } from "./reminder";

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const REMINDER = buildReminder(
  [{ kind: "seven_day", percentUsed: 94 }],
  NOW,
) as string;

type UsageMode = "ok" | "reject" | "hang";

// Stands for the engine beneath the plugin: a recording tool.call core, a
// session.usage answer chosen per test, and a mocked clock.
function setup(
  on: On,
  options: {
    pct?: number;
    usage?: UsageMode;
    next?: (e: unknown) => unknown;
  } = {},
) {
  const calls = { next: [] as unknown[], usage: 0 };
  const clock = mock.clock(on, { now: NOW });
  on("tool.call", (_, e) => {
    calls.next.push(e);
    return (options.next?.(e) ?? { result: {}, ref: "r1" }) as never;
  });
  on("session.usage", () => {
    calls.usage++;
    if (options.usage === "reject") throw new Error("usage failed");
    if (options.usage === "hang") return new Promise<never>(() => undefined);
    return {
      value: {
        startedAt: 0,
        context: { window: 200_000 },
        rateLimits: [{ kind: "seven_day", percentUsed: options.pct ?? 94 }],
      },
    };
  });
  return { calls, clock };
}

describe("delegation-budget", () => {
  test("Agent at 94% -> reminder is last in context, result and ref kept", async ($, on) => {
    setup(on);
    const out = await $.tool.call({
      tool: "Agent",
      subagent_type: "general-purpose",
      prompt: "p",
      description: "d",
    });
    expect(out.context?.at(-1)).toBe(REMINDER);
    expect(out.result).toEqual({});
    expect(out.ref).toBe("r1");
  });

  test("Workflow at 94% -> same", async ($, on) => {
    setup(on);
    const out = await $.tool.call({ tool: "Workflow", script: "s" } as never);
    expect(out.context?.at(-1)).toBe(REMINDER);
    expect(out.ref).toBe("r1");
  });

  test("Agent codex:codex-rescue at 94% -> context unchanged", async ($, on) => {
    const { calls } = setup(on);
    const out = await $.tool.call({
      tool: "Agent",
      subagent_type: "codex:codex-rescue",
      prompt: "p",
      description: "d",
    });
    expect(out.context).toBeUndefined();
    expect(calls.usage).toBe(0);
  });

  test("Agent at 50% -> context unchanged", async ($, on) => {
    setup(on, { pct: 50 });
    const out = await $.tool.call({
      tool: "Agent",
      subagent_type: "general-purpose",
      prompt: "p",
      description: "d",
    });
    expect(out.context).toBeUndefined();
  });

  test("a deny from next is returned as is", async ($, on) => {
    const { calls } = setup(on, { next: () => ({ deny: "x" }) });
    const out = await $.tool.call({
      tool: "Agent",
      subagent_type: "general-purpose",
      prompt: "p",
      description: "d",
    });
    expect(out).toEqual({ deny: "x" });
    expect(calls.usage).toBe(0);
  });

  test("context from below is kept: ['a'] -> ['a', reminder]", async ($, on) => {
    setup(on, { next: () => ({ result: {}, context: ["a"], ref: "r1" }) });
    const out = await $.tool.call({
      tool: "Agent",
      subagent_type: "general-purpose",
      prompt: "p",
      description: "d",
    });
    expect(out.context).toEqual(["a", REMINDER]);
  });

  test("session.usage rejecting -> next's result as is", async ($, on) => {
    setup(on, { usage: "reject" });
    const out = await $.tool.call({
      tool: "Agent",
      subagent_type: "general-purpose",
      prompt: "p",
      description: "d",
    });
    expect(out.context).toBeUndefined();
    expect(out.ref).toBe("r1");
  });

  test("session.usage never resolving -> next's result after 500 ms", async ($, on) => {
    const { clock } = setup(on, { usage: "hang" });
    const pending = $.tool.call({
      tool: "Agent",
      subagent_type: "general-purpose",
      prompt: "p",
      description: "d",
    });
    await clock.advance(499);
    let settled = false;
    void pending.then(() => (settled = true));
    await clock.settle();
    expect(settled).toBe(false);
    await clock.advance(1);
    const out = await pending;
    expect(out.context).toBeUndefined();
    expect(out.ref).toBe("r1");
  });

  test("next rejecting -> same rejection, usage never read", async ($, on) => {
    const { calls } = setup(on, {
      next: () => {
        throw new Error("core failed");
      },
    });
    await expect(
      $.tool.call({
        tool: "Agent",
        subagent_type: "general-purpose",
        prompt: "p",
        description: "d",
      }),
      // The kit reports a throwing hook beneath the plugin as "no
      // implementation" (the thrown message is only in its diagnostics), so
      // the assertion is that the call rejects, not which message it carries.
    ).rejects.toThrow();
    expect(calls.usage).toBe(0);
  });

  test("next is called once with the input the hook received", async ($, on) => {
    const { calls } = setup(on);
    const input = {
      tool: "Agent",
      subagent_type: "general-purpose",
      prompt: "p",
      description: "d",
    } as const;
    await $.tool.call(input);
    expect(calls.next).toHaveLength(1);
    expect(calls.next[0]).toMatchObject(input);
  });
});
