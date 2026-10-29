import { isFeedbackId } from "./item.ts";
import type { FeedbackItemV1, FeedbackKind, FeedbackAgent } from "./item.ts";
import {
  FEEDBACK_AGENTS,
  FEEDBACK_KINDS,
  FEEDBACK_LABEL,
  FEEDBACK_OWNER,
  FIELD_LIMITS,
  PUBLIC_REPO,
} from "./constants.ts";

export type MarkerMeta = Pick<FeedbackItemV1, "kind" | "target" | "source">;
export type MarkerResult =
  | { status: "ok"; id: string; v: 1; meta: MarkerMeta }
  | { status: "newer"; id: string; v: number }
  | { status: "unreadable" };

export function neutralizeMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, "＠");
}

export function renderIssue(item: FeedbackItemV1): {
  title: string;
  body: string;
  labels: string[];
} {
  if (!isFeedbackId(item.id)) throw new Error("dotfiles-feedback: invalid id");
  const meta: MarkerMeta = {
    kind: item.kind,
    target: neutralizeMentions(item.target),
    source: item.source,
  };
  const json = JSON.stringify(meta).replace(
    /[<>&]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return {
    title: neutralizeMentions(item.title),
    body: `<!-- dotfiles-feedback id=${item.id} v=1 ${json} -->\n\n対象: ${neutralizeMentions(item.target)}\n\n${neutralizeMentions(item.body)}`,
    labels: [FEEDBACK_LABEL, `kind:${item.kind}`],
  };
}

function validText(
  value: string | null | undefined,
  field: "target" | "repoKey" | "host",
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= FIELD_LIMITS[field] &&
    !/[\r\n]/.test(value)
  );
}

export function parseMarker(body: string): MarkerResult {
  const firstLine = body.split("\n", 1)[0] ?? "";
  const match =
    /^<!-- dotfiles-feedback id=(\S+) v=(\d+) (\{[\s\S]*\}) -->$/.exec(
      firstLine,
    );
  if (!match) return { status: "unreadable" };
  const [, id, version, json] = match;
  if (!id || !isFeedbackId(id)) return { status: "unreadable" };
  const v = Number(version);
  if (!Number.isSafeInteger(v) || v < 1) return { status: "unreadable" };
  if (v > 1) return { status: "newer", id, v };
  try {
    const meta = JSON.parse(json ?? "") as Partial<MarkerMeta> | null;
    if (
      !meta ||
      !FEEDBACK_KINDS.includes(meta.kind as FeedbackKind) ||
      !validText(meta.target, "target")
    )
      return { status: "unreadable" };
    const source = meta.source;
    if (
      !source ||
      typeof source !== "object" ||
      Array.isArray(source) ||
      !FEEDBACK_AGENTS.includes(source.agent) ||
      ("reportedAgent" in source &&
        !FEEDBACK_AGENTS.includes(source.reportedAgent as FeedbackAgent)) ||
      typeof source.vm !== "boolean" ||
      !validText(source.host, "host") ||
      (source.repoKey !== null && !validText(source.repoKey, "repoKey"))
    )
      return { status: "unreadable" };
    return {
      status: "ok",
      id,
      v: 1,
      meta: {
        kind: meta.kind as FeedbackKind,
        target: meta.target,
        source: {
          agent: source.agent,
          ...(source.reportedAgent === undefined
            ? {}
            : { reportedAgent: source.reportedAgent }),
          repoKey: source.repoKey,
          host: source.host,
          vm: source.vm,
        },
      },
    };
  } catch {
    return { status: "unreadable" };
  }
}

export type IssueSummary = {
  number: number;
  state: string;
  title: string;
  body: string;
  user: string;
  labels: string[];
  updatedAt: string;
  pullRequest: boolean;
};
export type IssueClass =
  | { kind: "target"; id: string; meta: MarkerMeta }
  | { kind: "unreadable" }
  | { kind: "not-target" };

// 対象は、自分の feedback label が付いた PR でない issue で、読める版のマーカーを持つもの。
// 作成者の確認は checkDestination が認証ユーザーについて済ませてから呼ぶ前提。
export function classifyIssue(issue: IssueSummary): IssueClass {
  if (
    issue.pullRequest ||
    !issue.labels.includes(FEEDBACK_LABEL) ||
    issue.user !== FEEDBACK_OWNER
  )
    return { kind: "not-target" };
  const marker = parseMarker(issue.body);
  return marker.status === "ok"
    ? { kind: "target", id: marker.id, meta: marker.meta }
    : { kind: "unreadable" };
}

export function countOpenTargets(issues: readonly IssueSummary[]): {
  targets: number;
  unreadable: number;
} {
  let targets = 0;
  let unreadable = 0;
  for (const issue of issues) {
    if (issue.state !== "open") continue;
    const kind = classifyIssue(issue).kind;
    if (kind === "target") targets++;
    else if (kind === "unreadable") unreadable++;
  }
  return { targets, unreadable };
}

export type TriageTo = "issue" | "plan" | "reject";
export type TriageActor = "agent" | "human";
export type IssueComment = {
  id: number;
  user: string;
  body: string;
  createdAt: string;
};
const PUBLIC_URL_PATTERN = `https://github\\.com/${PUBLIC_REPO}/issues/[1-9]\\d*`;

// web UI の編集で CRLF になったマーカーも読む。書くのは FEEDBACK_OWNER だけなので偽造の余地は増えない。
const withoutOneCr = (line: string) =>
  line.endsWith("\r") ? line.slice(0, -1) : line;
const firstLine = (text: string) => withoutOneCr(text.split("\n", 1)[0] ?? "");

export const renderTriageMarker = (to: TriageTo, actor: TriageActor) =>
  `<!-- dotfiles-feedback-triage to=${to} actor=${actor} -->`;
export function parseTriageMarker(
  commentBody: string,
): { to: TriageTo; actor: TriageActor } | null {
  const match =
    /^<!-- dotfiles-feedback-triage to=(issue|plan|reject) actor=(agent|human) -->$/.exec(
      firstLine(commentBody),
    );
  return match
    ? { to: match[1] as TriageTo, actor: match[2] as TriageActor }
    : null;
}
// 複数あれば createdAt が最も古いもの、同時刻なら id の小さいもの。
export function findTriageMarker(
  comments: readonly IssueComment[],
): { to: TriageTo; actor: TriageActor; comment: IssueComment } | null {
  let best: { to: TriageTo; actor: TriageActor; comment: IssueComment } | null =
    null;
  for (const comment of comments) {
    if (comment.user !== FEEDBACK_OWNER) continue;
    const parsed = parseTriageMarker(comment.body);
    if (!parsed) continue;
    const older =
      best === null ||
      Date.parse(comment.createdAt) < Date.parse(best.comment.createdAt) ||
      (comment.createdAt === best.comment.createdAt &&
        comment.id < best.comment.id);
    if (older) best = { ...parsed, comment };
  }
  return best;
}

export const publicIssueUrl = (number: number) =>
  `https://github.com/${PUBLIC_REPO}/issues/${number}`;
export const renderPublicUrlMarker = (url: string) =>
  `<!-- dotfiles-feedback-public url=${url} -->`;
export function parsePublicUrlMarker(commentBody: string): string | null {
  const match = new RegExp(
    `^<!-- dotfiles-feedback-public url=(${PUBLIC_URL_PATTERN}) -->$`,
  ).exec(firstLine(commentBody));
  return match?.[1] ?? null;
}
export function findPublicUrl(
  comments: readonly IssueComment[],
): string | null {
  for (const comment of comments) {
    if (comment.user !== FEEDBACK_OWNER) continue;
    const url = parsePublicUrlMarker(comment.body);
    if (url) return url;
  }
  return null;
}

export const renderOriginMarker = (id: string) =>
  `<!-- dotfiles-feedback-origin id=${id} -->`;
// web UI の編集で末尾に空行が付いても探索が外れないよう、空白だけの行を除いた最終行を見る。
export function parseOriginId(body: string): string | null {
  const lines = body.split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "")
    lines.pop();
  const match = /^<!-- dotfiles-feedback-origin id=(\S+) -->$/.exec(
    withoutOneCr(lines[lines.length - 1] ?? ""),
  );
  return match?.[1] && isFeedbackId(match[1]) ? match[1] : null;
}
