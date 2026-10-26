#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import hook from "../../implementations/english-reply-gate.ts";
import {
  countProse,
  findEnglishRequest,
  isEnglishProse,
  stripNonProse,
} from "../../lib/english-reply.ts";
import { createStopContextFor, invokeRun } from "../support/test-helpers.ts";

const hookEntry = join(
  import.meta.dirname,
  "..",
  "..",
  "implementations",
  "english-reply-gate.ts",
);

// Three paragraphs of review-result prose, about 300 Latin letters.
const ENGLISH_REPLY = [
  "All four reviewers finished the second round and none of them found a blocking problem in the plan.",
  "The scope reviewer confirmed that the change stays inside two new files and one settings entry, and the logic reviewer only asked for two minor clarifications.",
  "I applied both clarifications to the document, so the next step is to ask for approval before any implementation starts.",
].join("\n\n");

const REVIEWER_NAMES_JA = `レビュアーは ${[
  "logic-validator",
  "scope-justification-reviewer",
  "decision-quality-reviewer",
  "greenfield-perspective-reviewer",
  "architecture-boundary-analyzer",
  "data-contract-evolution-evaluator",
  "security-vulnerability-analyzer",
  "release-safety-evaluator",
  "test-quality-evaluator",
  "resilience-analyzer",
].join(" ")} の 10 名です。全員の判定が出ました。`;

const userLine = (content: unknown) =>
  JSON.stringify({ type: "user", message: { content } });
const queuedLine = (prompt: unknown) =>
  JSON.stringify({
    type: "attachment",
    attachment: { type: "queued_command", prompt },
  });
const toolResultLine = (text: string) =>
  userLine([{ type: "tool_result", tool_use_id: "t1", content: text }]);

describe("english-reply: isEnglishProse (accuracy)", () => {
  it("fixed English fixture has at least 200 Latin letters", () => {
    assert.ok(countProse(ENGLISH_REPLY).latin >= 200);
  });

  const notEnglish: Array<[string, string]> = [
    ["short status line", "Waiting for logic-validator."],
    [
      "short status with identifiers (L < 200)",
      "Round 2 of plan-2 now has three passes: scope, architecture, and data-contract. Waiting on logic-validator and security.",
    ],
    [
      "Japanese with many identifiers (ratio about 0.08, L >= 200)",
      REVIEWER_NAMES_JA,
    ],
    [
      "measured Japanese minimum (ratio 0.087)",
      "Round 2 は、pass 4 名（decision-quality、greenfield、scope、architecture）、needs-work 1 名（security）です。残りは logic-validator と data-contract の 2 名です。",
    ],
    [
      "Japanese plus fenced English code",
      `修正しました。\n確認してください。\n\`\`\`ts\n${"const value = computeSomething(argument);\n".repeat(50)}\`\`\`\n`,
    ],
    [
      "Japanese plus unclosed fence",
      `修正しました。\n確認してください。\n\`\`\`ts\n${"const value = computeSomething(argument);\n".repeat(50)}`,
    ],
    [
      "Japanese plus quoted English error",
      `エラーが出ました。\n${"> TypeError: cannot read properties of undefined while reading value\n".repeat(20)}`,
    ],
    ["empty string", ""],
    [
      "inline code",
      `次を使います。\`${"english words inside inline code ".repeat(4)}\``,
    ],
    [
      "URLs",
      "参考: https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa https://example.org/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb https://example.net/cccccccccccccccccccccccccccccccccccccccccc",
    ],
    [
      "paths",
      "変更: home/dot_claude/hooks/implementations/foo.ts home/dot_claude/hooks/implementations/bar.ts home/dot_claude/hooks/lib/baz.ts home/dot_claude/hooks/lib/qux.ts home/dot_claude/hooks/tests/unit/quux.test.ts",
    ],
    ["199 letters, no kana", "a".repeat(199)],
    [
      "11 kana + 209 letters (ratio exactly 0.05)",
      `${"あ".repeat(11)}${"a".repeat(209)}`,
    ],
  ];
  for (const [name, text] of notEnglish) {
    it(`is not English: ${name}`, () => {
      assert.equal(isEnglishProse(text), false);
    });
  }

  const english: Array<[string, string]> = [
    ["three English paragraphs", ENGLISH_REPLY],
    ["200 letters, no kana", "a".repeat(200)],
    [
      "10 kana + 240 letters (ratio 0.04)",
      `${"あ".repeat(10)}${"a".repeat(240)}`,
    ],
  ];
  for (const [name, text] of english) {
    it(`is English: ${name}`, () => {
      assert.equal(isEnglishProse(text), true);
    });
  }

  it("the Japanese-with-identifiers fixture sits between 0.05 and 0.1 with L >= 200", () => {
    const { kana, latin } = countProse(REVIEWER_NAMES_JA);
    assert.ok(latin >= 200, `latin=${latin}`);
    const ratio = kana / (kana + latin);
    assert.ok(ratio > 0.05 && ratio < 0.1, `ratio=${ratio}`);
  });

  it("stripNonProse removes code, URLs, quotes and path-like words", () => {
    const stripped = stripNonProse(
      "text\n```\ncode here\n```\n> quoted\nsee `inline` https://a.b/c and x/y.ts end",
    );
    for (const gone of ["code here", "quoted", "inline", "https", "x/y.ts"]) {
      assert.ok(!stripped.includes(gone), `${gone} remained in ${stripped}`);
    }
    assert.ok(stripped.includes("text"));
    assert.ok(stripped.includes("end"));
  });
});

describe("english-reply: findEnglishRequest (context)", () => {
  const lines = (...xs: string[]) => xs.join("\n");

  it("detects 'Please answer in English'", () => {
    assert.equal(
      findEnglishRequest(lines(userLine("Please answer in English"))),
      true,
    );
  });
  it("does not treat a complaint about English output as a request", () => {
    assert.equal(
      findEnglishRequest(
        lines(userLine("メッセージが英語になってしまうことがある")),
      ),
      false,
    );
  });
  it("looks back across turns", () => {
    assert.equal(
      findEnglishRequest(
        lines(userLine("以降は英語で答えて"), userLine("次は？")),
      ),
      true,
    );
  });
  it("a later request for Japanese cancels it", () => {
    assert.equal(
      findEnglishRequest(
        lines(userLine("英語で答えて"), userLine("日本語に戻して")),
      ),
      false,
    );
  });
  it("a later English request beats an earlier Japanese one", () => {
    assert.equal(
      findEnglishRequest(
        lines(userLine("日本語で答えて"), userLine("answer in English")),
      ),
      true,
    );
  });
  it("reads mid-turn queued_command prompts", () => {
    assert.equal(
      findEnglishRequest(
        lines(userLine("続けて"), queuedLine("explain this in English")),
      ),
      true,
    );
  });
  it("ignores an English input without a language instruction", () => {
    assert.equal(
      findEnglishRequest(
        lines(userLine("TypeError: Cannot read properties of undefined")),
      ),
      false,
    );
  });
  it("ignores tool_result lines", () => {
    assert.equal(
      findEnglishRequest(lines(toolResultLine("please reply in English"))),
      false,
    );
  });
  it("skips a queued_command without a string prompt", () => {
    assert.equal(
      findEnglishRequest(
        lines(
          userLine("answer in English"),
          JSON.stringify({
            type: "attachment",
            attachment: { type: "queued_command" },
          }),
        ),
      ),
      true,
    );
  });
  it("skips a truncated first line", () => {
    assert.equal(
      findEnglishRequest(
        lines(`ssage":{"content":"cut off`, userLine("answer in English")),
      ),
      true,
    );
  });
  it("returns false for empty input", () => {
    assert.equal(findEnglishRequest(""), false);
  });
});

describe("english-reply-gate hook (in process)", () => {
  it("blocks an English reply when the transcript path does not exist", async () => {
    const ctx = createStopContextFor(hook, {
      last_assistant_message: ENGLISH_REPLY,
      stop_hook_active: false,
      transcript_path: "/nonexistent/path/transcript.jsonl",
    });
    await invokeRun(hook, ctx);
    const out = ctx.jsonCalls.at(-1);
    assert.equal(out?.output?.decision ?? out?.decision, "block");
  });

  it("does not block when stop_hook_active is true", async () => {
    const ctx = createStopContextFor(hook, {
      last_assistant_message: ENGLISH_REPLY,
      stop_hook_active: true,
      transcript_path: "/nonexistent/path/transcript.jsonl",
    });
    await invokeRun(hook, ctx);
    assert.equal(ctx.jsonCalls.length, 0);
    assert.equal(ctx.successCalls.length, 1);
  });

  it("does not block a Japanese reply", async () => {
    const ctx = createStopContextFor(hook, {
      last_assistant_message: REVIEWER_NAMES_JA,
      stop_hook_active: false,
      transcript_path: "/nonexistent/path/transcript.jsonl",
    });
    await invokeRun(hook, ctx);
    assert.equal(ctx.jsonCalls.length, 0);
  });

  it("does not block when the user asked for English", async () => {
    const dir = realpathSync(
      mkdtempSync(join(tmpdir(), "english-reply-gate-")),
    );
    try {
      const transcript = join(dir, "t.jsonl");
      writeFileSync(transcript, `${userLine("Please answer in English")}\n`);
      const ctx = createStopContextFor(hook, {
        last_assistant_message: ENGLISH_REPLY,
        stop_hook_active: false,
        transcript_path: transcript,
      });
      await invokeRun(hook, ctx);
      assert.equal(ctx.jsonCalls.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not see an English request that lies before the 1 MiB window", async () => {
    const dir = realpathSync(
      mkdtempSync(join(tmpdir(), "english-reply-gate-")),
    );
    try {
      const transcript = join(dir, "t.jsonl");
      const filler = `${toolResultLine("x".repeat(1000))}\n`.repeat(1200);
      writeFileSync(
        transcript,
        `${userLine("Please answer in English")}\n${filler}`,
      );
      const ctx = createStopContextFor(hook, {
        last_assistant_message: ENGLISH_REPLY,
        stop_hook_active: false,
        transcript_path: transcript,
      });
      await invokeRun(hook, ctx);
      assert.equal(ctx.jsonCalls.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function runAsProcess(
  stdin: string,
  logsDir: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("bun", [hookEntry], {
      env: { ...process.env, CLAUDE_LOGS_DIR: logsDir },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout }));
    child.stdin.end(stdin);
  });
}

describe("english-reply-gate hook (as a process)", () => {
  it("blocks an English reply, tells the reason in Japanese, and logs the firing", async () => {
    const logsDir = realpathSync(
      mkdtempSync(join(tmpdir(), "english-reply-logs-")),
    );
    try {
      const { code, stdout } = await runAsProcess(
        JSON.stringify({
          hook_event_name: "Stop",
          session_id: "english-reply-gate-test",
          transcript_path: "/nonexistent/path/transcript.jsonl",
          cwd: logsDir,
          stop_hook_active: false,
          last_assistant_message: ENGLISH_REPLY,
        }),
        logsDir,
      );
      assert.equal(code, 0);
      assert.match(stdout, /"decision":\s*"block"/);
      assert.match(stdout, /直前の返答が英語でした/);
      const logFile = join(logsDir, "events.jsonl");
      assert.ok(existsSync(logFile));
      const logged = readFileSync(logFile, "utf-8");
      assert.match(logged, /english-reply-gate/);
      assert.match(logged, /english-reply-gate-test/);
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it("does not block on broken JSON input (cc-hooks-ts reports a non-blocking exit 1)", async () => {
    const logsDir = realpathSync(
      mkdtempSync(join(tmpdir(), "english-reply-logs-")),
    );
    try {
      const { code, stdout } = await runAsProcess("{not json", logsDir);
      assert.notEqual(code, 2);
      assert.doesNotMatch(stdout, /block/);
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});
