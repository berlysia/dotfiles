/**
 * Offload entry: the checks that run before opencode is started for a
 * delegation that leaves the machine.
 *
 * This file holds the types, the collection of stored opencode credentials
 * (names only; secret values are never selected or kept) and the comparison
 * of those names with the recorded verification. It is imported by neither
 * capture.ts nor the Mod.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsc,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OFFLOAD_DIR_NAME, isExposure, offloadAgentName } from "./constants.ts";
import { allowedAuthProviders, sendsOutModels } from "./destinations.ts";
import { resolveDataDir } from "./store.ts";

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

// ---- arguments ------------------------------------------------------------

export type OffloadArgs = {
  model: string;
  briefFile: string;
  dir: string;
  plan: string | null;
  write: boolean;
};

export type ArgsResult =
  | { ok: true; args: OffloadArgs; model: string }
  | { ok: false; reason: string; model: string | null };

const DIR_MAX_BYTES = 1024;
const PROXY_VARS = [
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
] as const;
const VALUE_FLAGS = new Set([
  "--exposure",
  "--model",
  "--brief-file",
  "--dir",
  "--plan",
]);

/** A proxy value is passed on only as a plain http(s) URL without userinfo. */
export function proxyValueProblem(value: string): string | null {
  if (!/^https?:\/\//.test(value)) return "http:// か https:// で始まらない";
  const authority =
    value.replace(/^https?:\/\//, "").split(/[/?#]/, 1)[0] ?? "";
  if (authority.includes("@")) return "認証情報を含む";
  return null;
}

/**
 * Validate the argv after `offload`. `--model` is counted here (not by the
 * generic parser, where the last value wins), so a repeated `--model` cannot
 * smuggle a second value past the first check.
 */
export function parseOffloadArgs(
  argv: readonly string[],
  ctx: { cwd: string; env: Env },
): ArgsResult {
  const seen = new Map<string, string>();
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--write") {
      write = true;
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        return { ok: false, reason: `${a} に値が無い`, model: null };
      }
      if (seen.has(a)) {
        return { ok: false, reason: `${a} が複数回指定された`, model: null };
      }
      seen.set(a, v);
      i++;
    } else {
      return {
        ok: false,
        reason: `知らない引数: ${displayArg(a)}`,
        model: null,
      };
    }
  }
  const model = seen.get("--model") ?? null;
  const fail = (reason: string): ArgsResult => ({ ok: false, reason, model });

  const exposure = seen.get("--exposure");
  if (exposure === undefined || !isExposure(exposure)) {
    return fail("--exposure external-ok が要る");
  }
  if (exposure !== "external-ok") return fail("--exposure closed では送れない");
  if (model === null) return fail("--model が要る");
  if (!sendsOutModels().includes(model)) {
    return fail("--model は外へ送る委譲先の model のどれかと一致しない");
  }
  const briefFile = seen.get("--brief-file");
  if (briefFile === undefined || !isAbsolute(briefFile)) {
    return fail("--brief-file は絶対パスで指定する");
  }
  const dir = seen.get("--dir") ?? ctx.cwd;
  if (!isAbsolute(dir)) return fail("--dir は絶対パスで指定する");
  if (Buffer.byteLength(dir) > DIR_MAX_BYTES) {
    return fail(`--dir が ${DIR_MAX_BYTES} バイトを超える`);
  }
  const plan = seen.get("--plan") ?? null;
  if (plan !== null && !isAbsolute(plan)) {
    return fail("--plan は絶対パスで指定する");
  }
  for (const name of PROXY_VARS) {
    const value = ctx.env[name];
    if (value === undefined || value === "") continue;
    const problem = proxyValueProblem(value);
    if (problem !== null) return fail(`${name} の値が使えない（${problem}）`);
  }
  return { ok: true, args: { model, briefFile, dir, plan, write }, model };
}

function displayArg(a: string): string {
  return a.length <= 40 && SAFE_NAME.test(a.replace(/^-+/, ""))
    ? a
    : "(表示できない引数)";
}

// ---- brief and plan files -------------------------------------------------

export const BRIEF_MAX_BYTES = 100 * 1024;
export const PLAN_MAX_BYTES = 1024 * 1024;

const SECRET_SHAPES: { name: string; pattern: RegExp }[] = [
  { name: "秘密鍵の形", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS のアクセスキーの形", pattern: /AKIA[0-9A-Z]{16}/ },
  {
    name: "トークンの形",
    pattern: /(?:ghp_|github_pat_|sk-ant-|xoxb-|xoxp-)[A-Za-z0-9]{20,}/,
  },
];
// (a) any "@" before ._/~- ; (b) an "@" before an alphanumeric that does not
// follow an e-mail-looking character (or starts the text).
const ATTACHMENT_AT = /@(?=[._/~-])|(?<![A-Za-z0-9._%+-])@(?=[A-Za-z0-9])/;
const EXCERPT_RADIUS = 8;

/** Quote an excerpt so control characters and escape sequences stay inert. */
export function quoteExcerpt(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\u009f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export type BriefCheck =
  | { ok: true }
  | { ok: false; reason: string; excerpt?: string };

/** Content checks on a brief that has already been read from one fd. */
export function checkBriefBytes(bytes: Uint8Array): BriefCheck {
  if (bytes.length < 1) return { ok: false, reason: "brief が空" };
  if (bytes.length > BRIEF_MAX_BYTES) {
    return { ok: false, reason: `brief が ${BRIEF_MAX_BYTES} バイトを超える` };
  }
  if (bytes.includes(0))
    return { ok: false, reason: "brief に NUL が含まれる" };
  if (bytes[0] === 0x2d) return { ok: false, reason: "brief の先頭が -" };
  const text = Buffer.from(bytes).toString("utf8");
  for (const shape of SECRET_SHAPES) {
    if (shape.pattern.test(text)) {
      return {
        ok: false,
        reason: `brief に秘密に見えるもの（${shape.name}）が含まれる`,
      };
    }
  }
  const at = ATTACHMENT_AT.exec(text);
  if (at !== null) {
    const start = Math.max(0, at.index - EXCERPT_RADIUS);
    return {
      ok: false,
      reason: "brief に添付に見える @ が含まれる",
      excerpt: quoteExcerpt(text.slice(start, at.index + 1 + EXCERPT_RADIUS)),
    };
  }
  return { ok: true };
}

export type ReadFileResult =
  | { ok: true; bytes: Buffer; sha256: string }
  | { ok: false; reason: string };

/**
 * Open once with O_NOFOLLOW (and O_NONBLOCK so a FIFO cannot hang the open),
 * check the fd, and read from that same fd.
 */
function readRegularFile(
  path: string,
  label: string,
  limits: { min: number; max: number; ownedBySelf: boolean },
): ReadFileResult {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (e) {
    return {
      ok: false,
      reason:
        errnoCode(e) === "ELOOP"
          ? `${label} が symlink`
          : `${label} を開けない`,
    };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile())
      return { ok: false, reason: `${label} が通常ファイルでない` };
    if (limits.ownedBySelf && st.uid !== process.getuid?.()) {
      return { ok: false, reason: `${label} の所有者が自分でない` };
    }
    if (st.size < limits.min || st.size > limits.max) {
      return { ok: false, reason: `${label} の大きさが範囲外` };
    }
    const bytes = readFileSync(fd);
    return {
      ok: true,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return { ok: false, reason: `${label} を読めない` };
  } finally {
    closeSync(fd);
  }
}

export type BriefLoad =
  | { ok: true; bytes: Buffer; text: string; sha256: string }
  | { ok: false; reason: string; excerpt?: string; sha256?: string };

/** Read the brief file once and run the content checks on those bytes. */
export function loadBrief(path: string): BriefLoad {
  const read = readRegularFile(path, "brief", {
    min: 1,
    max: BRIEF_MAX_BYTES,
    ownedBySelf: true,
  });
  if (!read.ok) return read;
  const check = checkBriefBytes(read.bytes);
  if (!check.ok) return { ...check, sha256: read.sha256 };
  return {
    ok: true,
    bytes: read.bytes,
    text: read.bytes.toString("utf8"),
    sha256: read.sha256,
  };
}

/** sha256 of the plan file (regular file, 1 MiB at most). */
export function hashPlanFile(
  path: string,
): { ok: true; sha256: string } | { ok: false; reason: string } {
  const read = readRegularFile(path, "plan", {
    min: 0,
    max: PLAN_MAX_BYTES,
    ownedBySelf: false,
  });
  return read.ok ? { ok: true, sha256: read.sha256 } : read;
}

// ---- launch directory -----------------------------------------------------

/** Read-deny patterns of the offload agents (mirrored in opencode.jsonc). */
export const READ_DENY: readonly string[] = [
  ".git",
  "**/.git",
  "**/.git/**",
  "**/.tmp/**",
  "**/node_modules/**",
  "**/.env",
  "**/.env.*",
  "**/*.env",
  "**/.envrc",
  "**/.dev.vars",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.git-credentials",
  "**/credentials*",
  "**/service-account*.json",
  "**/*.tfvars",
  "**/*.tfstate",
  "**/secrets/**",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.kube/**",
  "**/.gnupg/**",
  "**/.docker/config.json",
  "**/.mcp.json",
  "**/.claude/**",
  "**/.codex/**",
];

/** Patterns denied for edit and write on top of READ_DENY. */
export const EDIT_DENY_EXTRA: readonly string[] = [
  "opencode.json",
  "opencode.jsonc",
  ".opencode/**",
  "AGENTS.md",
  "CLAUDE.md",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "mise.toml",
  ".mise.toml",
  ".husky/**",
  ".github/**",
  ".vscode/**",
  ".devcontainer/**",
  "lefthook.yml",
  ".lefthook.yml",
  ".pre-commit-config.yaml",
  ".gitmodules",
  ".gitattributes",
  ".pnpmfile.cjs",
  "bunfig.toml",
  ".yarnrc*",
  "pnpm-workspace.yaml",
  "mise.local.toml",
  ".mise.local.toml",
  ".mise/**",
  ".tool-versions",
  ".githooks/**",
  "package.json",
  "**/package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "vitest.config.*",
  "vite.config.*",
  "jest.config.*",
  "playwright.config.*",
  "Makefile",
  "justfile",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "conftest.py",
  "**/conftest.py",
  "tox.ini",
  "pytest.ini",
  "noxfile.py",
  "Cargo.toml",
  "build.rs",
  ".cargo/**",
  "Gemfile",
  "Rakefile",
  "composer.json",
  "Dockerfile",
  "docker-compose*.yml",
  ".mocharc*",
  ".eslintrc*",
  "eslint.config.*",
  "tsdown.config.*",
  "rollup.config.*",
  "webpack.config.*",
];

export const EDIT_DENY: readonly string[] = [...READ_DENY, ...EDIT_DENY_EXTRA];

/** Compile an opencode-style glob (`**`, `*`) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

const READ_DENY_RES = READ_DENY.map(globToRegExp);
const EDIT_DENY_RES = EDIT_DENY.map(globToRegExp);

/** True when the path (or something beneath it, if a directory) is denied. */
export function matchesDeny(relPath: string, kind: "read" | "edit"): boolean {
  const res = kind === "read" ? READ_DENY_RES : EDIT_DENY_RES;
  return res.some((re) => re.test(relPath) || re.test(`${relPath}/x`));
}

const SKIPPED_ENTRIES = new Set([".git", "node_modules", ".tmp"]);
const SCAN_BUDGET_MS = 2000;
const PROJECT_CONFIG_NAMES = ["opencode.json", "opencode.jsonc", ".opencode"];
const CHEZMOI_REL = join(".local", "share", "chezmoi");

export type DirCheck =
  | { ok: true; realpath: string }
  | { ok: false; reason: string };

function within(parent: string, child: string): boolean {
  return (
    child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`)
  );
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check the directory opencode will start in: a git toplevel, not the home
 * directory or its ancestors, no hidden home subdirectory (except this
 * repo), no opencode project config in it or any ancestor, and no symlink
 * that leaves the tree or lands on a denied path.
 */
export function checkLaunchDir(opts: {
  dir: string;
  write: boolean;
  home?: string;
  budgetMs?: number;
}): DirCheck {
  const budgetMs = opts.budgetMs ?? SCAN_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  let dir: string;
  try {
    dir = realpathSync(opts.dir);
  } catch {
    return { ok: false, reason: "起動ディレクトリを解決できない" };
  }
  let home: string;
  try {
    home = realpathSync(opts.home ?? homedir());
  } catch {
    return { ok: false, reason: "home を解決できない" };
  }

  const gitEnv: Env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_")) gitEnv[k] = v;
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    env: gitEnv as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 5000,
  });
  if (top.status !== 0) {
    return {
      ok: false,
      reason: "git の作業ツリーでない（git rev-parse に失敗）",
    };
  }
  let toplevel: string;
  try {
    toplevel = realpathSync(top.stdout.trim());
  } catch {
    return { ok: false, reason: "git の toplevel を解決できない" };
  }
  if (toplevel !== dir) {
    return { ok: false, reason: "起動ディレクトリが git の toplevel でない" };
  }

  if (within(dir, home)) {
    return { ok: false, reason: "起動ディレクトリが home かその祖先" };
  }
  if (within(home, dir)) {
    const rel = relative(home, dir);
    const hidden = rel.split("/").some((s) => s.startsWith("."));
    if (hidden && !(rel === CHEZMOI_REL || rel.startsWith(`${CHEZMOI_REL}/`))) {
      return { ok: false, reason: "home の下の . で始まる dir は送らない" };
    }
  }

  for (let cur = dir; ;) {
    for (const name of PROJECT_CONFIG_NAMES) {
      if (exists(join(cur, name))) {
        return {
          ok: false,
          reason: `opencode の project 設定がある: ${join(cur, name)}`,
        };
      }
    }
    const parent = join(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }

  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(join(dir, relDir), { withFileTypes: true });
    } catch {
      return { ok: false, reason: `読めない dir がある: ${relDir || "."}` };
    }
    for (const entry of entries) {
      if (Date.now() >= deadline) {
        return { ok: false, reason: "走査が時間切れ" };
      }
      if (SKIPPED_ENTRIES.has(entry.name)) continue;
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(join(dir, rel));
        } catch {
          return { ok: false, reason: `壊れた symlink か循環: ${rel}` };
        }
        if (!within(dir, target) || target === dir) {
          return { ok: false, reason: `作業ツリーの外を指す symlink: ${rel}` };
        }
        const targetRel = relative(dir, target);
        if (matchesDeny(targetRel, "read")) {
          return {
            ok: false,
            reason: `読み取り不可のパスを指す symlink: ${rel}`,
          };
        }
        if (
          opts.write &&
          (matchesDeny(targetRel, "edit") || matchesDeny(rel, "edit"))
        ) {
          return {
            ok: false,
            reason: `書き込み不可のパスを指す symlink: ${rel}`,
          };
        }
      } else if (entry.isDirectory()) {
        stack.push(rel);
      }
    }
  }
  return { ok: true, realpath: dir };
}

// ---- child process: env, argv, log ----------------------------------------

const ENV_PASS = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "TMPDIR",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);

/** The allowlisted environment for opencode. */
export function buildChildEnv(parent: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (ENV_PASS.has(k) || k.startsWith("LC_")) out[k] = v;
  }
  out.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  return out;
}

/** argv for opencode: the brief is always the last, single element. */
export function buildOpencodeArgv(opts: {
  model: string;
  write: boolean;
  brief: string;
}): string[] {
  return [
    "run",
    "--standalone",
    "--agent",
    offloadAgentName(opts.write),
    "-m",
    opts.model,
    "--auto",
    opts.brief,
  ];
}

export type OffloadResult =
  | "spawned"
  | "args"
  | "brief"
  | "resolve"
  | "verify"
  | "dir"
  | "version";

export type LogFields = {
  at: string;
  result: OffloadResult;
  model: string | null;
  agent: string | null;
  dir: string | null;
  briefSha256: string | null;
  planSha256: string | null;
};

export const LOG_LINE_MAX_BYTES = 4096;

/** One offload.log line; the brief text is never part of it. */
export function buildLogLine(fields: LogFields): string {
  const make = (f: LogFields) => `${JSON.stringify({ v: 1, ...f })}\n`;
  let line = make(fields);
  // JSON escaping can widen a long --dir; drop it rather than split the line.
  if (Buffer.byteLength(line) > LOG_LINE_MAX_BYTES) {
    line = make({ ...fields, dir: null });
  }
  return line;
}

// ---- record, executable and configuration ---------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const RECORD_MAX_BYTES = 1024 * 1024;
const CONFIG_FILES = ["opencode.json", "config.json", "config.jsonc"];
const CONFIG_DIRS = [
  "plugin",
  "plugins",
  "tool",
  "tools",
  "agent",
  "agents",
  "command",
  "commands",
  "mode",
  "modes",
  "skill",
  "skills",
];

export function offloadDirPath(env: Env): string {
  return join(resolveDataDir(env), OFFLOAD_DIR_NAME);
}

export function offloadRecordPath(env: Env): string {
  return join(offloadDirPath(env), "verified.json");
}

export function offloadLogPath(env: Env): string {
  return join(offloadDirPath(env), "offload.log");
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Parse verified.json bytes; a broken record is reported, never repaired. */
export function parseVerifiedRecord(bytes: Buffer): RecordState {
  const rawSha256 = createHash("sha256").update(bytes).digest("hex");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { kind: "broken", reason: "JSON として読めない" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "broken", reason: "オブジェクトでない" };
  }
  const o = value as Record<string, unknown>;
  if (typeof o.v !== "number")
    return { kind: "broken", reason: "v が数でない" };
  if (o.v !== 1) return { kind: "version", v: o.v };
  const broken = (field: string): RecordState => ({
    kind: "broken",
    reason: `${field} が欠けているか型が違う`,
  });
  if (
    typeof o.verifiedAt !== "string" ||
    Number.isNaN(Date.parse(o.verifiedAt))
  ) {
    return broken("verifiedAt");
  }
  if (typeof o.realpath !== "string" || !isAbsolute(o.realpath)) {
    return broken("realpath");
  }
  if (
    typeof o.executableSha256 !== "string" ||
    !HEX64.test(o.executableSha256)
  ) {
    return broken("executableSha256");
  }
  if (!Array.isArray(o.targets)) return broken("targets");
  const targets: { path: string; sha256: string }[] = [];
  for (const t of o.targets as unknown[]) {
    const tt = t as Record<string, unknown> | null;
    if (
      typeof tt !== "object" ||
      tt === null ||
      typeof tt.path !== "string" ||
      !isAbsolute(tt.path) ||
      typeof tt.sha256 !== "string" ||
      !HEX64.test(tt.sha256)
    ) {
      return broken("targets");
    }
    targets.push({ path: tt.path, sha256: tt.sha256 });
  }
  if (typeof o.version !== "string" || o.version.trim() === "") {
    return broken("version");
  }
  if (typeof o.configSha256 !== "string" || !HEX64.test(o.configSha256)) {
    return broken("configSha256");
  }
  if (!isStringArray(o.authProviders)) return broken("authProviders");
  const providers = o.authProviders;
  for (let i = 1; i < providers.length; i++) {
    if ((providers[i - 1] as string) >= (providers[i] as string)) {
      return {
        kind: "broken",
        reason: "authProviders が昇順でないか重複している",
      };
    }
  }
  if (!isStringArray(o.models) || o.models.length === 0)
    return broken("models");
  return {
    kind: "ok",
    rawSha256,
    record: {
      v: 1,
      verifiedAt: o.verifiedAt,
      realpath: o.realpath,
      executableSha256: o.executableSha256,
      targets,
      version: o.version,
      configSha256: o.configSha256,
      authProviders: providers,
      models: o.models,
    },
  };
}

function readRecordState(env: Env): RecordState {
  const dir = offloadDirPath(env);
  try {
    const dst = lstatSync(dir);
    if (dst.isSymbolicLink() || !dst.isDirectory()) {
      return { kind: "broken", reason: "記録の dir が通常の dir でない" };
    }
  } catch (e) {
    return errnoCode(e) === "ENOENT"
      ? { kind: "missing" }
      : { kind: "broken", reason: "記録の dir を調べられない" };
  }
  let fd: number;
  try {
    fd = openSync(
      offloadRecordPath(env),
      fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK,
    );
  } catch (e) {
    return errnoCode(e) === "ENOENT"
      ? { kind: "missing" }
      : { kind: "broken", reason: "記録を開けない" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > RECORD_MAX_BYTES) {
      return { kind: "broken", reason: "記録が通常ファイルでないか大きすぎる" };
    }
    return parseVerifiedRecord(readFileSync(fd));
  } catch {
    return { kind: "broken", reason: "記録を読めない" };
  } finally {
    closeSync(fd);
  }
}

/** sha256 of a file's content, read in chunks; null when unreadable. */
export function sha256File(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 16);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Realpath of the first executable regular `opencode` on PATH, or null. */
export function findOpencode(env: Env): string | null {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, "opencode");
    try {
      accessSync(candidate, fsc.X_OK);
      const real = realpathSync(candidate);
      if (statSync(real).isFile()) return real;
    } catch {
      // try the next PATH entry
    }
  }
  return null;
}

function foundConfigPaths(): string[] {
  const home = homedir();
  const base = join(home, ".config", "opencode");
  const found: string[] = [];
  for (const name of [...CONFIG_FILES, ...CONFIG_DIRS]) {
    const p = join(base, name);
    if (exists(p)) found.push(p);
  }
  const legacy = join(home, ".opencode");
  if (exists(legacy)) found.push(legacy);
  return found;
}

/** Gather everything verifyOffload compares. Starts nothing. */
export function collectOffloadInputs(env: Env): OffloadInputs {
  const realpath = findOpencode(env);
  const record = readRecordState(env);
  const targetSha256: Record<string, string | null> = {};
  if (record.kind === "ok") {
    for (const t of record.record.targets)
      targetSha256[t.path] = sha256File(t.path);
  }
  return {
    realpath,
    executableSha256: realpath === null ? null : sha256File(realpath),
    targetSha256,
    configSha256: sha256File(
      join(homedir(), ".config", "opencode", "opencode.jsonc"),
    ),
    foundConfigPaths: foundConfigPaths(),
    record,
    ...collectAuthInputs(env),
  };
}

export type VerifyResult =
  | { ok: true; models: string[] }
  | {
      ok: false;
      check: "resolve" | "verify";
      reason: string;
      recovery: string[];
    };

/**
 * Compare the inputs with the verification record. A missing opencode is
 * reported as `resolve` before the record is looked at. Throws if the
 * destination tables are malformed (an implementation error, not a verdict).
 */
export function verifyOffload(inputs: OffloadInputs): VerifyResult {
  if (inputs.realpath === null) {
    return {
      ok: false,
      check: "resolve",
      reason: "PATH に opencode が無い",
      recovery: [],
    };
  }
  const refuse = (
    reason: string,
    recovery: string[] = [VERIFY_RECOVERY],
  ): VerifyResult => ({
    ok: false,
    check: "verify",
    reason,
    recovery,
  });
  const state = inputs.record;
  if (state.kind === "missing") return refuse("確認済みの記録が無い");
  if (state.kind === "broken") return refuse(`壊れた記録: ${state.reason}`);
  if (state.kind === "version") {
    return refuse(`形式の版が違う記録（v=${state.v}）`);
  }
  const record = state.record;
  if (record.realpath !== inputs.realpath) {
    return refuse("opencode の realpath が記録と違う");
  }
  if (record.executableSha256 !== inputs.executableSha256) {
    return refuse("opencode の実行ファイルが記録と違う");
  }
  for (const t of record.targets) {
    if (inputs.targetSha256[t.path] !== t.sha256) {
      return refuse(`launcher の実体が記録と違う: ${t.path}`);
    }
  }
  if (record.configSha256 !== inputs.configSha256) {
    return refuse("opencode.jsonc が記録と違う");
  }
  if (inputs.foundConfigPaths.length > 0) {
    return refuse(
      `記録に無い opencode の設定がある: ${inputs.foundConfigPaths.join(", ")}`,
    );
  }
  const auth = verifyAuthProviders(inputs, record);
  if (!auth.ok) return refuse(auth.reason, auth.recovery);
  return { ok: true, models: [...record.models] };
}

/** Build the record the verification script writes (target hashes given). */
export function buildVerifiedRecord(opts: {
  inputs: OffloadInputs;
  version: string;
  models: string[];
  targets: { path: string; sha256: string }[];
  now: Date;
}): VerifiedRecord {
  const { inputs } = opts;
  if (
    inputs.realpath === null ||
    inputs.executableSha256 === null ||
    inputs.configSha256 === null
  ) {
    throw new Error("cannot build a record: opencode or its config is missing");
  }
  const names = new Set<string>();
  if (inputs.authFile.kind === "ok")
    for (const p of inputs.authFile.providers) names.add(p);
  if (inputs.authDb.kind === "ok")
    for (const id of inputs.authDb.ids) names.add(id);
  return {
    v: 1,
    verifiedAt: opts.now.toISOString(),
    realpath: inputs.realpath,
    executableSha256: inputs.executableSha256,
    targets: opts.targets.map((t) => ({ path: t.path, sha256: t.sha256 })),
    version: opts.version.trim(),
    configSha256: inputs.configSha256,
    authProviders: [...names].sort(),
    models: [...opts.models],
  };
}
