#!/usr/bin/env -S bun run --silent

/**
 * `agent-learnings`: the CLI Claude and Codex both call to read, record and
 * remove per-repository learnings. The store logic lives in
 * `lib/agent-learnings/core/`; this file is the argument parsing, the
 * human-only gate and the choice between writing directly and leaving a
 * request in the sandbox inbox.
 *
 * `runLearningsCli` is a pure function of `argv` and `deps`: no `process.exit`
 * and no ambient `process.cwd()` reads, so `node --test` calls it directly.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  inboxDirsSafe,
  applyInboxLocked,
  writeInboxRequest,
} from "../lib/agent-learnings/core/inbox.ts";
import { runGit, type RunGit } from "../lib/agent-learnings/core/git.ts";
import {
  COMMON_KEY,
  parseLearningsFile,
  serializeLearningsFile,
  type LearningsFile,
} from "../lib/agent-learnings/core/learnings-file.ts";
import { withStoreLock } from "../lib/agent-learnings/core/lock.ts";
import { readNoPromote } from "../lib/agent-learnings/core/no-promote.ts";
import { applyOps, type LearningOp } from "../lib/agent-learnings/core/ops.ts";
import { promoteManually } from "../lib/agent-learnings/core/promote.ts";
import {
  applyRetag,
  countRetagLines,
  parseRetagFile,
  planRetag,
  type PlannedRetag,
  type RetagExpect,
  type RetagOp,
} from "../lib/agent-learnings/core/retag.ts";
import {
  filterByTrigger,
  formatTriggers,
  parseTriggers,
  type Trigger,
  type ValidatedTriggers,
} from "../lib/agent-learnings/core/triggers.ts";
import { countJobs, summarizeRuns } from "../lib/agent-learnings/core/queue.ts";
import {
  detectFeedbackReader,
  findAcceptingInjection,
  formatReviewLine,
  isRecordKind,
  isRecordedId,
  WINDOW_MS,
  type FeedbackReader,
  type RecordKind,
  type Verdict,
} from "../lib/agent-learnings/core/metrics.ts";
import {
  fullLogs,
  loadInjections,
  loadMetrics,
  recordFeedback,
} from "../lib/agent-learnings/core/metrics-log.ts";
import { renderLearnings } from "../lib/agent-learnings/core/render.ts";
import {
  isValidRepoKey,
  resolveRepoKey,
} from "../lib/agent-learnings/core/repo-key.ts";
import {
  appendReadLog,
  commitStore,
  commonFilePath,
  defaultStoreDir,
  feedbackLogPathFor,
  initStore,
  injectionLogPaths,
  readLearnings,
  readLogTail,
  repoFilePath,
  storeGitArgs,
  storePaths,
  writeFileSyncAtomic,
  writeLearnings,
} from "../lib/agent-learnings/core/store.ts";
import { loadRedactList } from "../lib/redact-secrets.ts";
import { getHomeDir } from "../lib/path-utils.ts";

export interface RunLearningsCliDeps {
  cwd: string;
  home: string;
  now: Date;
  readerEnv: string | undefined;
  isTty: boolean; // stdin と stdout の両方が TTY
  agentEnv: boolean; // エージェントの実行環境を示す環境変数がある
  // feedback の reader。入口で detectFeedbackReader(Object.keys(process.env)) から決める
  feedbackReader: FeedbackReader;
  lockWaitMs: number;
  runGit: RunGit;
  // 昇格と人の tag の確認。message を見せて、利用者が y と答えたときだけ true を返す
  confirm: (message: string) => Promise<boolean>;
}
export interface RunLearningsCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Claude Code の Bash は CLAUDECODE を、Codex は AI_AGENT（home/dot_codex/.config.toml の
// shell_environment_policy.set）と CODEX_SANDBOX* を渡す。外すには `env -u` などをコマンドに書く
// 必要があり、権限の照合に見える。
const AGENT_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_SANDBOX.*|AI_AGENT)$/;

// 人の操作かの判定はここ 1 か所。曖昧なときは人ではない扱いにする。人だけの操作
// （--common、promote、rekey、init）は拒否し、tag では確認を省く（省いても付けられる
// 範囲は人と同じなので、曖昧さが広げるものは無い）。環境からの推定で、証明ではない
export function isHumanCaller(
  deps: Pick<RunLearningsCliDeps, "isTty" | "agentEnv">,
): boolean {
  return deps.isTty && !deps.agentEnv;
}

type Actor = "human" | "agent";
const actorOf = (
  deps: Pick<RunLearningsCliDeps, "isTty" | "agentEnv">,
): Actor => (isHumanCaller(deps) ? "human" : "agent");

const REPO_KEY_SHAPE = "host/owner/repo（例: github.com/berlysia/awai）";

const USAGE = [
  "usage: agent-learnings <command>",
  "  show [--cwd DIR] [--reader NAME] [--grep=WORD]... [--id L-…]...",
  "                   --on=TRIGGER は on がその trigger に等しい項目だけ（session は on の無い項目も含む）",
  "                   --grep は見出し・本文・id の部分一致（大文字小文字を区別しない、複数で AND）。--id は複数で OR",
  "  path [--common]",
  "  add --title=T --body=B [--common] [--on=TRIGGER]...",
  "                   --on は最大 4 個。session / cmd:<語> <語> / path:<部分>/<部分>/ / path:*.<a>.<b>",
  "  remove <id>",
  "  feedback <id> <helpful|mistimed|wrong> --at=<session|pre|fail|path>",
  "                   注入された学びが場面に合っていたかを返す（直近 14 日に出た組だけ受け付ける）",
  "  status",
  "  tag <id> --on=TRIGGER... | tag <id> --on= | tag --from-file PATH",
  "                   on を付け替える（--on= は外す）。--from-file は 1 行 `<id>\\t<on を , でつないだ値>`（最大 200 行、64KB）",
  "                   repo の学びにも common の学びにも付けられる（common には path:<部分>/ は付けられない）。人は /dev/tty の確認つき、エージェントは確認なし",
  "  promote <id>    (human only)",
  "  init            (human only)",
  "  rekey <old> <new>  (human only)",
  `                     キーは ${REPO_KEY_SHAPE}。path が出すファイル名ではない`,
  "",
].join("\n");

const ID_PATTERN = /^L-[0-9a-f]{12}$/;
const REQUEST_NAME = /^\d+-R-[0-9a-f]{12}\.json$/;
const READS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const READS_TAIL_BYTES = 1024 * 1024;
const HUMAN_ONLY_MESSAGE =
  "この操作は人が端末から実行する（--common、URL を含む本文、promote、rekey、init）。エージェントからは実行できない\n";

const done = (
  exitCode: number,
  stdout = "",
  stderr = "",
): RunLearningsCliResult => ({ exitCode, stdout, stderr });
const fail = (message: string, exitCode = 1): RunLearningsCliResult =>
  done(exitCode, "", `${message}\n`);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readerOf(deps: RunLearningsCliDeps, flag: string | undefined): string {
  return flag ?? deps.readerEnv ?? "unknown";
}

function storeExists(store: string): boolean {
  return existsSync(join(store, ".git"));
}

const MAX_FILTER_FLAGS = 8;
const MAX_GREP_LENGTH = 100;
const FILTERED_OMITTED_HINT = "語を足して絞り込める";

interface ShowArgs {
  cwd: string | undefined;
  reader: string | undefined;
  greps: readonly string[]; // 小文字化済み
  ids: readonly string[];
  on: Trigger | undefined;
}

// 不正な値はエージェントの入力そのもの。parseArgs の例外文にも値が入りうるので、
// 診断は固定の文言に落とし、渡された値を stderr に返さない。
function parseShowArgs(
  args: readonly string[],
): { ok: true; value: ShowArgs } | { ok: false; message: string } {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        cwd: { type: "string" },
        reader: { type: "string" },
        grep: { type: "string", multiple: true },
        id: { type: "string", multiple: true },
        on: { type: "string", multiple: true },
      },
      strict: true,
    }));
  } catch {
    return { ok: false, message: "show の引数が不正" };
  }
  let on: Trigger | undefined;
  if (values.on !== undefined) {
    const parsedOn = parseTriggers(values.on);
    if (!parsedOn.ok)
      return { ok: false, message: `--on が不正（${parsedOn.error}）` };
    const only = parsedOn.value[0];
    // 重複をまとめた後に 1 個でなければ複数指定。show は trigger 1 個で絞る
    if (only === undefined || parsedOn.value.length !== 1)
      return { ok: false, message: "--on は trigger を 1 個だけ渡す" };
    on = only;
  }
  const greps = values.grep ?? [];
  const ids = values.id ?? [];
  if (
    greps.length > MAX_FILTER_FLAGS ||
    greps.some((word) => word.length === 0 || word.length > MAX_GREP_LENGTH)
  )
    return {
      ok: false,
      message: `--grep は ${MAX_FILTER_FLAGS} 個まで、1 語は 1〜${MAX_GREP_LENGTH} 字。\`-\` で始まる語は --grep=WORD の形で渡す`,
    };
  if (ids.length > MAX_FILTER_FLAGS || ids.some((id) => !ID_PATTERN.test(id)))
    return {
      ok: false,
      message: `--id は ${MAX_FILTER_FLAGS} 個まで、L- と 12 桁の 16 進数`,
    };
  return {
    ok: true,
    value: {
      cwd: values.cwd,
      reader: values.reader,
      greps: greps.map((word) => word.toLowerCase()),
      ids,
      on,
    },
  };
}

// 語は見出し・本文・id をつないだ 1 つの文字列に対して照合する。語ごとに別の
// フィールドに当たってよい（AND）。正規表現にしないのは、エージェントの入力を
// そのまま RegExp に渡さないため
function filterEntries(file: LearningsFile, show: ShowArgs): LearningsFile {
  return {
    ...file,
    entries: file.entries.filter((entry) => {
      if (show.ids.length > 0 && !show.ids.includes(entry.id)) return false;
      const haystack = `${entry.title} ${entry.body} ${entry.id}`.toLowerCase();
      return show.greps.every((word) => haystack.includes(word));
    }),
  };
}

// grep・id の絞り込みの後に trigger の絞り込みを重ねる（AND）
function filterShow(file: LearningsFile, show: ShowArgs): LearningsFile {
  const byText = filterEntries(file, show);
  return show.on === undefined
    ? byText
    : {
        ...byText,
        entries: filterByTrigger(byText.entries, file.key, show.on),
      };
}

function runShow(
  args: readonly string[],
  deps: RunLearningsCliDeps,
): RunLearningsCliResult {
  // 引数の誤りは try の外で exit 1 にする。中に置くと catch が exit 0 にして、
  // --grep を知らない古い CLI の「空の出力」と見分けがつかなくなる
  const parsed = parseShowArgs(args);
  if (!parsed.ok) return fail(`${parsed.message}\n${USAGE}`);
  const show = parsed.value;
  const filtered =
    show.greps.length > 0 || show.ids.length > 0 || show.on !== undefined;
  // reads は「開始時に show したか」の指標。開始時と同じ全件（または session の絞り込み）だけ数える
  const countsAsRead =
    show.greps.length === 0 &&
    show.ids.length === 0 &&
    (show.on === undefined || show.on.kind === "session");
  try {
    const store = defaultStoreDir(deps.home);
    if (!storeExists(store)) return done(0);
    const repoKey = resolveRepoKey(show.cwd ?? deps.cwd, deps.runGit);
    if (repoKey === null) return done(0);

    const repoRead = readLearnings(store, repoKey);
    const commonRead = readLearnings(store, COMMON_KEY);
    const repoPath = repoFilePath(store, repoKey);
    const commonPath = commonFilePath(store);
    const repo = repoRead.ok
      ? filtered
        ? filterShow(repoRead.value, show)
        : repoRead.value
      : null;
    const common = commonRead.ok
      ? filtered
        ? filterShow(commonRead.value, show)
        : commonRead.value
      : null;
    // 開始時の絞り（--on=session だけ）で外れた、場面だけを持つ学びの件数。
    // 開始時の注入（claude/session-context.ts）と同じく、件数だけを 1 行で知らせる
    const sessionOnly =
      show.on?.kind === "session" &&
      show.greps.length === 0 &&
      show.ids.length === 0;
    const sceneOnlyCount = sessionOnly
      ? (repoRead.ok && repo !== null
          ? repoRead.value.entries.length - repo.entries.length
          : 0) +
        (commonRead.ok && common !== null
          ? commonRead.value.entries.length - common.entries.length
          : 0)
      : 0;

    const recordRead = (): void => {
      if (!countsAsRead) return;
      const paths = storePaths(store);
      const reader = readerOf(deps, show.reader);
      // 記録は学びの件数にかかわらず行う。Codex は .state/codex の中にしか書けない
      appendReadLog(reader === "codex" ? paths.codexReadsLog : paths.readsLog, {
        at: deps.now,
        reader,
        repoKey,
      });
    };

    if (filtered) {
      const matched =
        (repo?.entries.length ?? 0) + (common?.entries.length ?? 0);
      if (matched === 0 && sceneOnlyCount === 0) {
        recordRead();
        const unreadable = [
          ...(repoRead.ok ? [] : [repoPath]),
          ...(commonRead.ok ? [] : [commonPath]),
        ];
        return done(
          0,
          "",
          unreadable.length > 0
            ? `学びファイルを読めなかった（${unreadable.join(" / ")}）\n`
            : `一致する学びが無い（全文: ${repoPath} / ${commonPath}）\n`,
        );
      }
    }
    const rendered = renderLearnings({
      repo,
      common,
      repoPath,
      commonPath,
      ...(filtered ? { omittedHint: FILTERED_OMITTED_HINT } : {}),
      ...(sceneOnlyCount > 0 ? { sceneOnlyCount } : {}),
    });

    // --grep・--id と session 以外の --on は数えない。検索の回数で増えると
    // AGENTS.md が守られているかを判断できなくなる
    recordRead();
    return done(0, rendered === null ? "" : `${rendered}\n`);
  } catch (error) {
    return done(0, "", `agent-learnings show failed: ${errorMessage(error)}\n`);
  }
}

function runPath(
  args: readonly string[],
  deps: RunLearningsCliDeps,
): RunLearningsCliResult {
  const { values } = parseArgs({
    args: [...args],
    options: { common: { type: "boolean" } },
    strict: true,
  });
  const store = defaultStoreDir(deps.home);
  if (values.common) return done(0, `${commonFilePath(store)}\n`);
  const repoKey = resolveRepoKey(deps.cwd, deps.runGit);
  if (repoKey === null) return fail("git リポジトリの中で実行する");
  return done(0, `${repoFilePath(store, repoKey)}\n`);
}

function commitMessage(
  subject: string,
  evidence: readonly string[],
  evictedIds: readonly string[],
  // 付け替えと add は誰の操作かを残す（環境からの推定）。worker と inbox は題で分かる
  actor?: Actor,
): string {
  const lines = [
    ...evidence,
    ...evictedIds.map((id) => `evict ${id}: over the entry cap`),
    ...(actor === undefined ? [] : [`actor: ${actor}`]),
  ];
  return lines.length === 0 ? subject : `${subject}\n\n${lines.join("\n")}`;
}

const todayOf = (now: Date): string => now.toISOString().slice(0, 10);

function inboxReader(deps: RunLearningsCliDeps): string {
  return deps.readerEnv === "claude" || deps.readerEnv === "codex"
    ? deps.readerEnv
    : "codex";
}

async function runAdd(
  args: readonly string[],
  deps: RunLearningsCliDeps,
): Promise<RunLearningsCliResult> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      title: { type: "string" },
      body: { type: "string" },
      common: { type: "boolean" },
      on: { type: "string", multiple: true },
    },
    strict: true,
  });
  if (values.title === undefined || values.body === undefined)
    return fail(`--title と --body が要る\n${USAGE}`);
  const humanOnly = isHumanCaller(deps);
  let on: ValidatedTriggers | undefined;
  if (values.on !== undefined) {
    const parsedOn = parseTriggers(values.on);
    if (!parsedOn.ok) return fail(`--on が不正（${parsedOn.error}）`);
    on = parsedOn.value;
  }
  if (values.common && !humanOnly) return fail(HUMAN_ONLY_MESSAGE.trimEnd());

  const store = defaultStoreDir(deps.home);
  if (!storeExists(store))
    return fail("store が無い。人が `agent-learnings init` を実行する");
  const repoKey = resolveRepoKey(deps.cwd, deps.runGit);
  if (!values.common && repoKey === null)
    return fail("git リポジトリの中で実行する（共通の学びは --common）");
  const fileKey = values.common ? COMMON_KEY : (repoKey ?? COMMON_KEY);
  const paths = storePaths(store);
  const extraRedact = loadRedactList(
    join(deps.home, ".claude/insight-distill-redact.txt"),
  );
  const title = values.title;
  const body = values.body;

  const locked = await withStoreLock(
    paths.state,
    { waitMs: deps.lockWaitMs },
    (): RunLearningsCliResult => {
      // 自分が持っている lock の中なので drainInbox ではなく applyInboxLocked を呼ぶ
      applyInboxLocked(store, {
        today: todayOf(deps.now),
        runGit: deps.runGit,
        extraRedact,
      });
      const file = readLearnings(store, fileKey);
      if (!file.ok) return fail(file.reason);
      const ops: LearningOp[] = [
        {
          op: "add",
          title,
          body,
          evidence: "manual add",
          ...(on === undefined ? {} : { on }),
        },
      ];
      const applied = applyOps(file.value, ops, {
        today: todayOf(deps.now),
        repoKey,
        newId: () => `L-${randomBytes(6).toString("hex")}`,
        rules: { allowUrl: humanOnly },
        extraRedact,
      });
      if (!applied.ok) return fail(applied.reason);
      const written = writeLearnings(store, applied.value.file);
      if (!written.ok) return fail(written.reason);
      const id = applied.value.addedIds[0] ?? "";
      const committed = commitStore(
        store,
        commitMessage(
          `learnings: add ${id} (${fileKey})`,
          applied.value.evidence,
          applied.value.evictedIds,
          actorOf(deps),
        ),
        deps.runGit,
      );
      if (!committed.ok) {
        return done(
          3,
          `${id}\n`,
          `学びは書いたが commit に失敗した: ${committed.reason}\n`,
        );
      }
      return done(0, `${id}\n`);
    },
  );

  if (locked.ok) return locked.value;
  if (locked.reason === "timeout")
    return fail("store の lock を取れなかった", 2);
  // lock も作れない（Codex の sandbox など）: inbox に依頼を書き、Claude 側が次に取り込む
  if (values.common || repoKey === null)
    return fail("store に書き込めない（inbox は repo の学びだけを受け付ける）");
  const requestId = writeInboxRequest(
    store,
    {
      op: "add",
      repoKey,
      title,
      body,
      reader: inboxReader(deps),
      ...(values.on === undefined ? {} : { on: values.on }),
    },
    deps.now,
  );
  return done(
    0,
    `${requestId}\n`,
    "依頼として受け付けた。次の Claude のセッション開始時に反映される。出力は依頼 id（R-）で、学びの id（L-）ではない\n",
  );
}

async function runRemove(
  args: readonly string[],
  deps: RunLearningsCliDeps,
): Promise<RunLearningsCliResult> {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    allowPositionals: true,
    strict: true,
  });
  const id = positionals[0];
  if (positionals.length !== 1 || id === undefined || !ID_PATTERN.test(id)) {
    return fail(
      `remove には学びの id（L-…）を 1 つ渡す。依頼 id（R-…）は使えない\n${USAGE}`,
    );
  }
  const store = defaultStoreDir(deps.home);
  if (!storeExists(store)) return fail("store が無い");
  const repoKey = resolveRepoKey(deps.cwd, deps.runGit);
  const paths = storePaths(store);
  const extraRedact = loadRedactList(
    join(deps.home, ".claude/insight-distill-redact.txt"),
  );

  const locked = await withStoreLock(
    paths.state,
    { waitMs: deps.lockWaitMs },
    (): RunLearningsCliResult => {
      applyInboxLocked(store, {
        today: todayOf(deps.now),
        runGit: deps.runGit,
        extraRedact,
      });
      const keys = repoKey === null ? [COMMON_KEY] : [repoKey, COMMON_KEY];
      for (const key of keys) {
        const file = readLearnings(store, key);
        if (!file.ok) return fail(file.reason);
        if (!file.value.entries.some((entry) => entry.id === id)) continue;
        if (file.value.readOnly) {
          return fail(
            `${key} のファイルは読み取り専用（未対応の format）。手で直す`,
          );
        }
        const applied = applyOps(
          file.value,
          [{ op: "remove", id, reason: "manual remove" }],
          {
            today: todayOf(deps.now),
            repoKey,
            newId: () => `L-${randomBytes(6).toString("hex")}`,
            rules: { allowUrl: true },
            extraRedact,
          },
        );
        if (!applied.ok) return fail(applied.reason);
        const written = writeLearnings(store, applied.value.file);
        if (!written.ok) return fail(written.reason);
        const committed = commitStore(
          store,
          commitMessage(
            `learnings: remove ${id} (${key})`,
            applied.value.evidence,
            [],
          ),
          deps.runGit,
        );
        if (!committed.ok)
          return done(
            3,
            "",
            `学びは消したが commit に失敗した: ${committed.reason}\n`,
          );
        return done(0);
      }
      return fail(`${id} は見つからない`);
    },
  );

  if (locked.ok) return locked.value;
  if (locked.reason === "timeout")
    return fail("store の lock を取れなかった", 2);
  if (repoKey === null)
    return fail(
      "store に書き込めない（inbox の依頼には git リポジトリが要る）",
    );
  const requestId = writeInboxRequest(
    store,
    { op: "remove", repoKey, id, reader: inboxReader(deps) },
    deps.now,
  );
  return done(
    0,
    `${requestId}\n`,
    "依頼として受け付けた。次の Claude のセッション開始時に反映される。common.md の項目はこの経路では消せない\n",
  );
}

const FROM_FILE_MAX_BYTES = 64 * 1024;
const FROM_FILE_UNREADABLE =
  "--from-file を読めない（通常ファイルで 64KB 以下、symlink・FIFO は不可）";
const RETAG_CHANGED = "確認の後に変わった。やり直す";

// O_NOFOLLOW は最後の要素の symlink だけを防ぐ（途中のディレクトリの symlink は辿る）。
// 人とエージェントが指定したパスを読むだけなので受け入れる。FIFO は O_NONBLOCK で開いて
// fstat で弾く。上限の 1 バイト先までで読み止め、全体を読み込まない
function readBoundedFile(
  path: string,
): { ok: true; text: string } | { ok: false } {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return { ok: false };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > FROM_FILE_MAX_BYTES) return { ok: false };
    const buffer = Buffer.alloc(FROM_FILE_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const n = readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total > FROM_FILE_MAX_BYTES) return { ok: false };
    return { ok: true, text: buffer.subarray(0, total).toString("utf8") };
  } catch {
    return { ok: false };
  } finally {
    closeSync(fd);
  }
}

function applyFailureMessage(reason: string): string {
  switch (reason) {
    case "changed":
      return RETAG_CHANGED;
    case "read-only":
      return "読み取り専用のファイルには付けられない（未対応の format）";
    case "path-prefix-in-common":
      return "common の学びに path: の接頭辞は付けられない";
    default:
      return reason;
  }
}

type RetagGroup = {
  file: LearningsFile;
  ops: RetagOp[];
  expects: RetagExpect[];
};

// 書く順は common → 現在の repo（promote と同じ。途中で落ちても重複側に倒れる）
function groupRetag(
  files: { repo: LearningsFile; common: LearningsFile },
  planned: readonly PlannedRetag[],
  ops: readonly RetagOp[],
): RetagGroup[] {
  const groups: RetagGroup[] = [];
  for (const file of [files.common, files.repo]) {
    const mine = planned.filter((p) => p.fileKey === file.key);
    if (mine.length === 0) continue;
    const ids = new Set(mine.map((p) => p.id));
    groups.push({
      file,
      ops: ops.filter((op) => ids.has(op.id)),
      expects: mine.map((p) => p.expect),
    });
  }
  return groups;
}

const describeCurrent = (value: string): string =>
  value === "" ? "なし" : value === "invalid" ? "（不正な値）" : value;

function writeRetagged(
  store: string,
  files: readonly LearningsFile[],
  lines: readonly string[],
  ops: readonly RetagOp[],
  deps: RunLearningsCliDeps,
): RunLearningsCliResult {
  // files は common → repo の順（groupRetag）。1 つの lock の中で両方を書く
  for (const file of files) {
    const written = writeLearnings(store, file);
    if (!written.ok) return fail(written.reason);
  }
  const subject =
    ops.length === 1
      ? `learnings: retag ${ops[0]?.id ?? ""}`
      : `learnings: retag ${ops.length} entries`;
  const committed = commitStore(
    store,
    commitMessage(subject, lines, [], actorOf(deps)),
    deps.runGit,
  );
  const stdout = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  if (!committed.ok)
    return done(
      3,
      stdout,
      `on は付け替えたが commit に失敗した: ${committed.reason}\n`,
    );
  return done(0, stdout);
}

async function runTag(
  args: readonly string[],
  deps: RunLearningsCliDeps,
): Promise<RunLearningsCliResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        on: { type: "string", multiple: true },
        "from-file": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    // parseArgs の例外文には渡された値が入りうる
    return fail(`tag の引数が不正\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const human = isHumanCaller(deps);

  let ops: RetagOp[];
  if (values["from-file"] !== undefined) {
    if (positionals.length > 0 || values.on !== undefined)
      return fail(`--from-file は id・--on と同時に使えない\n${USAGE}`);
    const read = readBoundedFile(values["from-file"]);
    if (!read.ok) return fail(FROM_FILE_UNREADABLE);
    const fileOps = parseRetagFile(read.text);
    if (!fileOps.ok)
      return fail(
        "line" in fileOps
          ? `--from-file の ${fileOps.line} 行目が不正（${fileOps.error}）`
          : `--from-file が長すぎる（${fileOps.error}）`,
      );
    ops = fileOps.ops;
    if (ops.length === 0) return fail("--from-file に付け替える行が無い");
  } else {
    const id = positionals[0];
    if (positionals.length !== 1 || id === undefined || !ID_PATTERN.test(id))
      return fail(`tag には学びの id（L-…）を 1 つ渡す\n${USAGE}`);
    if (values.on === undefined)
      return fail(`--on が要る（外すときは --on=）\n${USAGE}`);
    const onValues =
      values.on.length === 1 && values.on[0] === "" ? [] : values.on;
    const parsedOn = parseTriggers(onValues);
    // id と値は出さず、固定の語だけを返す
    if (!parsedOn.ok) return fail(`--on が不正（${parsedOn.error}）`);
    ops = [{ id, on: parsedOn.value }];
  }

  const store = defaultStoreDir(deps.home);
  if (!storeExists(store)) return fail("store が無い");
  const repoKey = resolveRepoKey(deps.cwd, deps.runGit);
  if (repoKey === null) return fail("git リポジトリの中で実行する");
  const paths = storePaths(store);
  const extraRedact = loadRedactList(
    join(deps.home, ".claude/insight-distill-redact.txt"),
  );
  const readBoth = ():
    | { ok: true; repo: LearningsFile; common: LearningsFile }
    | { ok: false; reason: string } => {
    const repo = readLearnings(store, repoKey);
    if (!repo.ok) return { ok: false, reason: repo.reason };
    const common = readLearnings(store, COMMON_KEY);
    if (!common.ok) return { ok: false, reason: common.reason };
    return { ok: true, repo: repo.value, common: common.value };
  };
  const lockFailed = (): RunLearningsCliResult =>
    fail("store の lock を取れなかった", 2);

  // 人もエージェントも同じ流れ。違いは確認だけ: 人は lock の外で /dev/tty の確認を取り、
  // 確認の前に作った expect で適用時の食い違いを検知する。エージェントは確認の待ち時間が
  // 無く、計画から適用までを 1 つの lock の中で行うので expect は要らない
  let confirmed: { planned: readonly PlannedRetag[] } | null = null;
  if (human) {
    const preview = readBoth();
    if (!preview.ok) return fail(preview.reason);
    const plan = planRetag(preview, ops);
    if (!plan.ok) return fail(`${plan.error}（${plan.count} 件）`);
    for (const group of groupRetag(preview, plan.planned, ops)) {
      const dry = applyRetag(group.file, group.ops, group.expects);
      if (!dry.ok) return fail(applyFailureMessage(dry.reason));
    }
    const approved = await deps.confirm(
      [
        "次の学びの on を付け替える:",
        ...plan.planned.map(
          (p) =>
            `  ${p.id}  ${p.title === "invalid" ? "（不正な見出し）" : p.title}  ${describeCurrent(p.currentOn)} -> ${p.nextOn.length === 0 ? "なし（外す）" : formatTriggers(p.nextOn)}${p.fileKey === COMMON_KEY ? "  [common]" : ""}`,
        ),
        "付け替える場合は y を入力する [y/N]: ",
      ].join("\n"),
    );
    if (!approved) return fail("付け替えなかった");
    confirmed = { planned: plan.planned };
  }

  const locked = await withStoreLock(
    paths.state,
    { waitMs: deps.lockWaitMs },
    (): RunLearningsCliResult => {
      applyInboxLocked(store, {
        today: todayOf(deps.now),
        runGit: deps.runGit,
        extraRedact,
      });
      const files = readBoth();
      if (!files.ok) return fail(files.reason);
      const again = planRetag(files, ops);
      if (confirmed === null) {
        if (!again.ok) return fail(`${again.error}（${again.count} 件）`);
      } else {
        const before = confirmed.planned;
        // 対象が消えた・別のファイルへ移った場合も確認の後の変更として扱う
        if (
          !again.ok ||
          again.planned.some(
            (p) => before.find((q) => q.id === p.id)?.fileKey !== p.fileKey,
          )
        )
          return fail(RETAG_CHANGED);
      }
      const planned = confirmed?.planned ?? (again.ok ? again.planned : []);
      // 全ファイルの applyRetag が通ったときだけ書く（片方の失敗で何も書かない）
      const written: LearningsFile[] = [];
      const lines: string[] = [];
      for (const group of groupRetag(files, planned, ops)) {
        const applied = applyRetag(
          group.file,
          group.ops,
          confirmed === null ? undefined : group.expects,
        );
        if (!applied.ok) return fail(applyFailureMessage(applied.reason));
        written.push(applied.file);
        lines.push(...applied.lines);
      }
      return writeRetagged(store, written, lines, ops, deps);
    },
  );
  return locked.ok ? locked.value : lockFailed();
}

async function runPromote(
  args: readonly string[],
  deps: RunLearningsCliDeps,
): Promise<RunLearningsCliResult> {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    allowPositionals: true,
    strict: true,
  });
  const id = positionals[0];
  if (positionals.length !== 1 || id === undefined || !ID_PATTERN.test(id)) {
    return fail(
      `promote には現在の repo の学びの id（L-…）を 1 つ渡す\n${USAGE}`,
    );
  }
  const store = defaultStoreDir(deps.home);
  if (!storeExists(store)) return fail("store が無い");
  const repoKey = resolveRepoKey(deps.cwd, deps.runGit);
  if (repoKey === null) return fail("git リポジトリの中で実行する");
  const newId = (): string => `L-${randomBytes(6).toString("hex")}`;

  // 確認は lock の外で取る（人の入力を待つ間、ほかの書き込みを止めない）
  const previewRepo = readLearnings(store, repoKey);
  const previewCommon = readLearnings(store, COMMON_KEY);
  if (!previewRepo.ok) return fail(previewRepo.reason);
  if (!previewCommon.ok) return fail(previewCommon.reason);
  const shown = previewRepo.value.entries.find((entry) => entry.id === id);
  if (shown === undefined)
    return fail(
      `${id} は現在の repo のファイルに無い（common.md の項目は移せない）`,
    );
  const preview = promoteManually({
    repoKey,
    today: todayOf(deps.now),
    repoFile: previewRepo.value,
    common: previewCommon.value,
    noPromote: readNoPromote(store),
    id,
    newId,
  });
  if (!preview.ok) return fail(preview.reason);
  const approved = await deps.confirm(
    [
      "次の学びを共通の学び（全リポジトリで読まれる）へ移す:",
      `  ${shown.title}`,
      `  ${shown.body}`,
      ...preview.value.warnings.map((warning) => `警告: ${warning}`),
      "移す場合は y を入力する [y/N]: ",
    ].join("\n"),
  );
  if (!approved) return fail("移さなかった");

  const paths = storePaths(store);
  const extraRedact = loadRedactList(
    join(deps.home, ".claude/insight-distill-redact.txt"),
  );
  const locked = await withStoreLock(
    paths.state,
    { waitMs: deps.lockWaitMs },
    (): RunLearningsCliResult => {
      applyInboxLocked(store, {
        today: todayOf(deps.now),
        runGit: deps.runGit,
        extraRedact,
      });
      const repo = readLearnings(store, repoKey);
      const common = readLearnings(store, COMMON_KEY);
      if (!repo.ok) return fail(repo.reason);
      if (!common.ok) return fail(common.reason);
      const current = repo.value.entries.find((entry) => entry.id === id);
      if (
        current === undefined ||
        current.title !== shown.title ||
        current.body !== shown.body
      )
        return fail(`${id} が確認の後に変わった。やり直す`);
      const moved = promoteManually({
        repoKey,
        today: todayOf(deps.now),
        repoFile: repo.value,
        common: common.value,
        noPromote: readNoPromote(store),
        id,
        newId,
      });
      if (!moved.ok) return fail(moved.reason);
      // 書く順は common → 現在の repo。途中で落ちると重複が残る側に倒れる
      const wroteCommon = writeLearnings(store, moved.value.common);
      if (!wroteCommon.ok) return fail(wroteCommon.reason);
      const wroteRepo = writeLearnings(store, moved.value.repoFile);
      if (!wroteRepo.ok) return fail(wroteRepo.reason);
      const commonId = moved.value.commonId;
      const committed = commitStore(
        store,
        commitMessage(
          `learnings: promote ${id} -> ${commonId} (${repoKey})`,
          moved.value.commitLines,
          [],
        ),
        deps.runGit,
      );
      if (!committed.ok)
        return done(
          3,
          `${commonId}\n`,
          `学びは移したが commit に失敗した: ${committed.reason}\n`,
        );
      return done(0, `${commonId}\n`);
    },
  );
  if (locked.ok) return locked.value;
  return fail("store の lock を取れなかった", 2);
}

// `path` prints the file name, not the key, so the file name is the value people
// most often pass back. Its slug cannot be reversed ("-" may have been "/"), so
// read the key from the header of the file the name points at.
function describeBadRepoKey(
  label: string,
  value: string,
  store: string,
): string {
  const lines = [`${label} が ${REPO_KEY_SHAPE} の形ではない: ${value}`];
  if (value.endsWith(".md")) {
    const key = value.includes("/")
      ? null
      : readRepoKeyFromFile(join(store, "repos", value));
    lines.push(
      key === null
        ? "ファイル名ではなく、ファイルの 1 行目の key: に書かれたキーを渡す"
        : `ファイル名ではなくキーを渡す: ${key}`,
    );
  }
  return lines.join("\n");
}

function readRepoKeyFromFile(path: string): string | null {
  try {
    const header = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
    const key = /;\s*key:\s*(\S+)\s*-->/.exec(header)?.[1];
    return key !== undefined && isValidRepoKey(key) ? key : null;
  } catch {
    return null;
  }
}

async function runRekey(
  args: readonly string[],
  deps: RunLearningsCliDeps,
): Promise<RunLearningsCliResult> {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    allowPositionals: true,
    strict: true,
  });
  const [oldKey, newKey] = positionals;
  if (
    positionals.length !== 2 ||
    oldKey === undefined ||
    newKey === undefined
  ) {
    return fail(`rekey <old> <new>\n${USAGE}`);
  }
  const store = defaultStoreDir(deps.home);
  for (const [label, key] of [
    ["<old>", oldKey],
    ["<new>", newKey],
  ] as const) {
    if (!isValidRepoKey(key))
      return fail(describeBadRepoKey(label, key, store));
  }
  if (oldKey === newKey) return fail(`<old> と <new> が同じ: ${oldKey}`);
  if (!storeExists(store)) return fail("store が無い");
  const oldPath = repoFilePath(store, oldKey);
  const newPath = repoFilePath(store, newKey);
  const present = (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  if (!present(oldPath)) return fail(`${oldKey} のファイルが無い`);
  if (present(newPath)) return fail(`${newKey} のファイルが既にある`);

  const locked = await withStoreLock(
    storePaths(store).state,
    { waitMs: deps.lockWaitMs },
    (): RunLearningsCliResult => {
      const old = readLearnings(store, oldKey);
      if (!old.ok) return fail(old.reason);
      if (old.value.readOnly) return fail("読み取り専用のファイルは移せない");

      const replaceKey = (repos: readonly string[]): string[] => [
        ...new Set(repos.map((key) => (key === oldKey ? newKey : key))),
      ];
      const moved = runGit_mv(store, oldPath, newPath, deps.runGit);
      if (!moved) return fail("ファイルを移せなかった");
      const rewritten: LearningsFile = {
        ...old.value,
        key: newKey,
        entries: old.value.entries.map((entry) => ({
          ...entry,
          repos: replaceKey(entry.repos),
        })),
      };
      const written = writeLearnings(store, rewritten);
      if (!written.ok) return fail(written.reason);

      // store 全体（common.md と、ほかの repo ファイル）の repos に残る旧キーを置き換える
      const others = [commonFilePath(store)];
      for (const name of readdirSync(storePaths(store).repos)) {
        const path = join(storePaths(store).repos, name);
        if (name.endsWith(".md") && path !== newPath) others.push(path);
      }
      for (const path of others) {
        let text: string;
        try {
          if (!lstatSync(path).isFile()) continue;
          text = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        const parsed = parseLearningsFile(text);
        if (!parsed.ok || parsed.value.readOnly) continue;
        const entries = parsed.value.entries.map((entry) => ({
          ...entry,
          repos: replaceKey(entry.repos),
        }));
        const next = serializeLearningsFile({ ...parsed.value, entries });
        if (next !== text) writeFileSyncAtomic(path, next, 0o600);
      }

      const committed = commitStore(
        store,
        `learnings: rekey ${oldKey} -> ${newKey}`,
        deps.runGit,
      );
      if (!committed.ok)
        return done(
          3,
          `${newPath}\n`,
          `移したが commit に失敗した: ${committed.reason}\n`,
        );
      return done(0, `${newPath}\n`);
    },
  );
  if (locked.ok) return locked.value;
  return fail("store の lock を取れなかった", 2);
}

// 追跡されているファイルは git mv、そうでなければ rename
function runGit_mv(
  store: string,
  from: string,
  to: string,
  git: RunGit,
): boolean {
  const rel = (path: string): string => path.slice(store.length + 1);
  if (git(storeGitArgs(store, ["mv", rel(from), rel(to)]), store).ok)
    return true;
  try {
    renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

function countReads(
  paths: readonly string[],
  now: Date,
): Record<"claude" | "codex" | "unknown", number> {
  const counts = { claude: 0, codex: 0, unknown: 0 };
  for (const path of paths) {
    const tail = readLogTail(path, READS_TAIL_BYTES);
    if (tail === null) continue;
    for (const line of tail.split("\n")) {
      if (line === "") continue;
      try {
        const record = JSON.parse(line) as { at?: unknown; reader?: unknown };
        const at =
          typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
        if (Number.isNaN(at) || now.getTime() - at > READS_WINDOW_MS) continue;
        if (record.reader === "claude") counts.claude += 1;
        else if (record.reader === "codex") counts.codex += 1;
        else counts.unknown += 1;
      } catch {
        // 途中で切れた先頭行など
      }
    }
  }
  return counts;
}

function countUnknownVersions(inbox: string, names: readonly string[]): number {
  let unknown = 0;
  for (const name of names.slice(0, 200)) {
    const text = readLogTail(join(inbox, name), READS_TAIL_BYTES);
    if (text === null) continue;
    try {
      const parsed = JSON.parse(text) as { schemaVersion?: unknown };
      if (parsed.schemaVersion !== 1) unknown += 1;
    } catch {
      // 壊れた依頼は次の取り込みで拒否される
    }
  }
  return unknown;
}

function listNames(dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(dir).filter((name) => pattern.test(name));
  } catch {
    return [];
  }
}

const VERDICTS: readonly Verdict[] = ["helpful", "mistimed", "wrong"];
const isVerdict = (value: string): value is Verdict =>
  (VERDICTS as readonly string[]).includes(value);

// 引数は評価する側（エージェント）の入力そのもの。parseArgs の例外文にも値が入りうるので、
// 診断は固定の文言に落とし、渡された値を stdout にも stderr にも返さない
function parseFeedbackArgs(args: readonly string[]):
  | {
      ok: true;
      value: { id: string; verdict: Verdict; kind: RecordKind };
    }
  | { ok: false } {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: { at: { type: "string", multiple: true } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return { ok: false };
  }
  const { values, positionals } = parsed;
  const [id, verdict] = positionals;
  const at = values.at;
  if (
    positionals.length !== 2 ||
    id === undefined ||
    verdict === undefined ||
    at === undefined ||
    at.length !== 1
  )
    return { ok: false };
  const kind = at[0];
  if (
    !isRecordedId(id) ||
    !isVerdict(verdict) ||
    kind === undefined ||
    !isRecordKind(kind)
  )
    return { ok: false };
  return { ok: true, value: { id, verdict, kind } };
}

// 注入の記録がある (repoKey, id, kind) だけを受け付ける。学びは読まず、lock も取らない
function runFeedback(
  args: readonly string[],
  deps: RunLearningsCliDeps,
): RunLearningsCliResult {
  const parsed = parseFeedbackArgs(args);
  if (!parsed.ok)
    return fail(
      "feedback の引数が不正（feedback <id> <helpful|mistimed|wrong> --at=<session|pre|fail|path>）",
    );
  const { id, verdict, kind } = parsed.value;
  // Codex は開始時と失敗の直後の注入を記録しない。「記録が無い」と区別して知らせる
  if (
    deps.feedbackReader === "codex" &&
    (kind === "session" || kind === "fail")
  )
    return fail("Codex の開始時と失敗の直後は記録していないので評価できない");
  const store = defaultStoreDir(deps.home);
  if (!storeExists(store)) return fail("store が未初期化");
  const repoKey = resolveRepoKey(deps.cwd, deps.runGit);
  if (repoKey === null) return fail("repo を解決できない");

  const accepted = findAcceptingInjection(loadInjections(store).lines, {
    repoKey,
    id,
    kind,
    now: deps.now,
    reader: deps.feedbackReader,
  });
  if (accepted === null) {
    const rotated = injectionLogPaths(store).some((path) =>
      existsSync(`${path}.1`),
    );
    return fail(
      "注入の記録が無い（直近 14 日にこの repo でこの場面に出た学びだけを評価できる）" +
        (rotated ? "\n直近の回転で記録が .1 に移った可能性がある" : ""),
    );
  }
  const line = {
    v: 1 as const,
    at: deps.now.toISOString(),
    reader: deps.feedbackReader,
    repoKey,
    id,
    verdict,
    kind,
    trigger: accepted.trigger,
  };
  if (!recordFeedback(store, line)) {
    const target = feedbackLogPathFor(store, deps.feedbackReader);
    const full = fullLogs(store).some(
      (name) => join(storePaths(store).state, name) === target,
    );
    return fail(
      full
        ? "記録のログが上限に達している（agent-learnings status で確かめる）"
        : "記録できなかった",
    );
  }
  return done(0, `記録した: ${id} ${verdict} --at=${kind}\n`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 付け替えの数。store の git ログの本文から数える（付随の行なので失敗は ? に畳む）
function retagStatusLine(store: string, deps: RunLearningsCliDeps): string {
  const since = new Date(deps.now.getTime() - WINDOW_MS).toISOString();
  const log = deps.runGit(
    storeGitArgs(store, ["log", `--since=${since}`, "--format=%B"]),
    store,
  );
  if (!log.ok) return "retag (14d): ?";
  const counts = countRetagLines(log.stdout);
  return `retag (14d): ${counts.retag} untag (14d): ${counts.untag}`;
}

function metricsStatusLines(
  store: string,
  deps: RunLearningsCliDeps,
): string[] {
  const lines: string[] = [];
  const metrics = loadMetrics(store, deps.now);
  const { injections, feedback } = metrics;
  let injectionLine = `injections (14d): session ${injections.session} pre ${injections.pre} fail ${injections.fail} path ${injections.path}`;
  if (metrics.injectionsUnknown > 0)
    injectionLine += ` unknown ${metrics.injectionsUnknown}`;
  // 末尾 1MB で切って読み、かつ最古が窓より新しいときだけ、窓が短くなっていると知らせる
  if (metrics.injectionsTruncated && metrics.oldestInjectionAt !== null) {
    const span = deps.now.getTime() - Date.parse(metrics.oldestInjectionAt);
    if (span >= 0 && span < WINDOW_MS)
      injectionLine += ` (covers ${Math.floor(span / DAY_MS)}d)`;
  }
  lines.push(injectionLine);
  let feedbackLine = `feedback (14d): helpful ${feedback.helpful} mistimed ${feedback.mistimed} wrong ${feedback.wrong}`;
  if (metrics.feedbackUnknown > 0)
    feedbackLine += ` unknown ${metrics.feedbackUnknown}`;
  lines.push(feedbackLine);
  for (const item of metrics.review) {
    const reviewLine = formatReviewLine(item);
    if (reviewLine !== null) lines.push(reviewLine);
  }
  if (metrics.reviewCount > metrics.review.length)
    lines.push(`review: 他 ${metrics.reviewCount - metrics.review.length} 件`);
  lines.push(retagStatusLine(store, deps));
  // 回転されず書けなくなったログ。手で退避する手順を grep できる形で運ぶ
  const state = storePaths(store).state;
  for (const name of fullLogs(store)) {
    const path = join(state, name);
    lines.push(`log full: ${name} fix=mv ${path} ${path}.1`);
  }
  return lines;
}

function runStatus(deps: RunLearningsCliDeps): RunLearningsCliResult {
  const store = defaultStoreDir(deps.home);
  if (!storeExists(store))
    return done(
      0,
      "store: 未初期化（人が `agent-learnings init` を実行する）\n",
    );
  const paths = storePaths(store);
  const lines: string[] = [];

  if (!inboxDirsSafe(store)) {
    lines.push(`inbox: unsafe（${paths.codex} の中を確認して作り直す）`);
  } else {
    const names = listNames(paths.inbox, REQUEST_NAME);
    const unknown = countUnknownVersions(paths.inbox, names);
    lines.push(
      `inbox: ${names.length}${unknown > 0 ? `（未知の schemaVersion: ${unknown}）` : ""}`,
    );
  }
  const rejected = listNames(paths.rejected, REQUEST_NAME).length;
  lines.push(
    rejected > 0
      ? `rejected: ${rejected}（${paths.rejected}/reasons.log で理由を見て、.json を消す）`
      : "rejected: 0",
  );

  const porcelain = deps.runGit(
    storeGitArgs(store, ["status", "--porcelain"]),
    store,
  );
  const uncommitted =
    porcelain.ok && porcelain.stdout !== ""
      ? porcelain.stdout.split("\n").length
      : 0;
  lines.push(
    uncommitted > 0
      ? `uncommitted: ${uncommitted}（git -C ${store} add -A && git -C ${store} commit）`
      : "uncommitted: 0",
  );

  const remotes = deps.runGit(storeGitArgs(store, ["remote"]), store);
  const remote = remotes.ok ? (remotes.stdout.split("\n")[0] ?? "") : "";
  if (remote === "") {
    lines.push(
      `remote: なし（remote 未設定: git -C ${store} remote add origin <url>）`,
    );
  } else {
    const upstream = deps.runGit(
      storeGitArgs(store, ["rev-parse", "--abbrev-ref", "@{u}"]),
      store,
    );
    if (!upstream.ok) {
      lines.push(`remote: ${remote}（upstream 未設定）`);
    } else {
      const dates = deps.runGit(
        storeGitArgs(store, ["log", "@{u}..HEAD", "--format=%cs"]),
        store,
      );
      const unpushed =
        dates.ok && dates.stdout !== "" ? dates.stdout.split("\n") : [];
      lines.push(
        unpushed.length > 0
          ? `remote: ${remote}（未 push ${unpushed.length} 件、最古 ${unpushed[unpushed.length - 1]}）`
          : `remote: ${remote}（未 push なし）`,
      );
    }
  }

  const jobs = countJobs(store);
  lines.push(
    `queue: ${jobs.queue} processing: ${jobs.processing} failed: ${jobs.failed}`,
  );
  const runs = summarizeRuns(store, deps.now, 14);
  lines.push(
    `worker (14d): applied ${runs.applied} skipped ${runs.skipped} rejected ${runs.rejected} failed ${runs.failed}`,
  );

  const reads = countReads([paths.readsLog, paths.codexReadsLog], deps.now);
  lines.push(
    `reads: claude: ${reads.claude} codex: ${reads.codex} unknown: ${reads.unknown}`,
  );
  lines.push(...metricsStatusLines(store, deps));

  const readOnly: string[] = [];
  const candidates = [
    commonFilePath(store),
    ...listNames(paths.repos, /\.md$/).map((n) => join(paths.repos, n)),
  ];
  for (const path of candidates) {
    try {
      if (!lstatSync(path).isFile()) continue;
      const parsed = parseLearningsFile(readFileSync(path, "utf8"));
      if (!parsed.ok || parsed.value.readOnly) readOnly.push(path);
    } catch {
      // common.md が無いなど
    }
  }
  const noPromote = readNoPromote(store);
  if (!noPromote.ok)
    lines.push(
      `no-promote: ${noPromote.reason}（no-promote を直すまで昇格しない）`,
    );
  lines.push(
    readOnly.length > 0
      ? `read-only: ${readOnly.join(", ")}`
      : "read-only: なし",
  );
  return done(0, `${lines.join("\n")}\n`);
}

export async function runLearningsCli(
  argv: readonly string[],
  deps: RunLearningsCliDeps,
): Promise<RunLearningsCliResult> {
  const [command, ...rest] = argv;
  // human-only の判定より前に見る。エージェントも promote などの使い方を読めるように。
  // 見るのは argv[0] と argv[1] だけ。後ろまで探すと `--title --help` のように
  // 値の位置にある語を help と誤認して、書き込みの引数エラーを飲み込む
  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    rest[0] === "--help" ||
    rest[0] === "-h"
  )
    return done(0, USAGE);
  const humanOnly = isHumanCaller(deps);
  try {
    switch (command) {
      case "show":
        return runShow(rest, deps);
      case "path":
        return runPath(rest, deps);
      case "add":
        return await runAdd(rest, deps);
      case "remove":
        return await runRemove(rest, deps);
      case "feedback":
        return runFeedback(rest, deps);
      case "status":
        return runStatus(deps);
      case "init": {
        if (!humanOnly) return fail(HUMAN_ONLY_MESSAGE.trimEnd());
        const store = defaultStoreDir(deps.home);
        const initialized = initStore(store, deps.runGit);
        return initialized.ok
          ? done(0, `${store}\n`)
          : fail(initialized.reason);
      }
      case "tag":
        return await runTag(rest, deps);
      case "promote":
        if (!humanOnly) return fail(HUMAN_ONLY_MESSAGE.trimEnd());
        return await runPromote(rest, deps);
      case "rekey":
        if (!humanOnly) return fail(HUMAN_ONLY_MESSAGE.trimEnd());
        return await runRekey(rest, deps);
      default:
        return fail(`unknown command\n${USAGE}`);
    }
  } catch (error) {
    // parseArgs の未知の引数など。使い方を添えて 1 で終わる
    return fail(`${errorMessage(error)}\n${USAGE}`);
  }
}

// 質問も答えも制御端末（/dev/tty）を通す。stdin を読むと `yes |` で通せてしまう。
// 制御端末が無い（detached の子プロセスなど）か開けなければ false
export async function confirmOnDevTty(message: string): Promise<boolean> {
  let fd: number;
  try {
    fd = openSync("/dev/tty", constants.O_RDWR);
  } catch {
    return false;
  }
  try {
    writeSync(fd, message);
    const buffer = Buffer.alloc(64);
    let answer = "";
    while (!answer.includes("\n") && answer.length < 64) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      answer += buffer.subarray(0, n).toString("utf8");
    }
    return answer.split("\n")[0]?.trim().toLowerCase() === "y";
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

if (import.meta.main) {
  const result = await runLearningsCli(process.argv.slice(2), {
    cwd: process.cwd(),
    home: getHomeDir(),
    now: new Date(),
    readerEnv: process.env["AGENT_LEARNINGS_READER"],
    isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    agentEnv: Object.keys(process.env).some((name) => AGENT_ENV.test(name)),
    feedbackReader: detectFeedbackReader(Object.keys(process.env)),
    lockWaitMs: 10_000,
    runGit,
    confirm: confirmOnDevTty,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  // Not process.exit(): see docs/decisions/0002 (no-process-exit under hooks/).
  process.exitCode = result.exitCode;
}
