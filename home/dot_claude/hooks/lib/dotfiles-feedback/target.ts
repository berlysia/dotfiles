import { FEEDBACK_OWNER, FEEDBACK_REPO, DAY_MS } from "./constants.ts";
import type { FeedbackDeps } from "./deps.ts";
import { openGh, type FeedbackIssue, type GhResult } from "./gh.ts";
import { classifyIssue } from "./issue-body.ts";
import { isFeedbackId } from "./item.ts";
import { openSpool, type LocalPlace } from "./spool.ts";

type FeedbackError = Extract<GhResult<never>, { ok: false }>["error"];

export type TargetDeps = Pick<
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
> & {
  // 1 回の実行の中で宛先の確認を使い回す。無ければ resolveTarget が自分の分を作る。
  ensureDestination?: () => Promise<GhResult<void>>;
};
export type ResolvedTarget =
  | { kind: "issue"; issue: FeedbackIssue }
  | { kind: "local"; id: string; place: LocalPlace }
  | { kind: "invalid"; reason: string }
  | { kind: "not-found" }
  | { kind: "ambiguous"; numbers: number[] }
  | { kind: "gh-failed"; error: FeedbackError; message: string; hint: string };

const ISSUE_NUMBER = /^#([1-9]\d*)$/;
const LIST_HINT = "一覧で見つからない。`#番号` で指定する";

// 手元の形の id の時刻部分。月が 13 のような実在しない日時は null。
function idTime(id: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(id);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s
    ? date
    : null;
}

// 対象の issue（読めない版も含む）で、マーカーの id が一致するか。
const matches = (issue: FeedbackIssue, id: string) =>
  classifyIssue(issue).kind !== "not-target" &&
  issue.marker.status !== "unreadable" &&
  issue.marker.id === id;

// 最初の呼び出しで checkDestination を行い、結果を覚えて以後は同じ結果を返す。
export function withEnsuredDestination<T extends TargetDeps>(deps: T): T {
  if (deps.ensureDestination) return deps;
  let checked: Promise<GhResult<void>> | null = null;
  return {
    ...deps,
    ensureDestination: () => (checked ??= openGh(deps).checkDestination()),
  };
}

export async function resolveTarget(
  arg: string,
  deps: TargetDeps,
): Promise<ResolvedTarget> {
  const gh = openGh(deps);
  const { ensureDestination } = withEnsuredDestination(deps);
  // private repo に触れる 2 か所の直前で宛先を確かめる。手元の件を返す経路では確かめない。
  const destinationFailure = async (): Promise<ResolvedTarget | null> => {
    const checked = await ensureDestination!();
    return checked.ok
      ? null
      : {
          kind: "gh-failed",
          error: checked.error,
          message: checked.message,
          hint: "",
        };
  };
  const number = ISSUE_NUMBER.exec(arg)?.[1];
  if (number !== undefined) {
    const failure = await destinationFailure();
    if (failure) return failure;
    const viewed = await gh.viewFeedbackIssue(Number(number));
    return viewed.ok
      ? { kind: "issue", issue: viewed.value }
      : {
          kind: "gh-failed",
          error: viewed.error,
          message: viewed.message,
          hint: "",
        };
  }
  if (!isFeedbackId(arg))
    return { kind: "invalid", reason: "対象は #番号 か id で指定する" };
  const time = arg.startsWith("vm-") ? null : idTime(arg);
  if (!arg.startsWith("vm-") && time === null)
    return { kind: "invalid", reason: "id の日時が正しくない" };

  const spool = await openSpool(deps.root, deps);
  const place = await spool.findLocal(arg);
  if (place) return { kind: "local", id: arg, place };

  const failure = await destinationFailure();
  if (failure) return failure;

  const sent = await spool.findSent(arg);
  if (sent !== null) {
    const viewed = await gh.viewFeedbackIssue(sent);
    if (viewed.ok && matches(viewed.value, arg))
      return { kind: "issue", issue: viewed.value };
    // 404・PR・他の人・対象外・id の不一致は、その番号を使わず一覧に進む。
  }

  // issue は id の時刻より後に作られ、since は更新時刻で絞るので 1 日前から引けば取りこぼさない。
  const since =
    time === null
      ? undefined
      : new Date(time.getTime() - DAY_MS)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z");
  const listed = await gh.listFeedbackIssues({
    repo: FEEDBACK_REPO,
    state: "all",
    creator: FEEDBACK_OWNER,
    ...(since === undefined ? {} : { since }),
  });
  if (!listed.ok)
    return {
      kind: "gh-failed",
      error: listed.error,
      message: listed.message,
      hint: LIST_HINT,
    };
  const found = listed.value.filter((issue) => matches(issue, arg));
  if (found.length === 0) return { kind: "not-found" };
  if (found.length > 1)
    return {
      kind: "ambiguous",
      numbers: found.map((i) => i.number).sort((a, b) => a - b),
    };
  return { kind: "issue", issue: found[0]! };
}
