// proseMasks (markdown.ts) and the two phrase checks (phrases.ts). The sentence
// lists are the examples of tanteki's former textlint rules, kept here so the
// rebuilt checks are held to the same cases.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { check } from "../../../japanese-check/analyze.ts";
import type { Tokenizer } from "../../../japanese-check/contract.ts";
import { AnalyzerOutputError } from "../../../japanese-check/contract.ts";
import { matchKeeps } from "../../../japanese-check/keep.ts";
import {
  keepComments,
  paragraphs,
  proseLines,
  proseMasks,
} from "../../../japanese-check/markdown.ts";
import {
  phraseFindings,
  selectPhraseFindings,
} from "../../../japanese-check/phrases.ts";
import type { Finding } from "../../../japanese-check/types.ts";
import {
  createTestTokenizer,
  needsRuntime,
} from "../support/japanese-check-runtime.ts";

describe("proseMasks", () => {
  const rangesOf = (markdown: string) => proseMasks(markdown)[0]!.ranges;

  it("marks the destination of a link as link", () => {
    const line = "**適切**な[対応](https://example.test)を行った。";
    const start = line.indexOf("](");
    assert.deepEqual(rangesOf(line), [
      { start, end: line.indexOf(")") + 1, kind: "link" },
    ]);
  });

  it("marks inline code, a break tag and a comment as barrier", () => {
    for (const line of [
      "適切に`値を設定`対応する。",
      "適切に<br>対応する。",
      "適切に<!-- x -->対応する。",
    ]) {
      const ranges = rangesOf(line);
      assert.equal(ranges.length, 1, line);
      assert.equal(ranges[0]!.kind, "barrier", line);
    }
  });

  it("tells an image from a link by the order of replacement", () => {
    const line = "[対応](url)と![操作](image.png)";
    assert.deepEqual(rangesOf(line), [
      { start: 3, end: 9, kind: "link" },
      { start: 10, end: line.length, kind: "barrier" },
    ]);
  });

  it("keeps the ranges apart where a link destination spans a code span", () => {
    const line = "[a](`x)`y)";
    const ranges = rangesOf(line);
    const prose = proseLines(line)[0]!.text;
    const covered = new Set<number>();
    for (const range of ranges)
      for (let at = range.start; at < range.end; at++) {
        assert.ok(!covered.has(at), "ranges overlap");
        covered.add(at);
      }
    const blanked = new Set<number>();
    for (let at = 0; at < line.length; at++)
      if (prose[at] === " " && line[at] !== " ") blanked.add(at);
    assert.deepEqual([...covered].sort(), [...blanked].sort());
    assert.ok(ranges.some((range) => range.kind === "barrier"));
    assert.ok(ranges.some((range) => range.kind === "link"));
  });

  it("flags a quoted line before the marker is blanked", () => {
    assert.equal(proseMasks("> 適切に対応する。")[0]!.quote, true);
    assert.equal(proseMasks("適切に対応する。")[0]!.quote, false);
    assert.equal(proseMasks("- > 適切に対応する。")[0]!.quote, false);
  });

  it("lists the same lines as proseLines, with ranges inside the line", () => {
    const markdown = [
      "---",
      "title: x",
      "---",
      "# 見出し",
      "",
      "| 列 | 値 |",
      "| --- | --- |",
      "| 𠮷野家 | `code` |",
      "",
      "> 引用 [a](b)",
      "",
      "```",
      "適切に対応する。",
      "```",
      "本文 **強調**\r",
      "最後 😀 ![x](y)",
    ].join("\r\n");
    const lines = proseLines(markdown);
    const masks = proseMasks(markdown);
    assert.deepEqual(
      masks.map((mask) => mask.line),
      lines.map((row) => row.line),
    );
    for (const [index, mask] of masks.entries()) {
      const row = lines[index]!;
      for (const range of mask.ranges)
        assert.ok(0 <= range.start && range.start < range.end);
      for (const range of mask.ranges) assert.ok(range.end <= row.text.length);
      assert.equal(mask.raw.length, row.text.length);
    }
  });

  it("leaves the output of the other readers alone", () => {
    const markdown =
      "本文 `code` [a](b)\n\n次の段落\n<!-- ja-check-keep x -- y -->";
    assert.deepEqual(proseLines(markdown), [
      { line: 1, text: "本文        [a    ", kind: "paragraph" },
      { line: 3, text: "次の段落", kind: "paragraph" },
    ]);
    assert.equal(keepComments(markdown).length, 1);
    assert.equal(paragraphs(proseLines(markdown)).length, 2);
  });
});

// Upstream examples, verbatim.
const VAGUE_DETECTED = [
  "適切に対応する",
  "適切に対応しました",
  "適切に対応しません",
  "適切に対応すれば",
  "適切に対応しよう",
  "適切な対応を行います",
  "適切な対応を行わなかった",
  "適切な対応は行った",
  "適切な対応を実施しました",
  "適切に担当者が対応する",
  "適切に担当者が内容の評価を行う",
  "適切に、対応しました",
  "慎重な検討を行った",
  "十分な評価を行わなかった",
  "慎重に評価します",
  "適宜の調整を行う",
  "必要に応じて、対応を実施しました",
  "必要に応じた対応を行う",
  "状況に応じ、担当者が調整を行う",
  "これを実施すれば",
  "それは実施しません",
  "これについても実施します",
  "本件の実施を行う",
  "それへの対応を推進する",
  "これに対応します",
  "それにも対応する",
  "本件に対する対応を行います",
  "本件に関して対応する",
  "十分なリスク評価を行う",
  "慎重な性能評価を行う",
  "適切な問い合わせ対応を行う",
  "必要に応じて配信を停止する",
];
const OPAQUE_DETECTED = [
  "価値創出最大化基盤",
  "顧客体験向上プラットフォーム",
  "顧客の体験の向上プラットフォーム",
  "意思決定の高度化レイヤー",
  "意思決定高度化レイヤー",
  "組織横断価値創出",
  "問い合わせ対応品質向上基盤",
  "運用成熟度向上支援機構",
  "業務効率化促進システム",
  "判断迅速化推進機構",
  "業務効率化基盤",
  "業務効率化システム",
  "業務の効率化の基盤",
];
const VAGUE_ACCEPTED = [
  "適切な対応表を作った。",
  "本件の処理速度を測定する。",
  "適切な値を指定する。",
  "適切に値を設定して対応する。",
  "それを保存する。",
  "障害の種類に応じて再試行回数を変える。",
  "当番が失敗率を確認する。5%を超えたら配信を停止する。",
  "慎重に。評価する。",
  "適切に「値を設定する」と書く。対応する。",
];
const OPAQUE_ACCEPTED = [
  "情報処理安全確保支援士。",
  "顧客体験の向上を調査する。",
  "意思決定と描画レイヤーを分離する。",
  "画像処理システムの最適化。",
  "認証基盤の設定を更新する。",
  "価値提供と課題解決は具体的に書く。",
  "データ解析基盤の性能向上を検証する。",
  "高速画像処理基盤の最適化。",
  "最適化の対象システム。",
  "最適化対象システム。",
  "最適化問題の評価システム。",
];
const NEGATED = [
  "適切な対応を行わなかった",
  "適切に対応してはいません",
  "適切に対応するべきではない",
  "適切に対応しなければならない",
  "必要に応じない",
  "適切な対応ではない",
  "適切な対応はない",
  "慎重な評価ではありません",
];

describe("phrase checks (opaque-compound, vague-action)", () => {
  const tokenizer = createTestTokenizer();
  const run = async (markdown: string): Promise<Finding[]> =>
    phraseFindings(proseLines(markdown), proseMasks(markdown), await tokenizer);
  const countFor = async (markdown: string, rule: string) =>
    (await run(markdown)).filter((item) => item.rule === rule);

  it(
    "detects each vague-action example once, at the start of the sentence",
    needsRuntime,
    async () => {
      for (const text of VAGUE_DETECTED) {
        const found = await run(`${text}。`);
        assert.equal(found.length, 1, text);
        assert.equal(found[0]!.rule, "vague-action", text);
        assert.equal(found[0]!.column, 1, text);
      }
    },
  );

  it(
    "detects each opaque-compound example once, at the start of the sentence",
    needsRuntime,
    async () => {
      for (const text of OPAQUE_DETECTED) {
        const found = await run(`${text}。`);
        assert.equal(found.length, 1, text);
        assert.equal(found[0]!.rule, "opaque-compound", text);
        assert.equal(found[0]!.column, 1, text);
      }
    },
  );

  it(
    "passes the neighbouring uses that are not the patterns",
    needsRuntime,
    async () => {
      for (const text of [...VAGUE_ACCEPTED, ...OPAQUE_ACCEPTED])
        assert.deepEqual(await run(text), [], text);
    },
  );

  it(
    "reads across emphasis and link labels and quotes the written range",
    needsRuntime,
    async () => {
      for (const text of [
        "😀**適切**な[対応](https://example.test)を行った。",
        "## 適切に**対応**しません。",
        "| 手順 |\n| --- |\n| 適切に**対応**する |",
        "<https://example.test/path>適切に対応する。",
      ]) {
        const found = await run(text);
        assert.equal(found.length, 1, text);
        const line = text.split("\n").find((row) => row.includes("適切"))!;
        assert.equal(found[0]!.column - 1, line.indexOf("適切"), text);
        const stop = line.includes("。") ? line.indexOf("。") : line.length;
        assert.equal(
          found[0]!.text,
          line
            .slice(line.indexOf("適切"), stop)
            .replace(/\s*\|$/u, "")
            .trimEnd(),
          text,
        );
      }
    },
  );

  it("never joins words across a wall", needsRuntime, async () => {
    for (const text of [
      "適切に。対応する。",
      "適切に`値を設定`対応する。",
      "適切に![操作](image.png)対応する。",
      "| 適切に | 対応する |\n| --- | --- |",
      "> 適切に対応する。\n> > 適切な対応をする。",
      "```md\n適切に対応する。\n```",
      "[URL](https://example.test/適切に対応する)",
      "適切に<br>対応する。",
      "適切に「値を設定する」と書く。対応する。",
    ])
      assert.deepEqual(await run(text), [], text);
  });

  it("does not read across lines", needsRuntime, async () => {
    for (const text of [
      "適切に\n\n対応する。",
      "適切に  \n対応する。",
      "適切に\n対応しました。",
    ])
      assert.deepEqual(await run(text), [], text);
  });

  it(
    "reads a bare URL as ending at its first non-ASCII character",
    needsRuntime,
    async () => {
      assert.equal(
        (await run("https://example.test/適切に対応する")).length,
        1,
      );
    },
  );

  it(
    "keeps snake_case and counts columns in UTF-16",
    needsRuntime,
    async () => {
      const snake = "snake_case の値を適切に対応する。";
      const found = await run(snake);
      assert.equal(found.length, 1);
      assert.equal(found[0]!.column - 1, snake.indexOf("適切"));
      const wide = "𠮷野家で**適切**に対応する。";
      const second = await run(wide);
      assert.equal(second.length, 1);
      assert.equal(second[0]!.column - 1, wide.indexOf("適切"));
    },
  );

  it(
    "covers the whole sentence of a negated action",
    needsRuntime,
    async () => {
      for (const text of NEGATED) {
        const found = await run(`${text}。`);
        assert.equal(found.length, 1, text);
        assert.equal(found[0]!.text, text, text);
      }
    },
  );

  it(
    "drops the inner candidate and prefers vague-action on equal ranges",
    needsRuntime,
    async () => {
      assert.equal((await run("適切な対応を行わなかった。")).length, 1);
      const same = (rule: string): Finding => ({
        rule,
        line: 1,
        column: 1,
        text: "適切に対応する",
        reason: "r",
      });
      const picked = selectPhraseFindings([
        same("opaque-compound"),
        same("vague-action"),
      ]);
      assert.deepEqual(
        picked.map((item) => item.rule),
        ["vague-action"],
      );
    },
  );

  it("applies the opaque-compound rule", needsRuntime, async () => {
    const opaque = async (text: string) =>
      (await countFor(`${text}。`, "opaque-compound")).length;
    assert.equal(await opaque("業務効率化基盤"), 1);
    assert.equal(await opaque("業務効率化"), 0);
    assert.equal(await opaque("組織横断価値創出"), 1);
    assert.equal(await opaque("画像処理システムの最適化"), 0);
  });

  it("looks ahead at most 40 words after the entry", needsRuntime, async () => {
    const stuffing = (count: number) => "項目".repeat(count);
    const tokenize = await tokenizer;
    const words = (text: string) =>
      tokenize(text).filter((token) => token.surface === "項目").length;
    assert.equal(words(stuffing(39)), 39);
    assert.equal(words(stuffing(40)), 40);
    assert.equal((await run(`適切に${stuffing(39)}対応する。`)).length, 1);
    assert.equal((await run(`適切に${stuffing(40)}対応する。`)).length, 0);
  });

  it(
    "reads the projected word back inside the markers",
    needsRuntime,
    async () => {
      const emphasis = (await run("**適切**な対応を行った。"))[0]!;
      assert.equal(emphasis.column, 3);
      assert.equal(emphasis.text, "適切**な対応を行った");
      const underscore = (await run("__適切__に対応する。"))[0]!;
      assert.equal(underscore.text.replaceAll("_", ""), "適切に対応する");
      const link = (await run("[適切](url)に対応する。"))[0]!;
      assert.equal(link.text, "適切](url)に対応する");
      assert.equal(link.column, 2);
    },
  );

  it(
    "handles brackets that have no link behind them",
    needsRuntime,
    async () => {
      assert.equal(
        (await run("[![図](a.png)](url)適切に対応する。")).length,
        1,
      );
      assert.equal((await run("[適切][ref]に対応する。")).length, 0);
    },
  );

  it(
    "keeps one candidate and counts the other when a marker names the first",
    needsRuntime,
    async () => {
      const markdown =
        "**適切な対応を行わなかった**という原文。適切に対応しません。<!-- ja-check-keep vague-action -- 適切な対応を行わなかった 引用の原文 -->";
      const found = await run(markdown);
      assert.equal(found.length, 2);
      const { kept, keepIssues } = matchKeeps(keepComments(markdown), found);
      assert.equal(kept.length, 1);
      assert.equal(keepIssues.length, 0);
      assert.equal(found.length - kept.length, 1);
    },
  );

  it("returns exactly the two rule names", needsRuntime, async () => {
    const rules = new Set<string>();
    for (const text of [...VAGUE_DETECTED, ...OPAQUE_DETECTED])
      for (const item of await run(`${text}。`)) rules.add(item.rule);
    assert.deepEqual([...rules].sort(), ["opaque-compound", "vague-action"]);
  });

  it(
    "orders check() findings after lint() by line and column",
    needsRuntime,
    async () => {
      const result = check(
        "業務効率化基盤を作る。\n適切に対応する。",
        await tokenizer,
        [],
        { name: "t", version: "0", dictionary: "t" } as never,
      );
      const phrases = result.findings.filter(
        (item) =>
          item.rule === "opaque-compound" || item.rule === "vague-action",
      );
      assert.deepEqual(
        phrases.map((item) => item.line),
        [1, 2],
      );
    },
  );
});

describe("phraseFindings over a fake analyzer", () => {
  it("lets AnalyzerOutputError through check() unchanged", () => {
    const failing: Tokenizer = () => {
      throw new AnalyzerOutputError("x");
    };
    assert.throws(
      () =>
        check("本文です。", failing, [], {
          name: "t",
          version: "0",
          dictionary: "t",
        } as never),
      AnalyzerOutputError,
    );
  });
});
