import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { RunGit } from "../../run-git.ts";
import { applyOps, type LearningOp } from "./ops.ts";
import { isValidRepoKey } from "./repo-key.ts";
import { withStoreLock } from "./lock.ts";
import { parseTriggers } from "./triggers.ts";
import {
  commitStore,
  readLearnings,
  storePaths,
  writeFileSyncAtomic,
  writeLearnings,
} from "./store.ts";

export type InboxRequest =
  | {
      op: "add";
      repoKey: string;
      title: string;
      body: string;
      reader: string;
      on?: string[];
    }
  | { op: "remove"; repoKey: string; id: string; reader: string };
// 依頼ファイル: { schemaVersion: 1, requestId, requestedAt, ...InboxRequest }
export type DrainResult = {
  applied: number;
  rejected: number;
  unknownVersion: number;
  remaining: number;
  skipped: boolean;
  unsafe: boolean;
};
export type DrainOptions = {
  today: string;
  runGit: RunGit;
  extraRedact: readonly RegExp[];
};

export const INBOX_MAX_PER_DRAIN = 50;
export const INBOX_MAX_BYTES = 8 * 1024;
const INBOX_MAX_SCAN = 200;
const NAME_PATTERN = /^\d+-(R-[0-9a-f]{12})\.json$/;
const REQUEST_ID_PATTERN = /^R-[0-9a-f]{12}$/;
const ENTRY_ID_PATTERN = /^L-[0-9a-f]{12}$/;

const emptyResult = (): DrainResult => ({
  applied: 0,
  rejected: 0,
  unknownVersion: 0,
  remaining: 0,
  skipped: false,
  unsafe: false,
});

export function writeInboxRequest(
  store: string,
  request: InboxRequest,
  now: Date,
): string {
  const requestId = `R-${randomBytes(6).toString("hex")}`;
  const base = {
    schemaVersion: 1,
    requestId,
    requestedAt: now.toISOString(),
    op: request.op,
    repoKey: request.repoKey,
  };
  const body =
    request.op === "add"
      ? {
          ...base,
          title: request.title,
          body: request.body,
          reader: request.reader,
          ...(request.on === undefined ? {} : { on: request.on }),
        }
      : { ...base, id: request.id, reader: request.reader };
  writeFileSyncAtomic(
    join(storePaths(store).inbox, `${now.getTime()}-${requestId}.json`),
    JSON.stringify(body),
    0o600,
  );
  return requestId;
}

// Codex は .state/codex の中を書き換えられるので、symlink を辿って store の外を触らないよう確かめる
export function inboxDirsSafe(store: string): boolean {
  const { codex, inbox } = storePaths(store);
  const uid = process.getuid?.();
  for (const dir of [codex, inbox]) {
    try {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      if (uid !== undefined && stat.uid !== uid) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function listRequestNames(inbox: string): string[] {
  try {
    return readdirSync(inbox)
      .filter((name) => NAME_PATTERN.test(name))
      .sort();
  } catch {
    return [];
  }
}

type Loaded =
  | { kind: "ok"; json: Record<string, unknown> }
  | { kind: "reject"; reason: string };

function loadRequestFile(path: string): Loaded {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return { kind: "reject", reason: "unreadable" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: "reject", reason: "not a regular file" };
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid)
      return { kind: "reject", reason: "wrong owner" };
    if (stat.size > INBOX_MAX_BYTES)
      return { kind: "reject", reason: "too large" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      return { kind: "reject", reason: "invalid json" };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { kind: "reject", reason: "invalid json" };
    }
    return { kind: "ok", json: parsed as Record<string, unknown> };
  } finally {
    closeSync(fd);
  }
}

type Validated =
  | {
      ok: true;
      requestId: string;
      reader: string;
      repoKey: string;
      op: LearningOp;
    }
  | { ok: false; reason: string };

function validateRequest(
  json: Record<string, unknown>,
  fileId: string,
): Validated {
  const evidenceFor = (requestId: string, reader: string): string =>
    `inbox ${requestId} from ${reader}`;
  const requestId = json.requestId;
  if (
    typeof requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(requestId) ||
    requestId !== fileId
  ) {
    return { ok: false, reason: "invalid requestId" };
  }
  const reader = json.reader;
  if (reader !== "claude" && reader !== "codex")
    return { ok: false, reason: "invalid reader" };
  const op = json.op;
  if (op !== "add" && op !== "remove")
    return { ok: false, reason: "invalid op" };
  const repoKey = json.repoKey;
  if (typeof repoKey !== "string" || !isValidRepoKey(repoKey))
    return { ok: false, reason: "invalid repoKey" };
  const evidence = evidenceFor(requestId, reader);
  if (op === "add") {
    if (typeof json.title !== "string" || typeof json.body !== "string") {
      return { ok: false, reason: "invalid fields" };
    }
    // 外れた `on` は `on` だけを落として取り込まず、依頼ごと rejected に回す。
    // 理由は固定の語だけで、入力の値は書かない
    const rawOn = json.on;
    let on: Extract<LearningOp, { op: "add" }>["on"];
    if (rawOn !== undefined) {
      const parsed = Array.isArray(rawOn)
        ? parseTriggers(rawOn)
        : ({ ok: false, error: "bad-grammar" } as const);
      if (!parsed.ok) return { ok: false, reason: parsed.error };
      on = parsed.value;
    }
    return {
      ok: true,
      requestId,
      reader,
      repoKey,
      op: {
        op: "add",
        title: json.title,
        body: json.body,
        evidence,
        ...(on === undefined ? {} : { on }),
      },
    };
  }
  if (typeof json.id !== "string" || !ENTRY_ID_PATTERN.test(json.id))
    return { ok: false, reason: "invalid fields" };
  return {
    ok: true,
    requestId,
    reader,
    repoKey,
    op: { op: "remove", id: json.id, reason: evidence },
  };
}

function appendReason(
  rejectedDir: string,
  requestId: string,
  reason: string,
): void {
  try {
    const fd = openSync(
      join(rejectedDir, "reasons.log"),
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(
        fd,
        `${JSON.stringify({ at: new Date().toISOString(), requestId, reason })}\n`,
      );
    } finally {
      closeSync(fd);
    }
  } catch {
    // 拒否の記録に失敗しても取り込みは続ける
  }
}

// lock を持っている呼び出し側（CLI の add / remove）用。lock は取らない
export function applyInboxLocked(
  store: string,
  opts: DrainOptions,
): DrainResult {
  const result = emptyResult();
  if (!inboxDirsSafe(store)) return { ...result, unsafe: true };
  const paths = storePaths(store);
  mkdirSync(paths.rejected, { recursive: true, mode: 0o700 });

  const names = listRequestNames(paths.inbox).slice(0, INBOX_MAX_SCAN);
  const evidenceLines: string[] = [];
  let index = 0;
  for (; index < names.length; index++) {
    if (result.applied + result.rejected >= INBOX_MAX_PER_DRAIN) break;
    const name = names[index] ?? "";
    const fileId = NAME_PATTERN.exec(name)?.[1] ?? "";
    const path = join(paths.inbox, name);

    const reject = (reason: string, requestId: string): void => {
      appendReason(paths.rejected, requestId, reason);
      try {
        renameSync(path, join(paths.rejected, name));
      } catch {
        try {
          unlinkSync(path);
        } catch {
          // 残っても次回また拒否される
        }
      }
      result.rejected += 1;
    };

    const loaded = loadRequestFile(path);
    if (loaded.kind === "reject") {
      reject(loaded.reason, fileId);
      continue;
    }
    if (loaded.json.schemaVersion !== 1) {
      // 新しい CLI が来るまで失わないよう inbox に残す
      result.unknownVersion += 1;
      continue;
    }
    const request = validateRequest(loaded.json, fileId);
    if (!request.ok) {
      reject(request.reason, fileId);
      continue;
    }
    const file = readLearnings(store, request.repoKey);
    if (!file.ok) {
      reject(`ops rejected: ${file.reason}`.slice(0, 200), request.requestId);
      continue;
    }
    const applied = applyOps(file.value, [request.op], {
      today: opts.today,
      repoKey: request.repoKey,
      newId: () => `L-${randomBytes(6).toString("hex")}`,
      rules: { allowUrl: false },
      extraRedact: opts.extraRedact,
    });
    if (!applied.ok) {
      reject(
        `ops rejected: ${applied.reason}`.slice(0, 200),
        request.requestId,
      );
      continue;
    }
    const written = writeLearnings(store, applied.value.file);
    if (!written.ok) {
      reject(
        `ops rejected: ${written.reason}`.slice(0, 200),
        request.requestId,
      );
      continue;
    }
    unlinkSync(path);
    result.applied += 1;
    evidenceLines.push(...applied.value.evidence);
  }
  result.remaining = names.length - index;

  if (result.applied > 0) {
    commitStore(
      store,
      `learnings: inbox ${result.applied} requests\n\n${evidenceLines.join("\n")}`,
      opts.runGit,
    );
  }
  return result;
}

// lock を取ってから applyInboxLocked を呼ぶ（SessionStart 用）
export async function drainInbox(
  store: string,
  opts: DrainOptions & { waitMs: number },
): Promise<DrainResult> {
  if (!inboxDirsSafe(store)) return { ...emptyResult(), unsafe: true };
  if (listRequestNames(storePaths(store).inbox).length === 0)
    return emptyResult();
  const locked = await withStoreLock(
    storePaths(store).state,
    { waitMs: opts.waitMs },
    () => applyInboxLocked(store, opts),
  );
  return locked.ok ? locked.value : { ...emptyResult(), skipped: true };
}
