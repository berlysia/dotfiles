import { japaneseRule, particle, tokenFinding, wordAt } from "./lib/japanese-rule.mjs";

// Semantic components, not complete invented names: review the relation between
// a purpose, an abstract change and a container rather than banning long words.
const effects = ["創出", "向上", "高度化", "最大化", "最適化", "迅速化", "効率化", "強化", "促進", "推進", "横断", "データドリブン"];
const containers = ["基盤", "機構", "レイヤー", "プラットフォーム", "システム", "枠組み"];

function analyze(tokens) {
  const findings = [];
  for (let start = 0; start < tokens.length;) {
    if (tokens[start].pos !== "名詞") { start += 1; continue; }
    let end = start;
    let targets = 0;
    let changes = 0;
    let container = false;
    while (end < tokens.length) {
      if (particle("の")(tokens[end]) && tokens[end + 1]?.pos === "名詞") { end += 1; continue; }
      if (tokens[end].pos !== "名詞") break;
      const effectEnd = effects.map((word) => wordAt(tokens, end, word)).find((index) => index !== -1);
      const containerEnd = containers.map((word) => wordAt(tokens, end, word)).find((index) => index !== -1);
      if (effectEnd !== undefined) {
        if (targets > 0) changes += 1;
        end = effectEnd;
      }
      else if (containerEnd !== undefined) {
        container = true;
        end = containerEnd;
        if (targets > 0 && changes > 0) findings.push(tokenFinding(tokens, start, end,
          "対象・抽象的な変化・仕組みを名詞で重ねています。誰が何をどうするのか、要素の関係を書いてください"));
        // A later の最適化 describes work on this container, not its name.
        targets = 0;
        changes = 0;
      } else { targets += 1; end += 1; }
    }
    // の states attribution but does not by itself explain who does what.
    if (!container && targets > 0 && changes >= 2) {
      findings.push(tokenFinding(tokens, start, end, "目的・変化・仕組みを名詞で重ねています。誰が何をどうするのか、要素の関係を書いてください"));
    }
    start = end;
  }
  return findings;
}

export default japaneseRule(analyze, (suggestion) => `名詞の関係が分かりにくい表現の候補です。${suggestion}。`);
