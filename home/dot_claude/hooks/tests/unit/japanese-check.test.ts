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
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { findDependency } from "../../../japanese-check/deps.ts";
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
  const sudachi = findDependency("sudachi");
  assert.ok(sudachi.ok);
  const tokenizer = createTokenizer(sudachi.entry);

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

  it("finds inflected 効く even when the dictionary normalizes its spelling", async () => {
    const findings = calques(proseLines("薬が効いた。"), await tokenizer);
    assert.ok(findings.some((item) => item.text === "効い"));
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

  it("supports an unrecorded check and requires explicit review of actual findings", async () => {
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
  });

  it("tracks the final artifact instead of the extracted text", async () => {
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
      assert.deepEqual(tracked("artifact-session", stateDir).paths, [artifact]);
      assert.equal(verify(artifact, stateDir).status, "ready");
      writeFileSync(artifact, "artifact-v2");
      assert.equal(verify(artifact, stateDir).status, "stale");
    } finally {
      output.mock.restore();
    }
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
  });
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

  // tokenizer.ts loads the dictionary package by the resolved file path that
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
  const root = mkdtempSync(join(tmpdir(), "japanese-check-state-"));
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
  const dir = mkdtempSync(join(tmpdir(), "japanese-check-profile-"));
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

  it("leaves the output without --profile exactly as it was", async () => {
    const doc = fresh(longSentence);
    const report = await run(["check", doc.file, "--no-record"], doc.stateDir);
    assert.ok(!("profile" in report));
    assert.ok(flagged(report));
  });

  it("uses the row's genre and reports the profile", async () => {
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

  it("takes --genre only when the row has no genre", async () => {
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
  const dir = mkdtempSync(join(tmpdir(), "japanese-check-receipt-profile-"));
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

  it("writes the three fields only for a --profile check, never null", async () => {
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
  });

  it("keeps the fields on a review and drops them on a deferral", async () => {
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
  });

  it("carries a review over only to a check with the same profile", async () => {
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
  });

  it("does not carry a review to another row that resolves to the same list and genre", async () => {
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
  });

  it("treats malformed profile fields as a broken receipt and null as absent", async () => {
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
  });

  it("reads a receipt of the older shape that has none of the fields", async () => {
    const doc = fresh();
    await check(doc);
    const receipt: Receipt = rawReceipt(doc);
    assert.equal(receipt.schema, 1);
    assert.equal(verify(doc.file, doc.stateDir).receipt?.schema, 1);
  });
});

describe("checker version", () => {
  const checkerSource = fileURLToPath(
    new URL("../../../japanese-check/", import.meta.url),
  );
  const root = mkdtempSync(join(tmpdir(), "japanese-check-version-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  let number = 0;

  function copy() {
    const dir = join(root, `case-${++number}`, "japanese-check");
    cpSync(checkerSource, dir, { recursive: true });
    clearCheckerVersionCache();
    return dir;
  }
  function fakeSudachi(dir: string) {
    const pkg = join(dir, "node_modules", "sudachi");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "sudachi", version: "9.9.9", main: "index.js" }),
    );
    writeFileSync(join(pkg, "index.js"), "module.exports = {};\n");
  }
  const hashOf = (dir: string, deps: readonly DependencyEntry[] = []) => {
    clearCheckerVersionCache();
    return checkerVersion({ dir, deps });
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
    const deps: DependencyEntry[] = [{ name: "sudachi", group: "analyzer" }];
    const without = hashOf(dir, deps);
    assert.deepEqual(without.missing, ["sudachi"]);
    fakeSudachi(dir);
    const withPackage = hashOf(dir, deps);
    assert.deepEqual(withPackage.missing, []);
    assert.notEqual(withPackage.hash, without.hash);
  });

  it("hashes its own directory by default, wherever the copy sits", () => {
    const dir = copy();
    const script = join(dir, "..", "print-version.mjs");
    writeFileSync(
      script,
      `import { checkerVersion } from ${JSON.stringify(join(dir, "receipts.ts"))};\nconsole.log(JSON.stringify(checkerVersion()));\n`,
    );
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      cwd: tmpdir(),
    });
    assert.equal(result.status, 0, result.stderr);
    const printed = JSON.parse(result.stdout) as { hash: string };
    assert.equal(
      printed.hash,
      hashOf(dir, [{ name: "sudachi", group: "analyzer" }]).hash,
    );
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
  const root = mkdtempSync(join(tmpdir(), "japanese-check-incomplete-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  let number = 0;

  // One analyzer package is present; the grammar one never is.
  const deps: DependencyEntry[] = [
    { name: "sudachi", group: "analyzer" },
    { name: "absent-grammar", group: "grammar" },
  ];
  const completeDeps: DependencyEntry[] = [deps[0] as DependencyEntry];

  function fixture(content = "データを拾った。\n") {
    const key = ++number;
    const dir = join(root, `case-${key}`, "japanese-check");
    cpSync(checkerSource, dir, { recursive: true });
    const pkg = join(dir, "node_modules", "sudachi");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "sudachi", version: "9.9.9", main: "index.js" }),
    );
    writeFileSync(join(pkg, "index.js"), "module.exports = {};\n");
    const file = join(root, `doc-${key}.md`);
    writeFileSync(file, content);
    clearCheckerVersionCache();
    return { dir, file, content, stateDir: join(root, `state-${key}`) };
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
      deps,
    });
    assert.equal(
      verify(f.file, f.stateDir, { dir: f.dir, deps: completeDeps }).status,
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
      { dir: f.dir, deps },
    );
    assert.equal(reviewed.status, "ready");
    assert.equal(record(f, { candidates: 1, deps }).status, "needs-review");
  });

  it("carries a review only while the number of candidates stays the same", () => {
    const f = fixture();
    record(f, { candidates: 1, deps: completeDeps });
    recordDecision(f.file, digest(f.content), "残す", "checked", f.stateDir, {
      dir: f.dir,
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
  const forbidden = new Set(["tokenizer.ts", "analyze.ts", "cli.ts"]);

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

  it("keeps the tokenizer, analyzer, cli and sudachi out of what hooks and CI import", () => {
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

  it("has a single computed import(), in tokenizer.ts", () => {
    const computed = /import\(\s*[^"'\s)]/gu;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const count = [
        ...readFileSync(join(dir, name), "utf8").matchAll(computed),
      ].length;
      assert.equal(count, name === "tokenizer.ts" ? 1 : 0, name);
    }
  });
});
