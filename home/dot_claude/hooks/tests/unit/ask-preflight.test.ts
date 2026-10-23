import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildNotificationMessage,
  DECISIONS_MAX_BYTES,
  formatDecisionRow,
  judgeAskPreflight,
  MAX_MATCHED_CHARS,
  NOTIFY_AT_BOUNCES,
  parseDecisionRows,
  PREFLIGHT_REASON,
  questionHash,
  summarizeDecisions,
  type DecisionRow,
  type PreflightFacts,
} from "../../lib/ask-preflight.ts";
import { buildApprovalQuestions } from "../../lib/workflow-approval.ts";

function ask(question: string, labels: string[] = ["A", "B"], extra = {}) {
  return {
    questions: [
      {
        header: "H",
        question,
        options: labels.map((label) => ({ label, description: "d" })),
        multiSelect: false,
      },
    ],
    ...extra,
  };
}

function facts(
  toolInput: unknown,
  overrides: Partial<PreflightFacts> = {},
): PreflightFacts {
  return {
    toolInput,
    hasAgentId: false,
    hasApprovalCandidates: false,
    hasSignFailureMarker: false,
    ...overrides,
  };
}

function judge(question: string, labels?: string[]) {
  return judgeAskPreflight(facts(ask(question, labels)));
}

const BOUNCE = { kind: "bounce-candidate" } as const;

describe("PREFLIGHT_REASON", () => {
  it("is the fixed text of spec K5, character for character", () => {
    assert.equal(
      PREFLIGHT_REASON,
      "AskUserQuestion を出す前に点検する。(1) この質問と同じ対象・同じ選択肢について、利用者のこれまでの発言か過去の AskUserQuestion への回答に、答えがはっきり書かれている（その後に事情が変わっていれば当たらない）。(2) ファイル、コード、文書を読めば決まる。(3) 規則か承認済みの計画が、すでに決めている手順である。(4) 自分の推奨を受けるかどうかだけを聞く確認で、争点がなく、作業ツリーの中で完結し、元に戻せる。どれかに当たれば聞かずに進め、当たった番号と根拠を 1 行で報告する。どれにも当たらなければ、同じ質問を AskUserQuestion でもう一度出す（次は通る）。文章で聞き直さない。次の質問は、当たっても聞く: 承認、元に戻せない操作、外部への送信・公開、設計判断（API・アーキテクチャ・データモデル）、スコープ、利用者の意図の解釈、規則が人間への確認を定めている質問（Scope Guard の戦略、reframer の後の進め方、委任、利用者の提案が問題に合わないときの判断）",
    );
  });
});

describe("judgeAskPreflight: what is bounced", () => {
  it("bounces an ordinary design question", () => {
    assert.deepEqual(judge("アプローチ A と B のどちらにしますか"), BOUNCE);
  });

  it("does not take rm or PR out of confirm / problem", () => {
    assert.deepEqual(judge("confirm した内容で進めますか"), BOUNCE);
    assert.deepEqual(judge("which problem first"), BOUNCE);
  });

  it("looks at labels but not at option descriptions", () => {
    const input = {
      questions: [
        {
          question: "アプローチ A と B のどちらにしますか",
          options: [{ label: "A", description: "push する" }, { label: "B" }],
        },
      ],
    };
    assert.deepEqual(judgeAskPreflight(facts(input)), BOUNCE);
  });

  it("does not look at the header", () => {
    const input = ask("どちらにしますか");
    (input.questions[0] as { header: string }).header = "push";
    assert.deepEqual(judgeAskPreflight(facts(input)), BOUNCE);
  });

  it("bounces delete_branch: an underscore joins the word (a limit, not a safe error)", () => {
    assert.deepEqual(judge("delete_branch を使う"), BOUNCE);
  });

  it("evaluates a text of exactly the length limit", () => {
    const question = "x".repeat(MAX_MATCHED_CHARS - 1);
    assert.deepEqual(judge(question, ["A"]), BOUNCE);
  });
});

describe("judgeAskPreflight: what passes", () => {
  it("passes a subagent question", () => {
    assert.deepEqual(
      judgeAskPreflight(facts(ask("どちらにしますか"), { hasAgentId: true })),
      { kind: "pass", reason: "subagent" },
    );
  });

  it("passes while a document waits for approval", () => {
    assert.deepEqual(
      judgeAskPreflight(
        facts(ask("どちらにしますか"), { hasApprovalCandidates: true }),
      ),
      { kind: "pass", reason: "approval-candidates" },
    );
  });

  it("passes an approval question built by ask-approval (header 承認)", () => {
    const questions = buildApprovalQuestions(
      [{ name: "spec.md", hash: "a".repeat(64), title: null }],
      { tree: null, id: null },
    );
    assert.deepEqual(judgeAskPreflight(facts({ questions })), {
      kind: "pass",
      reason: "approval-question",
    });
  });

  it("passes a paraphrased approval that offers the decline label", () => {
    assert.deepEqual(
      judge("この計画で進めてよいですか", ["spec.md", "承認しない"]),
      { kind: "pass", reason: "approval-question" },
    );
  });

  it("passes an input with answers or annotations already filled in", () => {
    for (const extra of [{ answers: { q: "A" } }, { annotations: {} }]) {
      assert.deepEqual(
        judgeAskPreflight(facts(ask("どちらにしますか", ["A", "B"], extra))),
        { kind: "pass", reason: "prefilled-answer" },
      );
    }
  });

  it("passes while a signing failure is being asked about", () => {
    assert.deepEqual(
      judgeAskPreflight(
        facts(ask("どちらにしますか"), { hasSignFailureMarker: true }),
      ),
      { kind: "pass", reason: "sign-failure" },
    );
  });

  it("passes questions that name an operation that cannot be undone", () => {
    const questions = [
      "main に push しますか",
      "PR を出しますか",
      "PRを出しますか",
      "PRs をまとめますか",
      "push済みのものは",
      "chezmoi apply してよいか",
      "試験用のログを消しますか",
      "埋め込み API に送ってよいか",
      "Should I proceed with deleting the old branch?",
      "pushed したので",
      "force-pushing しますか",
      "Applies the migration?",
      "Will it be merged?",
      "the branch was dropped",
      "restarting the bot",
      "overwrite the file?",
      "truncate the table?",
      "kill the process?",
      "revoke the token?",
      "uninstall it?",
      "git reset --hard?",
      "rm -rf しますか",
      "bot の再起動が要ります",
      "課金が発生します",
      "プリセットを選ぶ",
    ];
    for (const q of questions) {
      assert.deepEqual(
        judge(q, ["A"]),
        { kind: "pass", reason: "irreversible-word" },
        q,
      );
    }
  });

  it("passes when only an option label names the operation", () => {
    assert.deepEqual(judge("どちらにしますか", ["merge する", "しない"]), {
      kind: "pass",
      reason: "irreversible-word",
    });
  });

  it("passes without matching when the text is longer than the limit", () => {
    const question = "x".repeat(MAX_MATCHED_CHARS);
    assert.deepEqual(judge(question, ["A"]), {
      kind: "pass",
      reason: "too-long",
    });
  });

  it("passes when the input shape is not the expected one", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      "x",
      {},
      { questions: "x" },
      { questions: [null] },
      { questions: [1] },
    ];
    for (const input of inputs) {
      assert.deepEqual(
        judgeAskPreflight(facts(input)),
        { kind: "pass", reason: "judge-failed" },
        JSON.stringify(input),
      );
    }
  });

  it("passes on an exception while reading the input", () => {
    const hostile = {
      get questions(): unknown {
        throw new Error("boom");
      },
    };
    assert.deepEqual(judgeAskPreflight(facts(hostile)), {
      kind: "pass",
      reason: "judge-failed",
    });
  });
});

describe("questionHash", () => {
  it("is the same for the same question and salt, whatever the spacing", () => {
    const a = questionHash(ask("どれに  します\nか"), "salt1");
    const b = questionHash(ask("どれに します か"), "salt1");
    assert.equal(a, b);
    assert.match(a ?? "", /^[0-9a-f]{16}$/);
  });

  it("differs when the salt differs", () => {
    assert.notEqual(
      questionHash(ask("どれにしますか"), "salt1"),
      questionHash(ask("どれにしますか"), "salt2"),
    );
  });

  it("differs when the labels differ", () => {
    assert.notEqual(
      questionHash(ask("どれにしますか", ["A", "B"]), "s"),
      questionHash(ask("どれにしますか", ["A", "C"]), "s"),
    );
  });

  it("is null for an input it cannot read", () => {
    assert.equal(questionHash({}, "s"), null);
  });
});

function row(
  kind: DecisionRow["kind"],
  sessionId: string,
  hash?: string,
  reason?: string,
): DecisionRow {
  return {
    at: "2026-10-23T00:00:00.000Z",
    sessionId,
    kind,
    ...(reason === undefined ? {} : { reason }),
    ...(hash === undefined ? {} : { hash }),
  };
}

describe("decision rows", () => {
  it("round-trips through the file format, one JSON per line", () => {
    const rows = [
      row("bounce", "s1", "0123456789abcdef", "preflight"),
      row("pass", "s1", "0123456789abcdef", "irreversible-word"),
      row("prompt", "s1"),
    ];
    const text = rows.map(formatDecisionRow).join("");
    assert.equal(text.split("\n").length, rows.length + 1);
    assert.deepEqual(parseDecisionRows(text), rows);
  });

  it("holds no question text, only the kinds of fields it names", () => {
    const line = formatDecisionRow(
      row("bounce", "s1", "0123456789abcdef", "x"),
    );
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), [
      "at",
      "hash",
      "kind",
      "reason",
      "sessionId",
    ]);
  });

  it("skips unreadable lines: blank, cut off, wrong kind, wrong type", () => {
    const good = formatDecisionRow(row("prompt", "s1"));
    const text = [
      "",
      "{not json",
      JSON.stringify({ at: "t", sessionId: "s", kind: "other" }),
      JSON.stringify({ at: 1, sessionId: "s", kind: "prompt" }),
      JSON.stringify({ at: "t", kind: "prompt" }),
      JSON.stringify({ at: "t", sessionId: "s", kind: "prompt", hash: 5 }),
      "null",
      "[]",
      good.trimEnd(),
      '{"at":"t","sessionId":"s","kind":"prom',
    ].join("\n");
    assert.deepEqual(parseDecisionRows(text), [row("prompt", "s1")]);
  });

  it("has a size cap of 1 MB", () => {
    assert.equal(DECISIONS_MAX_BYTES, 1024 * 1024);
  });
});

/** 30 bounces; the first `returned` of them were asked again before the next prompt. */
function thirtyBounces(returned: number): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (let i = 0; i < NOTIFY_AT_BOUNCES; i++) {
    const hash = i.toString(16).padStart(16, "0");
    rows.push(row("bounce", "s1", hash, "preflight"));
    if (i < returned) rows.push(row("pass", "s1", hash, "already-bounced"));
    rows.push(row("prompt", "s1"));
  }
  return rows;
}

describe("summarizeDecisions", () => {
  it("counts the share of bounces that were not asked again (2 of 30)", () => {
    const summary = summarizeDecisions(thirtyBounces(28));
    assert.equal(summary.bounces, 30);
    assert.equal(summary.eligible, 30);
    assert.equal(summary.notReturned, 2);
    assert.equal(summary.rate?.toFixed(3), "0.067");
  });

  it("leaves a bounce with no later prompt out of the denominator", () => {
    const rows = [
      ...thirtyBounces(28),
      row("bounce", "s1", "ffffffffffffffff"),
    ];
    const summary = summarizeDecisions(rows);
    assert.equal(summary.bounces, 31);
    assert.equal(summary.eligible, 30);
  });

  it("does not count a pass with another hash as asking again", () => {
    const rows = [
      row("bounce", "s1", "aaaaaaaaaaaaaaaa"),
      row("pass", "s1", "bbbbbbbbbbbbbbbb"),
      row("prompt", "s1"),
    ];
    assert.equal(summarizeDecisions(rows).notReturned, 1);
  });

  it("does not count a pass after the next prompt as asking again", () => {
    const rows = [
      row("bounce", "s1", "aaaaaaaaaaaaaaaa"),
      row("prompt", "s1"),
      row("pass", "s1", "aaaaaaaaaaaaaaaa"),
    ];
    assert.equal(summarizeDecisions(rows).notReturned, 1);
  });

  it("judges each session on its own when rows are interleaved", () => {
    const rows = [
      row("bounce", "s1", "aaaaaaaaaaaaaaaa"),
      row("bounce", "s2", "bbbbbbbbbbbbbbbb"),
      row("pass", "s1", "aaaaaaaaaaaaaaaa"),
      row("prompt", "s2"),
      row("prompt", "s1"),
    ];
    const summary = summarizeDecisions(rows);
    assert.equal(summary.eligible, 2);
    assert.equal(summary.notReturned, 1);
    assert.equal(summary.rate, 0.5);
  });

  it("does not match a pass from another session with the same hash", () => {
    const rows = [
      row("bounce", "s1", "aaaaaaaaaaaaaaaa"),
      row("pass", "s2", "aaaaaaaaaaaaaaaa"),
      row("prompt", "s1"),
    ];
    assert.equal(summarizeDecisions(rows).notReturned, 1);
  });

  it("has a null rate when no bounce has a later prompt", () => {
    const summary = summarizeDecisions([row("bounce", "s1", "a".repeat(16))]);
    assert.equal(summary.rate, null);
  });

  it("counts the prompts after the most recent 30 bounces", () => {
    assert.equal(summarizeDecisions(thirtyBounces(28)).promptsSinceRecent, 30);
    const noPrompts = thirtyBounces(0).filter((r) => r.kind !== "prompt");
    assert.equal(summarizeDecisions(noPrompts).promptsSinceRecent, 0);
  });
});

describe("buildNotificationMessage", () => {
  it("below 10%: the rate and the steps to back out", () => {
    const text = buildNotificationMessage(
      summarizeDecisions(thirtyBounces(28)),
    );
    assert.match(text, /6\.7%/);
    assert.match(text, /2\/30/);
    assert.ok(text.includes("(4)"));
    assert.ok(text.includes("chezmoi apply"));
    assert.ok(text.includes("起動し直"));
    assert.ok(text.includes("decisions.jsonl"));
    assert.ok(text.includes("transcript の再計測"));
  });

  it("at 10% or more: the rate and the re-measurement note only", () => {
    const text = buildNotificationMessage(
      summarizeDecisions(thirtyBounces(15)),
    );
    assert.match(text, /50\.0%/);
    assert.ok(
      text.includes(
        "文章での質問と言い換えた出し直しは transcript の再計測で確かめる",
      ),
    );
    assert.ok(text.includes("decisions.jsonl"));
    assert.equal(text.includes("chezmoi apply"), false);
    assert.equal(text.includes("(4)"), false);
  });

  it("exactly 10% counts as 10% or more", () => {
    const text = buildNotificationMessage(
      summarizeDecisions(thirtyBounces(27)),
    );
    assert.match(text, /10\.0%/);
    assert.equal(text.includes("chezmoi apply"), false);
  });

  it("reports a missing UserPromptSubmit registration when no prompt row follows", () => {
    const noPrompts = thirtyBounces(0).filter((r) => r.kind !== "prompt");
    const text = buildNotificationMessage(summarizeDecisions(noPrompts));
    assert.ok(text.includes("UserPromptSubmit"));
    assert.equal(text.includes("%"), false);
  });

  it("never carries a string read from a row", () => {
    const marker = "INJECT-MARKER";
    const rows = thirtyBounces(28).map((r) => ({
      ...r,
      sessionId: marker,
      reason: marker,
      hash: r.hash === undefined ? undefined : "deadbeefdeadbeef",
    }));
    const text = buildNotificationMessage(summarizeDecisions(rows));
    assert.equal(text.includes(marker), false);
    assert.equal(text.includes("deadbeef"), false);
  });
});
