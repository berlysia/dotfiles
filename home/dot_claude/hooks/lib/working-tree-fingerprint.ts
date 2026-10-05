import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Working-tree fingerprint used by completion-gate to tell whether a turn
 * changed any files. The invariant it protects is "if files changed, checks
 * ran", so every failure path yields null / "unknown" and the caller runs the
 * checks (current behaviour) instead of skipping them.
 */

const DEFAULT_DEADLINE_MS = 2000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export type TreeChangeState = "unchanged" | "changed" | "unknown";

export interface TreeChangeResult {
  state: TreeChangeState;
  reason: string;
}

function runGit(args: string[], cwd: string, deadline: number): Buffer | null {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return null;
  try {
    return execFileSync("git", args, {
      cwd,
      // execFile rejects fractional timeouts.
      timeout: Math.max(1, Math.floor(remaining)),
      maxBuffer: GIT_MAX_BUFFER,
      // Avoid index.lock contention with the user's own git commands.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Hex SHA-256 of an untracked file's content, or null if it must not be trusted. */
function hashRegularFile(
  path: string,
  deadline: number,
  budget: { remainingBytes: number },
): string | null {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    // lstat happened before open; re-check the opened object so a swap to a
    // FIFO or device between the two cannot block the read.
    if (!fstatSync(fd).isFile()) return null;
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let fileBytes = 0;
    for (;;) {
      if (performance.now() > deadline) return null;
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      fileBytes += n;
      budget.remainingBytes -= n;
      if (fileBytes > MAX_UNTRACKED_FILE_BYTES || budget.remainingBytes < 0) {
        return null;
      }
      hash.update(chunk.subarray(0, n));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function hashUntrackedEntries(
  toplevel: string,
  names: string[],
  deadline: number,
  outer: ReturnType<typeof createHash>,
): boolean {
  const budget = { remainingBytes: MAX_UNTRACKED_TOTAL_BYTES };
  for (const name of names) {
    if (performance.now() > deadline) return false;
    const path = join(toplevel, name);
    const stat = lstatSync(path);
    let kind: "f" | "l";
    let digest: string | null;
    if (stat.isSymbolicLink()) {
      kind = "l";
      digest = createHash("sha256").update(readlinkSync(path)).digest("hex");
    } else if (stat.isFile()) {
      if (stat.size > MAX_UNTRACKED_FILE_BYTES) return false;
      if (stat.size > budget.remainingBytes) return false;
      kind = "f";
      digest = hashRegularFile(path, deadline, budget);
    } else {
      // Nested untracked repositories (directories), FIFOs, sockets, ...
      return false;
    }
    if (digest === null) return false;
    outer.update(
      `${kind}\0${name}\0${(stat.mode & 0o7777).toString(8)}\0${digest}\n`,
    );
  }
  return true;
}

/**
 * SHA-256 over HEAD, the tracked diff and the untracked files' content.
 * Returns null when the tree cannot be fingerprinted reliably.
 */
export function computeTreeFingerprint(
  cwd: string,
  deadlineMs: number = DEFAULT_DEADLINE_MS,
): string | null {
  const deadline = performance.now() + deadlineMs;
  try {
    const toplevelOut = runGit(["rev-parse", "--show-toplevel"], cwd, deadline);
    if (toplevelOut === null) return null;
    const toplevel = toplevelOut.toString("utf-8").replace(/\r?\n$/, "");
    if (toplevel === "") return null;

    const head = runGit(["rev-parse", "HEAD"], toplevel, deadline);
    if (head === null) return null;
    const diff = runGit(
      [
        "diff",
        "HEAD",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--ignore-submodules=none",
      ],
      toplevel,
      deadline,
    );
    if (diff === null) return null;
    const untrackedOut = runGit(
      ["ls-files", "-o", "--exclude-standard", "-z"],
      toplevel,
      deadline,
    );
    if (untrackedOut === null) return null;

    const outer = createHash("sha256");
    outer.update(toplevel).update("\0");
    outer.update(head).update("\0");
    outer.update(diff).update("\0");
    outer.update(untrackedOut).update("\0");

    const names = untrackedOut
      .toString("utf-8")
      .split("\0")
      .filter((name) => name !== "");
    if (!hashUntrackedEntries(toplevel, names, deadline, outer)) return null;
    return outer.digest("hex");
  } catch {
    return null;
  }
}

function getBaselinePath(stateDir: string, sessionId: string): string | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  return join(stateDir, `${sessionId}.txt`);
}

/**
 * Stores the fingerprint for later comparison. Always drops the previous
 * baseline first so a failed write (or a null fingerprint) can never leave a
 * stale baseline that would cause a false "unchanged".
 */
export function saveBaseline(
  stateDir: string,
  sessionId: string,
  fingerprint: string | null,
): void {
  const path = getBaselinePath(stateDir, sessionId);
  if (path === null) return;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch {
    // fall through: the unlink/write below fail closed on their own
  }
  try {
    unlinkSync(path);
  } catch {
    // ENOENT is the normal case; other errors leave the old baseline, which
    // the caller's plan accepts (see plan K2).
  }
  if (fingerprint === null) return;

  const tmpPath = join(
    stateDir,
    `${sessionId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmpPath, fingerprint, { flag: "wx", mode: 0o600 });
    // rename replaces a symlink at `path` instead of writing through it.
    renameSync(tmpPath, path);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // nothing to clean up
    }
  }
}

export function pruneStaleBaselines(stateDir: string, maxAgeMs: number): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of readdirSync(stateDir)) {
      const path = join(stateDir, entry);
      try {
        if (lstatSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        // skip entries we cannot stat or remove
      }
    }
  } catch {
    // missing stateDir: nothing to prune
  }
}

/** "unchanged" only when both fingerprints exist and match; anything else runs the checks. */
export function checkTreeChange(
  stateDir: string,
  sessionId: string,
  cwd: string,
  deadlineMs: number = DEFAULT_DEADLINE_MS,
): TreeChangeResult {
  const path = getBaselinePath(stateDir, sessionId);
  if (path === null) {
    return { state: "unknown", reason: "invalid session id" };
  }
  let baseline: string;
  try {
    baseline = readFileSync(path, "utf-8").trim();
  } catch {
    return { state: "unknown", reason: "no baseline" };
  }
  if (!FINGERPRINT_PATTERN.test(baseline)) {
    return { state: "unknown", reason: "malformed baseline" };
  }
  const current = computeTreeFingerprint(cwd, deadlineMs);
  if (current === null) {
    return { state: "unknown", reason: "fingerprint unavailable" };
  }
  return current === baseline
    ? { state: "unchanged", reason: "fingerprint matches baseline" }
    : { state: "changed", reason: "fingerprint differs from baseline" };
}
