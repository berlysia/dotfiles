// Naive reference for the paragraph sentence rules (spec K2). It restates the
// rules as literally as possible and ignores speed, so that the production
// scanner is checked against an independent reading of the same rules. It lives
// outside the test file because the T3 regression script imports it too, and
// importing a test file would run the tests.

const SENTENCE_ENDS = new Set(["。", "！", "？", "!", "?"]);
const OPENERS = new Set(["「", "『", "（"]);
const CLOSERS = new Set(["」", "』", "）"]);

export function splitSentencesReference(text: string): string[] {
  const chars = [...text];
  const sentences: string[] = [];
  let current = "";
  let depth = 0;
  let index = 0;
  const flush = () => {
    const sentence = current.trim();
    if (sentence !== "") sentences.push(sentence);
    current = "";
  };
  while (index < chars.length) {
    const char = chars[index] as string;
    current += char;
    index += 1;
    if (OPENERS.has(char)) {
      depth += 1;
    } else if (CLOSERS.has(char)) {
      depth = Math.max(0, depth - 1);
    } else if (SENTENCE_ENDS.has(char) && depth === 0) {
      // Trailing closers and further end marks belong to the sentence just ended.
      while (index < chars.length) {
        const next = chars[index] as string;
        if (!CLOSERS.has(next) && !SENTENCE_ENDS.has(next)) break;
        current += next;
        index += 1;
      }
      flush();
    }
  }
  flush();
  return sentences;
}
