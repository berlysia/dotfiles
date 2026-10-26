// 語の一覧（data/words.json）の形、検証、照合。hook と検査器と CI が同じ関数を呼ぶ。
// 状態を持たず、I/O をしない。import は `node:` だけ（hook が配布先で読めなくても
// 終了コード 0 で終われるよう、依存を持ち込まない）。
//
// 検証は 2 段に分ける。`parseWordList` / `validateWordList` は項目の形（欄、型、長さ、
// kind の組み合わせ）を見る。`compileEntries` は正規表現の制約を見る。hook は fix の
// 項目だけをコンパイルするので、review の項目の壊れた pattern は hook の知らせに出ない。

// contract.ts の `LemmaClass` と同じ並び。ここで import しないのは、この
// ファイルの import を `node:` だけに保つ test（module hygiene）があるため。
// analyze.ts が `LemmaClass` の欄へ代入するので、並びがずれれば型検査で落ちる。
type LemmaClass = "noun" | "verb" | "adjective" | "adjectivalNoun";

export const WORD_LIST_SCHEMA = 2;
export const MAX_LIST_BYTES = 256 * 1024;
export const MAX_ENTRIES = 500;
export const MAX_REGEXES = 2000;
export const MAX_TEXT_CHARS = 200;
export const MAX_PATTERN_CHARS = 100;
export const MAX_ALLOW = 10;
export const MAX_EXAMPLES = 10;
export const MAX_NON_EXAMPLES = 10;
export const MAX_LEMMAS = 20;
// 層は検査ごとに nominal の lemma を解析に通すので、一覧全体の数を抑える。
export const MAX_NOMINAL_LEMMAS = 20;
export const MAX_QUANTIFIER_COUNT = 10;

export const MAX_SCAN_CHARS = 256 * 1024;
export const MAX_LINE_CHARS = 2000;
export const MAX_LINE_HITS = 1000;
export const MAX_COLLECTED_HITS = 10_000;
const EXCERPT_MARGIN = 15;

// words.json の `pos` は、contract.ts の `LemmaClass` と同じ英字の識別子で書く
// （解析器の品詞名は書かない）。Set にするのは、"constructor" のような値が
// オブジェクトの継承で当たらないようにするため。
const LEMMA_CLASSES: ReadonlySet<string> = new Set([
  "noun",
  "verb",
  "adjective",
  "adjectivalNoun",
]);

export const WORD_KINDS = [
  "named-translationese",
  "slop",
  "metaphor-verb",
  "calque",
  "jargon",
] as const;
export const WORD_ACTIONS = ["fix", "review"] as const;
export const WORD_MATCHES = ["regex", "lemma"] as const;

// 検証が読む欄。照合の結果に使う欄は検査器のハッシュに入れ、使わない欄は入れない
// （入れないものは、壊して検証が項目を飛ばすようになってもハッシュが動かない）。
export const WORD_FIELDS = [
  "word",
  "kind",
  "action",
  "match",
  "pattern",
  "lemmas",
  "pos",
  "allow",
  "nominal",
  "fix",
  "chapter",
  "origin",
  "english",
  "reason",
  "examples",
  "nonExamples",
] as const;
export const HASHED_WORD_FIELDS = [
  "word",
  "kind",
  "action",
  "match",
  "pattern",
  "lemmas",
  "pos",
  "allow",
  "nominal",
  "fix",
  "chapter",
] as const;
export const UNHASHED_WORD_FIELDS = [
  "origin",
  "english",
  "reason",
  "examples",
  "nonExamples",
] as const;

export type WordKind = (typeof WORD_KINDS)[number];
export type WordAction = (typeof WORD_ACTIONS)[number];
export type WordMatch = (typeof WORD_MATCHES)[number];

/** 形の検証を通した項目。`index` は入力の配列の 1 始まりの位置 */
export interface WordEntry {
  index: number;
  word: string;
  kind: WordKind;
  action: WordAction;
  match: WordMatch;
  origin: string;
  fix: string;
  english?: string;
  chapter?: string;
  pattern?: string;
  allow?: string[];
  lemmas?: string[];
  lemmaClass?: LemmaClass;
  /** `true` only: the entry's lemmas are also matched by their 連用形 as a noun */
  nominal?: true;
  /** match: regex の項目が、原形の照合へ移せない理由。照合には使わない */
  reason?: string;
  examples: string[];
  nonExamples: string[];
}

export type WordListResult =
  | { ok: true; entries: WordEntry[]; notices: string[] }
  | { ok: false; reason: string };

export interface CompiledEntry {
  index: number;
  word: string;
  fix: string;
  english?: string;
  pattern: RegExp;
  allow: RegExp[];
}

export interface Hit {
  word: string;
  fix: string;
  english?: string;
  excerpt: string;
  /** `CompiledEntry.index` of the entry that matched */
  index: number;
  /** UTF-16 offsets of the match in the scanned line (after the line-length cut) */
  start: number;
  end: number;
}

export type TruncationReason =
  | "line-chars"
  | "line-hits"
  | "scan-size"
  | "time-budget";

export interface FindResult {
  hits: Hit[];
  total: number;
  truncated: TruncationReason[];
}

const FORBIDDEN_CHARS = /[\p{C}\p{Zl}\p{Zp}]/u;
const URL_FORMS = [
  /[a-z][a-z0-9+.-]*:\/\//,
  /\/\/\S/,
  /www\./,
  /javascript:/,
  /data:/,
  /vbscript:/,
  /file:/,
  /mailto:/,
  /tel:/,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function hasUrlForm(text: string): boolean {
  const normalized = text.normalize("NFKC").toLowerCase();
  return URL_FORMS.some((re) => re.test(normalized));
}

function checkText(value: unknown, label: string): string | null {
  if (typeof value !== "string" || value === "") {
    return `${label} が空でない文字列でない`;
  }
  if (codePointLength(value) > MAX_TEXT_CHARS) {
    return `${label} が ${MAX_TEXT_CHARS} 字を超える`;
  }
  if (FORBIDDEN_CHARS.test(value)) {
    return `${label} に改行、制御・書式の文字がある`;
  }
  if (hasUrlForm(value)) return `${label} に URL の形がある`;
  return null;
}

function checkTextList(
  value: unknown,
  label: string,
  min: number,
  max: number,
): string | null {
  if (!Array.isArray(value)) return `${label} が配列でない`;
  if (value.length < min) return `${label} が ${min} 件未満`;
  if (value.length > max) return `${label} が ${max} 件を超える`;
  for (const item of value) {
    const problem = checkText(item, `${label} の要素`);
    if (problem) return problem;
  }
  return null;
}

function includes<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

function checkEntry(raw: unknown, index: number): WordEntry | string {
  if (!isRecord(raw)) return "オブジェクトではない";
  const { kind, action, match } = raw;
  if (!includes(WORD_KINDS, kind)) return "kind が未知";
  if (!includes(WORD_ACTIONS, action)) return "action が未知";
  if (!includes(WORD_MATCHES, match)) return "match が未知";
  if (action === "fix" && kind !== "named-translationese") {
    return `kind: ${kind} は action: fix を持てない`;
  }
  if (kind === "named-translationese") {
    if (action !== "fix") return "named-translationese は action: fix に限る";
    if (match !== "regex") return "named-translationese は match: regex に限る";
  }
  for (const field of ["word", "origin", "fix"] as const) {
    const problem = checkText(raw[field], field);
    if (problem) return problem;
  }
  if (kind === "named-translationese" || kind === "calque") {
    const problem = checkText(raw.english, "english");
    if (problem) return problem;
  } else if (raw.english !== undefined) {
    const problem = checkText(raw.english, "english");
    if (problem) return problem;
  }
  if (raw.chapter !== undefined) {
    const problem = checkText(raw.chapter, "chapter");
    if (problem) return problem;
  }
  const examples = checkTextList(raw.examples, "examples", 1, MAX_EXAMPLES);
  if (examples) return examples;
  const nonExamples = checkTextList(
    raw.nonExamples,
    "nonExamples",
    1,
    MAX_NON_EXAMPLES,
  );
  if (nonExamples) return nonExamples;

  const entry: WordEntry = {
    index,
    word: raw.word as string,
    kind,
    action,
    match,
    origin: raw.origin as string,
    fix: raw.fix as string,
    examples: raw.examples as string[],
    nonExamples: raw.nonExamples as string[],
  };
  if (raw.english !== undefined) entry.english = raw.english as string;
  if (raw.chapter !== undefined) entry.chapter = raw.chapter as string;

  if (match === "regex") {
    if (raw.nominal !== undefined)
      return "nominal は match: lemma の項目だけが持つ";
    if (raw.reason !== undefined) {
      const problem = checkText(raw.reason, "reason");
      if (problem) return problem;
      entry.reason = raw.reason as string;
    }
    if (typeof raw.pattern !== "string") return "pattern が文字列でない";
    entry.pattern = raw.pattern;
    if (raw.allow !== undefined) {
      if (!Array.isArray(raw.allow)) return "allow が配列でない";
      if (raw.allow.length > MAX_ALLOW)
        return `allow が ${MAX_ALLOW} 件を超える`;
      if (!raw.allow.every((a) => typeof a === "string")) {
        return "allow の要素が文字列でない";
      }
      entry.allow = raw.allow as string[];
    }
  } else {
    if (raw.allow !== undefined)
      return "allow は match: regex の項目だけが持つ";
    if (raw.reason !== undefined)
      return "reason は match: regex の項目だけが持つ";
    const lemmas = checkTextList(raw.lemmas, "lemmas", 1, MAX_LEMMAS);
    if (lemmas) return lemmas;
    const pos = checkText(raw.pos, "pos");
    if (pos) return pos;
    if (!LEMMA_CLASSES.has(raw.pos as string)) return "pos が許される値でない";
    entry.lemmas = raw.lemmas as string[];
    entry.lemmaClass = raw.pos as LemmaClass;
    // pos の検証の後で確かめる。false を許さないのは、付けないことと false が
    // 別のハッシュにならないよう、意味を 1 つに絞るため。
    if (raw.nominal !== undefined) {
      if (raw.nominal !== true) return "nominal が true でない";
      if (raw.pos !== "verb") return "nominal は pos: verb の項目だけが持つ";
      entry.nominal = true;
    }
  }
  return entry;
}

/** JSON を読んだ後の値を検証する。例外を投げない */
export function validateWordList(value: unknown): WordListResult {
  if (!isRecord(value))
    return { ok: false, reason: "最上位がオブジェクトでない" };
  if (value.schema !== WORD_LIST_SCHEMA) {
    return { ok: false, reason: `schema が ${WORD_LIST_SCHEMA} でない` };
  }
  if (!Array.isArray(value.entries)) {
    return { ok: false, reason: "entries が配列でない" };
  }
  if (value.entries.length > MAX_ENTRIES) {
    return { ok: false, reason: `項目が ${MAX_ENTRIES} を超える` };
  }
  const entries: WordEntry[] = [];
  const notices: string[] = [];
  let regexCount = 0;
  let nominalLemmas = 0;
  value.entries.forEach((raw: unknown, i: number) => {
    const result = checkEntry(raw, i + 1);
    if (typeof result === "string") {
      notices.push(`項目 ${i + 1} を飛ばした: ${result}`);
      return;
    }
    entries.push(result);
    if (result.nominal) nominalLemmas += result.lemmas?.length ?? 0;
    if (result.match === "regex") {
      regexCount += 1 + (result.allow?.length ?? 0);
    }
  });
  if (regexCount > MAX_REGEXES) {
    return { ok: false, reason: `正規表現が合計 ${MAX_REGEXES} 個を超える` };
  }
  if (nominalLemmas > MAX_NOMINAL_LEMMAS) {
    return {
      ok: false,
      reason: `nominal の項目の lemma が合計 ${MAX_NOMINAL_LEMMAS} 個を超える`,
    };
  }
  return { ok: true, entries, notices };
}

/** 文字列を読む。バイト長を JSON として読む前に確かめる。例外を投げない */
export function parseWordList(text: string): WordListResult {
  if (Buffer.byteLength(text) > MAX_LIST_BYTES) {
    return { ok: false, reason: `${MAX_LIST_BYTES / 1024} KB を超える` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: `JSON として読めない: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return validateWordList(value);
}

export function selectEntries(
  entries: WordEntry[],
  conditions: { kind: WordKind; action: WordAction; match: WordMatch },
): WordEntry[] {
  return entries.filter(
    (e) =>
      e.kind === conditions.kind &&
      e.action === conditions.action &&
      e.match === conditions.match,
  );
}

type Prev = "start" | "open" | "bar" | "atom" | "wide" | "group" | "quant";

/**
 * 正規表現（フラグなし）の制約。ADR-0045 K2・K8 を下限に、ここで強めている。
 * 時間のかかる形（入れ子の量指定、複数の量指定、広い atom への量指定）と、
 * 0 文字に一致する形、照合の意味が書き手の意図とずれる形（\p、\u{..}）を持ち込ませない。
 */
export function checkRegexSource(source: string, label: string): string | null {
  if (source === "") return `${label} が空`;
  if (codePointLength(source) > MAX_PATTERN_CHARS) {
    return `${label} が ${MAX_PATTERN_CHARS} 字を超える`;
  }
  let inClass = false;
  let negated = false;
  let quantifiers = 0;
  let prev: Prev = "start";
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (inClass) {
      if (c === "\\") {
        const n = source.charAt(i + 1);
        if (n === "p" || n === "P") return `${label} に \\p がある`;
        i += 2;
        continue;
      }
      if (c === "]") {
        inClass = false;
        prev = negated ? "wide" : "atom";
      }
      i += 1;
      continue;
    }
    if (c === "\\") {
      const n = source.charAt(i + 1);
      if (n === "p" || n === "P") return `${label} に \\p がある`;
      if (n === "b" || n === "B") return `${label} に \\b か \\B がある`;
      if (n >= "1" && n <= "9") return `${label} に後方参照がある`;
      if (n === "k" && source.charAt(i + 2) === "<") {
        return `${label} に後方参照がある`;
      }
      prev = n === "S" || n === "D" || n === "W" ? "wide" : "atom";
      i += 2;
      continue;
    }
    if (c === "[") {
      inClass = true;
      negated = source.charAt(i + 1) === "^";
      i += negated ? 2 : 1;
      continue;
    }
    if (c === "(") {
      if (source.charAt(i + 1) === "?") {
        if (source.charAt(i + 2) !== ":") {
          return `${label} に先読み・後読み・名前つきグループがある`;
        }
        i += 3;
      } else {
        i += 1;
      }
      prev = "open";
      continue;
    }
    if (c === ")") {
      if (prev === "open" || prev === "bar")
        return `${label} に空の選択肢がある`;
      prev = "group";
      i += 1;
      continue;
    }
    if (c === "|") {
      if (prev === "start" || prev === "open" || prev === "bar") {
        return `${label} に空の選択肢がある`;
      }
      prev = "bar";
      i += 1;
      continue;
    }
    if (c === "^" || c === "$") return `${label} に ^ か $ がある`;
    if (c === ".") {
      prev = "wide";
      i += 1;
      continue;
    }
    let width = 0;
    if (c === "*" || c === "+" || c === "?") {
      width = 1;
    } else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (m) {
        width = m[0].length;
        const low = Number(m[1]);
        if (m[2] !== undefined && m[3] === "") {
          return `${label} に量指定 {n,} がある`;
        }
        const high = m[2] !== undefined ? Number(m[3]) : low;
        if (low < 1 || high < low || high > MAX_QUANTIFIER_COUNT) {
          return `${label} の量指定の回数が 1〜${MAX_QUANTIFIER_COUNT} の範囲外`;
        }
      }
    }
    if (width === 0) {
      prev = "atom";
      i += 1;
      continue;
    }
    if (c === "?" && prev === "quant") return `${label} に lazy な量指定がある`;
    if (prev === "start" || prev === "open" || prev === "bar") {
      return `${label} の量指定の対象がない`;
    }
    if (prev === "group") return `${label} に量指定つきのグループがある`;
    if (prev === "wide") {
      return `${label} の . か否定の文字クラスか \\S \\D \\W に量指定がある`;
    }
    quantifiers += 1;
    if (quantifiers > 1) return `${label} に量指定が 2 つ以上ある`;
    prev = "quant";
    i += width;
  }
  if (prev === "bar") return `${label} に空の選択肢がある`;
  return null;
}

function compileRegex(source: string, label: string): RegExp | string {
  const problem = checkRegexSource(source, label);
  if (problem) return problem;
  try {
    const re = new RegExp(source, "g");
    if (new RegExp(source).test("")) return `${label} が空文字に一致する`;
    return re;
  } catch (error) {
    return `正規表現を作れない: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** match: regex の項目だけをコンパイルする（lemma の項目は黙って除く） */
export function compileEntries(entries: WordEntry[]): {
  compiled: CompiledEntry[];
  notices: string[];
} {
  const compiled: CompiledEntry[] = [];
  const notices: string[] = [];
  for (const entry of entries) {
    if (entry.match !== "regex" || entry.pattern === undefined) continue;
    const pattern = compileRegex(entry.pattern, "pattern");
    if (typeof pattern === "string") {
      notices.push(`項目 ${entry.index} を飛ばした: ${pattern}`);
      continue;
    }
    const allow: RegExp[] = [];
    let problem: string | null = null;
    for (const source of entry.allow ?? []) {
      const re = compileRegex(source, "allow");
      if (typeof re === "string") {
        problem = re;
        break;
      }
      allow.push(re);
    }
    if (problem) {
      notices.push(`項目 ${entry.index} を飛ばした: ${problem}`);
      continue;
    }
    compiled.push({
      index: entry.index,
      word: entry.word,
      fix: entry.fix,
      ...(entry.english !== undefined && { english: entry.english }),
      pattern,
      allow,
    });
  }
  return { compiled, notices };
}

const JAPANESE_CHAR = /[぀-ヿ一-鿿]/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

function stripInlineCode(line: string): string {
  return line.replace(/`[^`\n]*`/g, "");
}

function sanitizeExcerpt(text: string): string {
  return text
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/「/g, "『")
    .replace(/」/g, "』");
}

interface Range {
  start: number;
  end: number;
}

// `overlapping` は allow 用: 次の探索を前の当たりの開始位置の 1 つ先から始める。
// 重なる当たりを拾うので、除外される当たりが増える（当たりが減る向きにしか変わらない）
function matchRanges(
  re: RegExp,
  line: string,
  overlapping: boolean,
  onLimit: () => void,
): Range[] {
  const ranges: Range[] = [];
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(line);
    if (m === null) break;
    if (ranges.length >= MAX_LINE_HITS) {
      onLimit();
      break;
    }
    ranges.push({ start: m.index, end: m.index + m[0].length });
    re.lastIndex = overlapping ? m.index + 1 : m.index + m[0].length;
  }
  re.lastIndex = 0;
  return ranges;
}

/**
 * 本文の当たりを返す。日本語を含む行だけを見て、コードフェンスの中と行内コードは飛ばす。
 * `deadline` は `performance.now()` の絶対時刻。過ぎたら残りを走査せずに返す。
 */
export function findHits(
  text: string,
  compiled: CompiledEntry[],
  deadline?: number,
): FindResult {
  const hits: Hit[] = [];
  const truncated = new Set<TruncationReason>();
  let total = 0;
  const finish = (): FindResult => ({
    hits,
    total,
    truncated: [...truncated],
  });
  const expired = (): boolean => {
    if (deadline !== undefined && performance.now() > deadline) {
      truncated.add("time-budget");
      return true;
    }
    return false;
  };
  if (text.length > MAX_SCAN_CHARS) truncated.add("scan-size");
  const lines = text.slice(0, MAX_SCAN_CHARS).split("\n");
  let fence: { char: string; length: number } | null = null;
  for (const rawLine of lines) {
    if (expired()) return finish();
    const fenceMatch = FENCE_LINE.exec(rawLine);
    const marker = fenceMatch?.[1] ?? "";
    if (fence) {
      if (
        marker !== "" &&
        marker.startsWith(fence.char) &&
        marker.length >= fence.length &&
        rawLine.trim().replace(/[`~]/g, "") === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (marker !== "") {
      fence = { char: marker.charAt(0), length: marker.length };
      continue;
    }
    if (!JAPANESE_CHAR.test(rawLine)) continue;
    if (rawLine.length > MAX_LINE_CHARS) truncated.add("line-chars");
    const line = stripInlineCode(rawLine.slice(0, MAX_LINE_CHARS));
    const onLimit = (): void => {
      truncated.add("line-hits");
    };
    for (const entry of compiled) {
      if (expired()) return finish();
      const found = matchRanges(entry.pattern, line, false, onLimit);
      if (found.length === 0) continue;
      const allowed: Range[] = [];
      for (const re of entry.allow) {
        if (expired()) return finish();
        allowed.push(...matchRanges(re, line, true, onLimit));
      }
      for (const range of found) {
        if (allowed.some((a) => a.start < range.end && range.start < a.end)) {
          continue;
        }
        total += 1;
        if (hits.length < MAX_COLLECTED_HITS) {
          hits.push({
            word: entry.word,
            fix: entry.fix,
            ...(entry.english !== undefined && { english: entry.english }),
            index: entry.index,
            start: range.start,
            end: range.end,
            excerpt: sanitizeExcerpt(
              line.slice(
                Math.max(0, range.start - EXCERPT_MARGIN),
                Math.min(line.length, range.end + EXCERPT_MARGIN),
              ),
            ),
          });
        }
        if (total >= MAX_COLLECTED_HITS) return finish();
      }
    }
  }
  return finish();
}
