import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it, mock } from "node:test";
import {
  calques,
  check,
  lint,
  newFacts,
  outline,
  splitSentences,
  terms,
} from "../../../japanese-check/analyze.ts";
import type { OutlineEntry } from "../../../japanese-check/analyze.ts";
import { splitSentencesReference } from "../support/split-sentences-reference.ts";
import { main, parseArguments } from "../../../japanese-check/cli.ts";
import { parseMarker } from "../../../japanese-check/keep.ts";
import {
  keepComments,
  paragraphs,
  proseLines,
} from "../../../japanese-check/markdown.ts";
import {
  CHECKER_VERSION_FILES,
  checkerVersion,
  clearCheckerVersionCache,
  recordCheck,
  recordDecision,
  verify,
} from "../../../japanese-check/receipts.ts";
import type { Receipt } from "../../../japanese-check/receipts.ts";
import {
  HASHED_PROFILE_FIELDS,
  PROFILE_FIELDS,
  UNHASHED_PROFILE_FIELDS,
} from "../../../japanese-check/profiles.ts";
import {
  HASHED_WORD_FIELDS,
  WORD_LIST_SCHEMA,
  UNHASHED_WORD_FIELDS,
  WORD_FIELDS,
} from "../../../japanese-check/words.ts";
import type { DependencyEntry } from "../../../japanese-check/deps.ts";
import {
  atomicJson,
  defaultStateDir,
  digest,
  prepareState,
  StateDirError,
} from "../../../japanese-check/state.ts";
import type { StateOps } from "../../../japanese-check/state.ts";
import { tracked } from "../../../japanese-check/tracking.ts";
import {
  ANALYZER_IDENTITY,
  decodeTokens,
  dictionaryIdentity,
} from "../../../japanese-check/adapter-lindera-unidic.ts";
import {
  AnalyzerOutputError,
  isProperNoun,
  isVerb,
} from "../../../japanese-check/contract.ts";
import {
  createTestTokenizer,
  needsRuntime,
  runtimeEnv,
} from "../support/japanese-check-runtime.ts";
import {
  rawEntry,
  reviewFrom,
  shippedReview,
} from "../support/japanese-check-words.ts";

describe("Japanese prose extraction", () => {
  it("excludes frontmatter, fenced/indented code, comments, inline code and link destinations", () => {
    const input = [
      "---",
      "title: 入口",
      "---",
      "# API の入口",
      "",
      "````ts",
      "拾う",
      "```",
      "引く",
      "````",
      "",
      "    足す",
      "<!-- 通る",
      "効く -->",
      "[説明](https://example.com/拾う)",
      "`引く` 本文。",
      "![入口](image.png)",
      "[ref]: https://example.com/拾う",
    ].join("\n");
    const rows = proseLines(input);
    assert.deepEqual(
      rows.map((row) => row.line),
      [4, 15, 16],
    );
    assert.equal(rows[0]?.kind, "heading");
    assert.ok(
      !rows
        .map((row) => row.text)
        .join("\n")
        .includes("拾う"),
    );
    assert.ok(!rows.at(-1)?.text.includes("引く"));
  });

  it("masks a bare URL only up to its last ASCII character, keeping the prose after it", () => {
    const text =
      "詳しくは（https://example.com/usage）。以下は自分の実測値です。";
    const [row] = proseLines(text);
    assert.equal(row?.text.length, text.length);
    assert.ok(!row?.text.includes("example"));
    assert.ok(row?.text.endsWith("）。以下は自分の実測値です。"));
  });

  it("preserves UTF-16 offsets and physical line numbers around emoji and masks", () => {
    const text = "😀 `code` の実現。";
    const row = proseLines(text)[0];
    assert.ok(row);
    assert.equal(row.text.length, text.length);
    assert.equal(lint([row])[0]?.column, text.indexOf("の実現") + 1);
  });

  it("groups one-sentence-per-line prose but preserves heading, list, table and blank boundaries", () => {
    const rows = proseLines(
      "# 手順\n\n一文目。\n二文目。\n\n- 項目。\n| 用語 | 説明 |\n| --- | --- |\n",
    );
    assert.deepEqual(
      paragraphs(rows).map((block) => [block.line, block.endLine, block.kind]),
      [
        [1, 1, "heading"],
        [3, 4, "paragraph"],
        [6, 6, "list"],
        [7, 7, "table"],
      ],
    );
    assert.equal(outline(rows)[1]?.text, "一文目。");
  });
});

// Rows of the spec table. `sentences` is the expected split; the long inputs
// state only the count and the first and last sentence (timing is in tests/perf).
interface SentenceCase {
  input: string;
  sentences?: string[];
  count?: number;
  first?: string;
  last?: string;
}

const SENTENCE_CASES: SentenceCase[] = [
  { input: "一文目。", sentences: ["一文目。"] },
  { input: "一文目。二文目。", sentences: ["一文目。", "二文目。"] },
  { input: "A。B。C。", sentences: ["A。", "B。", "C。"] },
  { input: "記号の無い段落", sentences: ["記号の無い段落"] },
  { input: "A。B", sentences: ["A。", "B"] },
  { input: "一文目。\n二文目。", sentences: ["一文目。", "二文目。"] },
  { input: "本当？！そうだ。", sentences: ["本当？！", "そうだ。"] },
  {
    input: "彼は「はい。」と言った。",
    sentences: ["彼は「はい。」と言った。"],
  },
  { input: "A。「B。」C。", sentences: ["A。", "「B。」C。"] },
  { input: "「行く。」次の文。", sentences: ["「行く。」次の文。"] },
  { input: "「行く。」と言った。", sentences: ["「行く。」と言った。"] },
  {
    input: "「〜。」という指摘もある。",
    sentences: ["「〜。」という指摘もある。"],
  },
  { input: "「行く。」は誤りだ。", sentences: ["「行く。」は誤りだ。"] },
  {
    input: "「行く。」とても大事だ。",
    sentences: ["「行く。」とても大事だ。"],
  },
  { input: "「行く。」。", sentences: ["「行く。」。"] },
  { input: "（「はい。」）次の文。", sentences: ["（「はい。」）次の文。"] },
  {
    input: "一文目。\n「引用。」と書いた。",
    sentences: ["一文目。", "「引用。」と書いた。"],
  },
  { input: "A。 B。", sentences: ["A。", "B。"] },
  { input: "「A。）B。", sentences: ["「A。）B。"] },
  { input: "『A。』B。", sentences: ["『A。』B。"] },
  { input: "」A。", sentences: ["」A。"] },
  { input: "！？", sentences: ["！？"] },
  { input: "A．B．", sentences: ["A．B．"] },
  { input: "　　", sentences: [] },
  { input: " \n 　", sentences: [] },
  { input: "（注。）本文。", sentences: ["（注。）本文。"] },
  {
    input: "彼は（「はい。」と）言った。",
    sentences: ["彼は（「はい。」と）言った。"],
  },
  { input: "A。」」B。", sentences: ["A。」」", "B。"] },
  { input: "「閉じない。次。", sentences: ["「閉じない。次。"] },
  // Half-width parentheses are not counted: an intended limit (spec K8).
  { input: "English (note!) here.", sentences: ["English (note!", ") here."] },
  { input: "A。」！」。B。", sentences: ["A。」！」。", "B。"] },
  { input: "A。 」B。", sentences: ["A。", "」B。"] },
  { input: "」".repeat(100_000), count: 1, first: "」".repeat(100_000) },
  { input: "「".repeat(100_000), count: 1, first: "「".repeat(100_000) },
  {
    input: `。${"」".repeat(100_000)}`,
    count: 1,
    first: `。${"」".repeat(100_000)}`,
  },
  { input: "。".repeat(100_000), count: 1, first: "。".repeat(100_000) },
  { input: "A。".repeat(50_000), count: 50_000, first: "A。", last: "A。" },
  {
    input: "「B。」".repeat(30_000),
    count: 1,
    first: "「B。」".repeat(30_000),
  },
  {
    input: "A「B。」".repeat(30_000),
    count: 1,
    first: "A「B。」".repeat(30_000),
  },
];

function sentenceShape(item: SentenceCase) {
  if (item.sentences) {
    return {
      count: item.sentences.length,
      first: item.sentences[0],
      last: item.sentences.at(-1),
    };
  }
  return {
    count: item.count,
    first: item.first,
    last: item.last ?? item.first,
  };
}

function stripSpaces(text: string): string {
  return [...text].filter((char) => char.trim() !== "").join("");
}

describe("splitSentences", () => {
  it("splits every row of the spec table as specified", () => {
    for (const item of SENTENCE_CASES) {
      const result = splitSentences(item.input);
      const shape = sentenceShape(item);
      const label = JSON.stringify(item.input.slice(0, 40));
      if (item.sentences) {
        assert.deepEqual(result, item.sentences, label);
      } else {
        assert.equal(result.length, shape.count, label);
        assert.equal(result[0], shape.first, label);
        assert.equal(result.at(-1), shape.last, label);
      }
    }
  });

  it("agrees with the naive reference on every string of up to 5 characters", () => {
    const alphabet = [
      "A",
      "。",
      "！",
      "？",
      "「",
      "」",
      "『",
      "』",
      "（",
      "）",
      "\n",
      " ",
      "　",
    ];
    let checked = 0;
    const visit = (prefix: string, remaining: number) => {
      const actual = splitSentences(prefix);
      assert.deepEqual(
        actual,
        splitSentencesReference(prefix),
        JSON.stringify(prefix),
      );
      assert.equal(stripSpaces(actual.join("")), stripSpaces(prefix));
      for (const sentence of actual) {
        assert.ok(sentence !== "" && sentence === sentence.trim());
      }
      checked += 1;
      if (remaining === 0) return;
      for (const char of alphabet) visit(prefix + char, remaining - 1);
    };
    visit("", 5);
    assert.equal(checked, 402_234);
  });
});

describe("outline paragraph entries", () => {
  const markdown =
    "# 手順\n\n一文目。\n二文目。\n\n- 項目。\n| 用語 | 説明 |\n| --- | --- |\n";

  function paragraphEntries(entries: OutlineEntry[]) {
    return entries.flatMap((entry) =>
      entry.kind === "paragraph" ? [entry] : [],
    );
  }

  it("adds last and sentences to paragraphs and leaves other entries as they were", () => {
    const entries = outline(proseLines(markdown));
    assert.deepEqual(entries[1], {
      line: 3,
      kind: "paragraph",
      text: "一文目。",
      last: "二文目。",
      sentences: 2,
    });
    for (const entry of entries.filter((item) => item.kind !== "paragraph")) {
      assert.deepEqual(Object.keys(entry), ["line", "kind", "text"]);
    }
    assert.equal(entries.length, 4);
  });

  it("keeps the long-sentence findings of the previous implementation", () => {
    // Measured on the implementation at the base commit before this change:
    // a 110-character sentence at line 1 and the same one at line 4.
    const sentence = `${"あ".repeat(55)}、${"い".repeat(53)}。`;
    const rows = proseLines(`${sentence}\n\n短い。\n${sentence}\n`);
    assert.deepEqual(
      lint(rows, "tech")
        .filter((item) => item.rule === "long-sentence")
        .map((item) => [item.line, item.column]),
      [
        [1, 1],
        [4, 1],
      ],
    );
  });

  it("gives every row of the spec table its text, last and sentences", () => {
    const cases = SENTENCE_CASES.filter(
      (item) => !item.sentences || item.sentences.length > 0,
    );
    const entries = paragraphEntries(
      outline(proseLines(cases.map((item) => item.input).join("\n\n"))),
    );
    assert.equal(entries.length, cases.length);
    cases.forEach((item, index) => {
      const entry = entries[index];
      assert.ok(entry);
      const shape = sentenceShape(item);
      const label = JSON.stringify(item.input.slice(0, 40));
      assert.deepEqual(
        Object.keys(entry),
        ["line", "kind", "text", "last", "sentences"],
        label,
      );
      assert.equal(entry.sentences, shape.count, label);
      assert.equal(entry.text, shape.first, label);
      assert.equal(entry.last, shape.count === 1 ? null : shape.last, label);
      if (entry.sentences === 0) {
        assert.equal(entry.text, "");
        assert.equal(entry.last, null);
      }
      if (entry.sentences === 1) assert.equal(entry.last, null);
      if (entry.sentences >= 2) assert.notEqual(entry.last, null);
      if (entry.sentences >= 1) assert.notEqual(entry.text, "");
    });
  });

  it("reports a blank paragraph as zero sentences and serializes last as null", () => {
    const [entry] = outline([{ line: 1, text: " ", kind: "paragraph" }]);
    assert.ok(entry && entry.kind === "paragraph");
    assert.equal(entry.sentences, 0);
    assert.equal(entry.text, "");
    assert.equal(entry.last, null);
    assert.match(JSON.stringify(entry), /"last":null/u);
    assert.deepEqual(splitSentences(" \n　"), []);
  });

  it("takes text and last from the paragraph body, including multi-line paragraphs", () => {
    const rows = proseLines(
      "一文目。\n二文目。\n三文目。\n\n「引用。」と書いた。次。\n",
    );
    const bodies = paragraphs(rows);
    for (const entry of paragraphEntries(outline(rows))) {
      const body = bodies.find((block) => block.line === entry.line);
      assert.ok(body);
      assert.ok(body.text.includes(entry.text));
      if (entry.last !== null) assert.ok(body.text.includes(entry.last));
    }
  });
});

describe("outline CLI process", () => {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-check-outline-")),
  );
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("prints last and sentences for paragraphs and leaves the input file alone", () => {
    const home = join(dir, "home");
    mkdirSync(home);
    const file = join(dir, "doc.md");
    const content = "一文目。二文目。\n\n「行く。」次の文。\n";
    writeFileSync(file, content);
    const cli = fileURLToPath(
      new URL("../../../japanese-check/cli.ts", import.meta.url),
    );
    const result = spawnSync(process.execPath, [cli, "outline", file], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    const entries: unknown = JSON.parse(result.stdout);
    assert.deepEqual(entries, [
      {
        line: 1,
        kind: "paragraph",
        text: "一文目。",
        last: "二文目。",
        sentences: 2,
      },
      {
        line: 3,
        kind: "paragraph",
        text: "「行く。」次の文。",
        last: null,
        sentences: 1,
      },
    ]);
    assert.equal(readFileSync(file, "utf8"), content);
  });
});

describe("Japanese review rules", () => {
  it("reports review reasons without rewriting uncertainty or natural literal expressions", () => {
    const text = "改善の実現は可能かもしれない。\nボタンを押す。\n薬が効く。";
    const findings = lint(proseLines(text));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, "nominalized-action");
    assert.ok(findings[0]?.reason.includes("原文"));
  });

  it("uses genre only for review thresholds", () => {
    const rows = proseLines(`${"あ".repeat(90)}。`);
    assert.ok(
      lint(rows, "business").some((item) => item.rule === "long-sentence"),
    );
    assert.ok(
      !lint(rows, "essay").some((item) => item.rule === "long-sentence"),
    );
  });
});

const TEST_ANALYZER = {
  engine: "lindera-unidic",
  version: "6.2.0",
  dictionary: "d".repeat(64),
};

describe("lindera-backed Japanese review", () => {
  const tokenizer = createTestTokenizer();

  it(
    "preserves original spelling and positions with ASCII case, width and emoji",
    needsRuntime,
    async () => {
      const tokenize = await tokenizer;
      for (const text of [
        "japanese-check を使う。",
        "ＡＰＩで確認する。",
        "😀 api-check を拾った。",
        "ｷﾀ━(ﾟ∀ﾟ)━! 机がｶﾞｸｶﾞｸする。",
      ]) {
        const tokens = tokenize(text);
        // The analyzer drops white space, so compare without it.
        assert.equal(
          tokens.map((token) => token.surface).join(""),
          text.replace(/\s/gu, ""),
        );
        for (const token of tokens) {
          assert.equal(text.slice(token.start, token.end), token.surface);
        }
      }
    },
  );

  it(
    "uses actual morphological POS and normalized forms for inflected verbs",
    needsRuntime,
    async () => {
      const tokenize = await tokenizer;
      const tokens = tokenize("データを拾った。");
      assert.ok(
        tokens.some(
          (token) =>
            token.surface === "拾っ" &&
            token.lemma === "拾う" &&
            isVerb(token) &&
            token.conjugation?.kind === "godan" &&
            token.conjugation.row === "wa",
        ),
      );
      const findings = calques(
        proseLines("# API の入口\nデータを拾った。\n`拾った`"),
        tokenize,
        shippedReview(["calque"]),
      );
      assert.ok(
        findings.some((item) => item.text === "入口" && item.line === 1),
      );
      assert.ok(
        findings.some((item) => item.text === "拾っ" && item.line === 2),
      );
      assert.ok(findings.every((item) => item.line !== 3));
    },
  );

  it(
    "maps 京都 to a proper noun and keeps 何 out of a term",
    needsRuntime,
    async () => {
      const tokenize = await tokenizer;
      assert.ok(
        tokenize("京都に行く。").some(
          (token) => token.surface === "京都" && isProperNoun(token),
        ),
      );
      assert.deepEqual(
        terms(proseLines("Docker何かを使う。"), tokenize).map((t) => t.term),
        ["Docker"],
      );
    },
  );

  it(
    "finds inflected 効く even when the dictionary normalizes its spelling",
    needsRuntime,
    async () => {
      const findings = calques(
        proseLines("薬が効いた。"),
        await tokenizer,
        shippedReview(["calque"]),
      );
      assert.ok(findings.some((item) => item.text === "効い"));
    },
  );

  it(
    "identifies first use while leaving explanation correctness to the reader",
    needsRuntime,
    async () => {
      const found = terms(
        proseLines(
          "API（外部から使う窓口）を呼ぶ。\nAPI を使う。\nキャッシュを消す。",
        ),
        await tokenizer,
      );
      assert.equal(found.filter((term) => term.term === "API").length, 1);
      assert.equal(
        found.find((term) => term.term === "API")?.explanationNearby,
        true,
      );
      assert.equal(
        found.find((term) => term.term === "キャッシュ")?.explanationNearby,
        false,
      );
    },
  );

  it(
    "detects changed counts and proper nouns, ignores moved text and code",
    needsRuntime,
    async () => {
      const tokenize = await tokenizer;
      const source = proseLines(
        "大阪でAPIを使う。\n利用者は３人。\n\n既存の説明。\n",
      );
      const final = proseLines(
        "既存の説明。\n\n大阪でAPIを使う。\n利用者は9人。\n京都も対象。\n`NewCode 999人`\n",
      );
      const found = newFacts(source, final, tokenize);
      assert.ok(found.some((fact) => fact.value === "9人"));
      assert.ok(
        found.some((fact) => fact.value === "京都" && fact.kind === "name"),
      );
      assert.ok(
        !found.some((fact) => /API|大阪|999|NewCode/u.test(fact.value)),
      );
      assert.deepEqual(
        newFacts(
          source,
          proseLines("利用者は3人。\n大阪でAPIを使う。"),
          tokenize,
        ),
        [],
      );
    },
  );

  it(
    "check() carries the same outline as outline() and keeps schemaVersion 1",
    needsRuntime,
    async () => {
      const markdown = "# 手順\n\n一文目。\n二文目。\n\n「行く。」次の文。\n";
      const result = check(
        markdown,
        await tokenizer,
        shippedReview(["calque"]),
        TEST_ANALYZER,
      );
      assert.deepEqual(result.outline, outline(proseLines(markdown)));
      assert.equal(result.schemaVersion, 1);
    },
  );

  it(
    "does not claim that unchanged words prove unchanged meaning",
    needsRuntime,
    async () => {
      const result = check(
        "次回までに合意した。",
        await tokenizer,
        shippedReview(["calque"]),
        TEST_ANALYZER,
        "business",
        "次回までに検討する。",
      );
      assert.deepEqual(result.newFacts, []);
      assert.ok(result.limitations.some((text) => text.includes("確度")));
      assert.deepEqual(result.analyzer, TEST_ANALYZER);
    },
  );
});

describe("Japanese checker CLI", () => {
  // 追跡は realpath で記録するので、macOS の /var → /private/var をここで揃える。
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "japanese-check-")));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects missing input, unknown arguments and ambiguous source options", () => {
    for (const args of [
      [],
      ["check"],
      ["check", "a.md", "--genre", "unknown"],
      ["check", "a.md", "--source"],
      ["newfacts", "a.md"],
      ["check", "a.md", "--source", "a.md"],
      ["outline", "a.md", "--source", "b.md"],
      ["check", "a.md", "--source", "b.md", "--source", "c.md"],
      ["lint", "a.md", "--artifact", "a.pdf"],
      ["check", "a.md", "--session", "session", "--no-record"],
      ["review", "a.md", "--hash", "invalid", "--reason", "理由"],
      ["review", "a.md", "--hash", "0".repeat(64)],
    ]) {
      assert.throws(() => parseArguments(args));
    }
  });

  it("emits valid JSON and leaves the original input unchanged", async () => {
    const file = join(dir, "draft.md");
    const text = "# 手順\n\n確認する。\n操作する。\n";
    writeFileSync(file, text);
    const output = mock.method(console, "log", () => {});
    try {
      await main(["outline", file]);
      const json: unknown = JSON.parse(
        String(output.mock.calls[0]?.arguments[0]),
      );
      assert.ok(Array.isArray(json));
      assert.equal(readFileSync(file, "utf8"), text);
    } finally {
      output.mock.restore();
    }
    await assert.rejects(main(["check", join(dir, "missing.md")]));
  });

  it(
    "supports an unrecorded check and requires explicit review of actual findings",
    needsRuntime,
    async () => {
      const file = join(dir, "candidate.md");
      const content = "データを拾った。\n";
      const stateDir = join(dir, "candidate-state");
      writeFileSync(file, content);
      const output = mock.method(console, "log", () => {});
      try {
        await main(["check", file, "--no-record"], { stateDir });
        assert.equal(verify(file, stateDir).status, "missing");
        await main(["check", file], { stateDir });
        assert.equal(verify(file, stateDir).status, "needs-review");
        await main(
          [
            "review",
            file,
            "--hash",
            digest(content),
            "--reason",
            "処理名として資料に定義されているため残す",
          ],
          { stateDir },
        );
        assert.equal(verify(file, stateDir).status, "ready");
      } finally {
        output.mock.restore();
      }
    },
  );

  it(
    "tracks the final artifact instead of the extracted text",
    needsRuntime,
    async () => {
      const file = join(dir, "extracted.md");
      const artifact = join(dir, "document.pdf");
      const stateDir = join(dir, "artifact-state");
      writeFileSync(file, "文書を確認する。\n");
      writeFileSync(artifact, "artifact-v1");
      const output = mock.method(console, "log", () => {});
      try {
        await main(
          [
            "check",
            file,
            "--artifact",
            artifact,
            "--session",
            "artifact-session",
          ],
          { stateDir },
        );
        assert.deepEqual(tracked("artifact-session", stateDir).paths, [
          artifact,
        ]);
        assert.equal(verify(artifact, stateDir).status, "ready");
        writeFileSync(artifact, "artifact-v2");
        assert.equal(verify(artifact, stateDir).status, "stale");
      } finally {
        output.mock.restore();
      }
    },
  );

  it("rejects malformed analyzer output instead of silently skipping analysis", () => {
    assert.throws(() => decodeTokens({}, "本文"), AnalyzerOutputError);
    assert.throws(
      () => decodeTokens([{ surface: "本文" }], "本文"),
      AnalyzerOutputError,
    );
    // A byte offset inside a character is not a position in the text.
    assert.throws(
      () =>
        decodeTokens(
          [{ surface: "本", byteStart: 1, byteEnd: 3, details: [] }],
          "本文",
        ),
      AnalyzerOutputError,
    );
  });

  it("drops a token of no length", () => {
    const tokens = decodeTokens(
      [
        { surface: "", byteStart: 0, byteEnd: 0, details: [] },
        { surface: "本文", byteStart: 0, byteEnd: 6, details: [] },
      ],
      "本文",
    );
    assert.deepEqual(
      tokens.map(({ surface, start, end }) => [surface, start, end]),
      [["本文", 0, 2]],
    );
  });

  it("converts byte offsets to UTF-16 offsets for tokens that split one grapheme", () => {
    const tokens = decodeTokens(
      [
        { surface: "⚠", byteStart: 0, byteEnd: 3, details: [] },
        { surface: "\uFE0F", byteStart: 3, byteEnd: 6, details: [] },
        { surface: "注意", byteStart: 6, byteEnd: 12, details: [] },
      ],
      "⚠️注意",
    );
    assert.deepEqual(
      tokens.map(({ surface, start, end }) => [surface, start, end]),
      [
        ["⚠", 0, 1],
        ["\uFE0F", 1, 2],
        ["注意", 2, 4],
      ],
    );
  });

  it("converts byte offsets for a surrogate pair and a half-width semi-voiced mark", () => {
    const pair = decodeTokens(
      [
        { surface: "𠮷", byteStart: 0, byteEnd: 4, details: [] },
        { surface: "野", byteStart: 4, byteEnd: 7, details: [] },
      ],
      "𠮷野",
    );
    assert.deepEqual(
      pair.map(({ surface, start, end }) => [surface, start, end]),
      [
        ["𠮷", 0, 2],
        ["野", 2, 3],
      ],
    );
    const face = decodeTokens(
      [
        { surface: "(", byteStart: 0, byteEnd: 1, details: [] },
        { surface: "ﾟ", byteStart: 1, byteEnd: 4, details: [] },
        { surface: "д", byteStart: 4, byteEnd: 6, details: [] },
        { surface: "ﾟ", byteStart: 6, byteEnd: 9, details: [] },
        { surface: ")", byteStart: 9, byteEnd: 10, details: [] },
      ],
      "(ﾟдﾟ)",
    );
    assert.deepEqual(
      face.map(({ surface, start, end }) => [surface, start, end]),
      [
        ["(", 0, 1],
        ["ﾟ", 1, 2],
        ["д", 2, 3],
        ["ﾟ", 3, 4],
        [")", 4, 5],
      ],
    );
  });

  it(
    "names the analyzer, its resolved version and the derived dictionary identity in the output",
    needsRuntime,
    async () => {
      const file = join(dir, "analyzer-field.md");
      writeFileSync(file, "薬が効いた。\n");
      const output = mock.method(console, "log", () => {});
      try {
        await main(["check", file, "--no-record"], {
          stateDir: join(dir, "state-analyzer-field"),
        });
        const data: unknown = JSON.parse(
          String(output.mock.calls[0]?.arguments[0]),
        );
        assert.ok(data && typeof data === "object" && "analyzer" in data);
        assert.deepEqual(data.analyzer, {
          engine: ANALYZER_IDENTITY.engine,
          version: "6.2.0",
          dictionary: dictionaryIdentity(),
        });
      } finally {
        output.mock.restore();
      }
    },
  );

  it(
    "rejects aliases of the same source and emits a combined report with a real source",
    needsRuntime,
    async () => {
      const source = join(dir, "source.md");
      const alias = join(dir, "alias.md");
      const final = join(dir, "final.md");
      writeFileSync(source, "利用者は3人。\n");
      linkSync(source, alias);
      await assert.rejects(
        main(["check", alias, "--source", source]),
        /同じ実体/u,
      );
      writeFileSync(final, "利用者は9人。\n");
      const output = mock.method(console, "log", () => {});
      try {
        await main(["check", final, "--source", source], {
          stateDir: join(dir, "state"),
        });
        const data: unknown = JSON.parse(
          String(output.mock.calls[0]?.arguments[0]),
        );
        assert.ok(data && typeof data === "object" && "newFacts" in data);
        assert.ok(
          Array.isArray(data.newFacts) &&
            data.newFacts.some(
              (fact: unknown) =>
                typeof fact === "object" &&
                fact !== null &&
                "value" in fact &&
                fact.value === "9人",
            ),
        );
      } finally {
        output.mock.restore();
      }
    },
  );
});

describe("japanese-check module boundaries", () => {
  const dir = fileURLToPath(
    new URL("../../../japanese-check/", import.meta.url),
  );
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));

  function specifiers(source: string): string[] {
    const found: string[] = [];
    const pattern =
      /(?:\bimport|\bexport)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
    for (const match of source.matchAll(pattern))
      found.push(match[1] ?? match[2] ?? "");
    return found;
  }

  // adapter-lindera-unidic.ts loads the analyzer package by the resolved file path that
  // deps.ts found, so no file names the package in an import.
  it("imports only node: built-ins and sibling files", () => {
    assert.ok(files.length > 0);
    for (const name of files) {
      for (const specifier of specifiers(readFileSync(join(dir, name), "utf8")))
        assert.match(
          specifier,
          /^(?:node:|\.\/[^/]+\.ts$)/u,
          `${name}: ${specifier}`,
        );
    }
  });

  it("keeps receipts.ts and tracking.ts independent of each other", () => {
    const of = (name: string) =>
      specifiers(readFileSync(join(dir, name), "utf8"));
    assert.ok(!of("receipts.ts").includes("./tracking.ts"));
    assert.ok(!of("tracking.ts").includes("./receipts.ts"));
  });
});

describe("japanese-check state directory", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-check-state-")),
  );
  after(() => rmSync(root, { recursive: true, force: true }));
  let number = 0;
  const own = process.getuid?.();
  function fresh(): string {
    const dir = join(root, `case-${++number}`);
    mkdirSync(dir);
    return dir;
  }
  const real: StateOps = {
    lstat: (path) => lstatSync(path),
    chmod: (path, mode) => chmodSync(path, mode),
    uid: own,
  };
  function kindOf(action: () => void): string {
    try {
      action();
    } catch (error) {
      if (error instanceof StateDirError) return error.kind;
      throw error;
    }
    return "none";
  }
  function mode(path: string): number {
    return lstatSync(path).mode & 0o777;
  }

  it("creates a missing directory as 0700 and writes receipts as 0600", () => {
    const stateDir = join(fresh(), "state");
    const file = join(root, "doc.md");
    writeFileSync(file, "文書です。\n");
    recordCheck({
      file,
      expectedHash: digest("文書です。\n"),
      body: "文書です。\n",
      candidates: 0,
      stateDir,
    });
    assert.equal(mode(stateDir), 0o700);
    assert.equal(mode(join(stateDir, "receipts")), 0o700);
    const [name] = readdirSync(join(stateDir, "receipts"));
    assert.equal(mode(join(stateDir, "receipts", name ?? "")), 0o600);
  });

  it("tightens an own directory with mode 0755", () => {
    const stateDir = join(fresh(), "state");
    mkdirSync(stateDir);
    chmodSync(stateDir, 0o755);
    prepareState(stateDir);
    assert.equal(mode(stateDir), 0o700);
  });

  it("rejects a symlink, a regular file and a foreign owner", () => {
    const dir = fresh();
    const target = join(dir, "target");
    mkdirSync(target);
    symlinkSync(target, join(dir, "link"));
    assert.equal(
      kindOf(() => prepareState(join(dir, "link"))),
      "symlink",
    );
    writeFileSync(join(dir, "plain"), "x");
    assert.equal(
      kindOf(() => prepareState(join(dir, "plain"))),
      "not-directory",
    );
    assert.equal(
      kindOf(() => prepareState(target, { ...real, uid: (own ?? 0) + 1 })),
      "owner",
    );
  });

  it("reports io when chmod fails or the directory changes after chmod", () => {
    const stateDir = join(fresh(), "state");
    mkdirSync(stateDir);
    chmodSync(stateDir, 0o755);
    const denied = Object.assign(new Error("denied"), { code: "EPERM" });
    assert.equal(
      kindOf(() =>
        prepareState(stateDir, {
          ...real,
          chmod: () => {
            throw denied;
          },
        }),
      ),
      "io",
    );
    const swapped = (second: () => ReturnType<StateOps["lstat"]>): StateOps => {
      let calls = 0;
      return {
        ...real,
        lstat: (path) => (++calls === 2 ? second() : lstatSync(path)),
      };
    };
    chmodSync(stateDir, 0o755);
    assert.equal(
      kindOf(() =>
        prepareState(
          stateDir,
          swapped(() => ({
            isSymbolicLink: () => true,
            isDirectory: () => false,
            uid: own ?? 0,
            mode: 0o700,
          })),
        ),
      ),
      "symlink",
    );
    chmodSync(stateDir, 0o755);
    assert.equal(
      kindOf(() =>
        prepareState(
          stateDir,
          swapped(() => {
            throw Object.assign(new Error("gone"), { code: "ENOENT" });
          }),
        ),
      ),
      "io",
    );
  });

  it("leaves no temporary file when rename fails and never reuses an existing one", () => {
    const dir = fresh();
    mkdirSync(join(dir, "target"));
    assert.throws(() => atomicJson(join(dir, "target"), { a: 1 }));
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      [],
    );
    writeFileSync(join(dir, "fixed.json.tmp"), "kept");
    assert.throws(
      () => atomicJson(join(dir, "fixed.json"), { a: 1 }, (p) => `${p}.tmp`),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST",
    );
    assert.equal(readFileSync(join(dir, "fixed.json.tmp"), "utf8"), "kept");
  });

  it("derives the default directory from HOME, not from the cwd", () => {
    const home = process.env.HOME;
    const cwd = process.cwd();
    process.env.HOME = "/x/h";
    try {
      const results: string[] = [];
      for (const dir of [fresh(), fresh()]) {
        process.chdir(dir);
        results.push(defaultStateDir());
      }
      assert.deepEqual(results, [
        "/x/h/.claude/state/japanese-check",
        "/x/h/.claude/state/japanese-check",
      ]);
    } finally {
      process.chdir(cwd);
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });

  it("exits with 2 from the CLI when the default directory is a symlink", () => {
    const home = fresh();
    const target = join(home, "elsewhere");
    mkdirSync(target);
    mkdirSync(join(home, ".claude", "state"), { recursive: true });
    symlinkSync(target, join(home, ".claude", "state", "japanese-check"));
    const file = join(home, "doc.md");
    writeFileSync(file, "文書です。\n");
    const cli = fileURLToPath(
      new URL("../../../japanese-check/cli.ts", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [cli, "track", file, "--session", "s"],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /置き場を使えない（symlink）/u);
  });
});

describe("check --profile", () => {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-check-profile-")),
  );
  after(() => rmSync(dir, { recursive: true, force: true }));
  let number = 0;
  // 110 characters: over the tech limit (100) and the business limit (80), under
  // the essay limit (120).
  const longSentence = `${"あ".repeat(109)}。\n`;

  function fresh(content: string) {
    const key = ++number;
    const file = join(dir, `doc-${key}.md`);
    writeFileSync(file, content);
    return { file, stateDir: join(dir, `state-${key}`), content };
  }
  async function run(
    args: string[],
    stateDir: string,
  ): Promise<Record<string, unknown>> {
    const output = mock.method(console, "log", () => {});
    try {
      await main(args, { stateDir });
      return JSON.parse(String(output.mock.calls[0]?.arguments[0]));
    } finally {
      output.mock.restore();
    }
  }
  const flagged = (report: Record<string, unknown>) =>
    Array.isArray(report.findings) &&
    report.findings.some(
      (item: { rule?: string }) => item.rule === "long-sentence",
    );

  it(
    "leaves the output without --profile exactly as it was",
    needsRuntime,
    async () => {
      const doc = fresh(longSentence);
      const report = await run(
        ["check", doc.file, "--no-record"],
        doc.stateDir,
      );
      assert.ok(!("profile" in report));
      assert.ok(flagged(report));
    },
  );

  it("uses the row's genre and reports the profile", needsRuntime, async () => {
    const doc = fresh(longSentence);
    const report = await run(
      ["check", doc.file, "--profile", "design", "--no-record"],
      doc.stateDir,
    );
    assert.deepEqual(report.profile, { id: "design" });
    assert.ok(flagged(report));
    const withReader = await run(
      [
        "check",
        doc.file,
        "--profile",
        "design",
        "--reader",
        "adhd",
        "--no-record",
      ],
      doc.stateDir,
    );
    assert.deepEqual(withReader.profile, { id: "design", reader: "adhd" });
  });

  it("takes --genre only when the row has no genre", needsRuntime, async () => {
    const doc = fresh(longSentence);
    const caller = await run(
      [
        "check",
        doc.file,
        "--profile",
        "caller",
        "--genre",
        "essay",
        "--no-record",
      ],
      doc.stateDir,
    );
    assert.ok(!flagged(caller));
    const design = await run(
      [
        "check",
        doc.file,
        "--profile",
        "design",
        "--genre",
        "essay",
        "--no-record",
      ],
      doc.stateDir,
    );
    assert.ok(flagged(design));
  });

  it("exits with an error for unusable combinations", async () => {
    const doc = fresh("文書です。\n");
    for (const args of [
      ["check", doc.file, "--reader", "adhd"],
      ["check", doc.file, "--profile", "design", "--reader", "x"],
      ["lint", doc.file, "--profile", "design"],
      ["check", doc.file, "--profile", "design", "--profile", "book"],
    ]) {
      assert.throws(() => parseArguments(args), args.join(" "));
    }
    await assert.rejects(
      main(["check", doc.file, "--profile", "nope"], {
        stateDir: doc.stateDir,
      }),
    );
  });
});

describe("receipt profile fields", () => {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-check-receipt-profile-")),
  );
  after(() => rmSync(dir, { recursive: true, force: true }));
  let number = 0;
  const content = "データを拾った。\n";

  function fresh() {
    const key = ++number;
    const file = join(dir, `doc-${key}.md`);
    writeFileSync(file, content);
    return { file, stateDir: join(dir, `state-${key}`) };
  }
  async function check(
    doc: { file: string; stateDir: string },
    ...extra: string[]
  ) {
    const output = mock.method(console, "log", () => {});
    try {
      await main(["check", doc.file, ...extra], { stateDir: doc.stateDir });
    } finally {
      output.mock.restore();
    }
    return verify(doc.file, doc.stateDir);
  }
  function decide(
    doc: { file: string; stateDir: string },
    command: "review" | "defer",
  ) {
    return recordDecision(
      doc.file,
      digest(content),
      "理由",
      command === "review" ? "checked" : "draft",
      doc.stateDir,
    );
  }
  const rawReceipt = (doc: { stateDir: string }) => {
    const folder = join(doc.stateDir, "receipts");
    const [name] = readdirSync(folder);
    return JSON.parse(readFileSync(join(folder, name ?? ""), "utf8"));
  };

  it(
    "writes the three fields only for a --profile check, never null",
    needsRuntime,
    async () => {
      const withProfile = fresh();
      const result = await check(
        withProfile,
        "--profile",
        "design",
        "--reader",
        "adhd",
      );
      assert.equal(result.receipt?.profileId, "design");
      assert.equal(result.receipt?.reader, "adhd");
      assert.match(result.receipt?.profileHash ?? "", /^[0-9a-f]{64}$/u);
      const plain = fresh();
      await check(plain);
      const raw = rawReceipt(plain);
      for (const key of ["profileId", "reader", "profileHash"])
        assert.ok(!(key in raw), key);
    },
  );

  it(
    "keeps the fields on a review and drops them on a deferral",
    needsRuntime,
    async () => {
      const reviewed = fresh();
      await check(reviewed, "--profile", "design");
      const afterReview = decide(reviewed, "review");
      assert.equal(afterReview.receipt?.profileId, "design");
      assert.ok(afterReview.receipt?.profileHash);
      const deferred = fresh();
      await check(deferred, "--profile", "design");
      const afterDefer = decide(deferred, "defer");
      const raw = rawReceipt(deferred);
      assert.equal(afterDefer.status, "draft");
      for (const key of ["profileId", "reader", "profileHash"])
        assert.ok(!(key in raw), key);
    },
  );

  it(
    "carries a review over only to a check with the same profile",
    needsRuntime,
    async () => {
      const doc = fresh();
      await check(doc);
      decide(doc, "review");
      assert.equal(verify(doc.file, doc.stateDir).status, "ready");
      assert.equal(
        (await check(doc, "--profile", "design")).status,
        "needs-review",
      );
      decide(doc, "review");
      assert.equal((await check(doc, "--profile", "design")).status, "ready");
      assert.equal((await check(doc)).status, "needs-review");
    },
  );

  it(
    "does not carry a review to another row that resolves to the same list and genre",
    needsRuntime,
    async () => {
      const doc = fresh();
      await check(doc, "--profile", "compose-default", "--genre", "business");
      decide(doc, "review");
      const same = await check(
        doc,
        "--profile",
        "compose-default",
        "--genre",
        "business",
      );
      assert.equal(same.status, "ready");
      const other = await check(doc, "--profile", "report");
      assert.equal(other.status, "needs-review");
      assert.equal(
        other.receipt?.profileHash,
        same.receipt?.profileHash,
        "the lists are identical, so only the row id tells them apart",
      );
    },
  );

  it(
    "treats malformed profile fields as a broken receipt and null as absent",
    needsRuntime,
    async () => {
      const hash = "a".repeat(64);
      const cases: Array<[Record<string, unknown>, boolean]> = [
        [{ profileId: "design", profileHash: 5 }, true],
        [{ profileId: "Bad Id", profileHash: hash }, true],
        [{ reader: "adhd" }, true],
        [{ profileId: "design" }, true],
        [{ profileHash: hash }, true],
        [{ profileId: "design", profileHash: hash, reader: "other" }, true],
        [{ profileId: null, reader: null, profileHash: null }, false],
        [{ profileId: "design", profileHash: hash, reader: "adhd" }, false],
      ];
      for (const [fields, broken] of cases) {
        const doc = fresh();
        await check(doc);
        const folder = join(doc.stateDir, "receipts");
        const [name] = readdirSync(folder);
        const path = join(folder, name ?? "");
        writeFileSync(
          path,
          JSON.stringify({
            ...JSON.parse(readFileSync(path, "utf8")),
            ...fields,
          }),
        );
        const result = verify(doc.file, doc.stateDir);
        assert.equal(result.corrupt === true, broken, JSON.stringify(fields));
      }
    },
  );

  it(
    "reads a receipt of the older shape that has none of the fields",
    needsRuntime,
    async () => {
      const doc = fresh();
      await check(doc);
      const receipt: Receipt = rawReceipt(doc);
      assert.equal(receipt.schema, 1);
      assert.equal(verify(doc.file, doc.stateDir).receipt?.schema, 1);
    },
  );
});

describe("checker version", () => {
  const checkerSource = fileURLToPath(
    new URL("../../../japanese-check/", import.meta.url),
  );
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-check-version-")),
  );
  after(() => rmSync(root, { recursive: true, force: true }));
  let number = 0;

  function copy() {
    const dir = join(root, `case-${++number}`, "japanese-check");
    cpSync(checkerSource, dir, { recursive: true });
    clearCheckerVersionCache();
    return dir;
  }
  // The analyzer package lives in a runtime directory next to the checker copy.
  function runtimeOf(dir: string) {
    const runtime = join(dirname(dir), "runtime");
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    return runtime;
  }
  function fakeLindera(runtime: string, version = "9.9.9") {
    const pkg = join(runtime, "node_modules", "lindera");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "lindera", version, main: "index.js" }),
    );
    writeFileSync(join(pkg, "index.js"), "module.exports = {};\n");
  }
  const LINDERA: DependencyEntry[] = [{ name: "lindera", group: "analyzer" }];
  const hashOf = (
    dir: string,
    deps: readonly DependencyEntry[] = [],
    runtimeDir: string = join(dirname(dir), "runtime"),
  ) => {
    clearCheckerVersionCache();
    return checkerVersion({ dir, deps, runtimeDir });
  };
  const rewriteJson = (
    path: string,
    change: (value: Record<string, unknown>) => void,
  ) => {
    const value = JSON.parse(readFileSync(path, "utf8"));
    change(value);
    writeFileSync(path, JSON.stringify(value));
  };

  it("lists every non-test .ts file of the directory and the two data files", () => {
    const names = readdirSync(checkerSource).filter((n) => n.endsWith(".ts"));
    for (const name of names)
      assert.ok(CHECKER_VERSION_FILES.includes(name), name);
    assert.ok(CHECKER_VERSION_FILES.includes("data/words.json"));
    assert.ok(CHECKER_VERSION_FILES.includes("data/profiles.json"));
  });

  it("ignores fields that do not shape the result and follows those that do", () => {
    const dir = copy();
    const base = hashOf(dir).hash;
    const words = join(dir, "data", "words.json");
    const profiles = join(dir, "data", "profiles.json");
    rewriteJson(words, (v) => {
      const entries = v.entries as Array<Record<string, unknown>>;
      entries[0] = { ...entries[0], examples: ["別の例"], origin: "別の出自" };
    });
    rewriteJson(profiles, (v) => {
      const rows = v.rows as Array<Record<string, unknown>>;
      rows[0] = { ...rows[0], label: "別の見出し", signals: ["別の手がかり"] };
    });
    assert.equal(hashOf(dir).hash, base);
    rewriteJson(words, (v) => {
      const entries = v.entries as Array<Record<string, unknown>>;
      entries[0] = { ...entries[0], pattern: "(?:別の)" };
    });
    const afterPattern = hashOf(dir).hash;
    assert.notEqual(afterPattern, base);
    rewriteJson(profiles, (v) => {
      const rows = v.rows as Array<Record<string, unknown>>;
      rows[0] = { ...rows[0], structure: "book" };
    });
    assert.notEqual(hashOf(dir).hash, afterPattern);
  });

  it("falls back to the raw bytes of a data file that is not valid JSON", () => {
    const dir = copy();
    const base = hashOf(dir);
    writeFileSync(join(dir, "data", "profiles.json"), "{ broken");
    const broken = hashOf(dir);
    assert.deepEqual(broken.missing, []);
    assert.notEqual(broken.hash, base.hash);
  });

  it("names missing parts without throwing and gives the same hash every time", () => {
    const dir = copy();
    rmSync(join(dir, "tracking.ts"));
    rmSync(join(dir, "data", "words.json"));
    const first = hashOf(dir);
    assert.deepEqual([...first.missing].sort(), [
      "data/words.json",
      "tracking.ts",
    ]);
    assert.equal(hashOf(dir).hash, first.hash);
  });

  it("treats an unreadable part and an oversized part as missing", () => {
    const dir = copy();
    const denied = checkerVersion({
      dir,
      deps: [],
      read: (path) =>
        path.endsWith("state.ts")
          ? { ok: false, reason: "error" }
          : { ok: true, bytes: Buffer.from("x") },
    });
    assert.deepEqual(denied.missing, ["state.ts"]);
    writeFileSync(join(dir, "analyze.ts"), "a".repeat(1024 * 1024 + 1));
    assert.deepEqual(hashOf(dir).missing, ["analyze.ts"]);
  });

  it("includes the dependency version and reports a missing dependency", () => {
    const dir = copy();
    const without = hashOf(dir, LINDERA);
    assert.deepEqual(without.missing, ["lindera"]);
    fakeLindera(runtimeOf(dir));
    const withPackage = hashOf(dir, LINDERA);
    assert.deepEqual(withPackage.missing, []);
    assert.notEqual(withPackage.hash, without.hash);
  });

  it("changes with the version of lindera, and two runtime directories do not share a cache entry", () => {
    const dir = copy();
    const runtimeA = join(dirname(dir), "runtime-a");
    const runtimeB = join(dirname(dir), "runtime-b");
    for (const runtime of [runtimeA, runtimeB])
      mkdirSync(runtime, { recursive: true, mode: 0o700 });
    fakeLindera(runtimeA, "1.0.0");
    fakeLindera(runtimeB, "2.0.0");
    clearCheckerVersionCache();
    // No clearing between the two calls: the cache key must tell them apart.
    const a = checkerVersion({ dir, deps: LINDERA, runtimeDir: runtimeA });
    const b = checkerVersion({ dir, deps: LINDERA, runtimeDir: runtimeB });
    assert.notEqual(a.hash, b.hash);
    assert.deepEqual([a.missing, b.missing], [[], []]);
  });

  it("changes with the dictionary identity constant and with the word list schema alone", () => {
    const dir = copy();
    fakeLindera(runtimeOf(dir));
    const base = hashOf(dir, LINDERA).hash;
    const adapter = join(dir, "adapter-lindera-unidic.ts");
    const source = readFileSync(adapter, "utf8");
    const first = /"unk\.bin":\s*"([0-9a-f])/u.exec(source);
    assert.ok(first);
    writeFileSync(
      adapter,
      source.replace(
        /("unk\.bin":\s*")[0-9a-f]/u,
        `$1${first[1] === "0" ? "1" : "0"}`,
      ),
    );
    assert.notEqual(hashOf(dir, LINDERA).hash, base);
    writeFileSync(adapter, source);
    assert.equal(hashOf(dir, LINDERA).hash, base);
    rewriteJson(join(dir, "data", "words.json"), (v) => {
      v.schema = 99;
    });
    assert.notEqual(hashOf(dir, LINDERA).hash, base);
  });

  it("looks for the analyzer only in the runtime directory", () => {
    const dir = copy();
    fakeLindera(dir);
    fakeLindera(dirname(dir));
    const result = hashOf(dir, LINDERA);
    assert.deepEqual(result.missing, ["lindera"]);
  });

  it("treats a runtime directory that others can write to as missing the analyzer", () => {
    const dir = copy();
    const runtime = runtimeOf(dir);
    fakeLindera(runtime);
    assert.deepEqual(hashOf(dir, LINDERA).missing, []);
    chmodSync(runtime, 0o775);
    assert.deepEqual(hashOf(dir, LINDERA).missing, ["lindera"]);
  });

  it("reports a runtime directory owned by someone else as a missing analyzer without throwing", () => {
    const dir = copy();
    // /usr belongs to root and is not writable by others, so only the owner check refuses it.
    const result = hashOf(dir, LINDERA, "/usr");
    assert.deepEqual(result.missing, ["lindera"]);
  });

  it("hashes its own directory by default, wherever the copy sits", () => {
    const dir = copy();
    const runtime = runtimeOf(dir);
    fakeLindera(runtime);
    const script = join(dir, "..", "print-version.mjs");
    writeFileSync(
      script,
      `import { checkerVersion } from ${JSON.stringify(join(dir, "receipts.ts"))};\nconsole.log(JSON.stringify(checkerVersion()));\n`,
    );
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      cwd: tmpdir(),
      env: { ...process.env, JAPANESE_CHECK_RUNTIME_DIR: runtime },
    });
    assert.equal(result.status, 0, result.stderr);
    const printed = JSON.parse(result.stdout) as { hash: string };
    assert.equal(printed.hash, hashOf(dir, LINDERA, runtime).hash);
  });

  it("splits the validated fields into hashed and unhashed ones exactly", () => {
    assert.deepEqual(
      [...HASHED_WORD_FIELDS, ...UNHASHED_WORD_FIELDS].sort(),
      [...WORD_FIELDS].sort(),
    );
    assert.deepEqual(
      [...HASHED_PROFILE_FIELDS, ...UNHASHED_PROFILE_FIELDS].sort(),
      [...PROFILE_FIELDS].sort(),
    );
    // Fields that matching and resolveModules read are all hashed.
    for (const field of [
      "word",
      "kind",
      "action",
      "match",
      "pattern",
      "lemmas",
      "pos",
      "allow",
      "fix",
    ])
      assert.ok(
        (HASHED_WORD_FIELDS as readonly string[]).includes(field),
        field,
      );
    for (const field of ["id", "structure", "action", "genre", "stockBoundary"])
      assert.ok(
        (HASHED_PROFILE_FIELDS as readonly string[]).includes(field),
        field,
      );
  });
});

describe("receipts with a checker that is missing a part", () => {
  const checkerSource = fileURLToPath(
    new URL("../../../japanese-check/", import.meta.url),
  );
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-check-incomplete-")),
  );
  after(() => rmSync(root, { recursive: true, force: true }));
  let number = 0;

  // One analyzer package is present; the grammar one never is.
  const deps: DependencyEntry[] = [
    { name: "lindera", group: "analyzer" },
    { name: "absent-grammar", group: "grammar" },
  ];
  const completeDeps: DependencyEntry[] = [deps[0] as DependencyEntry];

  function fixture(content = "データを拾った。\n") {
    const key = ++number;
    const dir = join(root, `case-${key}`, "japanese-check");
    cpSync(checkerSource, dir, { recursive: true });
    const runtimeDir = join(root, `case-${key}`, "runtime");
    const pkg = join(runtimeDir, "node_modules", "lindera");
    mkdirSync(pkg, { recursive: true });
    chmodSync(runtimeDir, 0o700);
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "lindera", version: "9.9.9", main: "index.js" }),
    );
    writeFileSync(join(pkg, "index.js"), "module.exports = {};\n");
    const file = join(root, `doc-${key}.md`);
    writeFileSync(file, content);
    clearCheckerVersionCache();
    return {
      dir,
      runtimeDir,
      file,
      content,
      stateDir: join(root, `state-${key}`),
    };
  }
  const record = (
    f: ReturnType<typeof fixture>,
    options: { candidates: number; deps: DependencyEntry[] },
  ) =>
    recordCheck({
      file: f.file,
      expectedHash: digest(f.content),
      body: f.content,
      candidates: options.candidates,
      stateDir: f.stateDir,
      dir: f.dir,
      runtimeDir: f.runtimeDir,
      deps: options.deps,
    });

  it("marks a ready document as incomplete when a dependency group is absent", () => {
    const f = fixture();
    const result = record(f, { candidates: 0, deps });
    assert.equal(result.status, "ready");
    assert.equal(result.checkerIncomplete, true);
    assert.deepEqual(result.checkerMissing, ["absent-grammar"]);
    const whole = verify(f.file, f.stateDir, {
      dir: f.dir,
      runtimeDir: f.runtimeDir,
      deps: completeDeps,
    });
    assert.equal(whole.status, "stale");
    assert.equal(whole.checkerIncomplete, undefined);
  });

  it("turns a deferral made without the parts into stale once they are back", () => {
    const f = fixture();
    record(f, { candidates: 1, deps });
    recordDecision(f.file, digest(f.content), "草稿", "draft", f.stateDir, {
      dir: f.dir,
      runtimeDir: f.runtimeDir,
      deps,
    });
    assert.equal(
      verify(f.file, f.stateDir, {
        dir: f.dir,
        runtimeDir: f.runtimeDir,
        deps: completeDeps,
      }).status,
      "stale",
    );
  });

  it("does not carry a review recorded under an incomplete checker", () => {
    const f = fixture();
    record(f, { candidates: 1, deps });
    const reviewed = recordDecision(
      f.file,
      digest(f.content),
      "残す",
      "checked",
      f.stateDir,
      { dir: f.dir, runtimeDir: f.runtimeDir, deps },
    );
    assert.equal(reviewed.status, "ready");
    assert.equal(record(f, { candidates: 1, deps }).status, "needs-review");
  });

  it("carries a review only while the number of candidates stays the same", () => {
    const f = fixture();
    record(f, { candidates: 1, deps: completeDeps });
    recordDecision(f.file, digest(f.content), "残す", "checked", f.stateDir, {
      dir: f.dir,
      runtimeDir: f.runtimeDir,
      deps: completeDeps,
    });
    assert.equal(
      record(f, { candidates: 1, deps: completeDeps }).status,
      "ready",
    );
    assert.equal(
      record(f, { candidates: 2, deps: completeDeps }).status,
      "needs-review",
    );
  });
});

describe("japanese-check import closure", () => {
  const dir = fileURLToPath(
    new URL("../../../japanese-check/", import.meta.url),
  );
  const staticImport =
    /(?:\bimport|\bexport)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gu;
  const forbidden = new Set(["analyze.ts", "cli.ts"]);

  function closure(roots: string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const name = queue.pop() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      const source = readFileSync(join(dir, name), "utf8");
      for (const match of source.matchAll(staticImport)) {
        const specifier = match[1] ?? "";
        // A type-only import is erased and loads nothing.
        if (/^\s*import\s+type\b/u.test(match[0])) continue;
        if (specifier.startsWith("./")) queue.push(specifier.slice(2));
        else assert.ok(specifier.startsWith("node:"), `${name}: ${specifier}`);
      }
    }
    return seen;
  }

  it("keeps analyze.ts and cli.ts out of what hooks and CI import", () => {
    const reached = closure([
      "words.ts",
      "profiles.ts",
      "types.ts",
      "deps.ts",
      "safe-read.ts",
      "receipts.ts",
      "state.ts",
      "tracking.ts",
    ]);
    for (const name of forbidden) assert.ok(!reached.has(name), name);
  });

  it("has a single computed import(), in adapter-lindera-unidic.ts", () => {
    const computed = /import\(\s*[^"'\s)]/gu;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const count = [
        ...readFileSync(join(dir, name), "utf8").matchAll(computed),
      ].length;
      assert.equal(count, name === "adapter-lindera-unidic.ts" ? 1 : 0, name);
    }
  });
});

describe("keep markers", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "japanese-check-keep-")));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let number = 0;
  const KEEP = "ja-check-keep";
  const mark = (rule: string, text: string, reason = "字義どおり") =>
    `<!-- ${KEEP} ${rule} -- ${text} ${reason} -->`;

  interface Report {
    findings: Array<{ rule: string; line: number; text: string }>;
    calques: Array<{ rule: string; line: number; text: string }>;
    newFacts: unknown[] | null;
    kept: Array<{ rule: string; line: number; text: string; reason: string }>;
    keepIssues: Array<{ line: number; problem: string }>;
    verification: { status: string; receipt: { candidates: number } } | null;
  }

  function fresh(content: string) {
    const key = ++number;
    const file = join(dir, `doc-${key}.md`);
    writeFileSync(file, content);
    return { file, stateDir: join(dir, `state-${key}`) };
  }
  async function run(args: string[], stateDir: string): Promise<Report> {
    const output = mock.method(console, "log", () => {});
    try {
      await main(args, { stateDir });
      return JSON.parse(String(output.mock.calls[0]?.arguments[0]));
    } finally {
      output.mock.restore();
    }
  }
  // Records the check, so the report carries the candidate count.
  async function checked(content: string, extra: string[] = []) {
    const doc = fresh(content);
    const report = await run(["check", doc.file, ...extra], doc.stateDir);
    return { ...doc, report };
  }
  const candidates = (report: Report) =>
    report.verification?.receipt.candidates;

  describe("collecting comments", () => {
    const bodies = (markdown: string) =>
      keepComments(markdown).map((item) => [item.line, item.body.trim()]);

    it("collects single-line closed comments with physical line numbers", () => {
      assert.deepEqual(bodies(`本文。\n\n本文 <!-- a --> 続き <!-- b -->\n`), [
        [3, "a"],
        [3, "b"],
      ]);
    });

    it("leaves proseLines output as it was for a document with comments", () => {
      const input = "文。<!-- a -->\n<!-- b -->\n<!-- c\nd -->\n続き。";
      assert.deepEqual(
        proseLines(input).map((row) => [row.line, row.text.trim()]),
        [
          [1, "文。"],
          [5, "続き。"],
        ],
      );
    });

    it("ignores examples in fences, indented code, frontmatter and link definitions", () => {
      const input = [
        "---",
        "<!-- in frontmatter -->",
        "---",
        "```md",
        "<!-- in fence -->",
        "```",
        "    <!-- in indented code -->",
        "\t<!-- in tab code -->",
        "[ref]: https://example.com <!-- in definition -->",
      ].join("\n");
      assert.deepEqual(keepComments(input), []);
    });

    it("does not read a comment that starts inside an inline code span", () => {
      assert.deepEqual(bodies("例は `<!-- a -->` と書く。"), []);
      assert.deepEqual(bodies("例は `x <!-- a -->` と書く。"), []);
    });

    it("reads the real comment next to an inline code example on one line", () => {
      assert.deepEqual(bodies("例 `<!-- a -->` 本文 <!-- b -->"), [[1, "b"]]);
      assert.deepEqual(bodies("本文 <!-- b --> 例 `<!-- a -->`"), [[1, "b"]]);
    });

    it("keeps backticks inside a comment out of the parity count", () => {
      assert.deepEqual(bodies("本文 <!-- r `foo` --> 続き <!-- s -->"), [
        [1, "r `foo`"],
        [1, "s"],
      ]);
      assert.deepEqual(bodies("本文 <!-- r ` --> 続き <!-- s -->"), [
        [1, "r `"],
        [1, "s"],
      ]);
    });

    it("reads a closed comment and not the multi-line comment that opens after it", () => {
      assert.deepEqual(bodies("本文 <!-- a --> 続き <!-- b\nc -->\n次。"), [
        [1, "a"],
      ]);
    });

    it("does not read inside the continuation of a multi-line comment", () => {
      assert.deepEqual(bodies("<!-- 始まり\n<!-- x -->\nまだ -->\n次。"), []);
      assert.deepEqual(bodies("<!-- 始まり\n終わり --> 続き <!-- y -->"), [
        [2, "y"],
      ]);
    });

    it("collects a note-only line and a leading note", () => {
      assert.deepEqual(bodies("<!-- a -->\n<!-- b --> 本文。"), [
        [1, "a"],
        [2, "b"],
      ]);
    });

    it("collects a comment on a list item line", () => {
      assert.deepEqual(bodies("- 項目 <!-- a -->"), [[1, "a"]]);
    });
  });

  describe("matching candidates", () => {
    it(
      "moves a matched candidate to kept and lowers the count by one",
      needsRuntime,
      async () => {
        const plain = await checked("数を足す。\n");
        assert.equal(candidates(plain.report), 1);
        const kept = await checked(
          `数を足す。${mark("translation-candidate", "足す")}\n`,
        );
        assert.equal(kept.report.calques.length, 1);
        assert.deepEqual(kept.report.kept, [
          {
            rule: "translation-candidate",
            line: 1,
            text: "足す",
            reason: "字義どおり",
          },
        ]);
        assert.deepEqual(kept.report.keepIssues, []);
        assert.equal(candidates(kept.report), 0);
        assert.equal(kept.report.verification?.status, "ready");
      },
    );

    it(
      "reports a marker on another line as a marker without a candidate",
      needsRuntime,
      async () => {
        const { report } = await checked(
          `数を足す。\n${mark("translation-candidate", "足す")}\n`,
        );
        assert.deepEqual(report.kept, []);
        assert.equal(report.keepIssues.length, 1);
        assert.equal(report.keepIssues[0]?.line, 2);
        assert.match(
          report.keepIssues[0]?.problem ?? "",
          /同じ行に該当する候補が無い/u,
        );
        assert.equal(candidates(report), 2);
      },
    );

    it(
      "reports a malformed marker and keeps the candidate",
      needsRuntime,
      async () => {
        for (const body of [
          `${KEEP} translation-candidate -- 足す`,
          `${KEEP} translation-candidate 足す -- 字義どおり`,
          `${KEEP}`,
          `${KEEP} translation-candidate -- ""  理由`,
        ]) {
          const { report } = await checked(`数を足す。<!-- ${body} -->\n`);
          assert.deepEqual(report.kept, [], body);
          assert.equal(report.keepIssues.length, 1, body);
          assert.equal(candidates(report), 2, body);
        }
      },
    );

    it("reports the first error of a marker with the fixed wording", () => {
      const problem = (body: string) => {
        const parsed = parseMarker(body);
        assert.ok(parsed && !parsed.ok, body);
        return parsed.problem;
      };
      const R = "translation-candidate";
      const cases: Array<[string, string]> = [
        [`${KEEP}`, "規則が書かれていない"],
        [`${KEEP}   `, "規則が書かれていない"],
        [`${KEEP} -- 足す 理由`, "規則が書かれていない"],
        [`${KEEP} ${R} long-sentence -- 足す x`, "`--` の前は規則 1 語だけ"],
        [`${KEEP} ${R} 足す -- 字義どおり`, "`--` の前は規則 1 語だけ"],
        [`${KEEP} ${R}`, "`--` が無い"],
        [`${KEEP} ${R} 足す 字義どおり`, "`--` が無い"],
        [`${KEEP} ${R} --`, "対象の文字列が書かれていない"],
        [`${KEEP} ${R} --   `, "対象の文字列が書かれていない"],
        [`${KEEP} ${R} -- "" 字義どおり`, "対象の文字列が書かれていない"],
        [`${KEEP} ${R} -- "  " 字義どおり`, "対象の文字列が書かれていない"],
        [`${KEEP} ${R} -- "型の 関係 字義どおり`, "引用が閉じていない"],
        [`${KEEP} ${R} -- "足す"字義どおり`, "引用の後ろに空白が無い"],
        [`${KEEP} ${R} -- 足す`, "理由が無い"],
        [`${KEEP} ${R} -- 足す   `, "理由が無い"],
        [`${KEEP} ${R} -- "型の 関係"`, "理由が無い"],
        // A full-width space is an ordinary character, not a separator.
        [`${KEEP} ${R} -- 足す\u3000字義どおり`, "理由が無い"],
      ];
      for (const [body, expected] of cases)
        assert.equal(problem(body), expected, body);
    });

    it("reads text and reason from the original string after the first --", () => {
      const read = (body: string) => {
        const parsed = parseMarker(body);
        assert.ok(parsed?.ok, body);
        return [parsed.rule, parsed.text, parsed.reason];
      };
      const R = "translation-candidate";
      assert.deepEqual(read(`${KEEP} ${R} -- 足す 字義どおり`), [
        R,
        "足す",
        "字義どおり",
      ]);
      // Later -- belong to the reason.
      assert.deepEqual(read(`${KEEP} ${R} -- 足す 字義どおり -- 補足`), [
        R,
        "足す",
        "字義どおり -- 補足",
      ]);
      // Several spaces and tabs around the words read like one.
      assert.deepEqual(read(`  ${KEEP}  \t ${R}   --  足す  理由 `), [
        R,
        "足す",
        "理由",
      ]);
      // Spaces inside quotes and inside the reason are kept.
      assert.deepEqual(read(`${KEEP} ${R} -- "型の  関係" 字義  どおり`), [
        R,
        "型の  関係",
        "字義  どおり",
      ]);
      // A reason may start with a quote; it is not interpreted.
      assert.deepEqual(read(`${KEEP} ${R} -- 足す "字義どおり"`), [
        R,
        "足す",
        '"字義どおり"',
      ]);
      assert.deepEqual(read(`${KEEP} ${R} -- 足す ref-1 note="字義どおり"`), [
        R,
        "足す",
        'ref-1 note="字義どおり"',
      ]);
      // A full-width space stays inside the unquoted text.
      assert.deepEqual(read(`${KEEP} ${R} -- 足す\u3000す 理由`), [
        R,
        "足す\u3000す",
        "理由",
      ]);
    });

    it("does not treat other comments as markers", () => {
      assert.equal(parseMarker("ja-check-keepers a -- b c"), null);
      assert.equal(parseMarker("ordinary note"), null);
      assert.equal(parseMarker(`x ${KEEP} a -- b c`), null);
      // The keyword must end at a space or tab, not a full-width space.
      assert.equal(parseMarker(`${KEEP}\u3000a -- b c`), null);
    });

    it(
      "does not keep a candidate of another rule on the same line",
      needsRuntime,
      async () => {
        const { report } = await checked(
          `数を足す。${mark("long-sentence", "足す", "x")}\n`,
        );
        assert.deepEqual(report.kept, []);
        assert.equal(report.keepIssues.length, 1);
        assert.equal(candidates(report), 2);
      },
    );

    it(
      "keeps only the candidate the text names when a line has two",
      needsRuntime,
      async () => {
        const { report } = await checked(
          `数を足して、データを拾う。${mark("translation-candidate", "足し")}\n`,
        );
        assert.equal(report.calques.length, 2);
        assert.deepEqual(
          report.kept.map((item) => item.text),
          ["足し"],
        );
        assert.equal(candidates(report), 1);
      },
    );

    it(
      "matches the text inside quotes, spaces included",
      needsRuntime,
      async () => {
        const sentence = `${"あ".repeat(50)} ${"い".repeat(59)}。`;
        const { report } = await checked(
          `${sentence}${mark("long-sentence", '"あ い"', "定義文")}\n`,
        );
        assert.ok(
          report.findings.some((item) => item.rule === "long-sentence"),
        );
        assert.equal(report.kept.length, 1);
        assert.equal(report.kept[0]?.reason, "定義文");
        assert.equal(candidates(report), 0);
      },
    );

    it(
      "never builds a regular expression from the text",
      needsRuntime,
      async () => {
        const { report } = await checked(
          `数を足す。${mark("translation-candidate", ".*")}\n`,
        );
        assert.deepEqual(report.kept, []);
        assert.equal(report.keepIssues.length, 1);
        assert.equal(candidates(report), 2);
      },
    );

    it("takes an opaque reason as it is", needsRuntime, async () => {
      const reason = 'ref-1 note="字義どおり"';
      const { report } = await checked(
        `数を足す。${mark("translation-candidate", "足す", reason)}\n`,
      );
      assert.equal(report.kept[0]?.reason, reason);
    });

    it(
      "keeps a reason with backticks inside the marker",
      needsRuntime,
      async () => {
        const { report } = await checked(
          `数を足す。${mark("translation-candidate", "足す", "`foo` の用語")}\n`,
        );
        assert.equal(report.kept[0]?.reason, "`foo` の用語");
        assert.deepEqual(report.keepIssues, []);
      },
    );

    it(
      "reads the closed marker before a comment that continues on the next lines",
      needsRuntime,
      async () => {
        const { report } = await checked(
          `数を足す。${mark("translation-candidate", "足す")} <!-- 続く\n${mark("translation-candidate", "足す")}\n終わり -->\n`,
        );
        assert.equal(report.kept.length, 1);
        assert.deepEqual(report.keepIssues, []);
      },
    );

    it(
      "ignores examples in a fence, inline code, indented code and frontmatter",
      needsRuntime,
      async () => {
        const example = mark("translation-candidate", "足す");
        const { report } = await checked(
          [
            "---",
            example,
            "---",
            "手順。",
            "```md",
            example,
            "```",
            `例は \`${example}\` と書く。`,
            `    ${example}`,
            "",
          ].join("\n"),
        );
        assert.deepEqual(report.kept, []);
        assert.deepEqual(report.keepIssues, []);
      },
    );

    it(
      "reads the real marker when an inline code example shares the line",
      needsRuntime,
      async () => {
        const real = mark("translation-candidate", "足す");
        const { report } = await checked(
          `例 \`${mark("long-sentence", "x")}\` を足す。${real}\n`,
        );
        assert.equal(report.kept.length, 1);
        assert.deepEqual(report.keepIssues, []);
      },
    );

    it("keeps a candidate on a list item line", needsRuntime, async () => {
      const { report } = await checked(
        `- 数を足す。${mark("translation-candidate", "足す")}\n`,
      );
      assert.equal(report.kept.length, 1);
      assert.equal(candidates(report), 0);
    });

    it(
      "cannot keep a new fact: the marker becomes an issue",
      needsRuntime,
      async () => {
        const source = fresh("利用者は3人。\n");
        const doc = fresh(`利用者は9人。${mark("number", "9人")}\n`);
        const report = await run(
          ["check", doc.file, "--source", source.file],
          doc.stateDir,
        );
        assert.ok(Array.isArray(report.newFacts) && report.newFacts.length > 0);
        assert.deepEqual(report.kept, []);
        assert.equal(report.keepIssues.length, 1);
        assert.equal(candidates(report), report.newFacts.length + 1);
      },
    );

    it("turns a note-only line into an issue", needsRuntime, async () => {
      const { report } = await checked(
        `${mark("translation-candidate", "足す")}\n`,
      );
      assert.equal(report.keepIssues.length, 1);
      assert.match(
        report.keepIssues[0]?.problem ?? "",
        /同じ行に該当する候補が無い/u,
      );
      assert.equal(candidates(report), 1);
    });

    it(
      "drops a line-leading note's body as indented code and reports the note",
      needsRuntime,
      async () => {
        const { report } = await checked(
          `${mark("translation-candidate", "足す")} 数を足す。\n`,
        );
        assert.deepEqual(report.calques, []);
        assert.deepEqual(report.kept, []);
        assert.equal(report.keepIssues.length, 1);
      },
    );

    it(
      "reads nothing from a comment continuation line",
      needsRuntime,
      async () => {
        const { report } = await checked(
          `数を足す。 <!-- 始まり\n数を足す。${mark("translation-candidate", "足す")}\n終わり -->\n`,
        );
        assert.deepEqual(report.kept, []);
        assert.deepEqual(report.keepIssues, []);
      },
    );

    it(
      "leaves kept and keepIssues empty and the count unchanged without markers",
      needsRuntime,
      async () => {
        const { report } = await checked("数を足す。\n");
        assert.deepEqual(report.kept, []);
        assert.deepEqual(report.keepIssues, []);
        assert.equal(report.calques.length, 1);
        assert.equal(candidates(report), 1);
      },
    );

    it(
      "reports kept and keepIssues with --no-record too",
      needsRuntime,
      async () => {
        const doc = fresh(
          `数を足す。${mark("translation-candidate", "足す")}\n`,
        );
        const report = await run(
          ["check", doc.file, "--no-record"],
          doc.stateDir,
        );
        assert.equal(report.kept.length, 1);
        assert.deepEqual(report.keepIssues, []);
      },
    );

    it(
      "leaves the other commands' output without kept fields",
      needsRuntime,
      async () => {
        const doc = fresh(
          `数を足す。${mark("translation-candidate", "足す")}\n`,
        );
        const calquesReport = await run(["calques", doc.file], doc.stateDir);
        assert.ok(Array.isArray(calquesReport));
        const lintReport = await run(["lint", doc.file], doc.stateDir);
        assert.ok(Array.isArray(lintReport));
      },
    );
  });

  describe("keeping a judgement in the document", () => {
    it("stays ready after another line is edited", needsRuntime, async () => {
      const doc = fresh(
        `数を足す。${mark("translation-candidate", "足す")}\n\n別の段落。\n`,
      );
      const first = await run(["check", doc.file], doc.stateDir);
      assert.equal(first.verification?.status, "ready");
      writeFileSync(
        doc.file,
        `数を足す。${mark("translation-candidate", "足す")}\n\n書き換えた別の段落。\n`,
      );
      const second = await run(["check", doc.file], doc.stateDir);
      assert.equal(second.verification?.status, "ready");
      assert.equal(second.kept.length, 1);
    });

    it("is ready in an empty state directory", needsRuntime, async () => {
      const doc = fresh(`数を足す。${mark("translation-candidate", "足す")}\n`);
      const empty = join(dir, `empty-state-${++number}`);
      const report = await run(["check", doc.file], empty);
      assert.equal(report.verification?.status, "ready");
    });

    it(
      "still needs a review for a candidate the markers do not cover",
      needsRuntime,
      async () => {
        const doc = fresh(
          `数を足す。${mark("translation-candidate", "足す")}\nデータを拾う。\n`,
        );
        const report = await run(["check", doc.file], doc.stateDir);
        assert.equal(report.verification?.status, "needs-review");
        assert.equal(candidates(report), 1);
      },
    );

    it("shows kept when the CLI runs as a process", needsRuntime, () => {
      const doc = fresh(`数を足す。${mark("translation-candidate", "足す")}\n`);
      const cli = fileURLToPath(
        new URL("../../../japanese-check/cli.ts", import.meta.url),
      );
      const result = spawnSync(
        process.execPath,
        [cli, "check", doc.file, "--no-record"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as Report;
      assert.equal(report.kept.length, 1);
      assert.equal(report.kept[0]?.text, "足す");
      assert.deepEqual(report.keepIssues, []);
    });
  });
});

describe("the calque entries of the shipped list", needsRuntime, () => {
  const tokenizer = createTestTokenizer();

  it("hold the verbs and nouns calques() used to hard-code", () => {
    const lemmas = new Set(
      shippedReview(["calque"]).flatMap((entry) =>
        entry.match === "lemma" ? entry.lemmas : [],
      ),
    );
    assert.deepEqual(
      [...lemmas].sort(),
      [
        "入り口",
        "入口",
        "口",
        "受け口",
        "引く",
        "拾う",
        "効く",
        "足す",
        "通る",
        "響く",
      ].sort(),
    );
  });

  it("report nothing without review entries, so no word is left in analyze.ts", async () => {
    assert.deepEqual(
      calques(
        proseLines("薬が効いた。\n数を足す。\nAPI の入口"),
        await tokenizer,
        [],
      ),
      [],
    );
  });

  it("report the same candidate as before the words moved", async () => {
    const found = calques(
      proseLines("薬が効いた。"),
      await tokenizer,
      shippedReview(),
    );
    assert.deepEqual(found, [
      {
        rule: "translation-candidate",
        line: 1,
        column: 3,
        text: "効い",
        reason:
          "字義どおりの用法・定着した専門用語なら残す。何がどうなるか不明なら原文の範囲で言い直す。",
      },
    ]);
  });
});

describe("review entries from the word list", needsRuntime, () => {
  const tokenizer = createTestTokenizer();
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-check-review-")),
  );
  after(() => rmSync(dir, { recursive: true, force: true }));

  const jargonLemma = rawEntry({
    word: "ロバスト",
    kind: "jargon",
    match: "lemma",
    lemmas: ["ロバスト"],
    pos: "adjectivalNoun",
  });
  const slopRegex = rawEntry({
    word: "既定では",
    kind: "slop",
    match: "regex",
    pattern: "既定では",
  });
  const calqueLemma = rawEntry({
    word: "ロバスト（直訳）",
    kind: "calque",
    match: "lemma",
    lemmas: ["ロバスト"],
    pos: "adjectivalNoun",
    english: "robust",
  });
  const jargonRegex = rawEntry({
    word: "ロバスト（語）",
    kind: "jargon",
    match: "regex",
    pattern: "ロバスト",
  });

  async function found(markdown: string, entries: unknown[]) {
    return calques(proseLines(markdown), await tokenizer, reviewFrom(entries));
  }

  it("reports a lemma entry as word-jargon with the entry's fix", async () => {
    const result = await found("ロバストな設計", [jargonLemma]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.rule, "word-jargon");
    assert.equal(result[0]?.text, "ロバスト");
    assert.equal(result[0]?.reason, "確かめる。");
  });

  it("reports a regex entry with its rule and column", async () => {
    const result = await found("既定では有効", [slopRegex]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.rule, "word-slop");
    assert.equal(result[0]?.column, 1);
    assert.equal(result[0]?.text, "既定では");
  });

  it("maps each kind to its rule", async () => {
    const verb = rawEntry({
      word: "寄り添う",
      kind: "metaphor-verb",
      match: "lemma",
      lemmas: ["寄り添う"],
      pos: "verb",
    });
    const calqueDesign = rawEntry({
      word: "設計",
      kind: "calque",
      match: "lemma",
      lemmas: ["設計"],
      pos: "noun",
      english: "design",
    });
    const result = await found("既定ではロバストな設計に寄り添った。", [
      slopRegex,
      jargonLemma,
      verb,
      calqueDesign,
    ]);
    assert.deepEqual(
      result.map((item) => item.rule),
      [
        "word-slop",
        "word-jargon",
        "translation-candidate",
        "word-metaphor-verb",
      ],
    );
  });

  it("skips inline code and fenced code", async () => {
    assert.deepEqual(
      await found("```\n既定では\n```\n`既定では`", [slopRegex]),
      [],
    );
  });

  it("keeps only the earlier entry when two entries hit the same spot", async () => {
    const calqueFirst = await found("ロバストな設計", [
      calqueLemma,
      jargonRegex,
    ]);
    assert.deepEqual(
      calqueFirst.map((item) => item.rule),
      ["translation-candidate"],
    );
    const jargonFirst = await found("ロバストな設計", [
      jargonRegex,
      calqueLemma,
    ]);
    assert.deepEqual(
      jargonFirst.map((item) => item.rule),
      ["word-jargon"],
    );
  });

  describe("through the CLI", () => {
    let number = 0;
    function listFile(content: string) {
      const file = join(dir, `words-${++number}.json`);
      writeFileSync(file, content);
      return file;
    }
    const listOf = (...entries: unknown[]) =>
      JSON.stringify({ schema: WORD_LIST_SCHEMA, entries });
    function doc(content: string) {
      const key = ++number;
      const file = join(dir, `doc-${key}.md`);
      writeFileSync(file, content);
      return { file, stateDir: join(dir, `state-${key}`) };
    }
    async function run(args: string[], stateDir: string, wordListPath: string) {
      const output = mock.method(console, "log", () => {});
      const errors = mock.method(console, "error", () => {});
      try {
        await main(args, { stateDir, wordListPath });
        return JSON.parse(String(output.mock.calls[0]?.arguments[0])) as {
          findings: unknown[];
          calques: Array<{ rule: string; text: string }>;
          kept: unknown[];
          keepIssues: unknown[];
          limitations: string[];
          verification: { status: string } | null;
        };
      } finally {
        output.mock.restore();
        errors.mock.restore();
      }
    }
    const stateFiles = (stateDir: string) => {
      try {
        return readdirSync(stateDir, { recursive: true });
      } catch {
        return [];
      }
    };

    it("keeps a candidate with a marker for its rule", async () => {
      const words = listFile(listOf(jargonLemma));
      const d = doc(
        "ロバストな設計 <!-- ja-check-keep word-jargon -- ロバスト 定義済みの用語 -->\n",
      );
      const report = await run(["check", d.file], d.stateDir, words);
      assert.equal(report.calques.length, 1);
      assert.equal(report.kept.length, 1);
      assert.deepEqual(report.keepIssues, []);
      assert.equal(report.verification?.status, "ready");
    });

    it("the calques command finds 効く with the shipped list", async () => {
      const d = doc("薬が効いた。\n");
      const output = mock.method(console, "log", () => {});
      try {
        await main(["calques", d.file], { stateDir: d.stateDir });
        const result = JSON.parse(String(output.mock.calls[0]?.arguments[0]));
        assert.equal(result.length, 1);
        assert.equal(result[0].rule, "translation-candidate");
      } finally {
        output.mock.restore();
      }
    });

    it("the calques command reads the list too", async () => {
      const words = listFile(listOf(jargonLemma));
      const d = doc("ロバストな設計\n");
      const output = mock.method(console, "log", () => {});
      try {
        await main(["calques", d.file], {
          stateDir: d.stateDir,
          wordListPath: words,
        });
        const result = JSON.parse(String(output.mock.calls[0]?.arguments[0]));
        assert.equal(result.length, 1);
        assert.equal(result[0].rule, "word-jargon");
      } finally {
        output.mock.restore();
      }
    });

    it("does not record a check when the list is missing", async () => {
      const d = doc("ロバストな設計\n");
      const report = await run(
        ["check", d.file],
        d.stateDir,
        join(dir, "no-such-list.json"),
      );
      assert.equal(report.verification, null);
      assert.ok(
        report.limitations.some((line) =>
          line.includes("語の一覧を読めなかった"),
        ),
      );
      assert.deepEqual(stateFiles(d.stateDir), []);
    });

    it("does not record a check when the list is not JSON", async () => {
      const d = doc("ロバストな設計\n");
      const words = listFile("{ not json");
      const report = await run(["check", d.file], d.stateDir, words);
      assert.equal(report.verification, null);
      assert.ok(
        report.limitations.some(
          (line) =>
            line.includes("語の一覧を読めなかった") && line.includes("JSON"),
        ),
      );
      assert.deepEqual(stateFiles(d.stateDir), []);
    });

    it("matches with the entries that passed and records nothing when one entry fails", async () => {
      const d = doc("ロバストな設計\n");
      const words = listFile(
        listOf(jargonLemma, rawEntry({ kind: "unknown" })),
      );
      const report = await run(["check", d.file], d.stateDir, words);
      assert.equal(report.calques.length, 1);
      assert.equal(report.verification, null);
      assert.ok(
        report.limitations.some((line) =>
          line.includes("語の一覧を読めなかった"),
        ),
      );
      assert.deepEqual(stateFiles(d.stateDir), []);
    });
  });
});
