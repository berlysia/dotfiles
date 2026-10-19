import { tokenize } from "kuromojin";
import { split, SentenceSplitterSyntax } from "sentence-splitter";
import { StringSource } from "textlint-util-to-string";

function literalRanges(text, phrase) {
  const ranges = [];
  for (let start = text.indexOf(phrase); start !== -1; start = text.indexOf(phrase, start + 1)) {
    ranges.push([start, start + phrase.length]);
  }
  return ranges;
}

// Preserve leaf source ranges across emphasis and links. Excluded nodes are
// barriers, not deleted text that could join two unrelated words.
function proseLeaves(node) {
  if (node.children) return node.children.flatMap(proseLeaves);
  const value = node.type === "Str"
    ? node.raw.replace(/https?:\/\/[^\s<>]+/g, (url) => "。".repeat(url.length))
    : "。".repeat(node.raw.length);
  return [{ ...node, type: "Str", value }];
}

export const surface = (...values) => (token) => token && values.includes(token.surface_form);
export const noun = (...values) => (token) => token?.pos === "名詞" && values.includes(token.surface_form);
export const verb = (...values) => (token) => token?.pos === "動詞" && values.includes(token.basic_form);
export const particle = (...values) => (token) => token?.pos === "助詞" && values.includes(token.surface_form);

// A word can contain several dictionary tokens, e.g. ロバスト. Match complete
// token boundaries; callers also check compound suffixes. Never strip 助詞.
export function wordAt(tokens, start, word) {
  let value = "";
  for (let index = start; index < tokens.length; index += 1) {
    if (index > start && tokens[index - 1].end !== tokens[index].start) return -1;
    value += tokens[index].surface_form;
    if (value === word) return index + 1;
    if (!word.startsWith(value)) return -1;
  }
  return -1;
}

export function predicateEnd(tokens, start) {
  let end = start + 1;
  while (end < tokens.length) {
    const token = tokens[end];
    if (token.pos === "助動詞" ||
      (["動詞", "形容詞"].includes(token.pos) && ["接尾", "非自立"].includes(token.pos_detail_1)) ||
      (token.pos === "形容詞" && ["ない", "無い"].includes(token.basic_form))) {
      end += 1;
    } else if (particle("て", "で")(token)) {
      end += 1;
    } else if (particle("は", "も")(token) && surface("て", "で")(tokens[end - 1])) {
      end += 1;
    } else if (verb("いる", "おる", "ある")(token) && particle("は", "も")(tokens[end - 1]) &&
      surface("て", "で")(tokens[end - 2])) {
      end += 1;
    } else if (particle("ば")(token)) {
      const negative = ["ない", "ぬ"].includes(tokens[end - 1].basic_form);
      end += 1;
      if (negative && verb("なる")(tokens[end])) end += 1;
      else break;
    } else break;
  }
  return end;
}

export function tokenFinding(tokens, start, end, suggestion) {
  return { start: tokens[start].start, end: tokens[end - 1].end, suggestion };
}

export function japaneseRule(analyze, describe) {
  return (context, options = {}) => {
    const { Syntax, report, RuleError, locator } = context;
    const allow = options.allow ?? [];
    if (!Array.isArray(allow) || allow.some((item) => typeof item !== "string" || !item.length)) {
      throw new Error("allow には空でない文字列の配列を指定してください。");
    }
    let quoteDepth = 0;
    async function check(node) {
      if (quoteDepth > 0) return;
      const source = new StringSource({ ...node, type: "Paragraph", children: proseLeaves(node) });
      const text = source.toString();
      const excluded = allow.flatMap((phrase) => literalRanges(text, phrase));
      for (const sentence of split(text).filter((part) => part.type === SentenceSplitterSyntax.Sentence)) {
        // word_position is not a UTF-16 offset after astral characters. Locate
        // surface forms in order, without mutating kuromojin's cached tokens.
        let cursor = 0;
        const tokens = (await tokenize(sentence.raw)).map((token) => {
          const start = sentence.raw.indexOf(token.surface_form, cursor);
          if (start === -1) throw new Error("形態素の原文位置を復元できませんでした。");
          cursor = start + token.surface_form.length;
          return { ...token, start: start + sentence.range[0], end: cursor + sentence.range[0] };
        }).filter((token) => !/^\s+$/u.test(token.surface_form));
        const findings = analyze(tokens);
        const kept = [];
        for (const finding of findings.sort((a, b) => a.start - b.start || b.end - a.end)) {
          if (excluded.some(([start, end]) => start <= finding.start && finding.end <= end)) continue;
          if (kept.some(({ start, end }) => start <= finding.start && finding.end <= end)) continue;
          const start = source.originalIndexFromIndex(finding.start);
          const end = source.originalIndexFromIndex(finding.end, true);
          if (start === undefined || end === undefined) throw new Error("指摘の原文位置を復元できませんでした。");
          kept.push(finding);
          report(node, new RuleError(describe(finding.suggestion), { padding: locator.range([start, end]) }));
        }
      }
    }
    return {
      [Syntax.BlockQuote]() { quoteDepth += 1; },
      [Syntax.BlockQuoteExit]() { quoteDepth -= 1; },
      [Syntax.Paragraph]: check,
      [Syntax.Header]: check,
      [Syntax.TableCell]: check
    };
  };
}
