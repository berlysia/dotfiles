// The one contract between the checks (analyze.ts) and a morphological
// analyzer's adapter. Leaf module: it imports nothing and has
// no top-level side effects, so hooks and CI can load it through receipts.ts.
//
// The part of speech is stored under a module-private symbol, so only the
// predicates below can read it. A check that wants the analyzer's own tag set
// (a Japanese part-of-speech name, an index into a tag array) has nothing to
// read, and the type checker rejects it.
//
// The rule that builds an inflected form (`renyokei`) lives here too, next to
// `ConjugationKind`: every adapter would otherwise carry its own copy of the
// godan rows and the ichidan/sahen/kahen endings, and the copies could drift.

export type PartOfSpeech =
  | "noun"
  | "properNoun"
  | "verb"
  | "adjective"
  | "adjectivalNoun"
  | "particle"
  | "conjunctiveParticle"
  | "auxiliary"
  | "suffix"
  | "nonIndependent"
  | "symbol"
  | "other";

export type ConjugationKind =
  | {
      kind: "godan";
      row: "ka" | "ga" | "sa" | "ta" | "na" | "ba" | "ma" | "ra" | "wa";
    }
  | { kind: "kamiIchidan" }
  | { kind: "shimoIchidan" }
  | { kind: "sahen" }
  | { kind: "kahen" }
  | { kind: "adjective" };

/** What an adapter returns. Positions are UTF-16 offsets into the input text */
export interface AnalyzedToken {
  surface: string;
  start: number;
  end: number;
  lemma: string;
  pos: PartOfSpeech;
  conjugation?: ConjugationKind;
}

const posKey: unique symbol = Symbol("part-of-speech");

/**
 * What the checks receive. Only `validateTokens` creates one. It carries a
 * symbol key, so a JSON or structuredClone round trip drops the part of speech:
 * checks must not copy or serialize a token (object spread keeps symbol keys).
 */
export type Token = {
  readonly surface: string;
  readonly start: number;
  readonly end: number;
  readonly lemma: string;
  readonly conjugation?: ConjugationKind;
  readonly [posKey]: PartOfSpeech;
};
export type Tokenizer = (text: string) => readonly Token[];

export const LEMMA_CLASSES = [
  "noun",
  "verb",
  "adjective",
  "adjectivalNoun",
] as const;
export type LemmaClass = (typeof LEMMA_CLASSES)[number];

// The messages are fixed text: they never carry a piece of the document, so the
// cli can print them.
export class AnalyzerOutputError extends Error {
  override name = "AnalyzerOutputError";
}

export function isNoun(token: Token): boolean {
  return token[posKey] === "noun" || token[posKey] === "properNoun";
}

export function isProperNoun(token: Token): boolean {
  return token[posKey] === "properNoun";
}

export function isVerb(token: Token): boolean {
  return token[posKey] === "verb";
}

/**
 * The coarse class a lemma entry is matched under, or undefined for a token no
 * lemma entry can hit (a particle, a suffix, ...).
 */
export function lemmaClass(token: Token): LemmaClass | undefined {
  if (isNoun(token)) return "noun";
  const pos = token[posKey];
  if (pos === "verb" || pos === "adjective" || pos === "adjectivalNoun")
    return pos;
  return undefined;
}

/**
 * Checks the invariants every check relies on and brands the tokens. Text
 * between two tokens is not checked here: an adapter that must reject unparsed
 * text does so itself.
 */
export function validateTokens(
  text: string,
  analyzed: readonly AnalyzedToken[],
): readonly Token[] {
  let previousEnd = 0;
  return analyzed.map((item) => {
    if (
      !Number.isInteger(item.start) ||
      !Number.isInteger(item.end) ||
      item.start < 0 ||
      item.start >= item.end ||
      item.end > text.length ||
      item.start < previousEnd ||
      text.slice(item.start, item.end) !== item.surface
    )
      throw new AnalyzerOutputError(
        "解析器の形態素と入力位置を対応できません。",
      );
    previousEnd = item.end;
    const token: Token = {
      surface: item.surface,
      start: item.start,
      end: item.end,
      lemma: item.lemma,
      ...(item.conjugation === undefined
        ? {}
        : { conjugation: item.conjugation }),
      [posKey]: item.pos,
    };
    return token;
  });
}

/**
 * Wraps an adapter's analysis so its output always passes `validateTokens`.
 * The result per text is cached and the same array is returned on a repeat, so
 * a check must not modify what it receives.
 */
export function makeTokenizer(
  analyze: (text: string) => readonly AnalyzedToken[],
): Tokenizer {
  const cache = new Map<string, readonly Token[]>();
  return (text) => {
    const cached = cache.get(text);
    if (cached) return cached;
    const tokens = validateTokens(text, analyze(text));
    cache.set(text, tokens);
    return tokens;
  };
}

// The stem-final kana of a godan verb and its 連用形 (イ段) per row.
const GODAN_RENYOKEI: Record<
  Extract<ConjugationKind, { kind: "godan" }>["row"],
  { end: string; renyokei: string }
> = {
  ka: { end: "く", renyokei: "き" },
  ga: { end: "ぐ", renyokei: "ぎ" },
  sa: { end: "す", renyokei: "し" },
  ta: { end: "つ", renyokei: "ち" },
  na: { end: "ぬ", renyokei: "に" },
  ba: { end: "ぶ", renyokei: "び" },
  ma: { end: "む", renyokei: "み" },
  ra: { end: "る", renyokei: "り" },
  wa: { end: "う", renyokei: "い" },
};

/**
 * The 連用形 of a dictionary-form lemma, or undefined when the lemma's ending
 * does not fit its conjugation kind (so a wrong kind never yields a wrong
 * string) or the kind has none to build (adjectives, a sahen ending other than
 * する such as 愛す / 愛ずる). Call it only for a lemma that has a conjugation.
 */
export function renyokei(
  lemma: string,
  conjugation: ConjugationKind,
): string | undefined {
  switch (conjugation.kind) {
    case "godan": {
      const rule = GODAN_RENYOKEI[conjugation.row];
      return lemma.endsWith(rule.end)
        ? lemma.slice(0, -1) + rule.renyokei
        : undefined;
    }
    case "kamiIchidan":
    case "shimoIchidan":
      return lemma.endsWith("る") ? lemma.slice(0, -1) : undefined;
    case "sahen":
      return lemma.endsWith("する") ? lemma.slice(0, -2) + "し" : undefined;
    case "kahen":
      if (lemma.endsWith("来る")) return lemma.slice(0, -1);
      return lemma.endsWith("くる") ? lemma.slice(0, -2) + "き" : undefined;
    case "adjective":
      return undefined;
  }
}
