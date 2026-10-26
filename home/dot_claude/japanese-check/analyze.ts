import { paragraphs, proseLines, proseMasks } from "./markdown.ts";
import { phraseFindings } from "./phrases.ts";
import type { ProseLine } from "./markdown.ts";
import {
  isNoun,
  isProperNoun,
  isVerb,
  lemmaClass,
  renyokei,
} from "./contract.ts";
import type { LemmaClass, Tokenizer } from "./contract.ts";
import type { Finding, Genre } from "./types.ts";

export type { Finding };
import { compileEntries, findHits, selectEntries } from "./words.ts";
import type {
  CompiledEntry,
  TruncationReason,
  WordEntry,
  WordKind,
} from "./words.ts";

export interface Term {
  term: string;
  line: number;
  explanationNearby: boolean;
}
export interface Fact {
  value: string;
  kind: "number" | "name" | "ascii";
  line: number;
}

function finding(
  row: ProseLine,
  rule: string,
  offset: number,
  text: string,
  reason: string,
): Finding {
  return { rule, line: row.line, column: offset + 1, text, reason };
}

export function lint(lines: ProseLine[], genre?: Genre): Finding[] {
  const result: Finding[] = [];
  const patterns: Array<[string, RegExp, string]> = [
    [
      "nominalized-action",
      /(?:の実現|への寄与|の遂行|の実施)/gu,
      "動作主と対象が原文から決まる場合に、動詞で書けるか確認する。",
    ],
    [
      "indirect-assertion",
      /ということが(?:できる|可能)|と言えるでしょう|と言っても過言では/gu,
      "重なった言い回しか確認する。可能性や確信の度合いは変えない。",
    ],
    [
      "staged-negation",
      /(?:ではなく|ではない[。！])/gu,
      "誤解の訂正や条件の説明に必要な対比か確認する。",
    ],
    [
      "redundant-capability",
      /することができ(?:る|ます)/gu,
      "「できる」に短縮しても条件や可能性が変わらないか確認する。",
    ],
    [
      "noun-chain",
      /(?:[\p{Script=Han}\p{Script=Katakana}ー]+の){3,}/gu,
      "名詞のつながりと修飾先を読み直す。主体や関係を推測で足さない。",
    ],
    [
      "kanji-chain",
      /\p{Script=Han}{8,}/gu,
      "語の区切りが分かるか確認する。正式名称や専門用語は保持する。",
    ],
  ];
  const sentenceEnds: Array<{ row: ProseLine; end: string }> = [];
  for (const row of lines) {
    if (row.kind === "heading") continue;
    for (const [rule, pattern, reason] of patterns) {
      for (const match of row.text.matchAll(pattern)) {
        result.push(finding(row, rule, match.index, match[0], reason));
      }
    }
    // Thresholds indicate review candidates, never an automatic failure.
    const limit = genre === "essay" ? 120 : genre === "business" ? 80 : 100;
    for (const match of row.text.matchAll(/[^。！？!?]+[。！？!?]?/gu)) {
      const sentence = match[0].trim();
      if ([...sentence].length > limit) {
        result.push(
          finding(
            row,
            "long-sentence",
            match.index,
            sentence,
            `${limit} 字を超える文。条件・否定・修飾の対応を保って分けられるか確認する。`,
          ),
        );
      }
      const end = /(ます|です|である|した)[。！？!?]?$/u.exec(sentence)?.[1];
      if (end) sentenceEnds.push({ row, end });
      else sentenceEnds.push({ row, end: "" });
    }
  }
  if (genre !== "essay") {
    for (let i = 3; i < sentenceEnds.length; i++) {
      const current = sentenceEnds[i];
      if (!current) continue;
      if (
        current.end &&
        sentenceEnds.slice(i - 3, i).every((item) => item.end === current.end)
      ) {
        result.push(
          finding(
            current.row,
            "repeated-ending",
            0,
            current.end,
            "同じ文末が4文以上続く。意味に合う場合だけ組み立てを変える。",
          ),
        );
      }
    }
  }
  return result;
}

export type ReviewKind = Exclude<WordKind, "named-translationese">;

/**
 * One `action: review` entry of the word list, in list order. A lemma entry is
 * matched against the analyzer's tokens, a regex entry against the prose line.
 * analyze.ts never reads the file: the caller passes the entries in.
 */
export type ReviewEntry =
  | {
      match: "lemma";
      word: string;
      kind: ReviewKind;
      lemmas: string[];
      lemmaClass: LemmaClass;
      /** also match each lemma's 連用形 when the analyzer returns it as a noun */
      nominal?: true;
      fix: string;
    }
  | {
      match: "regex";
      word: string;
      kind: ReviewKind;
      compiled: CompiledEntry;
    };

const REVIEW_KINDS: readonly ReviewKind[] = [
  "calque",
  "jargon",
  "metaphor-verb",
  "slop",
];
const REVIEW_MATCHES = ["lemma", "regex"] as const;

// The rule names are part of the keep markers in existing documents.
const REVIEW_RULES: Record<ReviewKind, string> = {
  calque: "translation-candidate",
  jargon: "word-jargon",
  "metaphor-verb": "word-metaphor-verb",
  slop: "word-slop",
};

/**
 * Picks the review entries out of a validated list and compiles the regex ones.
 * The result keeps the list's order: it decides which entry's rule survives
 * when two entries hit the same spot (and so which keep marker applies).
 */
export function buildReviewEntries(entries: WordEntry[]): {
  review: ReviewEntry[];
  notices: string[];
} {
  const ordered: Array<{ index: number; entry: ReviewEntry }> = [];
  const notices: string[] = [];
  for (const kind of REVIEW_KINDS) {
    for (const match of REVIEW_MATCHES) {
      const selected = selectEntries(entries, {
        kind,
        action: "review",
        match,
      });
      if (match === "lemma") {
        for (const item of selected) {
          if (item.lemmas === undefined || item.lemmaClass === undefined)
            continue;
          ordered.push({
            index: item.index,
            entry: {
              match: "lemma",
              word: item.word,
              kind,
              lemmas: item.lemmas,
              lemmaClass: item.lemmaClass,
              ...(item.nominal === true && { nominal: true as const }),
              fix: item.fix,
            },
          });
        }
      } else {
        const result = compileEntries(selected);
        notices.push(...result.notices);
        for (const compiled of result.compiled) {
          ordered.push({
            index: compiled.index,
            entry: { match: "regex", word: compiled.word, kind, compiled },
          });
        }
      }
    }
  }
  ordered.sort((a, b) => a.index - b.index);
  return { review: ordered.map((item) => item.entry), notices };
}

interface Candidate {
  rank: number;
  start: number;
  finding: Finding;
}

/**
 * The nominalized-verb layer: for each `nominal` entry, builds the 連用形 of
 * every lemma from the analyzer's own reading of the dictionary form, so the
 * conjugation kind is never guessed. A lemma that does not come back as one
 * verb with a conjugation, or has no 連用形, is left out of the layer (the
 * entry still matches by lemma) and the entry's name goes into `notices`.
 * Why not a regex stem as before: it also hit other words (焼ける, 疑わしい).
 */
function nominalLayer(
  review: readonly ReviewEntry[],
  tokenize: Tokenizer,
): { surfaces: Map<string, number[]>; notices: string[] } {
  const surfaces = new Map<string, number[]>();
  const failed = new Set<string>();
  review.forEach((entry, rank) => {
    if (entry.match !== "lemma" || entry.nominal !== true) return;
    for (const lemma of entry.lemmas) {
      const tokens = tokenize(lemma);
      const only = tokens.length === 1 ? tokens[0] : undefined;
      const form =
        only !== undefined && isVerb(only) && only.conjugation !== undefined
          ? renyokei(lemma, only.conjugation)
          : undefined;
      if (form === undefined) {
        failed.add(entry.word);
        continue;
      }
      surfaces.set(form, [...(surfaces.get(form) ?? []), rank]);
    }
  });
  return {
    surfaces,
    notices: [...failed].map(
      (word) =>
        `語「${word}」の連用形を作れなかったため、名詞の形の照合から外した。`,
    ),
  };
}

function reviewCandidates(
  lines: ProseLine[],
  tokenize: Tokenizer,
  review: readonly ReviewEntry[],
): {
  findings: Finding[];
  truncated: TruncationReason[];
  notices: string[];
} {
  const layer = nominalLayer(review, tokenize);
  const lemmaRanks = new Map<string, number[]>();
  const regexRanks = new Map<number, number>();
  const compiled: CompiledEntry[] = [];
  review.forEach((entry, rank) => {
    if (entry.match === "lemma") {
      for (const lemma of entry.lemmas) {
        const key = `${entry.lemmaClass}\0${lemma}`;
        lemmaRanks.set(key, [...(lemmaRanks.get(key) ?? []), rank]);
      }
    } else {
      regexRanks.set(entry.compiled.index, rank);
      compiled.push(entry.compiled);
    }
  });
  const findings: Finding[] = [];
  const truncated = new Set<TruncationReason>();
  for (const row of lines) {
    const candidates: Candidate[] = [];
    if (lemmaRanks.size > 0 || layer.surfaces.size > 0) {
      for (const token of tokenize(row.text)) {
        if (isNoun(token)) {
          for (const rank of layer.surfaces.get(token.surface) ?? []) {
            const entry = review[rank];
            if (entry === undefined) continue;
            candidates.push({
              rank,
              start: token.start,
              finding: finding(
                row,
                REVIEW_RULES[entry.kind],
                token.start,
                token.surface,
                entry.match === "lemma" ? entry.fix : "",
              ),
            });
          }
        }
        const tokenClass = lemmaClass(token);
        if (tokenClass === undefined) continue;
        for (const rank of lemmaRanks.get(`${tokenClass}\0${token.lemma}`) ??
          []) {
          const entry = review[rank];
          if (entry === undefined) continue;
          candidates.push({
            rank,
            start: token.start,
            finding: finding(
              row,
              REVIEW_RULES[entry.kind],
              token.start,
              token.surface,
              entry.match === "lemma" ? entry.fix : "",
            ),
          });
        }
      }
    }
    if (compiled.length > 0) {
      const result = findHits(row.text, compiled);
      for (const reason of result.truncated) truncated.add(reason);
      for (const hit of result.hits) {
        const rank = regexRanks.get(hit.index);
        const entry = rank === undefined ? undefined : review[rank];
        if (rank === undefined || entry === undefined) continue;
        candidates.push({
          rank,
          start: hit.start,
          finding: finding(
            row,
            REVIEW_RULES[entry.kind],
            hit.start,
            row.text.slice(hit.start, hit.end),
            hit.fix,
          ),
        });
      }
    }
    // Same line, column and surface from two entries: the earlier entry wins.
    candidates.sort((a, b) => a.start - b.start || a.rank - b.rank);
    const seen = new Set<string>();
    for (const item of candidates) {
      const key = `${item.start}\0${item.finding.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(item.finding);
    }
  }
  return { findings, truncated: [...truncated], notices: layer.notices };
}

export function calques(
  lines: ProseLine[],
  tokenize: Tokenizer,
  review: readonly ReviewEntry[],
): Finding[] {
  return reviewCandidates(lines, tokenize, review).findings;
}

const SENTENCE_END_MARKS = new Set(["。", "！", "？", "!", "?"]);
const OPENING_BRACKETS = new Set(["「", "『", "（"]);
const CLOSING_BRACKETS = new Set(["」", "』", "）"]);

// One forward pass over a paragraph. The per-line regex used by `long-sentence`
// is not reused: it cuts "はい。」" into "はい。" and "」", so `last` would
// become a lone closing bracket. Sentences are sliced out of the original string
// by index and trimmed with String.prototype.trim only; a trailing-whitespace
// regex such as /\s+$/ is quadratic on long runs of spaces.
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let offset = 0;
  let depth = 0;
  // True after a depth-0 end mark, while closers and further end marks are
  // still being absorbed into the sentence that mark ended.
  let absorbing = false;
  const cutAt = (end: number) => {
    const sentence = text.slice(start, end).trim();
    if (sentence !== "") sentences.push(sentence);
    start = end;
  };
  for (const char of text) {
    if (absorbing) {
      if (CLOSING_BRACKETS.has(char) || SENTENCE_END_MARKS.has(char)) {
        offset += char.length;
        continue;
      }
      cutAt(offset);
      absorbing = false;
    }
    if (OPENING_BRACKETS.has(char)) depth += 1;
    else if (CLOSING_BRACKETS.has(char)) depth = Math.max(0, depth - 1);
    else if (SENTENCE_END_MARKS.has(char) && depth === 0) absorbing = true;
    offset += char.length;
  }
  cutAt(text.length);
  return sentences;
}

// Split by `kind` so that headings, list items and table rows keep the plain
// {line, kind, text} shape: an always-present `last: null` there would look like
// "a paragraph with one sentence". The type only constrains this file (the CLI
// prints `unknown`), so the JSON shape itself is pinned by the unit tests.
export type OutlineEntry =
  | {
      line: number;
      kind: "paragraph";
      text: string;
      last: string | null;
      sentences: number;
    }
  | { line: number; kind: "heading" | "list" | "table"; text: string };

export function outline(lines: ProseLine[]): OutlineEntry[] {
  return paragraphs(lines).map((block): OutlineEntry => {
    if (block.kind !== "paragraph") {
      return { line: block.line, kind: block.kind, text: block.text };
    }
    const sentences = splitSentences(block.text);
    return {
      line: block.line,
      kind: "paragraph",
      text: sentences[0] ?? "",
      last: sentences.length >= 2 ? (sentences.at(-1) ?? null) : null,
      sentences: sentences.length,
    };
  });
}

export function terms(lines: ProseLine[], tokenize: Tokenizer): Term[] {
  const result: Term[] = [];
  const seen = new Set<string>();
  for (const row of lines) {
    const tokens = tokenize(row.text);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token || !isNoun(token)) continue;
      if (
        !/^(?:[\p{Script=Katakana}ー]{3,}|[A-Za-z][A-Za-z0-9.+_-]+)$/u.test(
          token.surface,
        )
      )
        continue;
      let term = token.surface;
      let end = token.end;
      for (;;) {
        const next = tokens[i + 1];
        if (
          !next ||
          next.start !== end ||
          !isNoun(next) ||
          !/^[\p{L}\p{N}ー]+$/u.test(next.surface)
        )
          break;
        i++;
        term += next.surface;
        end = next.end;
      }
      const key = term.normalize("NFKC").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const nearby = row.text.slice(end, end + 100);
      result.push({
        term,
        line: row.line,
        explanationNearby:
          /^\s*[（(][^）)]+[）)]|^\s*(?:とは|は、|という)/u.test(nearby),
      });
    }
  }
  return result;
}

export function facts(lines: ProseLine[], tokenize: Tokenizer): Fact[] {
  const result: Fact[] = [];
  for (const row of lines) {
    const text = row.text.normalize("NFKC");
    for (const match of text.matchAll(
      /\d+(?:[.,]\d+)*(?:\s*(?:%|件|人|円|日|月|年|回|倍|秒|分|時間|万|億))?/gu,
    )) {
      result.push({
        value: match[0].replace(/\s/gu, ""),
        kind: "number",
        line: row.line,
      });
    }
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9._+-]+/gu)) {
      result.push({ value: match[0], kind: "ascii", line: row.line });
    }
    for (const token of tokenize(row.text)) {
      if (isProperNoun(token)) {
        result.push({ value: token.surface, kind: "name", line: row.line });
      }
    }
  }
  return result;
}

export function newFacts(
  source: ProseLine[],
  final: ProseLine[],
  tokenize: Tokenizer,
): Fact[] {
  const key = (fact: Fact) =>
    `${fact.kind}:${fact.value.normalize("NFKC").toLowerCase()}`;
  const known = new Set(facts(source, tokenize).map(key));
  return facts(final, tokenize).filter((fact) => {
    const value = key(fact);
    if (known.has(value)) return false;
    known.add(value);
    return true;
  });
}

/** What produced the tokens: the engine, the resolved package version and the dictionary. */
export interface AnalyzerIdentity {
  engine: string;
  version: string;
  dictionary: string;
}

export function check(
  markdown: string,
  tokenize: Tokenizer,
  review: readonly ReviewEntry[],
  analyzer: AnalyzerIdentity,
  genre?: Genre,
  source?: string,
) {
  const lines = proseLines(markdown);
  const matched = reviewCandidates(lines, tokenize, review);
  return {
    schemaVersion: 1,
    analyzer,
    findings: [
      ...lint(lines, genre),
      ...phraseFindings(lines, proseMasks(markdown), tokenize),
    ],
    calques: matched.findings,
    outline: outline(lines),
    terms: terms(lines, tokenize),
    paragraphs: paragraphs(lines),
    newFacts:
      source === undefined
        ? null
        : newFacts(proseLines(source), lines, tokenize),
    limitations: [
      "候補の検出であり、正確さや自然さの合否判定ではない。",
      "係り受けは解析しない。新出語がなくても意味や確度が変わっている可能性がある。",
      ...(matched.truncated.length > 0
        ? [
            `語の一覧の照合を途中で打ち切った箇所がある（${matched.truncated.join("、")}）。残りで照合した。`,
          ]
        : []),
      ...matched.notices,
    ],
  };
}
