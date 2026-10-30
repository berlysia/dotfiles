// Slow japanese-check tests: each one runs the checker's main() in process and
// loads the lindera analyzer and the UniDic dictionary again, which costs about
// 150 ms per call, so a describe with several calls takes seconds.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it, mock } from "node:test";
import { calques } from "../../../japanese-check/analyze.ts";
import { main, parseArguments } from "../../../japanese-check/cli.ts";
import { parseMarker } from "../../../japanese-check/keep.ts";
import { proseLines } from "../../../japanese-check/markdown.ts";
import { recordDecision, verify } from "../../../japanese-check/receipts.ts";
import type { Receipt } from "../../../japanese-check/receipts.ts";
import { WORD_LIST_SCHEMA } from "../../../japanese-check/words.ts";
import { digest } from "../../../japanese-check/state.ts";
import {
  createTestTokenizer,
  needsRuntime,
} from "../support/japanese-check-runtime.ts";
import { rawEntry, reviewFrom } from "../support/japanese-check-words.ts";

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
      await check(doc, "--profile", "rewrite-default", "--genre", "essay");
      decide(doc, "review");
      const same = await check(
        doc,
        "--profile",
        "rewrite-default",
        "--genre",
        "essay",
      );
      assert.equal(same.status, "ready");
      const other = await check(doc, "--profile", "essay");
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
