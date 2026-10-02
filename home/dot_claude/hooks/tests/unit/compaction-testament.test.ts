#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import hook from "../../implementations/compaction-testament.ts";
import { deriveDefaultWorkflowDir } from "../../lib/workflow-paths.ts";
import {
  createPostToolUseContextFor,
  createPreCompactContext,
  createSessionStartContext,
  createStopContextFor,
  EnvironmentHelper,
  invokeRun,
} from "./test-helpers.ts";
import {
  buildRestoreContext,
  buildSnapshot,
  buildTestamentRequest,
  decidePostToolUse,
  decideStop,
  extractRecentUserUtterances,
  getThresholds,
  isWrittenThisCycle,
  neutralizeTags,
  parseState,
  parseTokenCount,
  parseWrittenRecord,
  readContextTokens,
  resolveCompactAt,
  truncateSafely,
  updateUsageHealth,
  type RequestKind,
  type TestamentState,
  type Thresholds,
} from "../../lib/compaction-testament.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(
  join(here, "..", "__fixtures__", "compaction-testament-transcript.jsonl"),
  "utf8",
);

const TH: Thresholds = { triggerAt: 867_000, updateAt: 927_000 };
const INITIAL: TestamentState = {
  version: 1,
  stage: 0,
  stopBlocked: false,
  usageMissStreak: 0,
  degradedNotified: false,
};
const state = (over: Partial<TestamentState> = {}): TestamentState => ({
  ...INITIAL,
  ...over,
});

const assistantLine = (
  usage: { i: number; c: number; r: number },
  over: Record<string, unknown> = {},
  msgOver: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: {
      model: "m",
      usage: {
        input_tokens: usage.i,
        cache_creation_input_tokens: usage.c,
        cache_read_input_tokens: usage.r,
      },
      ...msgOver,
    },
    ...over,
  });

describe("readContextTokens (K1)", () => {
  it("sums the three input-side usage fields of the last main-chain assistant", () => {
    assert.deepEqual(readContextTokens(fixtureText), {
      kind: "tokens",
      value: 94048,
    });
  });

  it("skips sidechain assistants", () => {
    const text = [
      assistantLine({ i: 1, c: 0, r: 999 }),
      assistantLine({ i: 5, c: 5, r: 5000 }, { isSidechain: true }),
    ].join("\n");
    assert.deepEqual(readContextTokens(text), { kind: "tokens", value: 1000 });
  });

  it("skips <synthetic> model and zero-total assistants", () => {
    const text = [
      assistantLine({ i: 1, c: 0, r: 999 }),
      assistantLine({ i: 7, c: 7, r: 7 }, {}, { model: "<synthetic>" }),
      assistantLine({ i: 0, c: 0, r: 0 }),
    ].join("\n");
    assert.deepEqual(readContextTokens(text), { kind: "tokens", value: 1000 });
  });

  it("returns after-compact when a compact_boundary precedes any assistant", () => {
    const text = [
      assistantLine({ i: 1, c: 0, r: 999 }),
      JSON.stringify({ type: "system", subtype: "compact_boundary" }),
      JSON.stringify({
        type: "user",
        isCompactSummary: true,
        message: { content: "summary" },
      }),
    ].join("\n");
    assert.deepEqual(readContextTokens(text), {
      kind: "none",
      reason: "after-compact",
    });
  });

  it("skips a truncated leading line", () => {
    const text = [
      '{"type":"assistant","isSidechain":false,"message":{"usage":{"input_tok',
      assistantLine({ i: 2, c: 3, r: 4 }),
    ].join("\n");
    assert.deepEqual(readContextTokens(text), { kind: "tokens", value: 9 });
  });

  it("returns no-entry when there is no usable assistant", () => {
    const text = JSON.stringify({ type: "user", message: { content: "x" } });
    assert.deepEqual(readContextTokens(text), {
      kind: "none",
      reason: "no-entry",
    });
    assert.deepEqual(readContextTokens(""), {
      kind: "none",
      reason: "no-entry",
    });
  });
});

describe("parseTokenCount (K2)", () => {
  it("accepts numbers, numeric strings, and k/m suffixes", () => {
    const cases: Array<[unknown, number]> = [
      [500000, 500000],
      ["500000", 500000],
      ["500k", 500000],
      ["1M", 1000000],
      ["0.5m", 500000],
      [" 200K ", 200000],
    ];
    for (const [input, expected] of cases) {
      assert.equal(parseTokenCount(input), expected, String(input));
    }
  });

  it("rejects out-of-range and malformed values", () => {
    for (const input of [0, -1, NaN, "abc", 99999, 1000001, "1.5m", null]) {
      assert.equal(parseTokenCount(input), null, String(input));
    }
  });
});

describe("resolveCompactAt (K2)", () => {
  it("prefers env, then settings, then the default", () => {
    assert.equal(
      resolveCompactAt(
        { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" },
        { autoCompactWindow: "1m" },
      ),
      500000,
    );
    assert.equal(
      resolveCompactAt(
        { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "abc" },
        { autoCompactWindow: "1m" },
      ),
      1000000,
    );
    assert.equal(resolveCompactAt({}, {}), 967000);
    assert.equal(resolveCompactAt({}, null), 967000);
  });
});

describe("getThresholds (K2)", () => {
  it("derives the two stages from compactAt", () => {
    assert.deepEqual(getThresholds(967000), {
      triggerAt: 867000,
      updateAt: 927000,
    });
    assert.deepEqual(getThresholds(200000), {
      triggerAt: 100000,
      updateAt: 160000,
    });
    assert.deepEqual(getThresholds(100000), {
      triggerAt: 50000,
      updateAt: 80000,
    });
  });
});

describe("parseState", () => {
  it("returns the initial state for missing or foreign-version input", () => {
    for (const input of [null, "", "x", "{}", '{"version":2,"stage":1}']) {
      assert.deepEqual(parseState(input), INITIAL, String(input));
    }
  });

  it("validates field by field and drops extra keys", () => {
    assert.deepEqual(
      parseState(
        '{"version":1,"stage":1,"stopBlocked":"yes","usageMissStreak":-3,"extra":1}',
      ),
      state({ stage: 1 }),
    );
    assert.deepEqual(
      parseState(
        '{"version":1,"stage":5,"stopBlocked":true,"usageMissStreak":2.5}',
      ),
      state({ stopBlocked: true }),
    );
    assert.deepEqual(
      parseState(
        '{"version":1,"stage":2,"usageMissStreak":"3","degradedNotified":"true"}',
      ),
      state({ stage: 2 }),
    );
  });

  it("keeps valid fields", () => {
    const full = state({
      stage: 2,
      stopBlocked: true,
      usageMissStreak: 7,
      degradedNotified: true,
    });
    assert.deepEqual(parseState(JSON.stringify(full)), full);
  });
});

describe("parseWrittenRecord", () => {
  const sha = "a".repeat(64);
  it("accepts a valid record", () => {
    const rec = { version: 1, sha256: sha, tokens: 900000 };
    assert.deepEqual(parseWrittenRecord(JSON.stringify(rec)), rec);
    const nullTokens = { version: 1, sha256: sha, tokens: null };
    assert.deepEqual(
      parseWrittenRecord(JSON.stringify(nullTokens)),
      nullTokens,
    );
  });

  it("rejects malformed records", () => {
    const bad = [
      { version: 1, sha256: "a".repeat(63), tokens: 1 },
      { version: 1, sha256: "A".repeat(64), tokens: 1 },
      { version: 1, sha256: 5, tokens: 1 },
      { version: 1, sha256: sha, tokens: -1 },
      { version: 1, sha256: sha, tokens: "1" },
      { version: 2, sha256: sha, tokens: 1 },
    ];
    for (const rec of bad) {
      assert.equal(parseWrittenRecord(JSON.stringify(rec)), null);
    }
    assert.equal(parseWrittenRecord(null), null);
    assert.equal(parseWrittenRecord("not json"), null);
  });
});

describe("isWrittenThisCycle", () => {
  it("compares the record tokens against triggerAt; null counts as written", () => {
    const sha256 = "b".repeat(64);
    const rec = (tokens: number | null) => ({
      version: 1 as const,
      sha256,
      tokens,
    });
    assert.equal(isWrittenThisCycle(rec(866_999), TH), false);
    assert.equal(isWrittenThisCycle(rec(867_000), TH), true);
    assert.equal(isWrittenThisCycle(rec(null), TH), true);
    assert.equal(isWrittenThisCycle(null, TH), false);
  });
});

describe("decidePostToolUse (K3 transition table)", () => {
  it("does nothing below triggerAt", () => {
    const d = decidePostToolUse(866_999, TH, state(), false);
    assert.equal(d.request, null);
    assert.equal(d.next.stage, 0);
    assert.equal(d.dropRecord, false);
  });

  it("asks to write at triggerAt", () => {
    const d = decidePostToolUse(867_000, TH, state(), false);
    assert.equal(d.request, "write");
    assert.equal(d.next.stage, 1);
  });

  it("jumps straight to write-urgent / stage 2 above updateAt", () => {
    const d = decidePostToolUse(930_000, TH, state(), false);
    assert.equal(d.request, "write-urgent");
    assert.equal(d.next.stage, 2);
  });

  it("does not ask when already written this cycle", () => {
    const a = decidePostToolUse(867_000, TH, state(), true);
    assert.equal(a.request, null);
    assert.equal(a.next.stage, 1);
    const b = decidePostToolUse(930_000, TH, state(), true);
    assert.equal(b.request, null);
    assert.equal(b.next.stage, 2);
  });

  it("resets below triggerAt and drops a this-cycle record only", () => {
    const a = decidePostToolUse(500_000, TH, state({ stage: 1 }), true);
    assert.equal(a.request, null);
    assert.equal(a.dropRecord, true);
    assert.equal(a.next.stage, 0);
    const b = decidePostToolUse(500_000, TH, state({ stage: 1 }), false);
    assert.equal(b.dropRecord, false);
    const c = decidePostToolUse(500_000, TH, state(), true);
    assert.equal(c.request, null);
    assert.equal(c.dropRecord, true);
    assert.equal(c.next.stage, 0);
  });

  it("escalates stage 1 to stage 2 at updateAt", () => {
    const upd = decidePostToolUse(927_000, TH, state({ stage: 1 }), true);
    assert.equal(upd.request, "update");
    assert.equal(upd.next.stage, 2);
    const miss = decidePostToolUse(927_000, TH, state({ stage: 1 }), false);
    assert.equal(miss.request, "not-yet-written");
    assert.equal(miss.next.stage, 2);
  });

  it("stays quiet in stage 2 and clears stopBlocked on reset", () => {
    assert.equal(
      decidePostToolUse(950_000, TH, state({ stage: 2 }), false).request,
      null,
    );
    const d = decidePostToolUse(
      500_000,
      TH,
      state({ stage: 2, stopBlocked: true }),
      false,
    );
    assert.equal(d.request, null);
    assert.equal(d.next.stage, 0);
    assert.equal(d.next.stopBlocked, false);
  });

  it("carries health fields through", () => {
    const s = state({ usageMissStreak: 7, degradedNotified: true });
    for (const tokens of [100_000, 867_000, 930_000]) {
      const d = decidePostToolUse(tokens, TH, s, false);
      assert.equal(d.next.usageMissStreak, 7);
      assert.equal(d.next.degradedNotified, true);
    }
  });
});

describe("decideStop (K3 transition table)", () => {
  const base = {
    tokens: 930_000 as number | null,
    th: TH,
    state: state(),
    writtenThisCycle: false,
    stopHookActive: false,
  };

  it("blocks once at triggerAt when nothing is written", () => {
    const d = decideStop({ ...base, tokens: 867_000 });
    assert.equal(d.block, true);
    assert.equal(d.next.stage, 1);
    assert.equal(d.next.stopBlocked, true);
    const e = decideStop(base);
    assert.equal(e.block, true);
    assert.equal(e.next.stage, 2);
  });

  it("does not block when already written; advances stage 0 only", () => {
    const d = decideStop({ ...base, writtenThisCycle: true });
    assert.equal(d.block, false);
    assert.equal(d.next.stage, 2);
  });

  it("blocks from stage 1 and takes the max stage", () => {
    const d = decideStop({ ...base, state: state({ stage: 1 }) });
    assert.equal(d.block, true);
    assert.equal(d.next.stage, 2);
    assert.equal(d.next.stopBlocked, true);
  });

  it("does not block with stop_hook_active, stopBlocked, or written", () => {
    for (const over of [
      { stopHookActive: true },
      { state: state({ stage: 1, stopBlocked: true }) },
      { writtenThisCycle: true },
    ]) {
      const input = { ...base, state: state({ stage: 1 }), ...over };
      const d = decideStop(input);
      assert.equal(d.block, false);
      assert.equal(d.next.stage, 1);
    }
  });

  it("resets below triggerAt and drops a this-cycle record", () => {
    const d = decideStop({
      ...base,
      tokens: 500_000,
      state: state({ stage: 1, stopBlocked: true }),
      writtenThisCycle: true,
    });
    assert.equal(d.block, false);
    assert.equal(d.dropRecord, true);
    assert.equal(d.next.stage, 0);
    assert.equal(d.next.stopBlocked, false);
  });

  it("leaves state untouched when tokens are unknown", () => {
    const s = state({ stage: 1, usageMissStreak: 3 });
    const d = decideStop({ ...base, tokens: null, state: s });
    assert.equal(d.block, false);
    assert.equal(d.dropRecord, false);
    assert.deepEqual(d.next, s);
  });

  it("carries health fields through", () => {
    const s = state({ usageMissStreak: 7, degradedNotified: true });
    const d = decideStop({ ...base, state: s });
    assert.equal(d.next.usageMissStreak, 7);
    assert.equal(d.next.degradedNotified, true);
  });
});

describe("updateUsageHealth (K9)", () => {
  const miss = { kind: "none", reason: "no-entry" } as const;

  it("notifies once when the streak reaches 20", () => {
    const first = updateUsageHealth(state({ usageMissStreak: 19 }), miss, true);
    assert.equal(first.notify, true);
    assert.equal(first.next.usageMissStreak, 20);
    assert.equal(first.next.degradedNotified, true);
    const second = updateUsageHealth(first.next, miss, true);
    assert.equal(second.notify, false);
  });

  it("does not count a miss before the widest read is exhausted", () => {
    const r = updateUsageHealth(state({ usageMissStreak: 5 }), miss, false);
    assert.equal(r.next.usageMissStreak, 5);
    assert.equal(r.notify, false);
  });

  it("does not count after-compact", () => {
    const r = updateUsageHealth(
      state({ usageMissStreak: 5 }),
      { kind: "none", reason: "after-compact" },
      true,
    );
    assert.equal(r.next.usageMissStreak, 5);
  });

  it("resets on recovery so a second degradation is announced again", () => {
    const r = updateUsageHealth(
      state({ usageMissStreak: 20, degradedNotified: true }),
      { kind: "tokens", value: 1000 },
      false,
    );
    assert.equal(r.next.usageMissStreak, 0);
    assert.equal(r.next.degradedNotified, false);
  });
});

describe("extractRecentUserUtterances", () => {
  const user = (content: unknown, over: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "user", message: { content }, ...over });

  it("keeps real utterances and drops tool results, reminders, and meta entries", () => {
    const text = [
      user("first request"),
      user([{ type: "text", text: "second request" }]),
      user([{ type: "tool_result", tool_use_id: "x", content: "out" }]),
      user("<system-reminder>reminder</system-reminder>"),
      user("<compaction-testament>old</compaction-testament>"),
      user("summary", { isCompactSummary: true }),
      user("Stop hook feedback:\nreason", { isMeta: true }),
      user("[compaction-testament] please write"),
    ].join("\n");
    assert.deepEqual(extractRecentUserUtterances(text, 10), [
      "first request",
      "second request",
    ]);
  });

  it("returns only the most recent entries up to the limit and caps length", () => {
    const text = [user("one"), user("two"), user("x".repeat(900))].join("\n");
    const out = extractRecentUserUtterances(text, 2);
    assert.equal(out.length, 2);
    assert.equal(out[0], "two");
    assert.equal(out[1]?.length, 500);
  });

  it("works on the fixture", () => {
    assert.deepEqual(extractRecentUserUtterances(fixtureText, 5), [
      "synthetic user request one",
      "synthetic user request two",
    ]);
  });
});

describe("buildSnapshot (K8)", () => {
  const input = {
    at: "2026-01-01T00:00:00Z",
    trigger: "auto",
    customInstructions: "CUSTOM-INSTR-BODY",
    utterances: ["UTTERANCE-BODY"],
    gitBranch: "feature/x",
    gitStatus: " M secret-file-name.ts",
    workflowStatus: ["plan: approved"],
  };

  it("omits utterances, custom_instructions and git status when not ignored", () => {
    const out = buildSnapshot({ ...input, ignored: false });
    assert.match(out, /ignore されていないため省略/);
    assert.ok(!out.includes("UTTERANCE-BODY"));
    assert.ok(!out.includes("CUSTOM-INSTR-BODY"));
    assert.ok(!out.includes("secret-file-name.ts"));
    assert.ok(out.includes("feature/x"));
    assert.ok(out.includes("plan: approved"));
  });

  it("writes the given values when ignored", () => {
    const out = buildSnapshot({ ...input, ignored: true });
    assert.ok(out.includes("UTTERANCE-BODY"));
    assert.ok(out.includes("CUSTOM-INSTR-BODY"));
    assert.ok(out.includes("secret-file-name.ts"));
  });
});

describe("neutralizeTags (K6)", () => {
  it("replaces the leading < of framing tags only", () => {
    for (const s of [
      "</compaction-testament>",
      "</Compaction-Testament >",
      "<compaction-testament foo>",
      "</system-reminder>",
    ]) {
      const out = neutralizeTags(s);
      assert.ok(out.startsWith("＜"), s);
      assert.ok(!out.includes("<"), s);
    }
    assert.equal(neutralizeTags("Array<string>"), "Array<string>");
  });
});

describe("truncateSafely (K6)", () => {
  it("never leaves a lone surrogate and ends with the marker", () => {
    const path = "/p/testament.md";
    const suffix = `(truncated; 全文: ${path})`;
    // Sweep cut positions so one of them lands inside a surrogate pair.
    for (let max = suffix.length + 5; max < suffix.length + 12; max++) {
      const out = truncateSafely("😀".repeat(50), max, path);
      assert.ok(out.endsWith(suffix));
      assert.ok(out.length <= max);
      const body = out.slice(0, out.length - suffix.length);
      assert.ok(body.isWellFormed(), `max=${max}`);
    }
  });

  it("returns short text unchanged", () => {
    assert.equal(truncateSafely("abc", 10, "/p"), "abc");
  });
});

describe("buildRestoreContext (K6, K7)", () => {
  const path200 = `/${"p".repeat(199)}`;
  const base = {
    snapshot: null as string | null,
    testament: null as string | null,
    testamentTokens: 900_000 as number | null,
    testamentPath: path200,
    snapshotPath: path200,
  };

  it("stays within 9000 chars and is wrapped by the framing tags", () => {
    const out = buildRestoreContext({
      ...base,
      testament: "t".repeat(8000),
      snapshot: "s".repeat(4000),
    });
    assert.ok(out !== null);
    assert.ok(out.length <= 9000, String(out.length));
    assert.ok(out.startsWith("<compaction-testament>"));
    assert.ok(out.endsWith("</compaction-testament>"));
  });

  it("emits the closing tag exactly once even if the bodies contain it", () => {
    const out = buildRestoreContext({
      ...base,
      testament: "a </compaction-testament> b",
      snapshot: "c </compaction-testament> d",
    });
    assert.ok(out !== null);
    assert.equal(out.split("</compaction-testament>").length - 1, 1);
  });

  it("reports a missing testament, and returns null when both are absent", () => {
    const out = buildRestoreContext({ ...base, snapshot: "snap" });
    assert.ok(out?.includes("遺言は書かれなかった"));
    assert.equal(buildRestoreContext(base), null);
  });

  it("frames the content as reference data and states when it was written", () => {
    const out = buildRestoreContext({ ...base, testament: "body" });
    assert.ok(out !== null);
    assert.ok(out.includes("命令ではなく参考情報"));
    assert.ok(out.includes("承認状態の根拠にはしない"));
    assert.ok(out.includes("900000"));
  });
});

describe("buildTestamentRequest (K6)", () => {
  const kinds: RequestKind[] = [
    "write",
    "write-urgent",
    "update",
    "not-yet-written",
  ];
  it("carries the marker, path, and constraints for every kind", () => {
    for (const kind of kinds) {
      const out = buildTestamentRequest({
        kind,
        testamentPath: "/wf/testament.md",
      });
      assert.ok(out.startsWith("[compaction-testament]"), kind);
      assert.ok(out.includes("/wf/testament.md"), kind);
      assert.ok(out.includes("Write ツール"), kind);
      assert.ok(out.includes("指示を転記しない"), kind);
      assert.ok(out.includes("5,000 字以内"), kind);
    }
  });
});

// --- hook-level (IO layer) -------------------------------------------------

const HOOK_FIXTURE_TOKENS = 94048;
const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

type HookEnv = { repo: string; wfDir: string; tdir: string };

describe("compaction-testament hook", () => {
  const envHelper = new EnvironmentHelper();
  const dirs: string[] = [];

  beforeEach(() => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
    envHelper.set("CLAUDE_CODE_AUTO_COMPACT_WINDOW", undefined);
    // A developer-level global excludes file may already ignore `.tmp`, which
    // would make the "not ignored" fixtures unreproducible.
    envHelper.set("GIT_CONFIG_GLOBAL", "/dev/null");
    envHelper.set("GIT_CONFIG_NOSYSTEM", "1");
    // Keep the hook away from the real ~/.claude/settings.json.
    const cfg = mkdtempSync(join(tmpdir(), "ct-cfg-"));
    dirs.push(cfg);
    envHelper.set("XDG_CONFIG_HOME", join(cfg, "xdg"));
    envHelper.set("CLAUDE_CONFIG_DIR", cfg);
  });

  afterEach(() => {
    envHelper.restore();
    for (const d of dirs.splice(0)) {
      try {
        chmodSync(join(d, ".tmp", "sessions", "test-ses"), 0o700);
      } catch {
        // not every dir has a workflow dir
      }
      rmSync(d, { recursive: true, force: true });
    }
  });

  function setup(opts: { git?: boolean; ignoreTmp?: boolean } = {}): HookEnv {
    const repo = mkdtempSync(join(tmpdir(), "ct-repo-"));
    const tdir = mkdtempSync(join(tmpdir(), "ct-tr-"));
    dirs.push(repo, tdir);
    if (opts.git) {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      if (opts.ignoreTmp) writeFileSync(join(repo, ".gitignore"), ".tmp\n");
    }
    const wfDir = join(repo, deriveDefaultWorkflowDir("test-session"));
    mkdirSync(wfDir, { recursive: true });
    envHelper.set("CLAUDE_TEST_CWD", repo);
    return { repo, wfDir, tdir };
  }

  const transcriptAt = (env: HookEnv, tokens: number | null): string => {
    const path = join(env.tdir, "t.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content: "SECRET-UTTERANCE sk-ant-" + "a".repeat(30),
        },
      }),
    ];
    if (tokens !== null)
      lines.push(assistantLine({ i: 1, c: 0, r: tokens - 1 }));
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  };

  const writeState = (env: HookEnv, over: Partial<TestamentState>): void =>
    writeFileSync(
      join(env.wfDir, "testament-state.json"),
      JSON.stringify({ ...INITIAL, ...over }),
    );
  const readStateFile = (env: HookEnv): TestamentState =>
    parseState(
      existsSync(join(env.wfDir, "testament-state.json"))
        ? readFileSync(join(env.wfDir, "testament-state.json"), "utf8")
        : null,
    );
  const recordPath = (env: HookEnv): string =>
    join(env.wfDir, "testament-written.json");
  const writeTestament = (
    env: HookEnv,
    body: string,
    tokens: number | null,
    recordedSha: string = sha256Hex(body),
  ): void => {
    writeFileSync(join(env.wfDir, "testament.md"), body);
    writeFileSync(
      recordPath(env),
      JSON.stringify({ version: 1, sha256: recordedSha, tokens }),
    );
  };

  const post = async (
    env: HookEnv,
    transcript: string,
    tool: "Write" | "Bash" = "Bash",
    toolInput: Record<string, unknown> = { command: "true" },
    over: { agent_id?: string } = {},
  ) => {
    const ctx = createPostToolUseContextFor(
      hook,
      tool,
      toolInput as never,
      {},
      { cwd: env.repo, ...over },
    );
    (ctx.input as { transcript_path: string }).transcript_path = transcript;
    const result = await invokeRun(hook, ctx);
    return {
      ctx,
      result: result as { payload?: { event: string; output: any } },
    };
  };
  const writeTestamentInput = {
    file_path: ".tmp/sessions/test-ses/testament.md",
    content: "ignored",
  };
  const additionalContextOf = (ctx: { jsonCalls: any[] }): string =>
    ctx.jsonCalls.at(-1)?.hookSpecificOutput?.additionalContext ?? "";

  describe("PostToolUse", () => {
    it("records a testament Write (relative path) with sha256 and fixture tokens", async () => {
      const env = setup();
      writeFileSync(join(env.wfDir, "testament.md"), "my testament");
      const fixture = join(
        here,
        "..",
        "__fixtures__",
        "compaction-testament-transcript.jsonl",
      );
      await post(env, fixture, "Write", writeTestamentInput);
      const raw = JSON.parse(readFileSync(recordPath(env), "utf8"));
      assert.equal(raw.sha256, sha256Hex("my testament"));
      assert.equal(raw.tokens, HOOK_FIXTURE_TOKENS);
    });

    it("records through a symlinked cwd alias", async () => {
      const env = setup();
      const alias = join(env.tdir, "alias");
      symlinkSync(env.repo, alias);
      envHelper.set("CLAUDE_TEST_CWD", alias);
      writeFileSync(join(env.wfDir, "testament.md"), "via alias");
      const ctx = createPostToolUseContextFor(
        hook,
        "Write",
        writeTestamentInput,
        {},
        { cwd: alias },
      );
      (ctx.input as { transcript_path: string }).transcript_path = transcriptAt(
        env,
        100_000,
      );
      await invokeRun(hook, ctx);
      assert.equal(
        JSON.parse(readFileSync(recordPath(env), "utf8")).sha256,
        sha256Hex("via alias"),
      );
    });

    it("keeps a below-threshold record and leaves stage 0", async () => {
      const env = setup();
      writeFileSync(join(env.wfDir, "testament.md"), "early");
      await post(env, transcriptAt(env, 500_000), "Write", writeTestamentInput);
      assert.ok(existsSync(recordPath(env)));
      assert.equal(
        JSON.parse(readFileSync(recordPath(env), "utf8")).tokens,
        500_000,
      );
      assert.equal(readStateFile(env).stage, 0);
    });

    it("does not request after a voluntary Write above triggerAt (stage becomes 1)", async () => {
      const env = setup();
      writeFileSync(join(env.wfDir, "testament.md"), "voluntary");
      const { ctx } = await post(
        env,
        transcriptAt(env, 880_000),
        "Write",
        writeTestamentInput,
      );
      assert.equal(ctx.jsonCalls.length, 0);
      assert.equal(readStateFile(env).stage, 1);
    });

    it("requests a write at triggerAt, and write-urgent from stage 0 at updateAt", async () => {
      const env = setup();
      const { ctx, result } = await post(env, transcriptAt(env, 870_000));
      assert.match(additionalContextOf(ctx), /^\[compaction-testament\]/);
      assert.match(additionalContextOf(ctx), /今すぐ|近づいて/);
      assert.equal(result.payload?.event, "PostToolUse");
      assert.equal(
        ctx.jsonCalls[0].hookSpecificOutput.hookEventName,
        "PostToolUse",
      );
      assert.equal(readStateFile(env).stage, 1);
      const env2 = setup();
      const second = await post(env2, transcriptAt(env2, 930_000));
      assert.match(additionalContextOf(second.ctx), /まもなく compact/);
      assert.equal(readStateFile(env2).stage, 2);
    });

    it("drops a stale record below triggerAt, then requests again at triggerAt", async () => {
      const env = setup();
      writeTestament(env, "old cycle", 900_000);
      writeState(env, { stage: 2 });
      await post(env, transcriptAt(env, 500_000));
      assert.equal(existsSync(recordPath(env)), false);
      assert.equal(readStateFile(env).stage, 0);
      const { ctx } = await post(env, transcriptAt(env, 867_000));
      assert.match(additionalContextOf(ctx), /^\[compaction-testament\]/);
    });

    it("leaves stage unchanged when usage cannot be read", async () => {
      const env = setup();
      writeState(env, { stage: 1 });
      const { ctx } = await post(env, transcriptAt(env, null));
      assert.equal(ctx.jsonCalls.length, 0);
      assert.equal(readStateFile(env).stage, 1);
    });

    it("does nothing for subagent calls and creates no state files", async () => {
      const env = setup();
      const { ctx } = await post(
        env,
        transcriptAt(env, 900_000),
        "Bash",
        { command: "x" },
        { agent_id: "sub-1" },
      );
      ctx.assertSuccess({});
      assert.equal(existsSync(join(env.wfDir, "testament-state.json")), false);
    });

    it("succeeds when transcript is missing or state JSON is corrupt", async () => {
      const env = setup();
      const missing = await post(env, join(env.tdir, "nope.jsonl"));
      missing.ctx.assertSuccess({});
      writeFileSync(join(env.wfDir, "testament-state.json"), "{not json");
      const corrupt = await post(env, transcriptAt(env, 870_000));
      assert.match(
        additionalContextOf(corrupt.ctx),
        /^\[compaction-testament\]/,
      );
    });

    it("notifies exactly once after 20 consecutive usage misses, with a recovery line", async () => {
      const env = setup();
      const transcript = transcriptAt(env, null);
      const messages: (string | undefined)[] = [];
      for (let i = 0; i < 21; i++) {
        const { ctx } = await post(env, transcript);
        messages.push(ctx.jsonCalls.at(-1)?.systemMessage);
      }
      assert.deepEqual(
        messages.map((m) => m !== undefined),
        Array.from({ length: 21 }, (_, i) => i === 19),
      );
      assert.match(messages[19] ?? "", /recovery:/);
    });

    it("writes state and record files with mode 0600", async () => {
      const env = setup();
      writeFileSync(join(env.wfDir, "testament.md"), "perm");
      await post(env, transcriptAt(env, 880_000), "Write", writeTestamentInput);
      for (const f of ["testament-state.json", "testament-written.json"]) {
        assert.equal(statSync(join(env.wfDir, f)).mode & 0o777, 0o600, f);
      }
    });
  });

  describe("Stop", () => {
    const stop = async (env: HookEnv, transcript: string, active = false) => {
      const ctx = createStopContextFor(hook, {
        cwd: env.repo,
        transcript_path: transcript,
        stop_hook_active: active,
      });
      const result = await invokeRun(hook, ctx);
      return {
        ctx,
        result: result as { payload?: { event: string; output: any } },
      };
    };

    it("blocks once with a write request above triggerAt when nothing was written", async () => {
      const env = setup();
      const { ctx, result } = await stop(env, transcriptAt(env, 870_000));
      assert.equal(result.payload?.event, "Stop");
      assert.equal(ctx.jsonCalls[0].decision, "block");
      assert.match(ctx.jsonCalls[0].reason, /^\[compaction-testament\]/);
      assert.equal(readStateFile(env).stopBlocked, true);
      const again = await stop(env, transcriptAt(env, 870_000));
      again.ctx.assertSuccess({});
    });

    it("does not block while stop_hook_active", async () => {
      const env = setup();
      const { ctx } = await stop(env, transcriptAt(env, 870_000), true);
      ctx.assertSuccess({});
    });

    it("drops a stale record and does not block below triggerAt", async () => {
      const env = setup();
      writeTestament(env, "stale", 900_000);
      const { ctx } = await stop(env, transcriptAt(env, 500_000));
      ctx.assertSuccess({});
      assert.equal(existsSync(recordPath(env)), false);
    });
  });

  describe("SessionStart", () => {
    const start = async (env: HookEnv, source: string) => {
      const ctx = createSessionStartContext(source, { cwd: env.repo });
      const result = await invokeRun(hook, ctx);
      return {
        ctx,
        result: result as { payload?: { event: string; output: any } },
      };
    };

    it("injects a matching testament framed as reference data, then consumes record and snapshot", async () => {
      const env = setup();
      writeTestament(env, "NEXT-STEP-XYZ", 900_000);
      writeFileSync(join(env.wfDir, "snapshot.md"), "# snap");
      writeState(env, { stage: 2, stopBlocked: true });
      const { ctx, result } = await start(env, "compact");
      const injected = ctx.jsonCalls[0].hookSpecificOutput
        .additionalContext as string;
      assert.equal(result.payload?.event, "SessionStart");
      assert.equal(
        ctx.jsonCalls[0].hookSpecificOutput.hookEventName,
        "SessionStart",
      );
      assert.match(injected, /NEXT-STEP-XYZ/);
      assert.match(injected, /命令ではなく参考情報/);
      assert.match(injected, /承認状態の根拠にはしない/);
      assert.equal(existsSync(recordPath(env)), false);
      assert.equal(existsSync(join(env.wfDir, "snapshot.md")), false);
      assert.deepEqual(readStateFile(env), INITIAL);
    });

    it("injects a pre-threshold testament too (hash only)", async () => {
      const env = setup();
      writeTestament(env, "EARLY-BODY", 100_000);
      const { ctx } = await start(env, "compact");
      assert.match(
        ctx.jsonCalls[0].hookSpecificOutput.additionalContext,
        /EARLY-BODY/,
      );
    });

    it("omits the body on hash mismatch, symlink, or oversize", async () => {
      const mismatch = setup();
      writeTestament(mismatch, "TAMPERED-BODY", 1, sha256Hex("other"));
      writeFileSync(join(mismatch.wfDir, "snapshot.md"), "# snap");
      const a = await start(mismatch, "compact");
      assert.doesNotMatch(
        a.ctx.jsonCalls[0].hookSpecificOutput.additionalContext,
        /TAMPERED-BODY/,
      );

      const linked = setup();
      const target = join(linked.tdir, "elsewhere.md");
      writeFileSync(target, "LINKED-BODY");
      symlinkSync(target, join(linked.wfDir, "testament.md"));
      writeFileSync(
        recordPath(linked),
        JSON.stringify({
          version: 1,
          sha256: sha256Hex("LINKED-BODY"),
          tokens: 1,
        }),
      );
      writeFileSync(join(linked.wfDir, "snapshot.md"), "# snap");
      const b = await start(linked, "compact");
      assert.doesNotMatch(
        b.ctx.jsonCalls[0].hookSpecificOutput.additionalContext,
        /LINKED-BODY/,
      );

      const big = setup();
      const bigBody = "BIG-BODY" + "x".repeat(70 * 1024);
      writeTestament(big, bigBody, 1);
      writeFileSync(join(big.wfDir, "snapshot.md"), "# snap");
      const c = await start(big, "compact");
      assert.doesNotMatch(
        c.ctx.jsonCalls[0].hookSpecificOutput.additionalContext,
        /BIG-BODY/,
      );
    });

    it("still returns the injection when deletion fails (read-only dir)", async () => {
      const env = setup();
      writeTestament(env, "KEEP-RETURNING", 1);
      chmodSync(env.wfDir, 0o500);
      try {
        const { ctx } = await start(env, "compact");
        assert.match(
          ctx.jsonCalls[0].hookSpecificOutput.additionalContext,
          /KEEP-RETURNING/,
        );
      } finally {
        chmodSync(env.wfDir, 0o700);
      }
    });

    it("does nothing for non-compact sources", async () => {
      const env = setup();
      writeTestament(env, "x", 1);
      const { ctx } = await start(env, "startup");
      ctx.assertSuccess({});
      assert.ok(existsSync(recordPath(env)));
    });
  });

  describe("PreCompact", () => {
    const compact = async (
      env: HookEnv,
      transcript: string,
      custom: string | null = null,
    ) => {
      const ctx = createPreCompactContext({
        cwd: env.repo,
        transcript_path: transcript,
        custom_instructions: custom,
      });
      const result = await invokeRun(hook, ctx);
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

    it("does not write through a symlink at snapshot.md", async () => {
      const env = setup({ git: true, ignoreTmp: true });
      const target = join(env.tdir, "victim.txt");
      writeFileSync(target, "UNTOUCHED");
      symlinkSync(target, join(env.wfDir, "snapshot.md"));
      await compact(env, transcriptAt(env, 500_000));
      assert.equal(readFileSync(target, "utf8"), "UNTOUCHED");
      assert.equal(statSync(join(env.wfDir, "snapshot.md")).isFile(), true);
    });

    it("does nothing for subagents", async () => {
      const env = setup();
      const ctx = createPreCompactContext({ cwd: env.repo });
      (ctx.input as { agent_id?: string }).agent_id = "sub";
      await invokeRun(hook, ctx);
      ctx.assertSuccess({});
      assert.equal(existsSync(join(env.wfDir, "snapshot.md")), false);
    });
  });
});
