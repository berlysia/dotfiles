const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
const MAX_CELL_LENGTH = 60;

function visibleText(node, Syntax) {
  if (node.children) return node.children.map((child) => visibleText(child, Syntax)).join("");
  if (node.type === Syntax.Image || node.type === Syntax.ImageReference) return node.alt ?? "";
  if (node.type === Syntax.Break) return "\n";
  if (node.type === Syntax.Html) return /^<br\s*\/?\s*>$/i.test(node.value) ? "\n" : "";
  return node.value ?? "";
}

export default function tableCellLength(context) {
  const { Syntax, report, RuleError } = context;
  let quoteDepth = 0;

  return {
    [Syntax.BlockQuote]() {
      quoteDepth += 1;
    },
    [Syntax.BlockQuoteExit]() {
      quoteDepth -= 1;
    },
    [Syntax.TableCell](node) {
      if (quoteDepth > 0) return;
      const length = [...segmenter.segment(visibleText(node, Syntax).trim())].length;
      if (length <= MAX_CELL_LENGTH) return;
      report(node, new RuleError(`表のセルが${length}文字あります。各セルは${MAX_CELL_LENGTH}文字以内にし、詳しい説明は表の外の見出しと段落へ移してください。条件や例外は削らないでください。`));
    }
  };
}
