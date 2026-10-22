import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  chmodSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isSafeSessionId } from "../../session-id.ts";
import { isValidRepoKey } from "./repo-key.ts";
import type { InjectedRecord, InjectedState, InjectionKind } from "./select.ts";

// 場面の注入の「このセッションで何を出したか」と、cwd → repo の解決のキャッシュ。
// 他のプロセス（別のユーザー・別の repo のコマンド）が置いたファイルを読むことがあるので、
// ディレクトリとファイルの両方を硬化する。厳密な一回性は保証しない: 並行する hook が互いの
// 追記を見る前に選ぶと、同じ学びが 1 回余分に出ることがある（受け入れる）。
// 途中で落ちた write の後ろに次の追記がつながると、その 1 行も読めなくなる。重複抑止が
// 1 回外れるだけで、合計の上限は壊れない（知らない形の行も数えるため）

export const MAX_STATE_FILE_BYTES = 64 * 1024;
export const MAX_CACHE_LINES = 64;
const GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RECORD_ID = /^L-[0-9a-f]{12}$/;
const KINDS: readonly InjectionKind[] = ["pre", "fail", "path"];
const STATE_FILE = /^(.+)\.(injected|cache)$/;

export type SceneCacheEntry = {
  cwd: string;
  repoKey: string;
  toplevel: string;
};

// 制御文字を含む path は state の行を壊しうるので扱わない（正規表現の制御文字の範囲を避けて走査する）
export function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const isValidAgentId = (agentId: string): boolean =>
  AGENT_ID.test(agentId);

const isOwnedByUs = (uid: number): boolean =>
  typeof process.getuid !== "function" || uid === process.getuid();

// 親も含めて 0700 で作る。umask に任せず、自分が作ったものは chmod で明示する。
// 既にあるディレクトリは lstat で「自分の uid の通常のディレクトリ・mode 0700」かを確かめるだけで、
// symlink や緩い mode を直そうとしない。false は「注入しない」
export function ensureSceneDir(dir: string): boolean {
  try {
    const missing: string[] = [];
    for (let at = dir; ; at = dirname(at)) {
      try {
        lstatSync(at);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        missing.push(at);
        if (dirname(at) === at) return false;
      }
    }
    for (const path of missing.reverse()) {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    }
    const stat = lstatSync(dir);
    return (
      stat.isDirectory() &&
      isOwnedByUs(stat.uid) &&
      (stat.mode & 0o777) === 0o700
    );
  } catch {
    return false;
  }
}

type ReadResult = { ok: true; text: string } | { ok: false };

// 無いファイルは空として読む。symlink・通常でないファイル・64KB 超・読み取りの失敗は ok:false
function readStateFile(path: string): ReadResult {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { ok: true, text: "" }
      : { ok: false };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_STATE_FILE_BYTES)
      return { ok: false };
    const buffer = Buffer.alloc(stat.size);
    let filled = 0;
    while (filled < stat.size) {
      const n = readSync(fd, buffer, filled, stat.size - filled, filled);
      if (n === 0) break;
      filled += n;
    }
    return { ok: true, text: buffer.subarray(0, filled).toString("utf8") };
  } catch {
    return { ok: false };
  } finally {
    closeSync(fd);
  }
}

function appendLine(path: string, line: string): boolean {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return false;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !isOwnedByUs(stat.uid)) return false;
    const data = Buffer.from(`${line}\n`);
    return writeSync(fd, data) === data.length;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

// 末尾の改行で終わらない最後の行（途中で落ちた write）は捨てる
function completeLines(text: string): string[] {
  const lines = text.split("\n");
  lines.pop();
  return lines.filter((l) => l !== "");
}

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const filePath = (dir: string, sessionId: string, ext: string): string =>
  join(dir, `${sessionId}.${ext}`);

// null は「注入しない」。知らない形の行も totalCount / totalBytes には数える
export function readInjected(
  dir: string,
  sessionId: string,
): InjectedState | null {
  if (!isSafeSessionId(sessionId) || !ensureSceneDir(dir)) return null;
  const read = readStateFile(filePath(dir, sessionId, "injected"));
  if (!read.ok) return null;
  const records: InjectedRecord[] = [];
  let totalCount = 0;
  let totalBytes = 0;
  for (const line of completeLines(read.text)) {
    const object = parseObject(line);
    if (object === null) continue;
    totalCount += 1;
    const { agent, id, kind, bytes } = object;
    const validBytes =
      typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0;
    if (validBytes) totalBytes += bytes;
    if (
      validBytes &&
      typeof agent === "string" &&
      AGENT_ID.test(agent) &&
      typeof id === "string" &&
      RECORD_ID.test(id) &&
      typeof kind === "string" &&
      (KINDS as readonly string[]).includes(kind)
    )
      records.push({ agent, id, kind: kind as InjectionKind, bytes });
  }
  return { records, totalCount, totalBytes };
}

export function appendInjected(
  dir: string,
  sessionId: string,
  record: InjectedRecord,
): boolean {
  if (!isSafeSessionId(sessionId) || !ensureSceneDir(dir)) return false;
  return appendLine(
    filePath(dir, sessionId, "injected"),
    JSON.stringify({
      agent: record.agent,
      id: record.id,
      kind: record.kind,
      bytes: record.bytes,
    }),
  );
}

const validCacheEntry = (value: Record<string, unknown>): boolean =>
  typeof value.cwd === "string" &&
  isAbsolute(value.cwd) &&
  !hasControlChars(value.cwd) &&
  typeof value.toplevel === "string" &&
  isAbsolute(value.toplevel) &&
  !hasControlChars(value.toplevel) &&
  typeof value.repoKey === "string" &&
  isValidRepoKey(value.repoKey);

// キャッシュの値は読むたびに再検査する（別のプロセスが書いた行を信用しない）。
// lineCount は壊れた行も含めた行数で、追記の上限に使う
export function readCache(
  dir: string,
  sessionId: string,
): { entries: SceneCacheEntry[]; lineCount: number } | null {
  if (!isSafeSessionId(sessionId) || !ensureSceneDir(dir)) return null;
  const read = readStateFile(filePath(dir, sessionId, "cache"));
  if (!read.ok) return null;
  const lines = completeLines(read.text);
  const entries: SceneCacheEntry[] = [];
  for (const line of lines) {
    const object = parseObject(line);
    if (object === null || !validCacheEntry(object)) continue;
    entries.push({
      cwd: object.cwd as string,
      repoKey: object.repoKey as string,
      toplevel: object.toplevel as string,
    });
  }
  return { entries, lineCount: lines.length };
}

export function appendCache(
  dir: string,
  sessionId: string,
  entry: SceneCacheEntry,
): boolean {
  if (
    !validCacheEntry({ ...entry }) ||
    !isSafeSessionId(sessionId) ||
    !ensureSceneDir(dir)
  )
    return false;
  const existing = readCache(dir, sessionId);
  if (existing === null || existing.lineCount >= MAX_CACHE_LINES) return false;
  return appendLine(
    filePath(dir, sessionId, "cache"),
    JSON.stringify({
      cwd: entry.cwd,
      repoKey: entry.repoKey,
      toplevel: entry.toplevel,
    }),
  );
}

// 7 日より古い state を消す。symlink は辿らず、対象は名前が `<安全な session id>.injected|cache` の通常ファイルだけ
export function gcSceneState(dir: string, now: Date): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = STATE_FILE.exec(name);
    if (match === null || !isSafeSessionId(match[1] ?? "")) continue;
    try {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isFile() && now.getTime() - stat.mtimeMs > GC_MAX_AGE_MS)
        unlinkSync(path);
    } catch {
      // 消せなかったものは次の SessionStart で拾う
    }
  }
}
