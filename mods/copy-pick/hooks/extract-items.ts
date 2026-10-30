import type { SessionMessage } from "claude-code";

export type PickKind = "code" | "inline" | "full";

export type PickItem = {
  kind: PickKind;
  text: string;
  label: string;
  truncated: boolean;
  /** Index of the source message; items sharing it came from one response. */
  group: number;
};

export type ExtractItemsResult = {
  items: PickItem[];
  droppedCount: number;
};

const MAX_ITEMS = 200;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_LABEL_CODE_POINTS = 80;

type Candidate = { kind: PickKind; text: string };

function sanitize(text: string): string {
  const safeCharacters: string[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const remove =
      (codePoint >= 0x0000 && codePoint <= 0x0008) ||
      (codePoint >= 0x000b && codePoint <= 0x001f) ||
      (codePoint >= 0x007f && codePoint <= 0x009f) ||
      codePoint === 0x061c ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x2069) ||
      codePoint === 0xfeff;
    if (!remove) safeCharacters.push(character);
  }
  return safeCharacters.join("");
}

function isLineBreak(character: string): boolean {
  return character === "\n" || character === "\u2028" || character === "\u2029";
}

function lineCount(text: string): number {
  let count = 1;
  for (const character of text) {
    if (isLineBreak(character)) count += 1;
  }
  return count;
}

function characterCount(text: string): number {
  let count = 0;
  for (const character of text) {
    if (!isLineBreak(character)) count += 1;
  }
  return count;
}

function utf8Width(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function limitText(text: string): { text: string; truncated: boolean } {
  let byteCount = 0;
  const prefix: string[] = [];
  for (const character of text) {
    const width = utf8Width(character);
    if (byteCount + width > MAX_TEXT_BYTES) {
      return { text: prefix.join(""), truncated: true };
    }
    byteCount += width;
    prefix.push(character);
  }
  return { text, truncated: false };
}

function makeLabel(text: string): string {
  const characters = characterCount(text);
  const lines = lineCount(text);
  if (lines === 1 && characters <= MAX_LABEL_CODE_POINTS) return text;

  const suffix = ` (${lines} 行、${characters} 文字)`;
  const prefixLimit = Math.max(
    0,
    MAX_LABEL_CODE_POINTS - Array.from(suffix).length - 1,
  );
  let prefix = "";
  let count = 0;
  for (const character of text) {
    if (count >= prefixLimit) break;
    prefix += isLineBreak(character) ? " " : character;
    count += 1;
  }
  return `${prefix}…${suffix}`;
}

function isClosingFence(
  line: string,
  character: string,
  length: number,
): boolean {
  const match =
    character === "`"
      ? /^(`+)[\t ]*\r?$/.exec(line)
      : /^(~+)[\t ]*\r?$/.exec(line);
  const run = match?.[1] ?? "";
  return run.length >= length && run[0] === character;
}

function extractFencedCode(text: string): {
  code: string[];
  outside: string[];
} {
  const lines = text.split("\n");
  const code: string[] = [];
  const outside: string[] = [];
  let plainLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const opener = /^(`{3,}|~{3,})/.exec(line);
    if (opener === null) {
      plainLines.push(line);
      index += 1;
      continue;
    }

    outside.push(plainLines.join("\n"));
    plainLines = [];
    const fence = opener[1] ?? "";
    const fenceCharacter = fence[0] ?? "`";
    const contentStart = index + 1;
    let closingIndex = contentStart;
    while (
      closingIndex < lines.length &&
      !isClosingFence(lines[closingIndex] ?? "", fenceCharacter, fence.length)
    ) {
      closingIndex += 1;
    }
    code.push(lines.slice(contentStart, closingIndex).join("\n"));
    index = closingIndex < lines.length ? closingIndex + 1 : lines.length;
  }

  outside.push(plainLines.join("\n"));
  return { code, outside };
}

function runLength(text: string, start: number): number {
  let end = start;
  while (text[end] === "`") end += 1;
  return end - start;
}

function findClosingRun(
  text: string,
  start: number,
  length: number,
): { start: number; end: number } | null {
  let index = start;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const candidateStart = index;
    const candidateLength = runLength(text, candidateStart);
    index += candidateLength;
    if (candidateLength === length) {
      return { start: candidateStart, end: index };
    }
  }
  return null;
}

function extractCommandLikeInline(text: string): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const openingStart = index;
    const delimiterLength = runLength(text, openingStart);
    const contentStart = openingStart + delimiterLength;
    const closing = findClosingRun(text, contentStart, delimiterLength);
    if (closing === null) {
      index = contentStart;
      continue;
    }

    const value = sanitize(text.slice(contentStart, closing.start)).trim();
    if (/\s/.test(value) && (value.startsWith("! ") || /^[a-z]/.test(value))) {
      values.push(value);
    }
    index = closing.end;
  }
  return values;
}

function addCandidate(
  candidates: Candidate[],
  kind: PickKind,
  text: string,
): void {
  candidates.push({ kind, text });
}

function makeItem(candidate: Candidate, group: number): PickItem | null {
  let safeText = sanitize(candidate.text);
  if (candidate.kind === "inline") safeText = safeText.trim();
  if (safeText.trim() === "") return null;

  const limited = limitText(safeText);
  if (limited.text.trim() === "") return null;
  return {
    kind: candidate.kind,
    text: limited.text,
    label: makeLabel(safeText),
    truncated: limited.truncated,
    group,
  };
}

export function extractItems(
  messages: SessionMessage[],
  query: string,
): ExtractItemsResult {
  const extracted: PickItem[] = [];
  const seen = new Set<string>();

  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    if (
      message === undefined ||
      message.role !== "assistant" ||
      message.text.trim() === ""
    ) {
      continue;
    }

    const { code, outside } = extractFencedCode(message.text);
    const candidates: Candidate[] = [];
    for (const block of code) addCandidate(candidates, "code", block);
    for (const segment of outside) {
      for (const value of extractCommandLikeInline(segment)) {
        addCandidate(candidates, "inline", value);
      }
    }
    addCandidate(candidates, "full", message.text);

    for (const candidate of candidates) {
      const item = makeItem(candidate, messageIndex);
      if (item === null || seen.has(item.text)) continue;
      seen.add(item.text);
      extracted.push(item);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matches =
    normalizedQuery === ""
      ? extracted
      : extracted.filter((item) =>
          item.text.toLowerCase().includes(normalizedQuery),
        );
  const droppedCount = Math.max(0, matches.length - MAX_ITEMS);
  return { items: matches.slice(0, MAX_ITEMS), droppedCount };
}
