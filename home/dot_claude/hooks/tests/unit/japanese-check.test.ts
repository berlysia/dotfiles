import assert from "node:assert/strict";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, mock } from "node:test";
import {
  calques,
  check,
  lint,
  newFacts,
  outline,
  terms,
} from "../../../japanese-check/analyze.ts";
import { main, parseArguments } from "../../../japanese-check/cli.ts";
import { paragraphs, proseLines } from "../../../japanese-check/markdown.ts";
import {
  createTokenizer,
  decodeTokens,
} from "../../../japanese-check/tokenizer.ts";

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

describe("Sudachi-backed Japanese review", () => {
  const tokenizer = createTokenizer();

  it("preserves original spelling and positions when Sudachi changes ASCII case or width", async () => {
    const tokenize = await tokenizer;
    for (const text of [
      "japanese-check を使う。",
      "ＡＰＩで確認する。",
      "😀 api-check を拾った。",
    ]) {
      const tokens = tokenize(text);
      assert.equal(tokens.map((token) => token.surface).join(""), text);
      for (const token of tokens) {
        assert.equal(text.slice(token.start, token.end), token.surface);
      }
    }
  });

  it("uses actual morphological POS and normalized forms for inflected verbs", async () => {
    const tokenize = await tokenizer;
    const tokens = tokenize("データを拾った。");
    assert.ok(
      tokens.some(
        (token) =>
          token.surface === "拾っ" &&
          token.normalized === "拾う" &&
          token.pos[0] === "動詞",
      ),
    );
    const findings = calques(
      proseLines("# API の入口\nデータを拾った。\n`拾った`"),
      tokenize,
    );
    assert.ok(findings.some((item) => item.text === "入口" && item.line === 1));
    assert.ok(findings.some((item) => item.text === "拾っ" && item.line === 2));
    assert.ok(findings.every((item) => item.line !== 3));
  });

  it("identifies first use while leaving explanation correctness to the reader", async () => {
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
  });

  it("detects changed counts and proper nouns, ignores moved text and code", async () => {
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
    assert.ok(!found.some((fact) => /API|大阪|999|NewCode/u.test(fact.value)));
    assert.deepEqual(
      newFacts(
        source,
        proseLines("利用者は3人。\n大阪でAPIを使う。"),
        tokenize,
      ),
      [],
    );
  });

  it("does not claim that unchanged words prove unchanged meaning", async () => {
    const result = check(
      "次回までに合意した。",
      await tokenizer,
      "business",
      "次回までに検討する。",
    );
    assert.deepEqual(result.newFacts, []);
    assert.ok(result.limitations.some((text) => text.includes("確度")));
    assert.equal(result.analyzer.engine, "sudachi");
  });
});

describe("Japanese checker CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "japanese-check-"));
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

  it("rejects malformed analyzer output instead of silently skipping analysis", () => {
    assert.throws(() => decodeTokens("[]", "未解析の本文"));
    assert.throws(() => decodeTokens("{}", "本文"));
    assert.throws(() => decodeTokens('[{"surface":"本文"}]', "本文"));
    assert.throws(() =>
      decodeTokens(
        '[{"surface":"別の文","normalized_form":"別","poses":["名詞"]}]',
        "本文",
      ),
    );
  });

  it("rejects aliases of the same source and emits a combined report with a real source", async () => {
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
      await main(["check", final, "--source", source]);
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
  });
});
