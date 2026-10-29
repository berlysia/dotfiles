import { constants } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { hasAgentEnv, isHumanCaller } from "../agent-caller.ts";
import { DAY_MS, DOTFILES_REPO_KEY } from "./constants.ts";
import type { FeedbackDeps, InteractiveDeps } from "./deps.ts";
import { sanitizeForDisplay, type TriageResultView } from "./display.ts";
import { openGh, type FeedbackIssue, type GhResult } from "./gh.ts";
import {
  classifyIssue,
  findPublicUrl,
  findTriageMarker,
  neutralizeMentions,
  parseOriginId,
  publicIssueUrl,
  renderOriginMarker,
  renderPublicUrlMarker,
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

const CONTINUE_ADVICE =
  "`--to issue` をもう一度実行すれば、作った public issue を使って続きから進む";
const WAIT_ADVICE =
  "時間をおいて `--to issue` を再実行する。public issue が無いと確かめるまでコメントを消さない";

// 起票済みの public issue を、origin のマーカーで探す。since はマーカーのコメントの 1 日前。
async function findPublicByOrigin(
  id: string,
  commentedAt: string,
  deps: TriageDeps,
): Promise<GhResult<string | null>> {
  const base = Number.isFinite(Date.parse(commentedAt))
    ? Date.parse(commentedAt)
    : deps.now().getTime() - 30 * DAY_MS;
  const since = new Date(base - DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const listed = await openGh(deps).listPublicIssues(since);
  if (!listed.ok) return listed;
  const found = listed.value
    .filter((entry) => parseOriginId(entry.body) === id)
    .sort((a, b) => a.number - b.number)[0];
  return {
    ok: true,
    value: found === undefined ? null : publicIssueUrl(found.number),
  };
}

// to=issue が固定された issue に別の行き先を求められたとき、分かっていることに応じて復旧の手順を出す。
async function differentDestination(
  prepared: Prepared,
  existing: { to: TriageTo; comment: IssueComment },
  deps: TriageDeps,
): Promise<TriageOutcome> {
  const base = `この issue の行き先は to=${existing.to} に固定されている。別の行き先には振り分けない`;
  if (existing.to !== "issue") return rejected(base);
  let advice: string;
  if (findPublicUrl(prepared.comments) !== null) advice = CONTINUE_ADVICE;
  else {
    const found = await findPublicByOrigin(
      prepared.id,
      existing.comment.createdAt,
      deps,
    );
    advice = !found.ok
      ? WAIT_ADVICE
      : found.value !== null
        ? CONTINUE_ADVICE
        : `private repo の issue #${prepared.issue.number} の \`to=issue\` のコメントを消せば、行き先を選び直せる`;
  }
  return rejected(`${base}。${advice}`);
}

// コメントを足して読み直し、最古のマーカーの行き先が自分と同じことを確かめる。通れば null。
async function pin(
  prepared: Prepared,
  to: TriageTo,
  actor: TriageActor,
  detail: string,
  deps: TriageDeps,
): Promise<TriageOutcome | null> {
  const gh = openGh(deps);
  const { number } = prepared.issue;
  const added = await gh.addComment(
    number,
    `${renderTriageMarker(to, actor)}\n${detail}`,
  );
  if (!added.ok) return ghFailed(added);
  const reread = await gh.listComments(number);
  if (!reread.ok) return ghFailed(reread);
  const pinned = findTriageMarker(reread.value);
  return !pinned || pinned.to !== to
    ? rejected(
        "読み直しで行き先を確かめられなかった。label と close はしていない",
      )
    : null;
}

async function labelAndClose(
  number: number,
  to: TriageTo,
  deps: TriageDeps,
  publicUrl?: string,
): Promise<TriageOutcome> {
  const gh = openGh(deps);
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

async function pinAndClose(
  prepared: Prepared,
  to: TriageTo,
  actor: TriageActor,
  detail: string,
  deps: TriageDeps,
): Promise<TriageOutcome> {
  const existing = findTriageMarker(prepared.comments);
  if (existing && existing.to !== to)
    return differentDestination(prepared, existing, deps);
  if (!existing) {
    const failed = await pin(prepared, to, actor, detail, deps);
    if (failed) return failed;
  }
  return labelAndClose(prepared.issue.number, to, deps);
}

// --- public の下書き ---
const DRAFT_MAX_BYTES = 64 * 1024;
const GUIDE = [
  ";; 1 行目がタイトル、空行の後が本文になる。「;; 」で始まる行は消える。",
  ";; 何も書かずに保存すると中止する。",
];
const INITIAL_DRAFT = `${GUIDE.join("\n")}\n\n`;
const MIN_COPY_WARNING = 20;
const cancelled = (reason: string): TriageOutcome => ({
  kind: "cancelled",
  reason,
});

// 無害化で最初に変わる文字の位置。削除は元の文字で、\t と \n の置換も元の文字が変わる。
function firstChange(
  text: string,
  multiline: boolean,
): { codePoint: string; line: number } | null {
  const cleaned = sanitizeForDisplay(text, { multiline });
  if (cleaned === text) return null;
  let index = 0;
  while (index < cleaned.length && cleaned[index] === text[index]) index++;
  const code = text.codePointAt(index) ?? 0;
  return {
    codePoint: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
    line: text.slice(0, index).split("\n").length,
  };
}
const changeMessage = (
  change: { codePoint: string; line: number },
  where: string,
) =>
  rejected(
    `${where}に端末で表示できない文字がある（${change.codePoint}、${change.line} 行目）。取り除いて書き直す`,
  );

async function readDraft(
  path: string,
  deps: TriageDeps,
): Promise<{ text: string } | TriageOutcome> {
  let handle: Awaited<ReturnType<TriageDeps["fs"]["open"]>>;
  try {
    handle = await deps.fs.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return cancelled("下書きを開けない（差し替えられた可能性がある）");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return cancelled("下書きが通常ファイルでない");
    if (stat.size > DRAFT_MAX_BYTES)
      return rejected("下書きが 64KB を超えている");
    const buffer = Buffer.alloc(DRAFT_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > DRAFT_MAX_BYTES)
      return rejected("下書きが 64KB を超えている");
    return { text: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close();
  }
}

function copyWarnings(
  prepared: Prepared,
  meta: { target: string; source: { repoKey: string | null; host: string } },
  draftText: string,
): string[] {
  const warnings: string[] = [];
  if (draftText.includes(meta.target))
    warnings.push("元の private の issue の target を含んでいる");
  if (meta.source.repoKey && draftText.includes(meta.source.repoKey))
    warnings.push("元の private の issue の repoKey を含んでいる");
  if (draftText.includes(meta.source.host))
    warnings.push("元の private の issue の host を含んでいる");
  const privateBody = prepared.issue.body.split("\n\n").slice(2).join("\n\n");
  let copied = false;
  if (privateBody.length > 0 && privateBody.length < MIN_COPY_WARNING)
    copied = draftText.includes(privateBody);
  else
    for (let i = 0; !copied && i + MIN_COPY_WARNING <= privateBody.length; i++)
      copied = draftText.includes(privateBody.slice(i, i + MIN_COPY_WARNING));
  if (copied) warnings.push("private の本文と一致する部分がある");
  if (/#\d+/.test(draftText)) warnings.push("#数字（issue 番号）を含んでいる");
  if (draftText.includes("github.com/berlysia/dotfiles-feedback"))
    warnings.push("private repo の URL を含んでいる");
  return warnings;
}

// 下書きを作って編集させ、検査と確認を通った最終のタイトルと本文を返す。
// 返した文字列をそのまま確認に出し、そのまま送るので、確認と送信の内容は同じになる。
async function draftPublicIssue(
  prepared: Prepared,
  meta: { target: string; source: { repoKey: string | null; host: string } },
  deps: TriageDeps,
): Promise<{ title: string; body: string } | TriageOutcome> {
  if (!deps.editor || deps.editor.trim() === "")
    return cancelled("$EDITOR が設定されていない");
  const dir = await deps.makeTempDir();
  try {
    const path = join(dir, "draft.md");
    const created = await deps.fs.open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await created.writeFile(INITIAL_DRAFT);
    } finally {
      await created.close();
    }
    const code = await deps.runEditor([
      ...deps.editor.trim().split(/\s+/),
      path,
    ]);
    if (code !== 0) return cancelled("エディタが正常に終わらなかった");
    const read = await readDraft(path, deps);
    if ("kind" in read) return read;
    const text = read.text.replace(/\r\n/g, "\n");
    if (text === INITIAL_DRAFT) return cancelled("下書きが変わっていない");
    const unsafe = firstChange(text, true);
    if (unsafe) return changeMessage(unsafe, "下書き");
    const lines = text.split("\n").filter((line) => !line.startsWith(";; "));
    if (lines.every((line) => line.trim() === ""))
      return cancelled("下書きが空");
    const rawTitle = lines[0] ?? "";
    if (rawTitle.trim() === "") return cancelled("タイトルが無い");
    const rawBody = lines
      .slice(1)
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\s+$/, "");
    if (
      [rawTitle, ...rawBody.split("\n")].some((line) =>
        line.trim().startsWith("<!-- dotfiles-feedback-origin"),
      )
    )
      return rejected("origin のマーカーの形の行は書けない");
    const title = normalizeField(rawTitle, "title");
    if (!title.ok) return rejected(`タイトルを使えない: ${title.reason}`);
    const body = normalizeField(rawBody, "body");
    if (!body.ok) return rejected(`本文を使えない: ${body.reason}`);
    const finalTitle = neutralizeMentions(title.value);
    const finalBody = `${neutralizeMentions(body.value)}\n\n${renderOriginMarker(prepared.id)}`;
    const changedTitle = firstChange(finalTitle, false);
    if (changedTitle) return changeMessage(changedTitle, "タイトル");
    const changedBody = firstChange(finalBody, true);
    if (changedBody) return changeMessage(changedBody, "本文");
    const warnings = copyWarnings(
      prepared,
      meta,
      `${finalTitle}\n${finalBody}`,
    );
    const shown = [
      ...(warnings.length > 0
        ? [
            "警告: 公開してよいか確かめる",
            ...warnings.map((w) => `  - ${w}`),
            "",
          ]
        : []),
      "次の内容で public の issue を作る",
      `タイトル: ${finalTitle}`,
      "",
      finalBody,
    ].join("\n");
    if (!(await deps.confirm(shown))) return cancelled("確認で中止した");
    return { title: finalTitle, body: finalBody };
  } finally {
    await deps.removeTree(dir);
  }
}

async function triageToIssue(
  arg: string,
  deps: TriageDeps,
): Promise<TriageOutcome> {
  const prepared = await prepare(arg, deps);
  if (isOutcome(prepared)) return prepared;
  const kind = classifyIssue(prepared.issue);
  if (kind.kind !== "target") return rejected("対象の issue ではない");
  const gh = openGh(deps);
  const { number } = prepared.issue;
  const existing = findTriageMarker(prepared.comments);
  if (existing && existing.to !== "issue")
    return differentDestination(prepared, existing, deps);

  let url = findPublicUrl(prepared.comments);
  const hadUrlComment = url !== null;
  if (existing && url === null) {
    const found = await findPublicByOrigin(
      prepared.id,
      existing.comment.createdAt,
      deps,
    );
    if (!found.ok) return ghFailed(found, WAIT_ADVICE);
    url = found.value;
  }
  if (url === null) {
    const draft = await draftPublicIssue(prepared, kind.meta, deps);
    if ("kind" in draft) return draft;
    if (!existing) {
      const failed = await pin(
        prepared,
        "issue",
        "human",
        "公開 issue に起票する",
        deps,
      );
      if (failed) return failed;
    }
    const created = await gh.createPublicIssue(draft.title, draft.body);
    if (!created.ok) return ghFailed(created);
    url = publicIssueUrl(created.value);
  }
  if (!hadUrlComment) {
    const commented = await gh.addComment(number, renderPublicUrlMarker(url));
    if (!commented.ok) return ghFailed(commented);
  }
  return labelAndClose(number, "issue", deps, url);
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
  // 人の判定は spool にも gh にも触る前に行う。
  if (options.to === "issue")
    return actor === "human"
      ? triageToIssue(arg, deps)
      : rejected(
          "--to issue は人が端末で行う（エージェントからは実行できない）",
        );

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
