import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
  recordCheck,
  verify,
} from "../../../japanese-check/receipts.ts";
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

  // tokenizer.ts loads the sudachi dictionary package lazily; it is the one
  // declared dependency, not a path into another directory.
  it("imports only node: built-ins, sudachi and sibling files", () => {
    assert.ok(files.length > 0);
    for (const name of files) {
      for (const specifier of specifiers(readFileSync(join(dir, name), "utf8")))
        assert.match(
          specifier,
          /^(?:node:|sudachi$|\.\/[^/]+\.ts$)/u,
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

  it("hashes state.ts but not tracking.ts into the checker version", () => {
    assert.ok(CHECKER_VERSION_FILES.includes("state.ts"));
    assert.ok(!CHECKER_VERSION_FILES.includes("tracking.ts"));
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
    recordCheck(file, digest("文書です。\n"), "文書です。\n", 0, stateDir);
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
