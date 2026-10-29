/**
 * Offload entry: the checks that run before opencode is started for a
 * delegation that leaves the machine.
 *
 * This file holds the types, the collection of stored opencode credentials
 * (names only; secret values are never selected or kept) and the comparison
 * of those names with the recorded verification. It is imported by neither
 * capture.ts nor the Mod.
 */

import {
  closeSync,
  constants as fsc,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { allowedAuthProviders } from "./destinations.ts";

export type Env = Record<string, string | undefined>;

/** What `verified.json` holds. Written by the verification script. */
export type VerifiedRecord = {
  v: 1;
  verifiedAt: string;
  realpath: string;
  executableSha256: string;
  targets: { path: string; sha256: string }[];
  version: string;
  configSha256: string;
  /** Names from auth.json and the credential table, sorted, unique. */
  authProviders: string[];
  models: string[];
};

export type RecordState =
  | { kind: "missing" }
  | { kind: "broken"; reason: string }
  | { kind: "version"; v: number }
  | { kind: "ok"; record: VerifiedRecord; rawSha256: string };

export type AuthFileInput =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "ok"; providers: string[] };

export type AuthDbInput =
  | { kind: "missing" }
  | { kind: "unopenable" }
  | { kind: "no-table" }
  | { kind: "ok"; ids: string[] };

export type AuthFileStat = {
  path: string;
  symlink: boolean;
  ownedBySelf: boolean;
  /** Low nine bits of lstat's mode. */
  mode: number;
};

export type AuthDirInput = {
  mode: number | null;
  ownedBySelf: boolean | null;
  symlink: boolean;
};

export type AuthInputs = {
  authFile: AuthFileInput;
  authDb: AuthDbInput;
  authFiles: AuthFileStat[];
  authDir: AuthDirInput;
};

export type OffloadInputs = AuthInputs & {
  /** Realpath of the opencode executable found on PATH; null when absent. */
  realpath: string | null;
  executableSha256: string | null;
  /** Current sha256 of each recorded launcher target, by path. */
  targetSha256: Record<string, string | null>;
  configSha256: string | null;
  /** Paths from the configuration-location list that exist. */
  foundConfigPaths: string[];
  record: RecordState;
};

export type VerifyFailure = {
  ok: false;
  reason: string;
  recovery: string[];
};

const AUTH_DIR_SEGMENTS = [".local", "share", "opencode"];
const AUTH_FILE_MAX_BYTES = 1024 * 1024;
const DB_BUSY_TIMEOUT_MS = 200;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const UNPRINTABLE_NAME = "(表示できない名前)";

/** The recovery line for a missing or mismatching verification record. */
export const VERIFY_RECOVERY =
  "recovery: cd <dotfiles> && node tests/opencode-containment.mjs --model <model> …";

/** True only when lstat and fstat describe the same file. */
export function sameFileIdentity(
  a: { dev: number | bigint; ino: number | bigint },
  b: { dev: number | bigint; ino: number | bigint },
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

function authDirPath(): string {
  return join(homedir(), ...AUTH_DIR_SEGMENTS);
}

function readAuthFile(path: string): AuthFileInput {
  let before;
  try {
    before = lstatSync(path);
  } catch (e) {
    return errnoCode(e) === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable" };
  }
  if (before.isSymbolicLink() || !before.isFile())
    return { kind: "unreadable" };
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch {
    return { kind: "unreadable" };
  }
  try {
    const after = fstatSync(fd);
    if (!sameFileIdentity(before, after) || after.size > AUTH_FILE_MAX_BYTES) {
      return { kind: "unreadable" };
    }
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { kind: "unreadable" };
    }
    // Only the key names leave this function; the values are dropped here.
    return { kind: "ok", providers: Object.keys(parsed).sort() };
  } catch {
    return { kind: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

function readAuthDb(path: string): AuthDbInput {
  let before;
  try {
    before = lstatSync(path);
  } catch (e) {
    return errnoCode(e) === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unopenable" };
  }
  if (before.isSymbolicLink() || !before.isFile())
    return { kind: "unopenable" };
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch {
    return { kind: "unopenable" };
  }
  try {
    if (!sameFileIdentity(before, fstatSync(fd))) return { kind: "unopenable" };
    let db: DatabaseSync | undefined;
    let result: AuthDbInput;
    try {
      // Plain read-only open: rows still in the write-ahead log must be visible.
      db = new DatabaseSync(path, { readOnly: true });
      db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'",
        )
        .all();
      if (tables.length === 0) {
        result = { kind: "no-table" };
      } else {
        // Names only: the secret column is never selected.
        const rows = db
          .prepare("SELECT DISTINCT integration_id FROM credential")
          .all();
        const ids: string[] = [];
        for (const row of rows) {
          const id = row.integration_id;
          if (typeof id !== "string") return { kind: "unopenable" };
          ids.push(id);
        }
        result = { kind: "ok", ids: [...new Set(ids)].sort() };
      }
    } catch {
      return { kind: "unopenable" };
    } finally {
      try {
        db?.close();
      } catch {
        // already closed or never opened
      }
    }
    // SQLite opened the path itself; make sure it is still the file we vetted.
    try {
      if (!sameFileIdentity(before, lstatSync(path))) {
        return { kind: "unopenable" };
      }
    } catch {
      return { kind: "unopenable" };
    }
    return result;
  } finally {
    closeSync(fd);
  }
}

function readAuthDir(dir: string): { input: AuthDirInput; failed: boolean } {
  const none = { mode: null, ownedBySelf: null, symlink: false };
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    return errnoCode(e) === "ENOENT"
      ? { input: none, failed: false }
      : { input: none, failed: true };
  }
  if (st.isSymbolicLink()) {
    return {
      input: { mode: null, ownedBySelf: null, symlink: true },
      failed: false,
    };
  }
  let fd: number;
  try {
    fd = openSync(dir, fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW);
  } catch (e) {
    return errnoCode(e) === "ENOENT"
      ? { input: none, failed: false }
      : { input: none, failed: true };
  }
  try {
    const fst = fstatSync(fd);
    return {
      input: {
        mode: fst.mode & 0o777,
        ownedBySelf: fst.uid === process.getuid?.(),
        symlink: false,
      },
      failed: false,
    };
  } finally {
    closeSync(fd);
  }
}

function statAuthFile(path: string): AuthFileStat | null {
  try {
    const st = lstatSync(path);
    return {
      path,
      symlink: st.isSymbolicLink(),
      ownedBySelf: st.uid === process.getuid?.(),
      mode: st.mode & 0o777,
    };
  } catch {
    return null;
  }
}

/**
 * Collect the stored-credential inputs: names from auth.json and from the
 * credential table, plus the modes and owners that the comparison checks.
 * The location is fixed under the home directory; opencode started by the
 * entry gets no XDG variables, so it reads the same place.
 */
export function collectAuthInputs(_env: Env): AuthInputs {
  const dir = authDirPath();
  const authPath = join(dir, "auth.json");
  const dbPath = join(dir, "opencode.db");
  const { input: authDir, failed } = readAuthDir(dir);
  const authFiles: AuthFileStat[] = [];
  for (const path of [
    authPath,
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    `${dbPath}-journal`,
  ]) {
    const st = statAuthFile(path);
    if (st !== null) authFiles.push(st);
  }
  if (failed) {
    return {
      authFile: { kind: "unreadable" },
      authDb: { kind: "unopenable" },
      authFiles,
      authDir,
    };
  }
  return {
    authFile: readAuthFile(authPath),
    authDb: readAuthDb(dbPath),
    authFiles,
    authDir,
  };
}

function displayName(name: string): string {
  return SAFE_NAME.test(name) ? name : UNPRINTABLE_NAME;
}

const KEY_REISSUE_NOTE =
  "緩いモードの間に鍵が他の利用者に読めた可能性がある。必要なら鍵を発行し直す";

/**
 * Compare the stored credentials with the record's `authProviders`.
 * Returns ok only when the files are private, the directory is not writable
 * by others, and the name set equals the record and lies inside the
 * allowed providers.
 */
export function verifyAuthProviders(
  inputs: AuthInputs,
  record: Pick<VerifiedRecord, "authProviders">,
): { ok: true } | VerifyFailure {
  const { authFiles, authDir, authFile, authDb } = inputs;

  const modeRecovery: string[] = [];
  const modeReasons: string[] = [];
  for (const f of authFiles) {
    if (f.symlink) {
      modeReasons.push(`${f.path} は symlink（chmod では直らない）`);
    } else if (!f.ownedBySelf) {
      modeReasons.push(`${f.path} の所有者が自分でない（chmod では直らない）`);
    } else if ((f.mode & 0o077) !== 0) {
      modeReasons.push(`${f.path} のモードが 0600 より緩い`);
      modeRecovery.push(`recovery: chmod 600 ${f.path}`);
    }
  }
  if (modeReasons.length > 0) {
    const looseMode = modeRecovery.length > 0;
    return {
      ok: false,
      reason: `保存済み認証のファイルを信頼できない: ${modeReasons.join(" / ")}`,
      recovery: looseMode ? [...modeRecovery, KEY_REISSUE_NOTE] : [],
    };
  }

  if (authDir.symlink) {
    return {
      ok: false,
      reason: "認証の置き場の dir が symlink",
      recovery: [],
    };
  }
  if (authDir.ownedBySelf === false) {
    return {
      ok: false,
      reason: "認証の置き場の dir の所有者が自分でない。dir の所有者を確かめる",
      recovery: [],
    };
  }
  if (authDir.mode !== null && (authDir.mode & 0o022) !== 0) {
    const dir = authDirPath();
    return {
      ok: false,
      reason: "認証の置き場の dir に group か other が書ける",
      recovery: [`recovery: chmod go-w ${dir}`],
    };
  }

  if (authFile.kind === "unreadable") {
    return { ok: false, reason: "auth.json unreadable", recovery: [] };
  }
  const reopen = "recovery: opencode を一度起動して DB を作り直すか確かめる";
  if (authDb.kind === "unopenable") {
    return {
      ok: false,
      reason: "opencode.db を開けない",
      recovery: [reopen],
    };
  }
  if (authDb.kind === "no-table") {
    return {
      ok: false,
      reason: "opencode.db に credential テーブルが無い",
      recovery: [reopen],
    };
  }

  const present = new Set<string>();
  if (authFile.kind === "ok")
    for (const p of authFile.providers) present.add(p);
  if (authDb.kind === "ok") for (const id of authDb.ids) present.add(id);
  const now = [...present].sort();

  const allowed = new Set(allowedAuthProviders());
  const outside = now.filter((name) => !allowed.has(name));
  if (outside.length > 0) {
    const recovery: string[] = [];
    for (const name of outside) {
      if (SAFE_NAME.test(name))
        recovery.push(`recovery: opencode auth logout ${name}`);
    }
    recovery.push(VERIFY_RECOVERY);
    return {
      ok: false,
      reason: `許可されない provider の認証が保存されている: ${outside
        .map(displayName)
        .join(", ")}`,
      recovery,
    };
  }

  const recorded = record.authProviders;
  const same =
    recorded.length === now.length && recorded.every((p, i) => p === now[i]);
  if (!same) {
    return {
      ok: false,
      reason: "保存済みの認証が記録の authProviders と違う",
      recovery: [VERIFY_RECOVERY],
    };
  }
  return { ok: true };
}
