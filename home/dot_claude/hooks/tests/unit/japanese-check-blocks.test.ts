import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
  blockFindings,
  inactiveBlockRules,
} from "../../../japanese-check/blocks.ts";
import type { BlockFlags } from "../../../japanese-check/blocks.ts";
import {
  blockLines,
  keepComments,
  paragraphs,
  proseLines,
} from "../../../japanese-check/markdown.ts";
import { loadProfiles } from "../../../japanese-check/profiles.ts";
import { needsRuntime, runtimeEnv } from "../support/japanese-check-runtime.ts";

// Built from lines so that no formatter rewrites the indentation that the
// tests depend on.
const MIXED_DOC = [
  "---",
  "title: x",
  "---",
  "# 見出し",
  "",
  "本文です。レバレッジを効かせる <!-- ja-check-keep word-jargon -- レバレッジ 理由 --> 例です。",
  "",
  "| 列 | 値 |",
  "| --- | --- |",
  "| a | PR #12 |",
  "",
  "> 引用の本文です。",
  "",
  "```",
  "PR #1",
  "```",
  "",
  "    インデントのコード <!-- ja-check-keep x -- y z -->",
  "",
  "[a]: https://github.com/acme/repo/pull/1 <!-- ja-check-keep x -- y z -->",
  "",
  "- 項目",
  "    - 入れ子 <!-- ja-check-keep word-jargon -- a b -->",
  "    - 次 <!-- c --> <!-- ja-check-keep word-jargon -- a b -->",
  "",
  "- a",
  "    text <!-- ja-check-keep x -- y z -->",
  "",
  "<!-- コメントのみ -->",
  "最後の段落。",
].join("\n");

const STOCK: BlockFlags = { stockBoundary: true, tableCells: false };
const TABLE: BlockFlags = { stockBoundary: false, tableCells: true };
const BOTH: BlockFlags = { stockBoundary: true, tableCells: true };

const stockAt = (text: string) =>
  blockFindings(blockLines(text), STOCK)
    .filter((item) => item.rule === "stock-boundary")
    .map((item) => [item.line, item.column]);
const tableLines = (text: string) =>
  blockFindings(blockLines(text), TABLE).map((item) => item.line);
const kinds = (text: string) =>
  blockLines(text).map((row) => [row.line, row.kind]);

describe("blockLines", () => {
  it("returns a link definition as a paragraph, and drops it when indented as code", () => {
    assert.deepEqual(kinds("[a]: https://github.com/acme/repo/pull/1"), [
      [1, "paragraph"],
    ]);
    assert.deepEqual(kinds("    [a]: https://github.com/acme/repo/pull/1"), []);
    assert.deepEqual(
      kinds("- a\n    [a]: https://github.com/acme/repo/pull/1"),
      [[1, "list"]],
    );
  });

  it("returns a nested list item indented by four spaces only right after a list item", () => {
    assert.deepEqual(kinds("- a\n    - [ ] x"), [
      [1, "list"],
      [2, "list"],
    ]);
    assert.deepEqual(kinds("- a\n    - b\n        - [ ] c"), [
      [1, "list"],
      [2, "list"],
      [3, "list"],
    ]);
    assert.deepEqual(kinds("- a\n    text\n        - [ ] x"), [[1, "list"]]);
    assert.deepEqual(kinds("- a\n\n    - [ ] x"), [[1, "list"]]);
    assert.deepEqual(kinds("- a\n    | 61 字 |"), [[1, "list"]]);
    assert.deepEqual(kinds("- a\n\t- b"), [
      [1, "list"],
      [2, "list"],
    ]);
  });

  it("blanks only the comment range and keeps columns, surrogate pairs included", () => {
    const rows = blockLines("# A\n\n本文 <!-- x PR #12 --> 続き");
    const row = rows.find((item) => item.line === 3);
    assert.ok(row);
    const original = "本文 <!-- x PR #12 --> 続き";
    assert.equal(row.text.length, original.length);
    assert.equal(row.text.indexOf("続き"), original.indexOf("続き"));
    assert.ok(!row.text.includes("PR"));
    const pair = blockLines("𠮷 <!-- x --> 野")[0];
    assert.equal(pair?.text.length, "𠮷 <!-- x --> 野".length);
    assert.equal(pair?.text.indexOf("野"), "𠮷 <!-- x --> 野".indexOf("野"));
  });

  it("returns a Setext underline as a separator", () => {
    assert.deepEqual(kinds("進捗状況\n===="), [
      [1, "paragraph"],
      [2, "separator"],
    ]);
  });

  it("returns lines with no prose left, and separators of a table", () => {
    assert.deepEqual(kinds("https://example.test/a\n`code`\n| a |\n| --- |"), [
      [1, "paragraph"],
      [2, "paragraph"],
      [3, "table"],
      [4, "separator"],
    ]);
  });

  it("leaves out fences, frontmatter, blank lines and comment-only lines", () => {
    assert.deepEqual(kinds("- [ ] a\n\n```\nPR #1\n```"), [[1, "list"]]);
    assert.deepEqual(kinds("---\ntitle: x\n---\n本文"), [[4, "paragraph"]]);
    assert.deepEqual(kinds("<!-- a -->\n本文\n<!-- b\nc -->\n末尾"), [
      [2, "paragraph"],
      [5, "paragraph"],
    ]);
  });

  it("marks only lines that start with > as a quote", () => {
    const rows = blockLines("> 引用\n本文 > 記号\n- > x");
    assert.deepEqual(
      rows.map((row) => row.quote),
      [true, false, false],
    );
  });

  it("does not change proseLines or paragraphs, and keepComments grows only for nested items and definitions", () => {
    const doc = MIXED_DOC;
    assert.deepEqual(
      proseLines(doc).map((row) => row.line),
      [4, 6, 8, 10, 12, 22, 26, 30],
    );
    assert.equal(paragraphs(proseLines(doc)).length, 8);
    assert.deepEqual(
      keepComments(doc).map((item) => [item.line, item.body.trim()]),
      [
        [6, "ja-check-keep word-jargon -- レバレッジ 理由"],
        [20, "ja-check-keep x -- y z"],
        [23, "ja-check-keep word-jargon -- a b"],
        [24, "c"],
        [24, "ja-check-keep word-jargon -- a b"],
        [29, "コメントのみ"],
      ],
    );
  });

  it("returns both comments of a nested item and none of the code", () => {
    const text = "- a\n    - b <!-- c --> <!-- d -->\n\n    code <!-- e -->";
    assert.deepEqual(
      keepComments(text).map((item) => item.body.trim()),
      ["c", "d"],
    );
  });
});

// The stock-boundary tests of the upstream textlint rule (tanteki lint.test.mjs,
// commit e9c4ae74), as input -> [line, column] pairs.
describe("stock-boundary against the upstream examples", () => {
  it("reports headings, checkboxes, PRs and tracker links", () => {
    const text =
      "## 進捗\n- [ ] 実装\nPR #12\n[PR](https://github.com/acme/repo/pull/3)\nhttps://jira.example.test/browse/DEV-3\n";
    assert.deepEqual(stockAt(text), [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 6],
      [5, 1],
    ]);
    for (const item of blockFindings(blockLines(text), STOCK))
      assert.ok(
        item.reason.includes("作業追跡はチケットまたは進捗文書へ移して"),
      );
  });

  it("accepts document IDs, ADR business states and dates", () => {
    const accepted =
      "ADR-001\nPRD-001\nRFC-9110\nREQ-001\nISO-8601\n状態：処理中\n状態: 完了\n状態: 採用\n状態: 廃止\n状態: 置換\n2026-09-05\n";
    assert.deepEqual(stockAt(accepted), []);
  });

  it("checks inline code and links but not fences or quotes", () => {
    assert.deepEqual(
      stockAt(
        "`PR #12` [ticket](https://github.com/a/b/issues/9)\n```md\nPR #13\n```\n> PR #14\n> > DEV-3\n> ## 進捗\n> - [ ] 引用内の作業\n",
      ),
      [
        [1, 2],
        [1, 19],
      ],
    );
  });

  it("follows variable-length fences and quoted fences, then resumes", () => {
    assert.deepEqual(
      stockAt(
        "````md\n``` literal fence\n````\n> ```md\n> PR #12\n> ```\n> lazy quote PR #13\nPR #14\n",
      ),
      [[8, 1]],
    );
  });

  it("finds ATX and Setext progress headings and enterprise tracker URLs", () => {
    assert.deepEqual(
      stockAt(
        "進捗状況\n====\n\n## ステータス詳細\nhttps://git.acme.test/team/repo/pull/42\nhttps://tracker.acme.test/browse/OPS-5\n",
      ),
      [
        [1, 1],
        [4, 1],
        [5, 1],
        [6, 1],
      ],
    );
  });

  it("does not take Jira-style IDs such as API-123 for work tracking", () => {
    assert.deepEqual(stockAt("UTF-8\nTLS-1\nAPI-123\nABC-12\n"), []);
  });

  it("tells HTTP and decision status from work progress", () => {
    assert.deepEqual(
      stockAt(
        "## HTTPステータス\nHTTPステータス: 200\n## ステータスコード\nステータス: 採用\n状態: 完了\n",
      ),
      [],
    );
    assert.deepEqual(
      stockAt("プルリクエスト#42\n進捗状況: 80%\nステータス: 実装中\n"),
      [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
    );
  });

  it("runs only for the flag", () => {
    const text = "PR #12\n";
    assert.equal(blockFindings(blockLines(text), TABLE).length, 0);
    assert.equal(
      blockFindings(blockLines(text), {
        stockBoundary: false,
        tableCells: false,
      }).length,
      0,
    );
    assert.equal(blockFindings(blockLines(text), STOCK).length, 1);
  });
});

describe("stock-boundary details", () => {
  it("ignores case in tracker URLs", () => {
    assert.equal(stockAt("https://jira.example.test/browse/dev-3").length, 1);
    assert.equal(stockAt("HTTPS://github.com/a/b/PULL/1").length, 1);
  });

  it("does not count the second slash of the scheme as the start of /pull/", () => {
    assert.deepEqual(stockAt("http://pull/1"), []);
  });

  it("reports the whole stretch up to the delimiter as the URL", () => {
    const found = blockFindings(
      blockLines("見る (https://github.com/a/b/pull/7?x=1#top) 以上"),
      STOCK,
    );
    assert.equal(found[0]?.text, "https://github.com/a/b/pull/7?x=1#top");
    assert.equal(found[0]?.column, 5);
  });

  it("accepts the differences from a syntax tree on purpose", () => {
    assert.deepEqual(stockAt("進捗:\n値"), []);
    assert.deepEqual(stockAt("PR\n#12"), []);
    assert.deepEqual(stockAt("a | b\n--|--\n| 61 字 |"), []);
  });

  it("does not make a heading of a table row or a list item before the underline", () => {
    assert.deepEqual(stockAt("| 進捗 |\n| --- |"), []);
    assert.deepEqual(stockAt("- 進捗\n---"), []);
  });

  it("does not join a heading and its underline across a dropped line", () => {
    assert.deepEqual(stockAt("進捗\n\n===="), []);
    assert.deepEqual(stockAt("進捗\n<!-- x -->\n----"), []);
  });

  it("reports a checkbox in a numbered or nested list at the marker", () => {
    assert.deepEqual(stockAt("1. [x] a\n- b\n    - [X] c\n- [ ]x"), [
      [1, 1],
      [3, 5],
    ]);
    const found = blockFindings(blockLines("  - [ ] 実装"), STOCK);
    assert.equal(found[0]?.text, "- [ ]");
    assert.equal(found[0]?.column, 3);
  });

  it("does not look inside a comment, so a keep note does not hit", () => {
    assert.deepEqual(
      stockAt("本文 <!-- ja-check-keep x -- PR #12 理由 -->"),
      [],
    );
  });

  it("holds the reasons fixed, with no text of the document", () => {
    const found = blockFindings(
      blockLines(`PR #12\n進捗: 秘密の値\n| ${"あ".repeat(61)} |\n`),
      BOTH,
    );
    assert.equal(found.length, 3);
    for (const item of found) {
      assert.ok(!item.reason.includes("PR #12"));
      assert.ok(!item.reason.includes("秘密"));
      assert.ok(!item.reason.includes("ああ"));
    }
    assert.match(found[2]?.reason ?? "", /^表のセルが61文字あります。/u);
  });
});

describe("table-cell-length", () => {
  it("accepts 60 characters and reports every cell at 61 or more, headers included", () => {
    const text = `| ${"あ".repeat(60)} | ${"い".repeat(61)} |\n| --- | --- |\n| ${"う".repeat(61)} | ${"え".repeat(62)} |\n| ${"お".repeat(60)} | 短い値 |\n`;
    assert.deepEqual(tableLines(text), [1, 3, 3]);
  });

  it("counts rendered text across formatting, links, references and inline code", () => {
    const short = "あ".repeat(60);
    const long = "い".repeat(61);
    const url = `https://example.test/${"path/".repeat(10)}`;
    const cells = [
      `**${short}**`,
      `[${short}](${url})`,
      `\`${short}\``,
      `**${long}**`,
      `[${long}](${url})`,
      `\`${long}\``,
      `[${long}][source]`,
      `<${url}>`,
      `*${"う".repeat(31)}*${"え".repeat(31)}`,
    ];
    const text = `| 説明 |\n| --- |\n${cells.map((cell) => `| ${cell} |`).join("\n")}\n\n[source]: ${url}\n`;
    assert.deepEqual(tableLines(text), [6, 7, 8, 9, 10, 11]);
  });

  it("uses graphemes, decodes entities and escapes, and trims only outer whitespace", () => {
    const cells = [
      "が".repeat(60),
      "👩‍💻".repeat(60),
      "&amp;".repeat(60),
      "\\|".repeat(60),
      `   ${"あ".repeat(60)}   `,
      "が".repeat(61),
      "👩‍💻".repeat(61),
      "&amp;".repeat(61),
      "\\|".repeat(61),
      `${"あ".repeat(30)} ${"い".repeat(30)}`,
    ];
    const text = `| 説明 |\n| --- |\n${cells.map((cell) => `| ${cell} |`).join("\n")}\n`;
    assert.deepEqual(tableLines(text), [8, 9, 10, 11, 12]);
  });

  it("keeps the length across a line break and HTML formatting in a cell", () => {
    const half = "あ".repeat(31);
    const text = `| 説明 |\n| --- |\n| ${half}<br>${half} |\n| <span>${half}</span><b>${half}</b> |\n`;
    assert.deepEqual(tableLines(text), [3, 4]);
  });

  it("leaves fenced examples, quotations and prose alone", () => {
    const table = `| 説明 |\n| --- |\n| ${"あ".repeat(61)} |`;
    const quoted = (prefix: string) =>
      table
        .split("\n")
        .map((line) => `${prefix}${line}`)
        .join("\n");
    const text = `\`\`\`md\n${table}\n\`\`\`\n\n${quoted("> ")}\n\n${quoted("> > ")}\n\n${"あ".repeat(61)}\n\n${table}\n`;
    const lines = tableLines(text);
    assert.deepEqual(lines, [text.trimEnd().split("\n").length]);
  });

  it("reports each cell with its own column and text", () => {
    const first = "あ".repeat(61);
    const second = "い".repeat(61);
    const found = blockFindings(
      blockLines(`| a |\n| --- |\n| ${first} | ${second} |`),
      TABLE,
    );
    assert.deepEqual(
      found.map((item) => [item.line, item.column, item.text]),
      [
        [3, 3, first],
        [3, 67, second],
      ],
    );
  });

  it("shows the text of a link, a reference link and an image, and not their destinations", () => {
    const url = `https://example.test/${"x".repeat(80)}`;
    const text = `| h |\n| --- |\n| [${"あ".repeat(60)}](${url}) |\n| [${"あ".repeat(60)}][r] |\n| ![${"あ".repeat(60)}](${url}) |\n`;
    assert.deepEqual(tableLines(text), []);
    const over = `| h |\n| --- |\n| ![${"あ".repeat(61)}](a.png) |\n`;
    assert.deepEqual(tableLines(over), [3]);
  });

  it("counts a bare URL and keeps snake_case underscores while dropping emphasis ones", () => {
    const bare = `https://example.test/${"a_b".repeat(20)}`;
    assert.deepEqual(tableLines(`| h |\n| --- |\n| ${bare} |`), [3]);
    const snake = `${"a_b".repeat(20)}`;
    assert.deepEqual(tableLines(`| h |\n| --- |\n| ${snake} |`), []);
    assert.deepEqual(
      tableLines(`| h |\n| --- |\n| __${"あ".repeat(60)}__ |`),
      [],
    );
  });

  it("does not report a table with no leading pipe or a row inside a list continuation without a marker", () => {
    assert.deepEqual(
      tableLines(`a | ${"あ".repeat(61)}\n--|--\n${"あ".repeat(61)} | b`),
      [],
    );
    assert.deepEqual(tableLines(`- a\n    | ${"あ".repeat(61)} |`), []);
  });

  it("runs only for the flag", () => {
    const text = `| ${"あ".repeat(61)} |`;
    assert.equal(blockFindings(blockLines(text), STOCK).length, 0);
    assert.equal(blockFindings(blockLines(text), TABLE).length, 1);
  });
});

describe("inactiveBlockRules", () => {
  it("lists the rules that do not run for the flags", () => {
    assert.deepEqual(inactiveBlockRules(undefined), [
      "stock-boundary",
      "table-cell-length",
    ]);
    assert.deepEqual(inactiveBlockRules(STOCK), ["table-cell-length"]);
    assert.deepEqual(inactiveBlockRules(TABLE), ["stock-boundary"]);
    assert.deepEqual(inactiveBlockRules(BOTH), []);
  });
});

describe("tanteki document types map to profile rows", () => {
  // The seven kinds of the tanteki entry point and the profile each one uses.
  const MAP: Array<[string, string, boolean, boolean]> = [
    ["design-doc", "design", true, true],
    ["prd", "design", true, true],
    ["adr", "design", true, true],
    ["rfc", "design", true, true],
    ["stock", "reference", true, true],
    ["flow", "procedure", false, true],
    ["record", "report", false, true],
  ];
  it("turns the two checks on and off as the old --type did", () => {
    const loaded = loadProfiles();
    assert.ok(loaded.ok);
    const text = `PR #12\n\n| h |\n| --- |\n| ${"あ".repeat(61)} |\n`;
    for (const [kind, profile, stock, table] of MAP) {
      const row = loaded.rows.find((item) => item.id === profile);
      assert.ok(row, kind);
      const found = blockFindings(blockLines(text), {
        stockBoundary: row.stockBoundary,
        tableCells: row.tableCells,
      });
      assert.equal(
        found.filter((item) => item.rule === "stock-boundary").length,
        stock ? 1 : 0,
        kind,
      );
      assert.equal(
        found.filter((item) => item.rule === "table-cell-length").length,
        table ? 1 : 0,
        kind,
      );
    }
  });
});

describe("check with --profile through the CLI", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-check-blocks-")),
  );
  after(() => rmSync(root, { recursive: true, force: true }));
  const cli = fileURLToPath(
    new URL("../../../japanese-check/cli.ts", import.meta.url),
  );
  let number = 0;

  function run(content: string, args: string[], record = false) {
    const key = ++number;
    const home = join(root, `home-${key}`);
    const file = join(root, `doc-${key}.md`);
    writeFileSync(file, content);
    const result = spawnSync(
      process.execPath,
      [cli, "check", file, ...args, ...(record ? [] : ["--no-record"])],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: home, ...runtimeEnv() },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as {
      findings: { rule: string }[];
      kept: unknown[];
      keepIssues: { problem: string }[];
      verification: { receipt?: { candidates?: number } } | null;
    };
  }
  const count = (
    report: { findings: { rule: string }[] },
    rule: string,
  ): number => report.findings.filter((item) => item.rule === rule).length;
  const DOC = `PR #12\n\n| h |\n| --- |\n| ${"あ".repeat(61)} |\n`;

  it("turns the two checks on by the profile row", needsRuntime, () => {
    const design = run(DOC, ["--profile", "design"]);
    assert.equal(count(design, "stock-boundary"), 1);
    assert.equal(count(design, "table-cell-length"), 1);
    const procedure = run(DOC, ["--profile", "procedure"]);
    assert.equal(count(procedure, "stock-boundary"), 0);
    assert.equal(count(procedure, "table-cell-length"), 1);
    for (const args of [["--profile", "book"], []]) {
      const off = run(DOC, args);
      assert.equal(count(off, "stock-boundary"), 0);
      assert.equal(count(off, "table-cell-length"), 0);
    }
    const adhd = run(DOC, ["--profile", "design", "--reader", "adhd"]);
    assert.equal(count(adhd, "stock-boundary"), 1);
    assert.equal(count(adhd, "table-cell-length"), 1);
  });

  it("counts the two checks in the receipt", needsRuntime, () => {
    const withProfile = run(DOC, ["--profile", "design"], true);
    const without = run(DOC, ["--profile", "book"], true);
    const gap =
      (withProfile.verification?.receipt?.candidates ?? 0) -
      (without.verification?.receipt?.candidates ?? 0);
    assert.equal(gap, 2);
  });

  it(
    "keeps a candidate with a marker and ignores a marker for a rule that did not run",
    needsRuntime,
    () => {
      const doc =
        "- a\n    - [ ] 実装 <!-- ja-check-keep stock-boundary -- - [ ] 理由 -->\n";
      const kept = run(doc, ["--profile", "design"]);
      assert.equal(kept.kept.length, 1);
      assert.deepEqual(kept.keepIssues, []);
      for (const args of [["--profile", "procedure"], []]) {
        const skipped = run(doc, args);
        assert.deepEqual(skipped.keepIssues, [], args.join(" "));
      }
    },
  );

  it(
    "reports a marker on a nested list item as having no candidate, since the other checks never read that line",
    needsRuntime,
    () => {
      const doc =
        "- 項目\n    - レバレッジを効かせる <!-- ja-check-keep word-jargon -- レバレッジ 理由 -->\n";
      const report = run(doc, []);
      assert.deepEqual(report.kept, []);
      assert.equal(report.keepIssues.length, 1);
    },
  );

  it(
    "leaves the output without --profile as before for a document with no nested list or definition",
    needsRuntime,
    () => {
      const doc = MIXED_DOC;
      const report = run(doc, []);
      assert.equal(count(report, "stock-boundary"), 0);
      assert.equal(count(report, "table-cell-length"), 0);
    },
  );
});
