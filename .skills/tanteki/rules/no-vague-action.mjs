import { japaneseRule, noun, particle, predicateEnd, surface, tokenFinding, verb, wordAt } from "./lib/japanese-rule.mjs";

const actions = noun("対応", "対処", "実施", "調整", "検討", "評価", "推進", "処理", "措置");
const support = verb("する", "行う", "おこなう", "図る", "進める");
const topic = particle("は", "も");

function actionEnd(tokens, start, nominal) {
  if (!actions(tokens[start])) return -1;
  if (tokens[start + 1]?.pos === "名詞") return -1; // 対応表、処理速度などは動作名ではない。
  let end = start + 1;
  if (particle("を", "は", "も", "が")(tokens[end])) {
    end += 1;
    if (topic(tokens[end])) end += 1;
  }
  if (actions(tokens[end]) && verb("する")(tokens[end + 1])) end += 1;
  if (support(tokens[end]) || verb("できる")(tokens[end])) return predicateEnd(tokens, end);
  if (!nominal) return -1;
  if (particle("で")(tokens[end])) {
    end += 1;
    if (topic(tokens[end])) end += 1;
  }
  if (tokens[end]?.pos === "助動詞" || verb("ある")(tokens[end]) ||
    (tokens[end]?.pos === "形容詞" && ["ない", "無い"].includes(tokens[end].basic_form))) {
    return predicateEnd(tokens, end);
  }
  return start + 1;
}

function findAction(tokens, start, { nominal = false } = {}) {
  for (let index = start; index < tokens.length; index += 1) {
    const end = actionEnd(tokens, index, nominal);
    if (end !== -1) return end;
    const token = tokens[index];
    // Nominal arguments can precede the predicate; a different predicate,
    // comma or quotation changes the clause and must stop this search.
    if ((nominal && !["名詞", "接頭詞"].includes(token.pos)) ||
      !["名詞", "助詞", "接頭詞"].includes(token.pos) || token.pos_detail_1 === "接続助詞") break;
  }
  return -1;
}

function analyze(tokens) {
  const findings = [];
  const add = (start, end, suggestion) => {
    if (end > start) findings.push(tokenFinding(tokens, start, end, suggestion));
  };
  for (let start = 0; start < tokens.length; start += 1) {
    const token = tokens[start];
    if (noun("適切", "適宜", "十分", "慎重")(token)) {
      let next = start + 1;
      const nominal = surface("な", "の")(tokens[next]);
      if (surface("な", "の", "に")(tokens[next])) next += 1;
      else if (token.surface_form !== "適宜") continue;
      if (surface("、", ",", "，")(tokens[next])) next += 1;
      add(start, findAction(tokens, next, { nominal }), "程度や方法を判断する基準と、実際に行うことを確認してください");
    }
    if (noun("必要", "状況")(token) && particle("に")(tokens[start + 1]) && verb("応じる")(tokens[start + 2])) {
      const ending = predicateEnd(tokens, start + 2);
      let next = ending;
      if (surface("、", ",", "，")(tokens[next])) next += 1;
      // A concrete action alone does not clarify this condition.
      add(start, Math.max(ending, findAction(tokens, next, { nominal: surface("た")(tokens[ending - 1]) })), "実施する条件・しない条件が前後の文から分かるか確認してください");
    }
    const demonstrative = ["これ", "それ", "本件", "当該事項"].map((word) => wordAt(tokens, start, word)).find((end) => end !== -1);
    if (demonstrative !== undefined && particle("を", "は", "も", "の", "に", "について", "に対して", "に関して", "に対する", "へ")(tokens[demonstrative])) {
      let next = demonstrative + 1;
      if (particle("に")(tokens[demonstrative]) && verb("対する", "関する")(tokens[next])) next = predicateEnd(tokens, next);
      if (topic(tokens[next]) || particle("の")(tokens[next])) next += 1;
      if (surface("、", ",", "，")(tokens[next])) next += 1;
      add(start, findAction(tokens, next), "指示語の参照先と、対象に対して行う操作が明確か確認してください");
    }
  }
  return findings;
}

export default japaneseRule(analyze, (suggestion) => `曖昧な動作の候補です。${suggestion}。否定・条件を保って見直してください。`);
