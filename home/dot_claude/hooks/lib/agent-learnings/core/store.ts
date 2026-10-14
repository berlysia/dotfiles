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
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { RunGit } from "./git.ts";
import {
  COMMON_KEY,
  parseLearningsFile,
  serializeLearningsFile,
  type LearningsFile,
  type Parsed,
} from "./learnings-file.ts";
import { keyToFileName } from "./repo-key.ts";

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

const READS_LOG_MAX_BYTES = 1024 * 1024;

export function appendReadLog(
  path: string,
  record: { at: Date; reader: string; repoKey: string },
): void {
  try {
    const reader =
      record.reader === "claude" || record.reader === "codex"
        ? record.reader
        : "unknown";
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const size = fstatSync(fd).size;
      closeSync(fd);
      if (size > READS_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // 無ければ新しく作る
    }
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
