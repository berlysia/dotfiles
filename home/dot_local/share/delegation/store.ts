import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsc,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  LEDGER_LARGE_BYTES,
  LOCK_RETRIES,
  LOCK_RETRY_DELAY_MS,
  LOCK_STALE_MS,
  REVIEW_AFTER_DAYS,
  REVIEW_AFTER_RECORDS,
  ROW_MAX_BYTES,
  STALE_PENDING_DAYS,
} from "./constants.ts";
import {
  isDelegationId,
  parseRow,
  type DelegationRow,
  type LapseRow,
  type LedgerRow,
  type Pending,
  type ReviewRow,
  type SkipReason,
} from "./schema.ts";

export type StoreErrorCode = "symlink" | "owner" | "busy" | "invalid" | "io";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export type Store = {
  dir: string;
  pendingDir: string;
  ledgerPath: string;
  retryDelayMs: number;
  maxAttempts: number;
};

const DAY_MS = 86_400_000;

export function resolveDataDir(
  env: Record<string, string | undefined>,
): string {
  const xdg = env.XDG_DATA_HOME;
  const base =
    xdg !== undefined && xdg.startsWith("/")
      ? xdg
      : join(env.HOME ?? "", ".local", "share");
  return join(base, "delegation-ledger");
}

function ensureOwnedDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new StoreError("symlink", `not a plain directory: ${path}`);
  }
  if (st.uid !== process.getuid?.()) {
    throw new StoreError("owner", `not owned by this user: ${path}`);
  }
  if ((st.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

export function openStore(
  env: Record<string, string | undefined> = process.env,
  opts: { retryDelayMs?: number; maxAttempts?: number } = {},
): Store {
  const dir = resolveDataDir(env);
  if (env.HOME === undefined && env.XDG_DATA_HOME === undefined) {
    throw new StoreError("invalid", "HOME is not set");
  }
  mkdirSync(join(dir, ".."), { recursive: true });
  ensureOwnedDir(dir);
  const pendingDir = join(dir, "pending");
  ensureOwnedDir(pendingDir);
  return {
    dir,
    pendingDir,
    ledgerPath: join(dir, "ledger.jsonl"),
    retryDelayMs: opts.retryDelayMs ?? LOCK_RETRY_DELAY_MS,
    maxAttempts: opts.maxAttempts ?? LOCK_RETRIES,
  };
}

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

function openNoFollow(path: string, flags: number, mode?: number): number {
  try {
    return openSync(path, flags | fsc.O_NOFOLLOW, mode);
  } catch (e) {
    if (errnoCode(e) === "ELOOP") {
      throw new StoreError("symlink", `symlink refused: ${path}`);
    }
    throw e;
  }
}

function assertOwnedRegular(fd: number, path: string): void {
  const st = fstatSync(fd);
  if (!st.isFile()) throw new StoreError("symlink", `not a file: ${path}`);
  if (st.uid !== process.getuid?.()) {
    throw new StoreError("owner", `not owned by this user: ${path}`);
  }
}

/** Returns null when the file does not exist. */
function readOwnedFile(path: string): string | null {
  let fd: number;
  try {
    fd = openNoFollow(path, fsc.O_RDONLY);
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return null;
    throw e;
  }
  try {
    assertOwnedRegular(fd, path);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function pendingPath(store: Store, id: string): string {
  if (!isDelegationId(id)) throw new StoreError("invalid", "bad id");
  return join(store.pendingDir, `${id}.json`);
}

function parsePending(text: string): Pending | null {
  try {
    const raw = JSON.parse(text) as Partial<Pending> | null;
    if (raw === null || typeof raw !== "object") return null;
    if (raw.v !== 1 || !isDelegationId(raw.id)) return null;
    return raw as Pending;
  } catch {
    return null;
  }
}

export function readPending(store: Store, id: string): Pending | null {
  const text = readOwnedFile(pendingPath(store, id));
  return text === null ? null : parsePending(text);
}

const PENDING_FILE_RE = /^d-[0-9a-f]{12}\.json$/;

export function listPending(store: Store): Pending[] {
  const out: Pending[] = [];
  for (const name of readdirSync(store.pendingDir).sort()) {
    if (!PENDING_FILE_RE.test(name)) continue;
    const text = readOwnedFile(join(store.pendingDir, name));
    if (text === null) continue;
    const p = parsePending(text);
    if (p !== null) out.push(p);
  }
  return out;
}

/** False when a pending with this id already exists. */
export function createPending(store: Store, pending: Pending): boolean {
  const path = pendingPath(store, pending.id);
  let fd: number;
  try {
    fd = openNoFollow(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
  } catch (e) {
    if (errnoCode(e) === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, `${JSON.stringify(pending)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Per-pending mutex. A rename alone would let two updaters that read the same
 * old version overwrite each other, so every read-modify-write holds this.
 */
export function withPendingLock<T>(store: Store, id: string, fn: () => T): T {
  if (!isDelegationId(id)) throw new StoreError("invalid", "bad id");
  const lock = join(store.pendingDir, `${id}.lock`);
  let held = false;
  for (let attempt = 0; attempt < store.maxAttempts; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      held = true;
      break;
    } catch (e) {
      if (errnoCode(e) !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        // lock vanished between mkdir and stat; retry immediately
        continue;
      }
      sleepSync(store.retryDelayMs);
    }
  }
  if (!held) throw new StoreError("busy", "busy");
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // already taken over as stale
    }
  }
}

function writePendingFile(store: Store, pending: Pending): void {
  const path = pendingPath(store, pending.id);
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  const fd = openNoFollow(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(pending)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Re-reads inside the lock, applies `fn`, and writes back. `fn` returns null
 * to leave the file as it is. Returns the stored pending, or null when absent.
 */
export function updatePending(
  store: Store,
  id: string,
  fn: (current: Pending) => Pending | null,
): Pending | null {
  return withPendingLock(store, id, () => {
    const current = readPending(store, id);
    if (current === null) return null;
    const next = fn(current);
    if (next === null) return current;
    writePendingFile(store, next);
    return next;
  });
}

/** Caller holds the pending lock. */
export function removePendingFile(store: Store, id: string): void {
  try {
    unlinkSync(pendingPath(store, id));
  } catch (e) {
    if (errnoCode(e) !== "ENOENT") throw e;
  }
}

export function appendLedger(store: Store, row: LedgerRow): void {
  const buf = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
  if (buf.length > ROW_MAX_BYTES) {
    throw new StoreError("invalid", "row exceeds 4 KB");
  }
  const fd = openNoFollow(
    store.ledgerPath,
    fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT,
    0o600,
  );
  try {
    assertOwnedRegular(fd, store.ledgerPath);
    // One write call: O_APPEND keeps rows from interleaving below 4 KB.
    if (writeSync(fd, buf) !== buf.length) {
      throw new StoreError("io", "short write to ledger");
    }
  } finally {
    closeSync(fd);
  }
}

export type SkipCounts = Record<SkipReason, number>;
export type LedgerRead = {
  rows: LedgerRow[];
  skipped: SkipCounts;
  bytes: number;
  large: boolean;
};

export function readLedger(store: Store): LedgerRead {
  const text = readOwnedFile(store.ledgerPath);
  const skipped: SkipCounts = { version: 0, type: 0, broken: 0 };
  const rows: LedgerRow[] = [];
  if (text === null) return { rows, skipped, bytes: 0, large: false };
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const r = parseRow(line);
    if (r.ok) rows.push(r.row);
    else skipped[r.reason]++;
  }
  const bytes = Buffer.byteLength(text, "utf8");
  return { rows, skipped, bytes, large: bytes > LEDGER_LARGE_BYTES };
}

export type FoldedDelegation = DelegationRow & {
  /** foundBy of every amend, in record order. */
  laterDefects: string[];
};
export type Folded = {
  delegations: FoldedDelegation[];
  lapses: LapseRow[];
  reviews: ReviewRow[];
  ignoredAmends: number;
};

export function foldLedger(rows: readonly LedgerRow[]): Folded {
  const delegations = new Map<string, FoldedDelegation>();
  for (const row of rows) {
    if (row.type === "delegation" && !delegations.has(row.id)) {
      delegations.set(row.id, { ...row, laterDefects: [] });
    }
  }
  const lapseById = new Map<string, LapseRow>();
  const reviews: ReviewRow[] = [];
  let ignoredAmends = 0;
  for (const row of rows) {
    if (row.type === "lapse") {
      if (!delegations.has(row.id) && !lapseById.has(row.id)) {
        lapseById.set(row.id, row);
      }
    } else if (row.type === "amend") {
      const target = delegations.get(row.id);
      if (target === undefined) {
        ignoredAmends++;
        continue;
      }
      if (row.reworks !== undefined) {
        target.reworks = Math.min(999, (target.reworks ?? 0) + row.reworks);
      }
      if (row.laterDefect !== undefined) {
        target.laterDefects.push(row.laterDefect.foundBy);
      }
    } else if (row.type === "review") {
      reviews.push(row);
    }
  }
  return {
    delegations: [...delegations.values()],
    lapses: [...lapseById.values()],
    reviews,
    ignoredAmends,
  };
}

export function ledgerIds(rows: readonly LedgerRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) if (row.type !== "review") ids.add(row.id);
  return ids;
}

export function newDelegationId(
  store: Store,
  taken: ReadonlySet<string>,
): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const id = `d-${Buffer.from(bytes).toString("hex")}`;
    if (taken.has(id)) continue;
    if (readPending(store, id) !== null) continue;
    return id;
  }
}

export function lapseRowFromPending(p: Pending, now: Date): LapseRow {
  return {
    v: 1,
    type: "lapse",
    id: p.id,
    at: now.toISOString(),
    openedAt: p.openedAt,
    harness: p.harness,
    invocation: p.invocation,
    model: p.model,
    effort: p.effort,
    sessionId: p.sessionId,
    durationMs: p.durationMs,
    endReason: p.endReason,
  };
}

/**
 * Ledger row first, then delete: a crash in between leaves a pending whose
 * id already has a lapse row, which folding and record both tolerate.
 */
export function lapsePending(store: Store, id: string, now: Date): boolean {
  return withPendingLock(store, id, () => {
    const p = readPending(store, id);
    if (p === null) return false;
    appendLedger(store, lapseRowFromPending(p, now));
    removePendingFile(store, id);
    return true;
  });
}

/** Lapses pendings older than the stale line; busy ones are left for later. */
export function lapseStalePendings(store: Store, now: Date): number {
  let n = 0;
  for (const p of listPending(store)) {
    const opened = Date.parse(p.openedAt);
    if (!(now.getTime() - opened > STALE_PENDING_DAYS * DAY_MS)) continue;
    try {
      if (lapsePending(store, p.id, now)) n++;
    } catch (e) {
      if (!(e instanceof StoreError && e.code === "busy")) throw e;
    }
  }
  return n;
}

export type ReviewDue = {
  due: boolean;
  /** Distinct delegation rows since the last review row. */
  count: number;
  /** Days since the last review row, or since the first row if none. */
  days: number;
};

/** Null when the ledger has no rows: nothing to review yet. */
export function reviewDue(
  rows: readonly LedgerRow[],
  now: Date,
): ReviewDue | null {
  if (rows.length === 0) return null;
  let lastReview = -1;
  rows.forEach((row, i) => {
    if (row.type === "review") lastReview = i;
  });
  const seen = new Set<string>();
  let count = 0;
  rows.forEach((row, i) => {
    if (row.type === "delegation" && !seen.has(row.id)) {
      seen.add(row.id);
      if (i > lastReview) count++;
    }
  });
  const anchorRow = lastReview >= 0 ? rows[lastReview] : rows[0];
  const anchor = Date.parse(anchorRow?.at ?? "");
  const days = Number.isFinite(anchor)
    ? Math.max(0, (now.getTime() - anchor) / DAY_MS)
    : 0;
  return {
    due: count >= REVIEW_AFTER_RECORDS || days >= REVIEW_AFTER_DAYS,
    count,
    days,
  };
}

export function reviewPromptLine(due: ReviewDue | null): string | null {
  if (due === null || !due.due) return null;
  return `振り返りの時期: 前回の review から ${due.count} 件 / ${Math.floor(due.days)} 日。delegation review を実行`;
}
