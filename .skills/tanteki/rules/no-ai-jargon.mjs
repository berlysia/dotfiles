import { japaneseRule, particle, predicateEnd, surface, tokenFinding, verb, wordAt } from "./lib/japanese-rule.mjs";

const terms = [
  ["レバレッジ", "使う対象と用途を書く"],
  ["シームレス", "利用者が何をせずに何をできるか書く"],
  ["アクショナブル", "誰が何を実行できるのか書く"],
  ["包括的", "対象範囲を列挙する"],
  ["観測", "確認・計測・調査など、実際に行ったことを書く"],
  ["ホリスティック", "対象範囲と要素どうしの関係を列挙する"],
  ["プロアクティブ", "いつ、誰が、何を先回りして行うか明記する"],
  ["ロバスト", "想定する故障・入力と満たす性質を明記する"],
  ["ゲームチェンジャー", "何がどのように変わるか明記する"]
];

function analyze(tokens) {
  const findings = [];
  const add = (start, end, suggestion) => findings.push(tokenFinding(tokens, start, end, suggestion));
  for (let start = 0; start < tokens.length; start += 1) {
    // A known awkward label; do not ban the character in 階段, 段落 or 3段.
    if (surface("段")(tokens[start]) && tokens[start].pos_detail_1 === "一般" &&
      tokens[start + 1]?.pos_detail_1 === "数") {
      let end = start + 2;
      while (tokens[end]?.pos_detail_1 === "数") end += 1;
      add(start, end, "手順の番号なら「ステップ」「手順」など、その役割に合う語で表す");
    }
    for (const [term, suggestion] of terms) {
      const end = wordAt(tokens, start, term);
      // A dictionary token can itself be part of a technical compound.
      const previous = tokens[start - 1];
      const next = tokens[end];
      if (end !== -1 && !(term === "観測" &&
        ((next?.pos === "名詞" && tokens[end - 1].end === next.start) ||
          (previous?.end === tokens[start].start && ["名詞", "接頭詞"].includes(previous.pos) && previous.pos_detail_1 !== "副詞可能")))) {
        add(start, end, suggestion);
      }
    }
    const optimized = wordAt(tokens, start, "最適化");
    if (optimized !== -1 && verb("する")(tokens[optimized]) && verb("れる", "られる")(tokens[optimized + 1])) {
      add(start, predicateEnd(tokens, optimized), "何をどの指標で改善したか明記する");
    }
    for (const [term, verbs, suggestion] of [
      ["価値", ["解き放つ"], "誰にどの価値を提供するか明記する"],
      ["アラインメント", ["取る", "とる"], "誰と何について合意するか明記する"]
    ]) {
      const end = wordAt(tokens, start, term);
      if (end === -1) continue;
      if (particle("の")(tokens[end]) && surface(term === "価値" ? "解放" : "取得")(tokens[end + 1])) {
        add(start, end + 2, suggestion);
      }
      if (!particle("を", "は", "も")(tokens[end])) continue;
      let next = end + 1;
      if (particle("は", "も")(tokens[next])) next += 1;
      if (surface("、", ",", "，")(tokens[next])) next += 1;
      // Accept nominal arguments (価値を利用者が…) up to the first predicate.
      while (tokens[next] && ["名詞", "助詞", "接頭詞"].includes(tokens[next].pos) &&
        tokens[next].pos_detail_1 !== "接続助詞" && !particle("を")(tokens[next])) next += 1;
      if (verb(...verbs)(tokens[next])) add(start, predicateEnd(tokens, next), suggestion);
    }
  }
  return findings;
}

export default japaneseRule(analyze, (suggestion) =>
  `直訳調・抽象的な表現の候補です。${suggestion}。対象と動作を具体化してください。`);
