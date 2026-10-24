import { paragraphs, proseLines } from "./markdown.ts";
import type { ProseLine } from "./markdown.ts";
import type { Tokenizer } from "./tokenizer.ts";
import type { Genre } from "./types.ts";

export interface Finding {
  rule: string;
  line: number;
  column: number;
  text: string;
  reason: string;
}
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

// Sudachi normalizes inflections of 効く to 利く.
const motionVerbs = new Set([
  "拾う",
  "引く",
  "通る",
  "効く",
  "利く",
  "響く",
  "足す",
]);
const placeNouns = new Set(["入口", "入り口", "受け口", "口"]);

export function calques(lines: ProseLine[], tokenize: Tokenizer): Finding[] {
  const result: Finding[] = [];
  for (const row of lines) {
    for (const token of tokenize(row.text)) {
      if (
        (token.pos[0] === "動詞" && motionVerbs.has(token.normalized)) ||
        (token.pos[0] === "名詞" && placeNouns.has(token.normalized))
      ) {
        result.push(
          finding(
            row,
            "translation-candidate",
            token.start,
            token.surface,
            "字義どおりの用法・定着した専門用語なら残す。何がどうなるか不明なら原文の範囲で言い直す。",
          ),
        );
      }
    }
  }
  return result;
}

export function outline(lines: ProseLine[]) {
  return paragraphs(lines).map((block) => ({
    line: block.line,
    kind: block.kind,
    text:
      block.kind === "paragraph"
        ? (block.text.match(/^[\s\S]*?[。！？!?]/u)?.[0] ?? block.text)
        : block.text,
  }));
}

export function terms(lines: ProseLine[], tokenize: Tokenizer): Term[] {
  const result: Term[] = [];
  const seen = new Set<string>();
  for (const row of lines) {
    const tokens = tokenize(row.text);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token || token.pos[0] !== "名詞") continue;
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
          next.pos[0] !== "名詞" ||
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
      if (token.pos[0] === "名詞" && token.pos[1] === "固有名詞") {
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

export function check(
  markdown: string,
  tokenize: Tokenizer,
  genre?: Genre,
  source?: string,
) {
  const lines = proseLines(markdown);
  return {
    schemaVersion: 1,
    analyzer: { engine: "sudachi", packageVersion: "0.1.5", mode: "C" },
    findings: lint(lines, genre),
    calques: calques(lines, tokenize),
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
    ],
  };
}
