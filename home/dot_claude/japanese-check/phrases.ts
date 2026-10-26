// Two checks that read the order of words rather than single words:
//
//   opaque-compound  a run of nouns that stacks a target, an abstract change
//                    and a container ("業務効率化基盤")
//   vague-action     a vague degree word or demonstrative followed by an action
//                    noun and its supporting verb ("適切に対応する")
//
// Both rebuild tanteki's textlint rules on the word contract. The part of
// speech is read through the predicates of contract.ts only; words are matched
// by surface and lemma.
//
// Why not a words.json section: an effect word or a container word is no
// candidate alone. It becomes one by where it sits, so the one-word-one-
// candidate shape of a word entry does not fit.
//
// A line is checked as a projection of itself: emphasis marks and the brackets
// and destinations of links are cut out so a phrase reads across them, while
// code, images, URLs and HTML stay as gaps that no phrase crosses.
import {
  isAdjectivalNoun,
  isAdjective,
  isAuxiliary,
  isConjunctiveParticle,
  isNoun,
  isParticle,
  isSuffix,
  isSymbol,
  isVerb,
} from "./contract.ts";
import type { Token, Tokenizer } from "./contract.ts";
import type { ProseLine, ProseMask } from "./markdown.ts";
import type { Finding } from "./types.ts";

export const OPAQUE_COMPOUND = "opaque-compound";
export const VAGUE_ACTION = "vague-action";

const OPAQUE_REASON =
  "名詞を重ねて、対象・変化・仕組みの関係が分かりにくい。誰が何をどうするのかを書けるか確認する。";
const VAGUE_REASON =
  "程度や方法が曖昧な動作の候補。判断する基準と、実際に行うことを確認する。否定と条件は変えない。";

// Components, not complete invented names: the check looks at how a target, an
// abstract change and a container are stacked, not at the length of a noun.
const EFFECTS = [
  "創出",
  "向上",
  "高度化",
  "最大化",
  "最適化",
  "迅速化",
  "効率化",
  "強化",
  "促進",
  "推進",
  "横断",
  "データドリブン",
];
const CONTAINERS = [
  "基盤",
  "機構",
  "レイヤー",
  "プラットフォーム",
  "システム",
  "枠組み",
];

const DEGREE_WORDS = new Set(["適切", "適宜", "十分", "慎重"]);
const CONDITION_WORDS = new Set(["必要", "状況"]);
const DEMONSTRATIVES = ["これ", "それ", "本件", "当該事項"];
const DEMONSTRATIVE_PARTICLES = new Set(["を", "は", "も", "の", "に", "へ"]);
const DEMONSTRATIVE_VERBS = new Set(["つく", "対する", "関する"]);
const ACTION_NOUNS = new Set([
  "対応",
  "対処",
  "実施",
  "調整",
  "検討",
  "評価",
  "推進",
  "処理",
  "措置",
]);
const SUPPORT_VERBS = new Set(["する", "行う", "おこなう", "図る", "進める"]);
const COMMAS = new Set(["、", "，", ","]);
// Verbs that follow て as the tail of a predicate (している, してしまう, ...).
const TAIL_VERBS = new Set([
  "いる",
  "おる",
  "ある",
  "しまう",
  "おく",
  "いく",
  "くる",
]);
const NEGATIVE_LEMMAS = new Set(["ない", "ぬ"]);

// How far ahead vague-action looks for the action noun, counted in words after
// the entry. Bounds the work on a long line that has no sentence end.
const SEARCH_LIMIT = 40;

interface Span {
  rule: string;
  from: number;
  to: number;
}

interface View {
  tokens: readonly Token[];
  // wall[i]: the projected text has a gap between token i - 1 and token i
  wall: readonly boolean[];
}

function isParticleOf(
  token: Token | undefined,
  ...surfaces: string[]
): boolean {
  return (
    token !== undefined && isParticle(token) && surfaces.includes(token.surface)
  );
}

function isCaseNi(token: Token | undefined): boolean {
  return (
    token !== undefined &&
    token.surface === "に" &&
    (isParticle(token) || isAuxiliary(token))
  );
}

// A word that can sit inside a noun run.
function isNounLike(token: Token): boolean {
  return isNoun(token) || isAdjectivalNoun(token) || isSuffix(token);
}

// The token at `index` when it follows the previous token without a gap.
function at(view: View, index: number): Token | undefined {
  return index < view.tokens.length && !view.wall[index]
    ? view.tokens[index]
    : undefined;
}

// Tokens from `start` whose surfaces join into exactly `word`. Returns the
// index after the last one, or -1. Why not a substring test on the text: a
// word must begin and end on token boundaries ("強化学習" is not "強化" alone,
// but it does start with the effect word 強化).
function wordAt(view: View, start: number, word: string): number {
  let value = "";
  for (let index = start; index < view.tokens.length; index++) {
    if (index > start && view.wall[index]) return -1;
    value += view.tokens[index]!.surface;
    if (value === word) return index + 1;
    if (!word.startsWith(value)) return -1;
  }
  return -1;
}

function firstWordAt(
  view: View,
  start: number,
  words: readonly string[],
): number {
  for (const word of words) {
    const end = wordAt(view, start, word);
    if (end !== -1) return end;
  }
  return -1;
}

function opaqueCompounds(view: View): Span[] {
  const { tokens } = view;
  const spans: Span[] = [];
  for (let start = 0; start < tokens.length;) {
    if (!isNounLike(tokens[start]!)) {
      start++;
      continue;
    }
    let end = start;
    let targets = 0;
    let changes = 0;
    let container = false;
    while (end < tokens.length) {
      if (end > start && view.wall[end]) break;
      const token = tokens[end]!;
      // の joins two words of the run; at the end of a run it is not part of it
      if (
        isParticleOf(token, "の") &&
        at(view, end + 1) !== undefined &&
        isNounLike(tokens[end + 1]!)
      ) {
        end++;
        continue;
      }
      if (!isNounLike(token)) break;
      const effectEnd = firstWordAt(view, end, EFFECTS);
      const containerEnd =
        effectEnd === -1 ? firstWordAt(view, end, CONTAINERS) : -1;
      if (effectEnd !== -1) {
        if (targets > 0) changes++;
        end = effectEnd;
      } else if (containerEnd !== -1) {
        container = true;
        end = containerEnd;
        if (targets > 0 && changes > 0)
          spans.push({ rule: OPAQUE_COMPOUND, from: start, to: end });
        // A following の最適化 works on this container; it is not part of its
        // name.
        targets = 0;
        changes = 0;
      } else {
        targets++;
        end++;
      }
    }
    if (!container && targets > 0 && changes >= 2)
      spans.push({ rule: OPAQUE_COMPOUND, from: start, to: end });
    start = Math.max(end, start + 1);
  }
  return spans;
}

// The end (exclusive) of a predicate whose head is at `head`: the auxiliaries,
// て/で, a negative adjective and the tail verbs that continue it.
function predicateEnd(view: View, head: number): number {
  const { tokens } = view;
  let end = head + 1;
  while (end < tokens.length && !view.wall[end]) {
    const token = tokens[end]!;
    const previous = tokens[end - 1]!;
    // で after a copula (ではない) is an auxiliary, not a particle, so て/で
    // is matched on the surface alone.
    const isTe = (word: Token | undefined) =>
      word !== undefined && (word.surface === "て" || word.surface === "で");
    const afterTe =
      isTe(previous) ||
      (isParticleOf(previous, "は", "も") && isTe(tokens[end - 2]));
    if (
      isAuxiliary(token) ||
      (isAdjective(token) && NEGATIVE_LEMMAS.has(token.lemma))
    ) {
      end++;
    } else if (isParticleOf(token, "て", "で")) {
      end++;
    } else if (isParticleOf(token, "は", "も") && isTe(previous)) {
      end++;
    } else if (isVerb(token) && TAIL_VERBS.has(token.lemma) && afterTe) {
      end++;
    } else if (isParticleOf(token, "ば")) {
      const negative = NEGATIVE_LEMMAS.has(previous.lemma);
      end++;
      const following = at(view, end);
      if (
        negative &&
        following !== undefined &&
        isVerb(following) &&
        following.lemma === "なる"
      )
        end++;
      else break;
    } else break;
  }
  return end;
}

// The end of an action phrase that starts with the action noun at `index`, or
// -1. `nominal` is true when the phrase was entered through な/の (the degree
// word acted as a noun), where a bare action noun or a copula also ends it.
function actionEnd(view: View, index: number, nominal: boolean): number {
  const { tokens } = view;
  const head = tokens[index]!;
  if (!isNoun(head) || !ACTION_NOUNS.has(head.surface)) return -1;
  // 対応表 and 処理速度 name a thing, not an action.
  const after = at(view, index + 1);
  if (after !== undefined && isNoun(after)) return -1;
  let end = index + 1;
  if (isParticleOf(at(view, end), "を", "は", "も", "が")) {
    end++;
    if (isParticleOf(at(view, end), "は", "も")) end++;
  }
  const second = at(view, end);
  const third = at(view, end + 1);
  if (
    second !== undefined &&
    isNoun(second) &&
    ACTION_NOUNS.has(second.surface) &&
    third !== undefined &&
    isVerb(third) &&
    third.lemma === "する"
  )
    end++;
  const verb = at(view, end);
  if (
    verb !== undefined &&
    isVerb(verb) &&
    (SUPPORT_VERBS.has(verb.lemma) || verb.lemma === "できる")
  )
    return predicateEnd(view, end);
  if (!nominal) return -1;
  if (isParticleOf(at(view, end), "で")) {
    end++;
    if (isParticleOf(at(view, end), "は", "も")) end++;
  }
  const predicate = at(view, end);
  if (
    predicate !== undefined &&
    (isAuxiliary(predicate) ||
      (isVerb(predicate) && predicate.lemma === "ある") ||
      (isAdjective(predicate) &&
        (predicate.lemma === "ない" || predicate.lemma === "無い")))
  )
    return predicateEnd(view, end);
  return index + 1;
}

// Looks ahead from `start` for an action phrase over nouns, suffixes and
// particles only. A verb, a conjunctive particle, a symbol (comma, full stop,
// bracket, `|`) or a gap ends the search: the clause has changed.
function findAction(view: View, start: number, nominal: boolean): number {
  const { tokens } = view;
  const limit = Math.min(tokens.length, start + SEARCH_LIMIT);
  for (let index = start; index < limit; index++) {
    if (view.wall[index]) break;
    const end = actionEnd(view, index, nominal);
    if (end !== -1) return end;
    const token = tokens[index]!;
    const passes = nominal
      ? isNounLike(token)
      : isNounLike(token) ||
        (isParticle(token) && !isConjunctiveParticle(token));
    if (!passes) break;
  }
  return -1;
}

function skipComma(view: View, index: number): number {
  const token = at(view, index);
  return token !== undefined && isSymbol(token) && COMMAS.has(token.surface)
    ? index + 1
    : index;
}

function vagueActions(view: View): Span[] {
  const { tokens } = view;
  const spans: Span[] = [];
  const add = (from: number, to: number) => {
    if (to > from) spans.push({ rule: VAGUE_ACTION, from, to });
  };
  for (let start = 0; start < tokens.length; start++) {
    const token = tokens[start]!;
    if (
      (isNoun(token) || isAdjectivalNoun(token)) &&
      DEGREE_WORDS.has(token.surface)
    ) {
      let next = start + 1;
      const link = at(view, next);
      const linked =
        link !== undefined &&
        (isParticle(link) || isAuxiliary(link)) &&
        ["な", "の", "に"].includes(link.surface);
      const nominal =
        linked && (link.surface === "な" || link.surface === "の");
      if (linked) next++;
      else if (token.surface !== "適宜") continue;
      add(start, findAction(view, skipComma(view, next), nominal));
    }
    const verb = tokens[start + 2];
    if (
      isNoun(token) &&
      CONDITION_WORDS.has(token.surface) &&
      // 必要 is also read as a copula stem, so に can be an auxiliary
      isCaseNi(at(view, start + 1)) &&
      verb !== undefined &&
      !view.wall[start + 2] &&
      isVerb(verb) &&
      (verb.lemma === "応ずる" || verb.lemma === "応じる")
    ) {
      const ending = predicateEnd(view, start + 2);
      const next = skipComma(view, ending);
      // A concrete action alone does not clarify the condition, so the phrase
      // stops at the predicate when no action follows.
      add(
        start,
        Math.max(
          ending,
          findAction(view, next, tokens[ending - 1]!.surface === "た"),
        ),
      );
    }
    const demonstrativeEnd = firstWordAt(view, start, DEMONSTRATIVES);
    if (demonstrativeEnd !== -1) {
      const marker = at(view, demonstrativeEnd);
      if (
        marker !== undefined &&
        isParticle(marker) &&
        DEMONSTRATIVE_PARTICLES.has(marker.surface)
      ) {
        let next = demonstrativeEnd + 1;
        const head = at(view, next);
        if (
          marker.surface === "に" &&
          head !== undefined &&
          isVerb(head) &&
          DEMONSTRATIVE_VERBS.has(head.lemma)
        )
          next = predicateEnd(view, next);
        if (isParticleOf(at(view, next), "は", "も", "の")) next++;
        add(start, findAction(view, skipComma(view, next), false));
      }
    }
  }
  return spans;
}

const ASCII_ALNUM = /^[A-Za-z0-9]$/u;

interface Projection {
  text: string;
  // originalOffset[i]: the offset in the line of the i-th UTF-16 unit of `text`
  originalOffset: Int32Array;
}

// Cuts out what must not stand between two words of a phrase: emphasis and
// strike-through marks, the `[` that opens a link text, and the `](...)` part
// of a link. A `_` run between two ASCII alphanumerics (snake_case) stays. A
// bracket with no link behind it ([text][ref]) stays and, as a symbol, ends
// the phrase.
function project(text: string, masks: ProseMask): Projection {
  const length = text.length;
  const drop = new Uint8Array(length);
  const links = masks.ranges.filter((range) => range.kind === "link");
  const open: number[] = [];
  let nextLink = 0;
  for (let index = 0; index < length; index++) {
    const link = links[nextLink];
    if (link !== undefined && index === link.start) {
      const bracket = open.pop();
      if (bracket !== undefined) drop[bracket] = 1;
      drop.fill(1, link.start, link.end);
      index = link.end - 1;
      nextLink++;
      continue;
    }
    const char = text[index];
    if (char === "[") open.push(index);
    else if (char === "*" || char === "~") drop[index] = 1;
    else if (char === "_") {
      let stop = index;
      while (text[stop] === "_") stop++;
      const before = text[index - 1] ?? "";
      const after = text[stop] ?? "";
      if (!(ASCII_ALNUM.test(before) && ASCII_ALNUM.test(after)))
        drop.fill(1, index, stop);
      index = stop - 1;
    }
  }
  const kept: string[] = [];
  const originalOffset = new Int32Array(length);
  let count = 0;
  for (let index = 0; index < length;) {
    if (drop[index]) {
      index++;
      continue;
    }
    const from = index;
    while (index < length && !drop[index]) {
      originalOffset[count++] = index;
      index++;
    }
    kept.push(text.slice(from, index));
  }
  return { text: kept.join(""), originalOffset };
}

function candidatesOfLine(
  row: ProseLine,
  mask: ProseMask,
  tokenize: Tokenizer,
): Finding[] {
  const projection = project(row.text, mask);
  if (projection.text.trim() === "") return [];
  const tokens = tokenize(projection.text);
  const wall = tokens.map(
    (token, index) => index > 0 && tokens[index - 1]!.end !== token.start,
  );
  const view: View = { tokens, wall };
  const result: Finding[] = [];
  for (const span of [...opaqueCompounds(view), ...vagueActions(view)]) {
    const start = projection.originalOffset[tokens[span.from]!.start]!;
    const end = projection.originalOffset[tokens[span.to - 1]!.end - 1]! + 1;
    result.push({
      rule: span.rule,
      line: row.line,
      column: start + 1,
      text: mask.raw.slice(start, end),
      reason: span.rule === OPAQUE_COMPOUND ? OPAQUE_REASON : VAGUE_REASON,
    });
  }
  return result;
}

/**
 * Drops a candidate whose range lies inside another candidate's range on the
 * same line (rule does not matter); of two candidates with the same range the
 * vague-action one stays, since it gives more to rewrite from. The result is
 * ordered by line and column. Candidates of other checks are not passed here:
 * a different rule is kept by a different keep marker.
 */
export function selectPhraseFindings(candidates: Finding[]): Finding[] {
  const order = [...candidates].sort(
    (a, b) =>
      a.line - b.line ||
      a.column - b.column ||
      b.text.length - a.text.length ||
      Number(b.rule === VAGUE_ACTION) - Number(a.rule === VAGUE_ACTION),
  );
  const kept: Finding[] = [];
  let line = -1;
  let reach = 0;
  for (const item of order) {
    const end = item.column + item.text.length;
    if (item.line !== line) {
      line = item.line;
      reach = 0;
    }
    // Sorted by start, then longest first: anything that ends within the
    // furthest end seen so far lies inside an earlier candidate.
    if (end <= reach) continue;
    reach = end;
    kept.push(item);
  }
  return kept;
}

/**
 * `masks` is proseMasks() of the same markdown as `lines`, entry for entry.
 * Quoted lines are skipped: a quotation is someone else's wording.
 */
export function phraseFindings(
  lines: readonly ProseLine[],
  masks: readonly ProseMask[],
  tokenize: Tokenizer,
): Finding[] {
  const candidates: Finding[] = [];
  for (const [index, row] of lines.entries()) {
    const mask = masks[index];
    if (mask === undefined || mask.line !== row.line)
      throw new Error("行の一覧と範囲の一覧が対応しません。");
    if (mask.quote) continue;
    candidates.push(...candidatesOfLine(row, mask, tokenize));
  }
  return selectPhraseFindings(candidates);
}
