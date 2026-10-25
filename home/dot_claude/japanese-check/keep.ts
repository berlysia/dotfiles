import type { KeepComment } from "./markdown.ts";

// `<!-- ja-check-keep <rule> <text> -- <reason> -->` on the line of a candidate
// records that the writer judged it and why. The marker lives in the document,
// so the judgement survives a new machine or clone, and a marker that no
// longer matches anything is reported instead of lingering.
const KEYWORD = "ja-check-keep";

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

// null: the comment is not a keep marker at all.
export function parseMarker(body: string): Parsed | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith(KEYWORD)) return null;
  const rest = trimmed.slice(KEYWORD.length);
  if (rest !== "" && !/^\s/u.test(rest)) return null;
  let tail = rest.trimStart();
  const rule = /^\S+/u.exec(tail)?.[0];
  if (rule === undefined || rule === "--")
    return { ok: false, problem: "規則が書かれていない" };
  tail = tail.slice(rule.length).trimStart();
  let text: string;
  if (tail.startsWith('"')) {
    const close = tail.indexOf('"', 1);
    if (close < 0)
      return { ok: false, problem: "対象の文字列の引用が閉じていない" };
    text = tail.slice(1, close);
    tail = tail.slice(close + 1).trimStart();
  } else {
    text = /^\S*/u.exec(tail)?.[0] ?? "";
    if (text === "--") text = "";
    else tail = tail.slice(text.length).trimStart();
  }
  if (text === "")
    return { ok: false, problem: "対象の文字列が書かれていない" };
  const reason = tail.startsWith("--") ? tail.slice(2).trim() : "";
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
        problem: "同じ行に当たる候補が無い",
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
