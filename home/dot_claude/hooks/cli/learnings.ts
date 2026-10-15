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
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
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
import { countJobs, summarizeRuns } from "../lib/agent-learnings/core/queue.ts";
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
  initStore,
  readLearnings,
  repoFilePath,
  storeGitArgs,
  storePaths,
  writeFileSyncAtomic,
  writeLearnings,
} from "../lib/agent-learnings/core/store.ts";
import { loadRedactList } from "../lib/insight-digest.ts";
import { getHomeDir } from "../lib/path-utils.ts";

export interface RunLearningsCliDeps {
  cwd: string;
  home: string;
  now: Date;
  readerEnv: string | undefined;
  isTty: boolean; // stdin と stdout の両方が TTY
  agentEnv: boolean; // エージェントの実行環境を示す環境変数がある
  lockWaitMs: number;
  runGit: RunGit;
  // 昇格の確認。message を見せて、利用者が y と答えたときだけ true を返す
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

const USAGE = [
  "usage: agent-learnings <command>",
  "  show [--cwd DIR] [--reader NAME]",
  "  path [--common]",
  "  add --title=T --body=B [--common]",
  "  remove <id>",
  "  status",
  "  promote <id>    (human only)",
  "  init            (human only)",
  "  rekey <old> <new>  (human only)",
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

function runShow(
  args: readonly string[],
  deps: RunLearningsCliDeps,
): RunLearningsCliResult {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { cwd: { type: "string" }, reader: { type: "string" } },
      strict: true,
    });
    const store = defaultStoreDir(deps.home);
    if (!storeExists(store)) return done(0);
    const repoKey = resolveRepoKey(values.cwd ?? deps.cwd, deps.runGit);
    if (repoKey === null) return done(0);

    const repo = readLearnings(store, repoKey);
    const common = readLearnings(store, COMMON_KEY);
    const rendered = renderLearnings({
      repo: repo.ok ? repo.value : null,
      common: common.ok ? common.value : null,
      repoPath: repoFilePath(store, repoKey),
      commonPath: commonFilePath(store),
    });

    const paths = storePaths(store);
    const reader = readerOf(deps, values.reader);
    // 記録は学びの件数にかかわらず行う。Codex は .state/codex の中にしか書けない
    appendReadLog(reader === "codex" ? paths.codexReadsLog : paths.readsLog, {
      at: deps.now,
      reader,
      repoKey,
    });
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
): string {
  const lines = [
    ...evidence,
    ...evictedIds.map((id) => `evict ${id}: over the entry cap`),
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
    },
    strict: true,
  });
  if (values.title === undefined || values.body === undefined)
    return fail(`--title と --body が要る\n${USAGE}`);
  const humanOnly = deps.isTty && !deps.agentEnv;
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
        { op: "add", title, body, evidence: "manual add" },
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
    { op: "add", repoKey, title, body, reader: inboxReader(deps) },
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
  if (!isValidRepoKey(oldKey) || !isValidRepoKey(newKey) || oldKey === newKey)
    return fail("キーが不正、または同じ");
  const store = defaultStoreDir(deps.home);
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

// 末尾 1MB だけを読む。Codex が書き換えられるファイルなので symlink・FIFO を辿らない
function readTail(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, READS_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const n = readSync(
        fd,
        buffer,
        offset,
        length - offset,
        stat.size - length + offset,
      );
      if (n === 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function countReads(
  paths: readonly string[],
  now: Date,
): Record<"claude" | "codex" | "unknown", number> {
  const counts = { claude: 0, codex: 0, unknown: 0 };
  for (const path of paths) {
    const tail = readTail(path);
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
    const text = readTail(join(inbox, name));
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
  const humanOnly = deps.isTty && !deps.agentEnv;
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

// stderr に見せて stdin から 1 行読む。y 以外はすべて「移さない」
async function confirmOnTty(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(message);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
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
    lockWaitMs: 10_000,
    runGit,
    confirm: confirmOnTty,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  // Not process.exit(): see docs/decisions/0002 (no-process-exit under hooks/).
  process.exitCode = result.exitCode;
}
