import { join } from "node:path";
import { parseArgs } from "node:util";
import { hasAgentEnv, isHumanCaller } from "../agent-caller.ts";
import { DOTFILES_REPO_KEY } from "./constants.ts";
import type { FeedbackDeps, InteractiveDeps } from "./deps.ts";
import type { TriageResultView } from "./display.ts";
import { openGh, type FeedbackIssue, type GhResult } from "./gh.ts";
import {
  classifyIssue,
  findTriageMarker,
  neutralizeMentions,
  renderTriageMarker,
  type IssueComment,
  type TriageActor,
  type TriageTo,
} from "./issue-body.ts";
import { normalizeField } from "./item.ts";
import { resolveTarget } from "./target.ts";

export type TriageDeps = Pick<
  FeedbackDeps,
  | "root"
  | "home"
  | "repo"
  | "runGh"
  | "fs"
  | "uid"
  | "now"
  | "pid"
  | "randomBytes"
  | "isPidAlive"
  | "getPidStartTime"
  | "envNames"
  | "resolveRepoKey"
> &
  InteractiveDeps & { log(text: string): void };
export type TriageOptions = { to: TriageTo; path?: string; reason?: string };
type FailureError = Extract<GhResult<never>, { ok: false }>["error"];
export type TriageOutcome =
  | { kind: "done"; view: TriageResultView }
  | { kind: "invalid"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "cancelled"; reason: string }
  | { kind: "gh-failed"; error: FailureError; message: string; hint: string };

const TARGETS: readonly TriageTo[] = ["issue", "plan", "reject"];
const FLAGS = ["--to", "--path", "--reason"];

// 引数の解釈は triage.ts に置き、CLI は呼ぶだけにする。
export function parseTriageArgs(
  args: readonly string[],
):
  | { ok: true; target: string; options: TriageOptions }
  | { ok: false; reason: string } {
  for (const flag of FLAGS)
    if (
      args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`)).length >
      1
    )
      return { ok: false, reason: `${flag} が重複している` };
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        to: { type: "string" };
        path: { type: "string" };
        reason: { type: "string" };
      };
      allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        to: { type: "string" },
        path: { type: "string" },
        reason: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "引数が正しくない",
    };
  }
  const { to, path, reason } = parsed.values;
  for (const value of [to, path, reason])
    if (value !== undefined && value.startsWith("-"))
      return { ok: false, reason: "値が - で始まっている" };
  if (parsed.positionals.length !== 1)
    return { ok: false, reason: "対象は 1 つだけ指定する" };
  if (to === undefined || !TARGETS.includes(to as TriageTo))
    return { ok: false, reason: "--to は issue / plan / reject のどれか" };
  if (to === "plan" && (path === undefined || reason !== undefined))
    return { ok: false, reason: "--to plan は --path だけを取る" };
  if (to === "reject" && (reason === undefined || path !== undefined))
    return { ok: false, reason: "--to reject は --reason だけを取る" };
  if (to === "issue" && (path !== undefined || reason !== undefined))
    return { ok: false, reason: "--to issue は --path も --reason も取らない" };
  return {
    ok: true,
    target: parsed.positionals[0] as string,
    options: {
      to: to as TriageTo,
      ...(path === undefined ? {} : { path }),
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

const rejected = (reason: string): TriageOutcome => ({
  kind: "rejected",
  reason,
});
const ghFailed = (
  failure: { error: FailureError; message: string },
  hint = "",
): TriageOutcome => ({ kind: "gh-failed", ...failure, hint });

const PLAN_PATH = /^docs\/plans\/[a-z0-9-]+\.md$/;
// 通常ファイルで、実パスが dotfiles の docs/plans/ の下にあるときだけ通す。
async function checkPlanPath(
  path: string,
  deps: TriageDeps,
): Promise<string | null> {
  if (!PLAN_PATH.test(path))
    return "--path は docs/plans/<小文字・数字・ハイフン>.md の形にする";
  if ((await deps.resolveRepoKey(deps.cwd)) !== DOTFILES_REPO_KEY)
    return "--to plan は dotfiles のリポジトリの中で実行する";
  const toplevel = await deps.resolveToplevel(deps.cwd);
  if (toplevel === null) return "リポジトリの root を求められない";
  const target = join(toplevel, path);
  try {
    if (!(await deps.fs.lstat(target)).isFile())
      return "--path は通常ファイルでなければならない";
    const real = await deps.realpath(target);
    const top = await deps.realpath(toplevel);
    if (!real.startsWith(`${top}/docs/plans/`))
      return "--path の実パスが docs/plans/ の外にある";
  } catch {
    return "--path のファイルを確かめられない";
  }
  return null;
}

const LOCAL_ADVICE = {
  pending: "先に flush する",
  sending: "先に flush する",
  held: "CLI を更新する",
  failed: "`flush --retry` か `drop` を使う",
} as const;

type Prepared = {
  issue: FeedbackIssue;
  id: string;
  comments: IssueComment[];
};

// 対象の解決から、読めること・open であることの確認までを plan / reject / issue で共有する。
async function prepare(
  arg: string,
  deps: TriageDeps,
): Promise<Prepared | TriageOutcome> {
  const target = await resolveTarget(arg, deps);
  switch (target.kind) {
    case "invalid":
      return { kind: "invalid", reason: target.reason };
    case "not-found":
      return rejected("見つからない");
    case "ambiguous":
      return rejected(
        `同じ id の issue が複数ある: ${target.numbers.map((n) => `#${n}`).join(", ")}`,
      );
    case "gh-failed":
      return ghFailed(target, target.hint);
    case "local":
      return rejected(
        `手元にある未送の件（${target.place}）は振り分けられない。${LOCAL_ADVICE[target.place]}`,
      );
    case "issue":
      break;
  }
  const kind = classifyIssue(target.issue);
  if (kind.kind === "not-target") return rejected("対象の issue ではない");
  if (kind.kind === "unreadable")
    return rejected("読めない版か、マーカーの無い issue は振り分けない");
  const gh = openGh(deps);
  const comments = await gh.listComments(target.issue.number);
  if (!comments.ok) return ghFailed(comments);
  if (target.issue.state === "closed") {
    const marker = findTriageMarker(comments.value);
    return rejected(marker ? `振り分け済み（to=${marker.to}）` : "close 済み");
  }
  return { issue: target.issue, id: kind.id, comments: comments.value };
}

const isOutcome = (value: Prepared | TriageOutcome): value is TriageOutcome =>
  "kind" in value;

function differentDestination(existing: TriageTo): TriageOutcome {
  return rejected(
    `この issue の行き先は to=${existing} に固定されている。別の行き先には振り分けない`,
  );
}

// コメントを足して読み直し、最古のマーカーの行き先が自分と同じことを確かめてから label と close に進む。
async function pinAndClose(
  prepared: Prepared,
  to: TriageTo,
  actor: TriageActor,
  detail: string,
  deps: TriageDeps,
  publicUrl?: string,
): Promise<TriageOutcome> {
  const gh = openGh(deps);
  const { number } = prepared.issue;
  const existing = findTriageMarker(prepared.comments);
  if (existing && existing.to !== to) return differentDestination(existing.to);
  if (!existing) {
    const added = await gh.addComment(
      number,
      `${renderTriageMarker(to, actor)}\n${detail}`,
    );
    if (!added.ok) return ghFailed(added);
    const reread = await gh.listComments(number);
    if (!reread.ok) return ghFailed(reread);
    const pinned = findTriageMarker(reread.value);
    if (!pinned || pinned.to !== to)
      return rejected(
        "読み直しで行き先を確かめられなかった。label と close はしていない",
      );
  }
  const labeled = await gh.addLabel(number, `triaged:${to}`);
  if (!labeled.ok) return ghFailed(labeled);
  const closed = await gh.closeIssue(number);
  if (!closed.ok) return ghFailed(closed);
  if (!(await deps.spawnRefresh()))
    deps.log(
      "警告: refresh を起動できなかった。dotfiles-feedback refresh を実行する\n",
    );
  return {
    kind: "done",
    view: { number, to, ...(publicUrl === undefined ? {} : { publicUrl }) },
  };
}

export async function triage(
  arg: string,
  options: TriageOptions,
  deps: TriageDeps,
): Promise<TriageOutcome> {
  const actor: TriageActor = isHumanCaller({
    isTty: deps.stdinIsTty && deps.stdoutIsTty,
    agentEnv: hasAgentEnv(deps.envNames),
  })
    ? "human"
    : "agent";
  if (options.to === "issue") return rejected("--to issue は未実装");

  let detail: string;
  if (options.to === "plan") {
    const path = options.path ?? "";
    const problem = await checkPlanPath(path, deps);
    if (problem) return rejected(problem);
    detail = `振り分け先: ${path}`;
  } else {
    const reason = normalizeField(options.reason ?? "", "reason");
    if (!reason.ok) return rejected(`理由を使えない: ${reason.reason}`);
    detail = `理由: ${neutralizeMentions(reason.value)}`;
  }
  const prepared = await prepare(arg, deps);
  if (isOutcome(prepared)) return prepared;
  return pinAndClose(prepared, options.to, actor, detail, deps);
}
