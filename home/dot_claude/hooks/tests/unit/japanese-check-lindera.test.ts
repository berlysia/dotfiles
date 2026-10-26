// The lindera-unidic adapter against the real analyzer and dictionary. The
// runtime comes from JAPANESE_CHECK_RUNTIME_DIR or ~/.config/japanese-check
// (CI builds it; see scripts/fetch-japanese-check-dictionary.sh).
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  ANALYZER_DEPENDENCIES,
  ANALYZER_IDENTITY,
  DICTIONARY_FILE_HASHES,
  createAnalyzer,
  dictionaryIdentity,
  mapConjugation,
  mapPartOfSpeech,
  mergeAsciiRuns,
  platformPackageName,
} from "../../../japanese-check/adapter-lindera-unidic.ts";
import {
  AnalyzerOutputError,
  isNoun,
  isProperNoun,
  isVerb,
  lemmaClass,
  validateTokens,
} from "../../../japanese-check/contract.ts";
import type { AnalyzedToken } from "../../../japanese-check/contract.ts";
import {
  RUNTIME_DIR,
  RUNTIME_PRESENT,
  needsRuntime,
} from "../support/japanese-check-runtime.ts";

const entryOf = (runtime: string) =>
  realpathSync(join(runtime, "node_modules/lindera/index.js"));

// Created only when the runtime exists: a top-level await that throws would
// fail the whole file, including the suites that need no runtime. Without the
// runtime the suites that use it are skipped (or, in CI, fail; see needsRuntime).
const analyzer = RUNTIME_PRESENT
  ? await createAnalyzer(entryOf(RUNTIME_DIR), RUNTIME_DIR)
  : (): never => {
      throw new Error("the japanese-check runtime is missing");
    };
const analyze = (text: string) => validateTokens(text, analyzer(text));
const find = (text: string, surface: string) => {
  const token = analyze(text).find((item) => item.surface === surface);
  assert.ok(token, `${surface} in ${text}`);
  return token;
};

const scratch: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jc-lindera-")));
  scratch.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the runtime that a test may damage. */
function copyRuntime(): string {
  const dir = tempDir();
  cpSync(join(RUNTIME_DIR, "node_modules"), join(dir, "node_modules"), {
    recursive: true,
  });
  cpSync(join(RUNTIME_DIR, "unidic"), join(dir, "unidic"), {
    recursive: true,
  });
  return dir;
}

describe("lindera-unidic: words", needsRuntime, () => {
  it("returns the dictionary form of a verb and its conjugation", () => {
    const token = find("薬が効いた。", "効い");
    assert.equal(token.lemma, "効く");
    assert.ok(isVerb(token));
    assert.deepEqual(token.conjugation, { kind: "godan", row: "ka" });
    const picked = find("データを拾った。", "拾っ");
    assert.equal(picked.lemma, "拾う");
    assert.deepEqual(picked.conjugation, { kind: "godan", row: "wa" });
  });

  it("marks a proper noun and an adjectival noun", () => {
    assert.ok(isProperNoun(find("京都に行く。", "京都")));
    assert.equal(
      lemmaClass(find("ロバストな設計。", "ロバスト")),
      "adjectivalNoun",
    );
  });

  it("makes an ASCII run one noun", () => {
    for (const [text, word] of [
      ["API の設計。", "API"],
      ["IPv6 で接続する。", "IPv6"],
      ["Java を使う。", "Java"],
    ] as const) {
      const token = find(text, word);
      assert.ok(isNoun(token), word);
      assert.equal(token.lemma, word);
    }
  });
});

describe("lindera-unidic: mergeAsciiRuns", () => {
  const fake = (surface: string, start: number): AnalyzedToken => ({
    surface,
    start,
    end: start + surface.length,
    lemma: surface,
    pos: "other",
  });
  const run = (...surfaces: string[]) => {
    let at = 0;
    return surfaces.map((surface) => {
      const token = fake(surface, at);
      at += surface.length;
      return token;
    });
  };

  it("merges single letters and digits that touch, with a letter among them", () => {
    const merged = mergeAsciiRuns(run("A", "P", "I", "2"));
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.surface, "API2");
    assert.equal(merged[0]?.pos, "noun");
    assert.equal(merged[0]?.lemma, "API2");
    assert.equal(merged[0]?.start, 0);
    assert.equal(merged[0]?.end, 4);
  });

  it("does not merge a word of two or more characters, full-width letters or digits only", () => {
    assert.equal(mergeAsciiRuns(run("Vue", "3")).length, 2);
    assert.equal(mergeAsciiRuns(run("Ａ", "Ｂ")).length, 2);
    assert.equal(mergeAsciiRuns(run("1", "2")).length, 2);
  });

  it("does not merge tokens that do not touch", () => {
    const apart = [fake("A", 0), { ...fake("B", 2) }];
    assert.equal(mergeAsciiRuns(apart).length, 2);
  });
});

describe("lindera-unidic: mapping", () => {
  it("maps parts of speech", () => {
    assert.equal(mapPartOfSpeech("名詞", "普通名詞"), "noun");
    assert.equal(mapPartOfSpeech("名詞", "固有名詞"), "properNoun");
    assert.equal(mapPartOfSpeech("代名詞", ""), "other");
    assert.equal(mapPartOfSpeech("助詞", "接続助詞"), "conjunctiveParticle");
    assert.equal(mapPartOfSpeech("助詞", "格助詞"), "particle");
    assert.equal(mapPartOfSpeech("接尾辞", ""), "suffix");
    assert.equal(mapPartOfSpeech("空白", ""), "symbol");
    assert.equal(mapPartOfSpeech("副詞", ""), "other");
  });

  it("maps conjugations", () => {
    assert.deepEqual(mapConjugation("五段-ワア行"), {
      kind: "godan",
      row: "wa",
    });
    assert.deepEqual(mapConjugation("上一段-カ行"), { kind: "kamiIchidan" });
    assert.deepEqual(mapConjugation("サ行変格"), { kind: "sahen" });
    assert.equal(mapConjugation("*"), undefined);
  });
});

describe("lindera-unidic: positions", needsRuntime, () => {
  it("returns tokens that pass validateTokens for wide and combining characters", () => {
    for (const text of ["𠮷野家の見落とし", "ｶﾞ", "😀︎", "ＡＢＣ", "が"])
      assert.doesNotThrow(() => analyze(text), text);
  });

  it("analyzes a 888-character line (the time bound is in perf/japanese-check-words.test.ts)", () => {
    const line = "データを拾って、薬が効いた。".repeat(64).slice(0, 888);
    assert.equal(line.length, 888);
    assert.ok(analyze(line).length > 0);
  });
});

describe("lindera-unidic: identity", () => {
  it("lists only lindera and derives the dictionary identity from the file hashes", () => {
    assert.deepEqual(ANALYZER_DEPENDENCIES, [
      { name: "lindera", group: "analyzer" },
    ]);
    assert.equal(ANALYZER_IDENTITY.engine, "lindera-unidic");
    assert.equal(ANALYZER_IDENTITY.dictionary, dictionaryIdentity());
    assert.equal(Object.keys(DICTIONARY_FILE_HASHES).length, 10);
    const changed = { ...DICTIONARY_FILE_HASHES, "unk.bin": "0".repeat(64) };
    assert.notEqual(dictionaryIdentity(changed), ANALYZER_IDENTITY.dictionary);
  });

  it("names the native package of this platform", () => {
    assert.equal(platformPackageName("linux", "x64"), "lindera-linux-x64-gnu");
    assert.equal(
      platformPackageName("darwin", "arm64"),
      "lindera-darwin-arm64",
    );
    assert.equal(platformPackageName("darwin", "x64"), "lindera-darwin-x64");
    assert.equal(
      platformPackageName("linux", "arm64"),
      "lindera-linux-arm64-gnu",
    );
  });
});

describe("lindera-unidic: failures are fixed text", needsRuntime, () => {
  const rejects = async (runtime: string, entry = entryOf(RUNTIME_DIR)) => {
    await assert.rejects(createAnalyzer(entry, runtime), (error: unknown) => {
      assert.ok(error instanceof AnalyzerOutputError);
      assert.ok(!error.message.includes(runtime));
      assert.ok(!error.message.includes("/"));
      return true;
    });
  };

  it("rejects a dictionary file that was rewritten", async () => {
    const runtime = copyRuntime();
    writeFileSync(join(runtime, "unidic/unk.bin"), "tampered");
    await rejects(runtime, entryOf(runtime));
  });

  it("rejects a missing dictionary directory", async () => {
    const runtime = tempDir();
    cpSync(join(RUNTIME_DIR, "node_modules"), join(runtime, "node_modules"), {
      recursive: true,
    });
    await rejects(runtime, entryOf(runtime));
  });

  it("rejects a runtime without the native package of this platform", async () => {
    const runtime = copyRuntime();
    rmSync(join(runtime, "node_modules", platformPackageName()), {
      recursive: true,
    });
    await rejects(runtime, entryOf(runtime));
  });

  it("rejects a lindera whose version differs from the pinned one", async () => {
    const runtime = copyRuntime();
    const path = join(runtime, "node_modules/lindera/package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    manifest.version = "0.0.1";
    writeFileSync(path, JSON.stringify(manifest));
    await rejects(runtime, entryOf(runtime));
  });

  it("rejects an entry outside the runtime's node_modules", async () => {
    const runtime = copyRuntime();
    const other = tempDir();
    mkdirSync(join(other, "lindera"));
    writeFileSync(join(other, "lindera/index.js"), "export {};");
    await rejects(runtime, join(other, "lindera/index.js"));
  });
});
