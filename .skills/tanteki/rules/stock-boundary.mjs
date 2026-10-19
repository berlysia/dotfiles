function maskedSource(source, ranges) {
  const characters = source.split("");
  for (const [start, end] of ranges) {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  return characters.join("");
}

function allMatches(source, expression) {
  return [...source.matchAll(new RegExp(expression.source, `${expression.flags.replace("g", "")}g`))];
}

export default function stockBoundary(context) {
  const { Syntax, getSource, report, RuleError, locator } = context;
  let quoteDepth = 0;
  let document;
  const excludedRanges = [];

  function reportMatches(node, source, expression, label) {
    for (const match of allMatches(source, expression)) {
      report(node, new RuleError(`文書に${label}が含まれています。作業追跡はチケットまたは進捗文書へ移してください。`, {
        padding: locator.range([match.index, match.index + match[0].length])
      }));
    }
  }

  return {
    [Syntax.Document](node) {
      document = node;
    },
    [Syntax.DocumentExit]() {
      const source = getSource(document);
      const masked = maskedSource(source, excludedRanges.map(([start, end]) => [start - document.range[0], end - document.range[0]]));
      reportMatches(document, masked, /進捗(?:状況)?\s*[:：]\s*[^\n]+/g, "進捗の記述");
      reportMatches(document, masked, /(?:状態|ステータス)\s*[:：]\s*(?:実装中|進行中|対応中|未着手|保留)/g, "作業状態の記述");
      reportMatches(document, masked, /(?:\b(?:PR|Pull Request)|プルリクエスト)\s*[#＃]\s*\d+\b/gi, "PR番号");
      reportMatches(document, masked, /https?:\/\/[^\s<>"')\]]*\/(?:(?:pull|pulls|issues)\/\d+|browse\/[A-Z][A-Z0-9]{1,9}-\d+)[^\s<>"')\]]*/gi, "PR・IssueまたはJiraのリンクURL");
    },
    [Syntax.BlockQuote](node) {
      quoteDepth += 1;
      excludedRanges.push(node.range);
    },
    [Syntax.BlockQuoteExit]() {
      quoteDepth -= 1;
    },
    [Syntax.CodeBlock](node) {
      excludedRanges.push(node.range);
    },
    [Syntax.Header](node) {
      if (quoteDepth > 0) return;
      const title = getSource(node).replace(/^#{1,6}\s*/, "").replace(/\n[=-]+\s*$/, "").trim();
      if (/^(?:(?:作業|実装|開発)の?)?(?:進捗(?:状況|報告)?|ステータス(?:詳細)?)(?:$|[\s:：])/.test(title)) {
        report(node, new RuleError("文書に進捗見出しが含まれています。作業追跡はチケットまたは進捗文書へ移してください。"));
      }
    },
    [Syntax.ListItem](node) {
      if (quoteDepth > 0) return;
      if (node.checked === true || node.checked === false) {
        report(node, new RuleError("文書に未完了または完了済みタスクのチェックボックスが含まれています。作業追跡はチケットまたは進捗文書へ移してください。", {
          padding: locator.range([0, 5])
        }));
      }
    }
  };
}
