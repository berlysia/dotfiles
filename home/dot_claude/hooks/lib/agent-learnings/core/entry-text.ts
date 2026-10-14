import { COMPACTION_EXTRA_PATTERNS, sanitize } from "../../redact-secrets.ts";

export type Check = { ok: true } | { ok: false; reason: string };
export type TextRules = { allowUrl: boolean };

// 制御文字、ゼロ幅、bidi、soft hyphen、CGJ、Hangul filler、variation selector、Unicode tag
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f­͏ᅟᅠ​-‏‪-‮⁠-⁩ㅤ︀-️﻿ﾠ\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

export function preprocessText(
  text: string,
  extraRedact: readonly RegExp[],
): string {
  const spaced = text
    .normalize("NFKC")
    .replace(/[\t\r\n]+/g, " ")
    .replace(INVISIBLE, "");
  const { text: redacted } = sanitize(spaced, [
    ...COMPACTION_EXTRA_PATTERNS,
    ...extraRedact,
  ]);
  return redacted.replace(/\s+/g, " ").trim();
}

const TYPE_ARGS = /\b[A-Za-z_]\w*<[A-Z]\w*(?:\s*,\s*[A-Z]\w*)*>/g;
const COMMON_RULES: Array<[RegExp, string]> = [
  [/^#/, "starts with #"],
  [/```/, "code fence"],
  [/<!--|-->/, "comment marker"],
  [/\]\(/, "markdown link"],
  [/&lt;|&gt;/i, "html entity"],
];
const URL_RULE = /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./i;
const KEY_LIKE = /[A-Za-z0-9+/=_-]{32,}/g;

function checkCommon(text: string, rules: TextRules): Check {
  for (const [re, reason] of COMMON_RULES)
    if (re.test(text)) return { ok: false, reason };
  if (text.replace(TYPE_ARGS, "").includes("<"))
    return { ok: false, reason: "angle bracket" };
  if (!rules.allowUrl && URL_RULE.test(text))
    return { ok: false, reason: "url" };
  for (const token of text.match(KEY_LIKE) ?? []) {
    if (/[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token)) {
      return { ok: false, reason: "key-like token" };
    }
  }
  return { ok: true };
}

export function validateTitle(title: string, rules: TextRules): Check {
  if (title.length === 0 || title.length > 80)
    return { ok: false, reason: "title length" };
  return checkCommon(title, rules);
}

export function validateBody(body: string, rules: TextRules): Check {
  if (body.length === 0 || body.length > 400)
    return { ok: false, reason: "body length" };
  return checkCommon(body, rules);
}

export function normalizeHeading(title: string): string {
  return title.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}
