#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { localDate } from "../../lib/auto-mode-experiment.ts";
import { PARSER_GIVE_UP_REASON_TEXTS } from "../../lib/bash-parser.ts";
import {
  buildReport,
  collectCalls,
  inlineSafe,
  parseArgs,
  parseReplayOutput,
  replayOne,
  type ReplayedCall,
  renderUntrusted,
} from "../../../scripts/auto-mode-experiment-report.ts";

const line = (value: unknown): string => JSON.stringify(value);
const use = (id: string, name: string, input: unknown, timestamp: string) =>
  line({
    type: "assistant",
    timestamp,
    sessionId: "s1",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
const result = (
  id: string,
  permissionDecision: unknown,
  timestamp: string,
  content = "ok",
  is_error = false,
) =>
  line({
    type: "user",
    timestamp,
    sessionId: "s1",
    cwd: "/w",
    permissionDecision,
    message: {
      content: [{ type: "tool_result", tool_use_id: id, content, is_error }],
    },
  });

describe("collectCalls", () => {
  const lines = [
    line({ type: "permission-mode", permissionMode: "auto", sessionId: "s1" }),
    use("t1", "Bash", { command: "ls" }, "2026-10-11T00:00:00.000Z"),
    result(
      "t1",
      { decision: "accept", source: "config", reasonType: "classifier" },
      "2026-10-11T00:00:01.000Z",
    ),
    use(
      "t2",
      "Bash",
      { command: "git push --force" },
      "2026-10-11T00:00:02.000Z",
    ),
    result(
      "t2",
      { decision: "reject", source: "config", reasonType: "classifier" },
      "2026-10-11T00:00:03.000Z",
      "blocked: [Rule]",
      true,
    ),
    use("t3", "Read", { file_path: "/w/a" }, "2026-10-11T00:00:04.000Z"),
    result(
      "t3",
      { decision: "accept", source: "user_temporary" },
      "2026-10-11T00:00:05.000Z",
    ),
    use("t4", "Bash", { command: "pwd" }, "2026-10-11T00:00:06.000Z"),
    "{broken json",
    line({
      type: "user",
      timestamp: "2026-10-11T00:00:07.000Z",
      message: { content: "plain prompt" },
    }),
  ];
  const calls = collectCalls(lines, "/p/s1.jsonl");

  it("joins tool uses with their results and skips uses without a decision", () => {
    deepStrictEqual(
      calls.map((c) => c.id),
      ["t1", "t2", "t3"],
    );
    strictEqual(calls[0]?.cwd, "/w");
    strictEqual(calls[0]?.sessionMode, "auto");
    strictEqual(
      calls[0]?.sessionStartMs,
      new Date("2026-10-11T00:00:00.000Z").getTime(),
    );
    deepStrictEqual(calls[2]?.decision, {
      decision: "accept",
      source: "user_temporary",
    });
  });

  it("keeps the reason returned to the model and the next tool use for a reject", () => {
    strictEqual(calls[1]?.resultText, "blocked: [Rule]");
    deepStrictEqual(calls[1]?.next, {
      name: "Read",
      input: { file_path: "/w/a" },
    });
    strictEqual(calls[2]?.next, null);
  });

  it("reports an unknown mode when the transcript records none", () => {
    strictEqual(
      collectCalls(lines.slice(1), "/p/s1.jsonl")[0]?.sessionMode,
      "unknown",
    );
  });

  it("uses the mode in effect at the result line, not the last one in the file", () => {
    const switched = [
      line({
        type: "user",
        permissionMode: "default",
        timestamp: "2026-10-11T00:00:00.000Z",
        sessionId: "s1",
        message: { content: "hi" },
      }),
      use("a", "Bash", { command: "ls" }, "2026-10-11T00:00:01.000Z"),
      result(
        "a",
        { decision: "accept", source: "config", reasonType: "rule" },
        "2026-10-11T00:00:02.000Z",
      ),
      line({
        type: "permission-mode",
        permissionMode: "auto",
        sessionId: "s1",
      }),
      use("b", "Bash", { command: "ls" }, "2026-10-11T00:00:03.000Z"),
      result(
        "b",
        { decision: "accept", source: "config", reasonType: "classifier" },
        "2026-10-11T00:00:04.000Z",
      ),
    ];
    deepStrictEqual(
      collectCalls(switched, "/p/s1.jsonl").map((c) => c.sessionMode),
      ["default", "auto"],
    );
  });

  it("skips results whose decision or timestamp it cannot read, and entries with several tool results", () => {
    const odd = [
      use("a", "Bash", { command: "ls" }, "2026-10-11T00:00:01.000Z"),
      result("a", "accept", "2026-10-11T00:00:02.000Z"),
      use("b", "Bash", { command: "ls" }, "2026-10-11T00:00:03.000Z"),
      result(
        "b",
        { decision: "ask", source: "config" },
        "2026-10-11T00:00:04.000Z",
      ),
      use("c", "Bash", { command: "ls" }, "2026-10-11T00:00:05.000Z"),
      result(
        "c",
        { decision: "accept", source: 1 },
        "2026-10-11T00:00:06.000Z",
      ),
      use("d", "Bash", { command: "ls" }, "2026-10-11T00:00:07.000Z"),
      result("d", { decision: "accept", source: "config" }, "not a time"),
      use("e", "Bash", { command: "ls" }, "2026-10-11T00:00:08.000Z"),
      use("f", "Bash", { command: "ls" }, "2026-10-11T00:00:09.000Z"),
      line({
        type: "user",
        timestamp: "2026-10-11T00:00:10.000Z",
        sessionId: "s1",
        cwd: "/w",
        permissionDecision: { decision: "accept", source: "config" },
        message: {
          content: [
            { type: "tool_result", tool_use_id: "e", content: "x" },
            { type: "tool_result", tool_use_id: "f", content: "y" },
          ],
        },
      }),
      use("g", "Bash", { command: "ls" }, "2026-10-11T00:00:11.000Z"),
      line({
        type: "user",
        timestamp: "2026-10-11T00:00:12.000Z",
        permissionDecision: { decision: "accept", source: "config" },
        message: {
          content: [{ type: "tool_result", tool_use_id: "g", content: "z" }],
        },
      }),
    ];
    const read = collectCalls(odd, "/p/s1.jsonl");
    deepStrictEqual(
      read.map((c) => c.id),
      ["g"],
    );
    strictEqual(read[0]?.cwd, "");
    strictEqual(read[0]?.sessionId, "");
  });
});

describe("inlineSafe", () => {
  it("passes plain identifiers and replaces anything else", () => {
    for (const fine of [
      "Bash",
      "mcp__context7__query-docs",
      "classifier",
      "user_temporary",
    ])
      strictEqual(inlineSafe(fine), fine);
    for (const bad of [
      "a`b",
      "x\n# heading",
      "",
      "a b",
      "x".repeat(65),
      undefined,
      1,
    ])
      strictEqual(inlineSafe(bad), "(invalid)");
  });
});

describe("parseReplayOutput", () => {
  const out = (permissionDecision: string, permissionDecisionReason: string) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason,
      },
    });

  it("reads allow, ask and the four deny sources", () => {
    deepStrictEqual(parseReplayOutput(out("allow", "x"), 0, false), {
      kind: "allow",
    });
    deepStrictEqual(parseReplayOutput(out("ask", "x"), 0, false), {
      kind: "ask",
    });
    deepStrictEqual(
      parseReplayOutput(
        out(
          "deny",
          "Blocked by security rules (1 commands): Blocked recursive delete/move of the home directory or its direct children (x).",
        ),
        0,
        false,
      ),
      { kind: "deny", denySource: "home" },
    );
    // Built from the real texts: they end with a sentence a hand-written copy would miss.
    for (const text of PARSER_GIVE_UP_REASON_TEXTS) {
      deepStrictEqual(
        parseReplayOutput(
          out("deny", `Blocked by security rules (1 commands): ${text}`),
          0,
          false,
        ),
        { kind: "deny", denySource: "parser-give-up" },
      );
    }
    deepStrictEqual(
      parseReplayOutput(
        out(
          "deny",
          "Blocked by security rules (1 commands): Individual command blocked: rm x",
        ),
        0,
        false,
      ),
      { kind: "deny", denySource: "settings-deny" },
    );
    deepStrictEqual(
      parseReplayOutput(
        out(
          "deny",
          "Blocked by security rules (1 commands): Filesystem creation",
        ),
        0,
        false,
      ),
      { kind: "deny", denySource: "dangerous-table" },
    );
  });

  it("treats empty output with exit 0 as pass, never as allow", () => {
    deepStrictEqual(parseReplayOutput("", 0, false), { kind: "pass" });
    deepStrictEqual(parseReplayOutput("{}", 0, false), { kind: "pass" });
  });

  it("separates timeouts and crashes from pass", () => {
    deepStrictEqual(parseReplayOutput("", null, true), { kind: "timeout" });
    deepStrictEqual(parseReplayOutput("", 2, false), { kind: "error" });
    deepStrictEqual(parseReplayOutput("not json", 0, false), { kind: "error" });
  });
});

describe("renderUntrusted", () => {
  it("redacts before cutting, strips backticks, and fences the text", () => {
    const secret = `sk-ant-${"a".repeat(40)}`;
    const text = `${"x".repeat(100)} curl -H "Authorization: Bearer ${secret}" \`\`\` ${"y".repeat(300)}`;
    const rendered = renderUntrusted(text);
    strictEqual(rendered.includes(secret.slice(0, 20)), false);
    ok(rendered.startsWith("```\n") && rendered.endsWith("\n```"));
    strictEqual(rendered.slice(4, -4).includes("`"), false);
    ok(rendered.length < 300);
  });
});

describe("buildReport", () => {
  const base = {
    cwd: "/w",
    sessionId: "s1",
    sessionMode: "auto" as const,
    sessionStartMs: 0,
    timestampMs: 1,
    resultText: "",
    next: null,
    cwdMissing: false,
    held: false,
  };
  const replayed: ReplayedCall[] = [
    {
      ...base,
      id: "a",
      name: "Bash",
      input: { command: "mkfs /dev/sda1" },
      decision: {
        decision: "accept",
        source: "config",
        reasonType: "classifier",
      },
      verdict: { kind: "deny", denySource: "dangerous-table" },
    },
    {
      ...base,
      id: "b",
      name: "Bash",
      input: { command: "dd if=/dev/zero of=/dev/sda" },
      decision: {
        decision: "reject",
        source: "config",
        reasonType: "classifier",
      },
      verdict: { kind: "deny", denySource: "dangerous-table" },
      resultText: "blocked: [Irreversible Local Destruction]",
      next: { name: "Bash", input: { command: "ls" } },
    },
    {
      ...base,
      id: "c",
      name: "Bash",
      input: { command: "git push --force" },
      decision: { decision: "accept", source: "user_temporary" },
      verdict: { kind: "ask" },
    },
    {
      ...base,
      id: "d",
      name: "Read",
      input: { file_path: "/w/a" },
      decision: { decision: "accept", source: "config", reasonType: "rule" },
      verdict: { kind: "allow" },
      sessionMode: "default" as const,
    },
  ];
  const { markdown, summary } = buildReport(replayed, {
    generatedAt: "2026-10-12T03:00:00.000Z",
    sinceMs: 0,
    untilMs: 10,
    registration: { autoApprove: false, guard: true },
    autoModeHash: "abc123",
    classifierRejectCount: 1,
  });

  it("counts would-deny calls that were executed and that were blocked", () => {
    deepStrictEqual(summary, {
      generatedAt: "2026-10-12T03:00:00.000Z",
      reportDate: localDate(Date.parse("2026-10-12T03:00:00.000Z")),
      wouldDenyAccepted: 1,
      wouldDenyRejected: 1,
    });
  });

  it("never emits a transcript-derived string outside a fence or inlineSafe", () => {
    const hostile = "x`\n# injected heading";
    const call: ReplayedCall = {
      ...base,
      id: "z",
      name: hostile,
      input: { command: "ls" },
      cwd: hostile,
      sessionId: hostile,
      decision: { decision: "reject", source: hostile, reasonType: hostile },
      verdict: { kind: "allow" },
      resultText: hostile,
      next: { name: hostile, input: { x: hostile } },
      cwdMissing: true,
    };
    const { markdown: out } = buildReport([call], {
      generatedAt: "2026-10-12T03:00:00.000Z",
      sinceMs: 0,
      untilMs: 10,
      registration: { autoApprove: false, guard: true },
      autoModeHash: "x",
      classifierRejectCount: 0,
    });
    strictEqual(
      out.split("\n").some((l) => l.startsWith("# injected heading")),
      false,
    );
    // Outside the ``` fences, no backtick survives from the hostile fields.
    const outsideFences = out
      .split("```")
      .filter((_, i) => i % 2 === 0)
      .join("");
    strictEqual(outsideFences.includes("x`"), false);
    ok(out.includes("(invalid)"));
  });

  it("opens with the untrusted-data warning, the registration, the rollback step and the autoMode hash", () => {
    const head = markdown.split("\n").slice(0, 20).join("\n");
    ok(head.includes("untrusted"));
    ok(head.includes("home-destruction-guard: registered"));
    ok(head.includes("chezmoi apply"));
    ok(head.includes("abc123"));
  });

  it("has the five sections, split by auto and non-auto sessions", () => {
    for (const heading of [
      "## 1. Human confirmations",
      "## 2. Hook would deny or ask",
      "## 3. Hook would allow",
      "## 4. Decisions by source",
      "## 5. Rejects",
    ])
      ok(markdown.includes(heading), heading);
    ok(
      markdown.includes("### auto sessions") &&
        markdown.includes("### other sessions"),
    );
  });

  it("lists the reject with its reason and the model's next call", () => {
    const section = markdown.slice(markdown.indexOf("## 5. Rejects"));
    ok(section.includes("Irreversible Local Destruction"));
    ok(section.includes("next: Bash"));
  });

  it("says so when no classifier reject was recorded", () => {
    const empty = buildReport([], {
      generatedAt: "2026-10-12T03:00:00.000Z",
      sinceMs: 0,
      untilMs: 10,
      registration: { autoApprove: false, guard: true },
      autoModeHash: "x",
      classifierRejectCount: 0,
    });
    ok(
      empty.markdown.includes(
        "classifier rejects: 0 — this does not rule out that they are recorded in a form this script does not read",
      ),
    );
  });
});

describe("parseArgs", () => {
  it("reads --write and --since, and rejects anything else", () => {
    deepStrictEqual(parseArgs(["--write", "--since", "2026-10-10T00:00:00Z"]), {
      write: true,
      sinceMs: new Date("2026-10-10T00:00:00Z").getTime(),
    });
    deepStrictEqual(parseArgs([]), { write: false, sinceMs: null });
    for (const bad of [["--since"], ["--since", "soon"], ["--out", "/tmp/x"]])
      strictEqual(parseArgs(bad), null);
  });
});

describe("replayOne", () => {
  it("runs auto-approve.ts in isolation and leaves the real decisions log alone", async () => {
    const real = join(homedir(), ".claude", "logs", "decisions.jsonl");
    const before = existsSync(real) ? statSync(real) : null;
    const dir = mkdtempSync(join(tmpdir(), "replay-test-"));
    try {
      const outcome = await replayOne({
        id: "toolu_test",
        name: "Bash",
        input: { command: "ls" },
        cwd: dir,
        sessionId: "s1",
        transcriptPath: join(dir, "t.jsonl"),
      });
      ok(
        ["allow", "pass"].includes(outcome.verdict.kind),
        outcome.verdict.kind,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const after = existsSync(real) ? statSync(real) : null;
    strictEqual(after?.size, before?.size);
    strictEqual(after?.mtimeMs, before?.mtimeMs);
  });
});
