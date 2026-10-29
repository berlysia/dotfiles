import {
  FEEDBACK_OWNER,
  FEEDBACK_REPO,
  MAX_RECENT_TRIAGE,
  RECENT_TRIAGE_WINDOW_MS,
} from "./constants.ts";
import type {
  ListView,
  RecentTriageView,
  ShowView,
  TargetIssueView,
} from "./display.ts";
import { openGh, type FeedbackIssue, type GhResult } from "./gh.ts";
import { classifyIssue, findTriageMarker } from "./issue-body.ts";
import { openSpool } from "./spool.ts";
import { resolveTarget, type TargetDeps } from "./target.ts";

export type CollectDeps = TargetDeps;
type FailureError = Extract<GhResult<never>, { ok: false }>["error"];
export type ShowOutcome =
  | { kind: "ok"; view: ShowView }
  | { kind: "invalid"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "failed"; error: FailureError; message: string; hint: string };

const isoSeconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

export async function collectList(deps: CollectDeps): Promise<ListView> {
  const spool = await openSpool(deps.root, deps);
  const local = await spool.listLocal(deps.now());
  const gh = openGh(deps);
  const unreachable = (error: FailureError, message: string): ListView => ({
    open: null,
    local,
    unreadable: 0,
    recent: null,
    unreachable: { error, message },
  });
  const checked = await gh.checkDestination();
  if (!checked.ok) return unreachable(checked.error, checked.message);
  const opened = await gh.listFeedbackIssues({
    repo: FEEDBACK_REPO,
    state: "open",
    creator: FEEDBACK_OWNER,
  });
  if (!opened.ok) return unreachable(opened.error, opened.message);

  const open: TargetIssueView[] = [];
  let unreadable = 0;
  for (const issue of opened.value) {
    if (issue.state !== "open") continue;
    const kind = classifyIssue(issue);
    if (kind.kind === "target")
      open.push({
        number: issue.number,
        id: kind.id,
        kind: kind.meta.kind,
        title: issue.title,
      });
    else if (kind.kind === "unreadable") unreadable++;
  }
  open.sort((a, b) => a.number - b.number);
  return {
    open,
    local,
    unreadable,
    recent: await collectRecent(deps, gh),
  };
}

async function collectRecent(
  deps: CollectDeps,
  gh: ReturnType<typeof openGh>,
): Promise<NonNullable<ListView["recent"]>> {
  const now = deps.now().getTime();
  const closed = await gh.listFeedbackIssues({
    repo: FEEDBACK_REPO,
    state: "closed",
    creator: FEEDBACK_OWNER,
    since: isoSeconds(new Date(now - RECENT_TRIAGE_WINDOW_MS)),
  });
  if (!closed.ok) return { ok: false, reason: closed.error };
  const targets = closed.value
    .filter(
      (issue: FeedbackIssue) =>
        issue.state === "closed" && classifyIssue(issue).kind === "target",
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const items: RecentTriageView[] = [];
  for (const issue of targets.slice(0, MAX_RECENT_TRIAGE)) {
    const comments = await gh.listComments(issue.number);
    if (!comments.ok) return { ok: false, reason: comments.error };
    const marker = findTriageMarker(comments.value);
    if (
      marker?.actor === "agent" &&
      now - Date.parse(marker.comment.createdAt) <= RECENT_TRIAGE_WINDOW_MS
    )
      items.push({ number: issue.number, title: issue.title, to: marker.to });
  }
  return { ok: true, items, truncated: targets.length > MAX_RECENT_TRIAGE };
}

export async function collectShow(
  arg: string,
  deps: CollectDeps,
): Promise<ShowOutcome> {
  const target = await resolveTarget(arg, deps);
  switch (target.kind) {
    case "invalid":
      return { kind: "invalid", reason: target.reason };
    case "not-found":
      return { kind: "rejected", reason: "見つからない" };
    case "ambiguous":
      return {
        kind: "rejected",
        reason: `同じ id の issue が複数ある: ${target.numbers.map((n) => `#${n}`).join(", ")}`,
      };
    case "gh-failed":
      return {
        kind: "failed",
        error: target.error,
        message: target.message,
        hint: target.hint,
      };
    case "local": {
      const spool = await openSpool(deps.root, deps);
      const read = await spool.readLocal(target.id, target.place);
      if (read.kind !== "ok")
        return { kind: "rejected", reason: "手元の件を読めない" };
      return {
        kind: "ok",
        view: {
          source: "local",
          id: target.id,
          place: target.place,
          title: read.item.title,
          target: read.item.target,
          kind: read.item.kind,
          body: read.item.body,
        },
      };
    }
    case "issue": {
      const kind = classifyIssue(target.issue);
      if (kind.kind === "not-target")
        return { kind: "rejected", reason: "対象の issue ではない" };
      if (kind.kind === "unreadable")
        return {
          kind: "rejected",
          reason: "読めない版か、マーカーの無い issue",
        };
      return {
        kind: "ok",
        view: {
          source: "github",
          number: target.issue.number,
          id: kind.id,
          title: target.issue.title,
          target: kind.meta.target,
          kind: kind.meta.kind,
          body: target.issue.body,
        },
      };
    }
  }
}
