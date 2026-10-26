// The adapter for lindera with the UniDic dictionary: the only place that knows
// its output format, its part-of-speech names and its conjugation names. Static
// imports are `node:` and ./contract.ts only; the analyzer package is loaded by
// the one computed import inside createAnalyzer, from the file deps.ts resolved.
//
// What is pinned where (the version of lindera lives in the runtime's
// package.json and bun.lock, the zip's version and sha256 in
// home/.chezmoidata/japanese_check.yaml; a test checks that they agree):
// - LINDERA_VERSION: the version createAnalyzer demands of the resolved package
// - DICTIONARY_FILE_HASHES: the sha256 of each extracted dictionary file, checked
//   right before the dictionary is loaded. The zip's hash guards the download;
//   this is the only guard on the files after extraction.
// - the dictionary identity: derived from those hashes, so it cannot drift from
//   what is checked. It goes into the checker hash and the output.

import { createHash } from "node:crypto";
import {
  createReadStream,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { AnalyzerOutputError } from "./contract.ts";
import type {
  AnalyzedToken,
  ConjugationKind,
  PartOfSpeech,
} from "./contract.ts";

export const LINDERA_VERSION = "6.2.0";

// Only lindera is listed. The native package for the platform is not: listing it
// would make the checker hash differ per OS. Its bytes are fixed by the integrity
// lines in bun.lock and `bun install --frozen-lockfile`.
export const ANALYZER_DEPENDENCIES: ReadonlyArray<{
  name: string;
  group: "analyzer";
}> = [{ name: "lindera", group: "analyzer" }];

export const DICTIONARY_FILE_HASHES: Readonly<Record<string, string>> = {
  "NOTICE.txt":
    "eea323c4928ad00819113a4dd3547964d33b40c62eb9478bb7d2d202cf235c3c",
  "char_def.bin":
    "fc47b7472f9a66bd02754d9214bd9362ca194d5d4e3326bca1c2cb0b958ce1b3",
  "dict.trie":
    "df37d906a7c27da61afab98883617694b67f51e09336c528168bdb675d25db8c",
  "dict.vals":
    "268e226a3b7ce49c6a72f41e87eb359fdbc39f35d5807f11e276faf06164451f",
  "dict.valsidx":
    "daba3721e79b27a78d65668f2672315341e42c834ef3d893d3e1d46a499c5680",
  "dict.words":
    "2f764678d3e0a5d1eeca84ab13c6c0d52b880cc19df8e43a48a8d5fdde281b34",
  "dict.wordsidx":
    "6b979e3e8fe7379c7f647d581c18d5e09ffcb7048a8990424a76382f56cf7d09",
  "matrix.mtx":
    "877844021e97b81429972fa3bc327f9b343112ff3d19a767a582a29dd4d1e3aa",
  "metadata.json":
    "7e0a11dcfc299c8056815c2ab53e348214824e9380f0e7e457bfbb01936b7d25",
  "unk.bin": "bb56ce6a509341e1b4ee276eda917e176684989931acac1e7f3c4f1038c481f0",
};

/** One value for the whole dictionary: the sha256 of the sorted `name:sha` lines. */
export function dictionaryIdentity(
  hashes: Readonly<Record<string, string>> = DICTIONARY_FILE_HASHES,
): string {
  const lines = Object.keys(hashes)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => `${name}:${hashes[name]}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export const ANALYZER_IDENTITY: Readonly<{
  engine: "lindera-unidic";
  version: string;
  dictionary: string;
}> = {
  engine: "lindera-unidic",
  version: LINDERA_VERSION,
  dictionary: dictionaryIdentity(),
};

const MAX_PACKAGE_JSON_BYTES = 64 * 1024;

// The native packages lindera's loader requires, by Node's platform and arch.
const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "lindera-darwin-arm64",
  "darwin-x64": "lindera-darwin-x64",
  "linux-x64": "lindera-linux-x64-gnu",
  "linux-arm64": "lindera-linux-arm64-gnu",
};

export function platformPackageName(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return (
    PLATFORM_PACKAGES[`${platform}-${arch}`] ?? `lindera-${platform}-${arch}`
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function within(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

const GODAN_ROWS: Record<
  string,
  Extract<ConjugationKind, { kind: "godan" }>["row"]
> = {
  カ: "ka",
  ガ: "ga",
  サ: "sa",
  タ: "ta",
  ナ: "na",
  バ: "ba",
  マ: "ma",
  ラ: "ra",
  ワ: "wa",
  ワア: "wa",
};

export function mapPartOfSpeech(major: string, minor: string): PartOfSpeech {
  switch (major) {
    case "名詞":
      return minor === "固有名詞" ? "properNoun" : "noun";
    case "動詞":
      return "verb";
    case "形容詞":
      return "adjective";
    case "形状詞":
      return "adjectivalNoun";
    case "助詞":
      return minor === "接続助詞" ? "conjunctiveParticle" : "particle";
    case "助動詞":
      return "auxiliary";
    case "接尾辞":
      return "suffix";
    case "補助記号":
    case "記号":
    case "空白":
      return "symbol";
    // A pronoun is "other", not "noun": the checks never treated it as a noun.
    default:
      return "other";
  }
}

export function mapConjugation(form: string): ConjugationKind | undefined {
  const godan = /^五段-(.+?)行/u.exec(form);
  if (godan) {
    const row = GODAN_ROWS[godan[1] ?? ""];
    return row ? { kind: "godan", row } : undefined;
  }
  if (form.startsWith("上一段")) return { kind: "kamiIchidan" };
  if (form.startsWith("下一段")) return { kind: "shimoIchidan" };
  if (form.startsWith("サ行変格")) return { kind: "sahen" };
  if (form.startsWith("カ行変格")) return { kind: "kahen" };
  if (form === "形容詞") return { kind: "adjective" };
  return undefined;
}

const ASCII_UNIT = /^[A-Za-z0-9]$/u;
const ASCII_LETTER = /[A-Za-z]/u;

/**
 * UniDic splits "API" into A, P, I and "IPv6" into I, P, v, 6. A run of adjacent
 * tokens that are each one half-width letter or digit, with at least one letter,
 * becomes one noun whose lemma is its surface. A token of two or more characters
 * ends a run and is never merged (Vue, 3 stay as they are).
 */
export function mergeAsciiRuns(
  tokens: readonly AnalyzedToken[],
): AnalyzedToken[] {
  const out: AnalyzedToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i] as AnalyzedToken;
    if (!ASCII_UNIT.test(first.surface)) {
      out.push(first);
      continue;
    }
    let last = i;
    while (last + 1 < tokens.length) {
      const next = tokens[last + 1] as AnalyzedToken;
      const before = tokens[last] as AnalyzedToken;
      if (!ASCII_UNIT.test(next.surface) || next.start !== before.end) break;
      last++;
    }
    const run = tokens.slice(i, last + 1);
    if (run.length > 1 && run.some((item) => ASCII_LETTER.test(item.surface))) {
      const surface = run.map((item) => item.surface).join("");
      out.push({
        surface,
        start: first.start,
        end: (run[run.length - 1] as AnalyzedToken).end,
        lemma: surface,
        pos: "noun",
      });
      i = last;
    } else {
      out.push(first);
    }
  }
  return out;
}

/** UTF-8 byte offset to UTF-16 offset, for the offsets on a character boundary. */
function byteOffsets(text: string): Map<number, number> {
  const map = new Map<number, number>();
  let bytes = 0;
  let units = 0;
  for (const char of text) {
    map.set(bytes, units);
    bytes += Buffer.byteLength(char, "utf8");
    units += char.length;
  }
  map.set(bytes, units);
  return map;
}

interface LinderaToken {
  surface: string;
  byteStart: number;
  byteEnd: number;
  details: string[];
}

function linderaTokens(value: unknown): LinderaToken[] {
  if (!Array.isArray(value))
    throw new AnalyzerOutputError("lindera の出力が配列ではありません。");
  for (const item of value) {
    if (
      !record(item) ||
      typeof item.surface !== "string" ||
      !Number.isInteger(item.byteStart) ||
      !Number.isInteger(item.byteEnd) ||
      !Array.isArray(item.details) ||
      !item.details.every((part: unknown) => typeof part === "string")
    )
      throw new AnalyzerOutputError("lindera の形態素データが不正です。");
  }
  return value as LinderaToken[];
}

export function decodeTokens(raw: unknown, text: string): AnalyzedToken[] {
  const offsets = byteOffsets(text);
  const decoded: AnalyzedToken[] = [];
  for (const item of linderaTokens(raw)) {
    const start = offsets.get(item.byteStart);
    const end = offsets.get(item.byteEnd);
    if (start === undefined || end === undefined)
      throw new AnalyzerOutputError(
        "lindera の形態素と入力位置を対応できません。",
      );
    // A token of no length carries nothing to check.
    if (end <= start) continue;
    const details = item.details;
    const base = details[10];
    const conjugation = mapConjugation(details[4] ?? "");
    decoded.push({
      surface: item.surface,
      start,
      end,
      // The dictionary form with its written form kept; `*` means none.
      lemma: base && base !== "*" ? base : item.surface,
      pos: mapPartOfSpeech(details[0] ?? "", details[1] ?? ""),
      ...(conjugation === undefined ? {} : { conjugation }),
    });
  }
  return mergeAsciiRuns(decoded);
}

const RUNTIME_MISSING = "解析器の実行環境が見つかりません。";
const DICTIONARY_INVALID = "辞書が固定値と一致しません。";
const PACKAGE_MISMATCH = "解析器のパッケージが想定と違います。";

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// The package that holds `entry`, found by walking up to the first package.json.
function packageManifestFor(
  entry: string,
  nodeModules: string,
): Record<string, unknown> | null {
  for (let dir = dirname(entry); within(dir, nodeModules); dir = dirname(dir)) {
    let bytes: Buffer;
    try {
      const path = join(dir, "package.json");
      if (statSync(path).size > MAX_PACKAGE_JSON_BYTES) return null;
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    try {
      const manifest: unknown = JSON.parse(bytes.toString("utf8"));
      return record(manifest) ? manifest : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * `entry` is the resolved file of the lindera package found by deps.ts and
 * `runtimeDir` the directory it was found in. Four checks run, in this order,
 * right before the load: the native package for this platform is under
 * runtimeDir/node_modules (so Node does not go looking in a directory above);
 * the dictionary directory is under runtimeDir and its 10 files match the pinned
 * hashes; the resolved package has the pinned version; then the package is
 * imported from `entry` and the dictionary read from the directory that was
 * checked. A swap between the check and the load is accepted (spec R7: a single
 * user owns the runtime directory, and the cli checks owner and mode).
 */
export async function createAnalyzer(
  entry: string,
  runtimeDir: string,
): Promise<(text: string) => AnalyzedToken[]> {
  const root = realpathOrNull(runtimeDir);
  const nodeModules = root && realpathOrNull(join(root, "node_modules"));
  const nativeDir =
    nodeModules && realpathOrNull(join(nodeModules, platformPackageName()));
  if (
    !root ||
    !nodeModules ||
    !nativeDir ||
    !within(nodeModules, root) ||
    !within(nativeDir, nodeModules)
  )
    throw new AnalyzerOutputError(RUNTIME_MISSING);

  const dictionaryDir = realpathOrNull(join(root, "unidic"));
  if (!dictionaryDir || !within(dictionaryDir, root))
    throw new AnalyzerOutputError(DICTIONARY_INVALID);
  for (const [name, expected] of Object.entries(DICTIONARY_FILE_HASHES)) {
    const file = realpathOrNull(join(dictionaryDir, name));
    let actual: string | null = null;
    if (file && within(file, dictionaryDir)) {
      try {
        actual = await sha256OfFile(file);
      } catch {
        actual = null;
      }
    }
    if (actual !== expected) throw new AnalyzerOutputError(DICTIONARY_INVALID);
  }

  const resolvedEntry = realpathOrNull(entry);
  if (!resolvedEntry || !within(resolvedEntry, nodeModules))
    throw new AnalyzerOutputError(PACKAGE_MISMATCH);
  const manifest = packageManifestFor(resolvedEntry, nodeModules);
  if (
    !manifest ||
    manifest.name !== "lindera" ||
    manifest.version !== LINDERA_VERSION
  )
    throw new AnalyzerOutputError(PACKAGE_MISMATCH);

  // Lazy import keeps structural commands independent of the large dictionary.
  // The specifier is the file that was checked: a bare "lindera" would be
  // resolved from this file's own location.
  let tokenizer: { tokenize: (text: string) => unknown };
  try {
    const loaded: unknown = await import(pathToFileURL(resolvedEntry).href);
    if (
      !record(loaded) ||
      typeof loaded.Tokenizer !== "function" ||
      typeof loaded.loadDictionary !== "function"
    )
      throw new Error("shape");
    const dictionary = (loaded.loadDictionary as (path: string) => unknown)(
      dictionaryDir,
    );
    tokenizer = new (loaded.Tokenizer as new (
      dictionary: unknown,
      mode: string,
    ) => { tokenize: (text: string) => unknown })(dictionary, "normal");
  } catch {
    // The package's own message is dropped: it may carry a path or a piece of text.
    throw new AnalyzerOutputError("解析器を読み込めません。");
  }
  return (text) => decodeTokens(tokenizer.tokenize(text), text);
}
