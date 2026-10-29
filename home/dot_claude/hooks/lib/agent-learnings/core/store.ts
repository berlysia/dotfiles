import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { RunGit } from "../../run-git.ts";
import {
  COMMON_KEY,
  parseLearningsFile,
  serializeLearningsFile,
  type LearningsFile,
  type Parsed,
} from "./learnings-file.ts";
import { keyToFileName } from "./repo-key.ts";
import type { FeedbackReader } from "./metrics.ts";

export type StorePaths = {
  store: string;
  state: string;
  repos: string;
  common: string;
  codex: string;
  inbox: string;
  rejected: string;
  readsLog: string;
  codexReadsLog: string;
  injectionsLog: string;
  feedbackLog: string;
  codexFeedbackLog: string;
  queue: string;
  processing: string;
  failed: string;
  processed: string;
  runsLog: string;
  workerLock: string;
  workerCwd: string;
};

export function storePaths(store: string): StorePaths {
  const state = join(store, ".state");
  const codex = join(state, "codex");
  return {
    store,
    state,
    repos: join(store, "repos"),
    common: join(store, "common.md"),
    codex,
    inbox: join(codex, "inbox"),
    // Codex の writable_roots の外に置く。Codex が拒否の記録を書き換えられないように
    rejected: join(state, "rejected"),
    readsLog: join(state, "reads.log"),
    codexReadsLog: join(codex, "reads.log"),
    injectionsLog: join(state, "injections.log"),
    feedbackLog: join(state, "feedback.log"),
    // Codex の sandbox が書ける側。Claude 側の feedback.log を Codex が書き換えられないように分ける
    codexFeedbackLog: join(codex, "feedback.log"),
    queue: join(state, "queue"),
    processing: join(state, "processing"),
    failed: join(state, "failed"),
    processed: join(state, "processed.json"),
    runsLog: join(state, "runs.log"),
    workerLock: join(state, "worker.lock"),
    workerCwd: join(state, "worker-cwd"),
  };
}

// plan-1 で作った store には無い、queue 系のディレクトリを足す（enqueue と worker の開始時に呼ぶ）
export function ensureStateDirs(store: string): void {
  const paths = storePaths(store);
  for (const dir of [
    paths.state,
    paths.queue,
    paths.processing,
    paths.failed,
    paths.workerCwd,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function defaultStoreDir(home: string): string {
  return join(home, ".local/share/agent-learnings");
}

export function repoFilePath(store: string, key: string): string {
  return join(store, "repos", keyToFileName(key));
}

export function commonFilePath(store: string): string {
  return join(store, "common.md");
}

export function writeFileSyncAtomic(
  path: string,
  content: string,
  mode: number,
): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

export const storeGitArgs = (
  store: string,
  args: readonly string[],
): string[] => [
  "--git-dir",
  join(store, ".git"),
  "--work-tree",
  store,
  ...args,
];

const AUTHOR = [
  "-c",
  "user.name=agent-learnings",
  "-c",
  "user.email=agent-learnings@localhost",
];

export function commitStore(
  store: string,
  message: string,
  runGit: RunGit,
): { ok: true; committed: boolean } | { ok: false; reason: string } {
  if (!existsSync(join(store, ".git")))
    return { ok: false, reason: "no git repository" };
  if (!runGit(storeGitArgs(store, ["add", "-A", "--", "."]), store).ok)
    return { ok: false, reason: "commit failed" };
  const status = runGit(storeGitArgs(store, ["status", "--porcelain"]), store);
  if (!status.ok) return { ok: false, reason: "commit failed" };
  if (status.stdout === "") return { ok: true, committed: false };
  const commit = runGit(
    storeGitArgs(store, [...AUTHOR, "commit", "-q", "-m", message]),
    store,
  );
  return commit.ok
    ? { ok: true, committed: true }
    : { ok: false, reason: "commit failed" };
}

// push していない commit のうち最も古いものの時刻。upstream が無ければ null
export function oldestUnpushedCommitTime(
  store: string,
  runGit: RunGit,
): Date | null {
  const upstream = runGit(
    storeGitArgs(store, ["rev-parse", "--abbrev-ref", "@{u}"]),
    store,
  );
  if (!upstream.ok) return null;
  const log = runGit(
    storeGitArgs(store, ["log", "@{u}..HEAD", "--format=%ct"]),
    store,
  );
  if (!log.ok || log.stdout === "") return null;
  const times = log.stdout
    .split("\n")
    .map(Number)
    .filter((n) => Number.isFinite(n));
  return times.length === 0 ? null : new Date(Math.min(...times) * 1000);
}

export function initStore(
  store: string,
  runGit: RunGit,
): { ok: true; created: boolean } | { ok: false; reason: string } {
  const paths = storePaths(store);
  try {
    for (const dir of [
      store,
      paths.repos,
      paths.state,
      paths.inbox,
      paths.rejected,
    ]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    ensureStateDirs(store);
    chmodSync(store, 0o700);
    let created = false;
    if (!existsSync(join(store, ".git"))) {
      if (!runGit(["init", "-q"], store).ok)
        return { ok: false, reason: "git init failed" };
      created = true;
    }
    for (const [name, content] of [
      ["no-promote", "local/*\n"],
      [".gitignore", ".state/\n"],
    ] as const) {
      const path = join(store, name);
      if (!existsSync(path)) {
        writeFileSync(path, content, { mode: 0o600 });
        created = true;
      }
    }
    if (created) {
      const committed = commitStore(
        store,
        "chore: initialize agent-learnings store",
        runGit,
      );
      if (!committed.ok) return committed;
    }
    return { ok: true, created };
  } catch (error) {
    return { ok: false, reason: `init failed: ${(error as Error).message}` };
  }
}

// repos/ が symlink、または store の外を指していれば拒否する（store の外への読み書きを防ぐ）
function checkReposDir(store: string): string | null {
  const repos = join(store, "repos");
  let stat;
  try {
    stat = lstatSync(repos);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "repos unreadable";
  }
  if (stat.isSymbolicLink()) return "repos is a symlink";
  try {
    if (realpathSync(repos) !== `${realpathSync(store)}/repos`)
      return "repos escapes the store";
  } catch {
    return "repos unreadable";
  }
  return null;
}

function filePathFor(store: string, key: string): string {
  return key === COMMON_KEY ? commonFilePath(store) : repoFilePath(store, key);
}

export function readLearnings(store: string, key: string): Parsed {
  if (key !== COMMON_KEY) {
    const problem = checkReposDir(store);
    if (problem !== null) return { ok: false, reason: problem };
  }
  const path = filePathFor(store, key);
  let text: string;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile())
        return { ok: false, reason: "not a regular file" };
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return {
        ok: true,
        value: { format: 1, key, readOnly: false, entries: [] },
      };
    if (code === "ELOOP")
      return { ok: false, reason: "symlinked learnings file" };
    return {
      ok: false,
      reason: `cannot read learnings file: ${code ?? "unknown"}`,
    };
  }
  const parsed = parseLearningsFile(text);
  if (!parsed.ok) return parsed;
  if (parsed.value.format !== 0 && parsed.value.key !== key)
    return { ok: false, reason: "header key mismatch" };
  return parsed;
}

export function writeLearnings(
  store: string,
  file: LearningsFile,
): { ok: true } | { ok: false; reason: string } {
  if (file.readOnly) return { ok: false, reason: "read-only file" };
  if (file.key !== COMMON_KEY) {
    const problem = checkReposDir(store);
    if (problem !== null) return { ok: false, reason: problem };
  }
  try {
    writeFileSyncAtomic(
      filePathFor(store, file.key),
      serializeLearningsFile(file),
      0o600,
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `write failed: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`,
    };
  }
}

export const LOG_MAX_BYTES = 1024 * 1024;
// 回転されないまま増え続けても、ここで書き込みを止めてディスクを埋めさせない
export const LOG_HARD_MAX_BYTES = 4 * 1024 * 1024;

// 書き先の決定はここ 1 か所
export function feedbackLogPathFor(
  store: string,
  reader: FeedbackReader,
): string {
  const paths = storePaths(store);
  return reader === "codex" ? paths.codexFeedbackLog : paths.feedbackLog;
}

// 読む対象の決定はここ 1 か所。Claude と Codex の注入は同じファイルに書く（行の reader で区別する）。
// Codex の sandbox は `.state/` を書けず、hook は sandbox の外で走るので、Codex のエージェントは
// このファイルに行を足せない。別ファイルにすると受理の根拠が増えるだけで守りは変わらない
export function injectionLogPaths(store: string): string[] {
  return [storePaths(store).injectionsLog];
}

// 1 回の write で複数行を書く。先頭に改行を 1 つ足すのは、前の write が行の途中で切れていても
// 次の行がその断片と融合しないため（空行は読む側が捨てる）。失敗は例外にせず false
export function appendLogLines(
  path: string,
  text: string,
  write: (fd: number, data: Buffer) => number = (fd, data) =>
    writeSync(fd, data),
): boolean {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
  } catch {
    return false;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size >= LOG_HARD_MAX_BYTES) return false;
    const data = Buffer.from(`\n${text}`, "utf8");
    return write(fd, data) === data.length;
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // 閉じられなくても記録の成否には関係しない
    }
  }
}

// 末尾 maxBytes だけを読む。Codex が書き換えられるファイルなので symlink・FIFO を辿らない
export function readLogTailInfo(
  path: string,
  maxBytes: number,
): { text: string; truncated: boolean } | null {
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
    const length = Math.min(stat.size, maxBytes);
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
    return {
      text: buffer.subarray(0, offset).toString("utf8"),
      truncated: stat.size > maxBytes,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export const readLogTail = (path: string, maxBytes: number): string | null =>
  readLogTailInfo(path, maxBytes)?.text ?? null;

// `show` の呼び出し記録を 1 行足す。回転はしない（worker が lock の中で rotateLogs で行う）
export function appendReadLog(
  path: string,
  record: { at: Date; reader: string; repoKey: string },
): void {
  try {
    const reader =
      record.reader === "claude" || record.reader === "codex"
        ? record.reader
        : "unknown";
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(
        fd,
        `${JSON.stringify({ at: record.at.toISOString(), reader, repoKey: record.repoKey })}\n`,
      );
    } finally {
      closeSync(fd);
    }
  } catch {
    // 記録できなくても show は成功させる
  }
}

// 1MB を超えた runs.log・reads.log・codex/reads.log を `.1` に回す。store lock の中から呼ぶ
export function rotateLogs(store: string): void {
  const paths = storePaths(store);
  for (const path of [
    paths.runsLog,
    paths.readsLog,
    paths.codexReadsLog,
    paths.injectionsLog,
    paths.feedbackLog,
    paths.codexFeedbackLog,
  ]) {
    try {
      // FIFO を開いて worker が lock を握ったまま止まらないよう O_NONBLOCK と通常ファイルの確認を付ける
      const fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let size: number;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) continue;
        size = stat.size;
      } finally {
        closeSync(fd);
      }
      if (size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // 無いログは回さない
    }
  }
}
