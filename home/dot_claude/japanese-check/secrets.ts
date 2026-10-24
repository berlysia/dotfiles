// 認証情報の形の走査。入力の本文を返さず、行の番号と固定の種類だけを返す。
// import は持たない（入力は呼び出し側が safe-read.ts で読む）。
//
// 最善努力: 一覧に無い形、分かち書きや改行で割られた値は拾わない。当たりが無いことは
// 秘密が無いことを意味しない。
//
// 時間: 行ごとに走査し、1 行の走査の総量を行の長さに比例させる。接頭辞と名前の語は
// indexOf で位置を見つけ、その位置から後ろの文字種と長さを上限つきで読む。読んだ区間は
// 読み直さない（次の探索は読み終えた位置から始める）。1 行で 1 つの kind が当たったら、
// その行のその kind の探索をやめる。大文字小文字を区別しない比較は ASCII の A-Z だけを
// 小文字にする（toLowerCase は文字によって長さが変わり、位置がずれる）。

export const MAX_SECRETS_BYTES = 256 * 1024;

export const SECRET_KINDS = [
  "openai-key",
  "anthropic-key",
  "aws-key",
  "google-key",
  "github-token",
  "gitlab-token",
  "slack-token",
  "jwt",
  "private-key-block",
  "authorization-header",
  "url-credentials",
  "assignment",
] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];
export interface SecretHit {
  line: number;
  kind: SecretKind;
}

type Accept = (code: number) => boolean;

const isDigit: Accept = (c) => c >= 48 && c <= 57;
const isUpper: Accept = (c) => c >= 65 && c <= 90;
const isLower: Accept = (c) => c >= 97 && c <= 122;
const isAlnum: Accept = (c) => isDigit(c) || isUpper(c) || isLower(c);
const isBase64Url: Accept = (c) => isAlnum(c) || c === 45 || c === 95;
const isUpperAlnum: Accept = (c) => isDigit(c) || isUpper(c);
const isSlack: Accept = (c) => isAlnum(c) || c === 45;
const isGithubPat: Accept = (c) => isAlnum(c) || c === 95;
const isIdent: Accept = (c) => isAlnum(c) || c === 95 || c === 45;
// [A-Za-z0-9_\-+/=.]
const isValueChar: Accept = (c) =>
  isAlnum(c) ||
  c === 95 ||
  c === 45 ||
  c === 43 ||
  c === 47 ||
  c === 61 ||
  c === 46;
const isBlank: Accept = (c) => c === 32 || c === 9;
const isQuote: Accept = (c) => c === 34 || c === 39 || c === 96;

/** `from` から accept の間だけ、最大 max 字を読んで、読み終えた位置を返す */
function readRun(line: string, from: number, accept: Accept, max: number) {
  const limit = Math.min(line.length, from + max);
  let end = from;
  while (end < limit && accept(line.charCodeAt(end))) end += 1;
  return end;
}

function lowerAscii(line: string): string {
  return line.replace(/[A-Z]/gu, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 32),
  );
}

// 直前が英数字でない位置で始まり、後ろに決まった文字種と長さが続く形
function scanPrefix(
  line: string,
  prefix: string,
  accept: Accept,
  min: number,
  max: number,
  excluded?: (position: number) => boolean,
): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf(prefix, from);
    if (at < 0) return false;
    const start = at + prefix.length;
    from = start;
    if (at > 0 && isAlnum(line.charCodeAt(at - 1))) continue;
    if (excluded?.(at)) continue;
    const end = readRun(line, start, accept, max);
    if (end - start >= min) return true;
    from = Math.max(from, end);
  }
}

function scanJwt(line: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf("eyJ", from);
    if (at < 0) return false;
    const start = at + 3;
    from = start;
    if (at > 0 && isAlnum(line.charCodeAt(at - 1))) continue;
    const headerEnd = readRun(line, start, isBase64Url, 2000);
    from = Math.max(from, headerEnd);
    if (headerEnd - start < 10 || line.charCodeAt(headerEnd) !== 46) continue;
    const bodyEnd = readRun(line, headerEnd + 1, isBase64Url, 2000);
    if (bodyEnd - (headerEnd + 1) >= 10) return true;
    from = Math.max(from, bodyEnd);
  }
}

function scanAuthorization(lower: string): boolean {
  let from = 0;
  for (;;) {
    const at = lower.indexOf("authorization:", from);
    if (at < 0) return false;
    from = at + 14;
    const scheme = readRun(lower, from, isBlank, 64);
    const length = lower.startsWith("bearer", scheme)
      ? 6
      : lower.startsWith("basic", scheme)
        ? 5
        : 0;
    if (length > 0) {
      const valueAt = readRun(lower, scheme + length, isBlank, 64);
      if (
        valueAt > scheme + length &&
        valueAt < lower.length &&
        !isBlank(lower.charCodeAt(valueAt)) &&
        lower.charCodeAt(valueAt) !== 13
      )
        return true;
    }
    from = Math.max(from, scheme);
  }
}

const URL_TERMINATORS = new Set([47, 63, 35, 32, 9, 13, 10]);

function scanUrlCredentials(line: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf("://", from);
    if (at < 0) return false;
    const start = at + 3;
    from = start;
    if (at === 0 || !isAlnum(line.charCodeAt(at - 1))) continue;
    const limit = Math.min(line.length, start + 256);
    let colon = -1;
    let end = start;
    while (end < limit && !URL_TERMINATORS.has(line.charCodeAt(end))) {
      const code = line.charCodeAt(end);
      if (code === 58 && colon < 0) colon = end;
      // user:password@ — a colon before the @ and something after the colon
      if (code === 64 && colon > start && end > colon + 1) return true;
      end += 1;
    }
    from = Math.max(from, end);
  }
}

const NAME_WORDS = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "api-key",
  "apikey",
];
// = : ： ＝
const isSeparator = (code: number) =>
  code === 61 || code === 58 || code === 0xff1a || code === 0xff1d;

function skipQuotesAndBlanks(line: string, from: number) {
  const limit = Math.min(line.length, from + 64);
  let end = from;
  let quoted = false;
  while (end < limit) {
    const code = line.charCodeAt(end);
    if (isQuote(code)) quoted = true;
    else if (!isBlank(code)) break;
    end += 1;
  }
  return { end, quoted };
}

function scanAssignment(line: string, lower: string): boolean {
  for (const word of NAME_WORDS) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(word, from);
      if (at < 0) break;
      // The rest of the identifier (access_token_value) belongs to the name.
      const nameEnd = readRun(lower, at + word.length, isIdent, 64);
      from = nameEnd;
      const beforeSeparator = skipQuotesAndBlanks(line, nameEnd);
      from = Math.max(from, beforeSeparator.end);
      if (!isSeparator(line.charCodeAt(beforeSeparator.end))) continue;
      const afterSeparator = skipQuotesAndBlanks(line, beforeSeparator.end + 1);
      from = Math.max(from, afterSeparator.end);
      if (afterSeparator.quoted) {
        const code = line.charCodeAt(afterSeparator.end);
        if (
          afterSeparator.end < line.length &&
          !isQuote(code) &&
          !isBlank(code) &&
          code !== 13
        )
          return true;
        continue;
      }
      const valueEnd = readRun(line, afterSeparator.end, isValueChar, 512);
      if (valueEnd - afterSeparator.end >= 8) return true;
      from = Math.max(from, valueEnd);
    }
  }
  return false;
}

type LineScan = (line: string, lower: string) => boolean;

const LINE_SCANS: Array<[SecretKind, LineScan]> = [
  [
    "openai-key",
    (line) =>
      scanPrefix(line, "sk-", isBase64Url, 20, 200, (at) =>
        line.startsWith("sk-ant-", at),
      ),
  ],
  [
    "anthropic-key",
    (line) => scanPrefix(line, "sk-ant-", isBase64Url, 20, 200),
  ],
  ["aws-key", (line) => scanPrefix(line, "AKIA", isUpperAlnum, 16, 16)],
  ["google-key", (line) => scanPrefix(line, "AIza", isBase64Url, 35, 35)],
  [
    "github-token",
    (line) =>
      scanPrefix(line, "ghp_", isAlnum, 36, 36) ||
      scanPrefix(line, "github_pat_", isGithubPat, 22, 255),
  ],
  ["gitlab-token", (line) => scanPrefix(line, "glpat-", isBase64Url, 20, 64)],
  [
    "slack-token",
    (line) =>
      ["a", "b", "p", "r", "s"].some((letter) =>
        scanPrefix(line, `xox${letter}-`, isSlack, 10, 200),
      ),
  ],
  ["jwt", (line) => scanJwt(line)],
  ["authorization-header", (_line, lower) => scanAuthorization(lower)],
  ["url-credentials", (line) => scanUrlCredentials(line)],
  ["assignment", (line, lower) => scanAssignment(line, lower)],
];

/** 本文から認証情報の形を探す。行は \n で区切り、1 から数える。CR は行末の文字として扱う */
export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let inBlock = false;
  text.split("\n").forEach((line, index) => {
    const number = index + 1;
    // A block runs from the BEGIN line to the END line, or to the end of the
    // file when no END follows. Certificates are included on purpose.
    let blockHit = false;
    if (inBlock) {
      blockHit = true;
      if (line.includes("-----END")) inBlock = false;
    } else {
      const begin = line.indexOf("-----BEGIN");
      if (begin >= 0) {
        blockHit = true;
        inBlock = line.indexOf("-----END", begin) < 0;
      }
    }
    const lower = lowerAscii(line);
    for (const [kind, scan] of LINE_SCANS) {
      if (scan(line, lower)) hits.push({ line: number, kind });
    }
    if (blockHit) hits.push({ line: number, kind: "private-key-block" });
  });
  return hits;
}
