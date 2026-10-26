// Pure helpers for english-reply-gate: decide whether a reply is English
// prose, and whether the user asked for English. No I/O lives here so the
// thresholds can be exercised with a table of strings.

// Thresholds measured on 4,195 final replies from recent sessions: Japanese
// replies never fell below a kana ratio of 0.087, English ones sat under 0.02
// (plus a few quote-heavy ones up to 0.05). Replies under 200 Latin letters
// are short status lines; a rewrite round trip is not worth it for those.
const MIN_LATIN_LETTERS = 200;
const KANA_RATIO_LIMIT = 0.05;

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const URL = /https?:\/\/\S+/g;
const QUOTED_LINE = /^[ \t]*>.*$/gm;
// A word containing / or \ is a path; and/or is swept up too, which is
// accepted because an English reply has far more than a word's worth of letters.
const PATH_LIKE_WORD = /\S*[/\\]\S*/g;

/** Remove everything that is not the author's own sentences. */
export function stripNonProse(text: string): string {
  return text
    .replace(FENCED_CODE, "")
    .replace(INLINE_CODE, "")
    .replace(URL, "")
    .replace(QUOTED_LINE, "")
    .replace(PATH_LIKE_WORD, "");
}

/**
 * Count hiragana/katakana (K) and ASCII letters (L) in the prose part.
 * Kanji is not counted: kana marks a Japanese sentence, and kanji-only
 * headings would make the ratio swing.
 */
export function countProse(text: string): { kana: number; latin: number } {
  const prose = stripNonProse(text);
  return {
    kana: (prose.match(/[ぁ-ゖァ-ヺー]/g) ?? []).length,
    latin: (prose.match(/[A-Za-z]/g) ?? []).length,
  };
}

/** True when the prose is long enough and has almost no kana. */
export function isEnglishProse(text: string): boolean {
  const { kana, latin } = countProse(text);
  // K/(K+L) < 0.05 written in integers so the 0.05 boundary is exact.
  return latin >= MIN_LATIN_LETTERS && kana < KANA_RATIO_LIMIT * (kana + latin);
}

const ENGLISH_REQUEST = /in english|英語で(?:答|返|書|説明)|英語にして/gi;
const JAPANESE_REQUEST = /in japanese|日本語で|日本語に戻/gi;

function lastMatchIndex(pattern: RegExp, text: string): number {
  let last = -1;
  for (const match of text.matchAll(pattern)) last = match.index ?? last;
  return last;
}

function userInputText(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as {
    type?: unknown;
    message?: { content?: unknown };
    attachment?: { type?: unknown; prompt?: unknown };
  };
  if (record.type === "user") {
    const content = record.message?.content;
    return typeof content === "string" ? content : null;
  }
  if (
    record.type === "attachment" &&
    record.attachment?.type === "queued_command"
  ) {
    const prompt = record.attachment.prompt;
    return typeof prompt === "string" ? prompt : null;
  }
  return null;
}

/**
 * Walk the user's inputs from newest to oldest; the first one that names a
 * language decides. The input's own language is deliberately not consulted:
 * pasting an English error message is not a request for English.
 */
export function findEnglishRequest(transcriptTail: string): boolean {
  const lines = transcriptTail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let text: string | null;
    try {
      text = userInputText(JSON.parse(line));
    } catch {
      // The window can start mid-line.
      continue;
    }
    if (text === null) continue;
    const en = lastMatchIndex(ENGLISH_REQUEST, text);
    const ja = lastMatchIndex(JAPANESE_REQUEST, text);
    if (en < 0 && ja < 0) continue;
    return en > ja;
  }
  return false;
}
