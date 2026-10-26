import type { KeepComment } from "./markdown.ts";

// `<!-- ja-check-keep <rule> -- <text> <reason> -->` on the line of a candidate
// records that the writer judged it and why. The marker lives in the document,
// so the judgement survives a new machine or clone, and a marker that no
// longer matches anything is reported instead of lingering.
//
// The field before the first `--` holds exactly one rule word, so a marker
// reads the same however its fields are counted. Everything after `--` is read
// from the original string: the text, then the reason as free prose that is
// never interpreted. A space here is an ASCII space or a tab; a full-width
// space is an ordinary character.
const KEYWORD = "ja-check-keep";
const BLANK = /[ \t]/u;

export interface Candidate {
  rule: string;
  line: number;
  text: string;
}
export interface Kept {
  rule: string;
  line: number;
  text: string;
  reason: string;
}
export interface KeepIssue {
  line: number;
  problem: string;
}

type Parsed =
  | { ok: true; rule: string; text: string; reason: string }
  | { ok: false; problem: string };

function trimBlanks(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/gu, "");
}

// null: the comment is not a keep marker at all. Only the first error is
// reported.
export function parseMarker(body: string): Parsed | null {
  const trimmed = trimBlanks(body);
  const words = [...trimmed.matchAll(/[^ \t]+/gu)];
  if (words[0]?.[0] !== KEYWORD) return null;
  const rest = words.slice(1);
  const delimiter = rest.findIndex((word) => word[0] === "--");
  if (delimiter < 0)
    return {
      ok: false,
      problem: rest.length === 0 ? "規則が書かれていない" : "`--` が無い",
    };
  if (delimiter === 0) return { ok: false, problem: "規則が書かれていない" };
  if (delimiter > 1) return { ok: false, problem: "`--` の前は規則 1 語だけ" };
  const rule = rest[0]?.[0] ?? "";
  const mark = rest[delimiter];
  let tail = trimmed.slice((mark?.index ?? 0) + 2).replace(/^[ \t]+/u, "");
  if (tail === "")
    return { ok: false, problem: "対象の文字列が書かれていない" };
  let text: string;
  if (tail.startsWith('"')) {
    const close = tail.indexOf('"', 1);
    if (close < 0) return { ok: false, problem: "引用が閉じていない" };
    text = tail.slice(1, close);
    if (trimBlanks(text) === "")
      return { ok: false, problem: "対象の文字列が書かれていない" };
    tail = tail.slice(close + 1);
    if (tail !== "" && !BLANK.test(tail.charAt(0)))
      return { ok: false, problem: "引用の後ろに空白が無い" };
  } else {
    text = /^[^ \t]+/u.exec(tail)?.[0] ?? "";
    tail = tail.slice(text.length);
  }
  const reason = trimBlanks(tail);
  if (reason === "") return { ok: false, problem: "理由が無い" };
  return { ok: true, rule, text, reason };
}

// A marker keeps every candidate on its line with the same rule whose text
// contains the marker's text as a plain substring (never as a pattern).
export function matchKeeps(
  comments: readonly KeepComment[],
  candidates: readonly Candidate[],
): { kept: Kept[]; keepIssues: KeepIssue[]; keptCandidates: Set<Candidate> } {
  const kept: Kept[] = [];
  const keepIssues: KeepIssue[] = [];
  const keptCandidates = new Set<Candidate>();
  for (const comment of comments) {
    const marker = parseMarker(comment.body);
    if (marker === null) continue;
    if (!marker.ok) {
      keepIssues.push({ line: comment.line, problem: marker.problem });
      continue;
    }
    const matched = candidates.filter(
      (item) =>
        item.line === comment.line &&
        item.rule === marker.rule &&
        item.text.includes(marker.text),
    );
    if (matched.length === 0) {
      keepIssues.push({
        line: comment.line,
        problem: "同じ行に該当する候補が無い",
      });
      continue;
    }
    for (const item of matched) {
      if (keptCandidates.has(item)) continue;
      keptCandidates.add(item);
      kept.push({
        rule: item.rule,
        line: item.line,
        text: item.text,
        reason: marker.reason,
      });
    }
  }
  return { kept, keepIssues, keptCandidates };
}
