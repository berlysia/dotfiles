import { isFeedbackId } from "./item.ts";
import type { FeedbackItemV1, FeedbackKind, FeedbackAgent } from "./item.ts";
import {
  FEEDBACK_AGENTS,
  FEEDBACK_KINDS,
  FEEDBACK_LABEL,
  FIELD_LIMITS,
} from "./constants.ts";

export type MarkerMeta = Pick<FeedbackItemV1, "kind" | "target" | "source">;
export type MarkerResult =
  | { status: "ok"; id: string; v: 1; meta: MarkerMeta }
  | { status: "newer"; id: string; v: number }
  | { status: "unreadable" };

function neutralizeMentions(text: string): string {
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
