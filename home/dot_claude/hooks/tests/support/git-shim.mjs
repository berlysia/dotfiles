// A `git` stand-in that makes a unit test file fail when it starts git.
// preload-test-env.mjs installs it when CLAUDE_TEST_FORBID_GIT is exactly "1"
// (only the `test` script sets that) and checks it when the process exits.
//
// This notices a git start; it is not a guarantee. It does not cover an
// absolute path to git, a PATH that was replaced or narrowed, or a run that
// bypasses `bun run test` (home/dot_claude/hooks/tests/README_TESTING.md).
//
// The shim never looks for or runs the real git. A hook that falls back when
// git is missing would otherwise pass while still having started git, so the
// record, not the child's exit status, is what fails the file.
//
// It lives in a .mjs because the preload is a .mjs and repo-level mjs tests go
// through the same preload.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RECORD_NAME = "git-calls.log";
export const SHIM_MESSAGE =
  "unit のテストは git を起動しない。heavy/ に置く（home/dot_claude/hooks/tests/README_TESTING.md）";

const shQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

function shimScript(recordPath, testFile) {
  // One printf appends one line with a single write, so concurrent callers do
  // not interleave. A failed append is reported, not hidden.
  return `#!/bin/sh
args=''
for a in "$@"; do args="$args $a"; done
printf 'git%s (cwd=%s, test=%s)\\n' "$args" "$PWD" ${shQuote(testFile)} >> ${shQuote(recordPath)} || printf 'git-shim: could not append to the record\\n' >&2
printf '%s\\n' ${shQuote(SHIM_MESSAGE)} >&2
exit 1
`;
}

/**
 * Puts the shim first on env.PATH and keeps the PATH it found in
 * env.CLAUDE_TEST_ORIGINAL_PATH (not overwritten when a parent process already
 * set it, so a nested process still gets the unshimmed PATH). Throws, after
 * removing what it made, when any step fails.
 */
export function installGitShim(env, testFile) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-git-shim-")));
  try {
    chmodSync(dir, 0o700);
    const record = join(dir, RECORD_NAME);
    writeFileSync(record, "", { mode: 0o600 });
    const shim = join(dir, "git");
    writeFileSync(shim, shimScript(record, testFile), { mode: 0o755 });
    chmodSync(shim, 0o755);
    env.CLAUDE_TEST_ORIGINAL_PATH ??= env.PATH ?? "";
    env.PATH = `${dir}:${env.PATH ?? ""}`;
    return { dir, record };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// writeSync: this runs inside an exit handler, where async stream writes are lost.
function say(text) {
  try {
    writeSync(2, text);
  } catch {
    // nothing left to report to
  }
}

/** Reads the record, reports it, and removes the shim dir. Returns the exit code to force (0 = leave). */
export function finishGitShim(shim) {
  let code = 0;
  try {
    const text = readFileSync(shim.record, "utf8");
    if (text.trim() !== "") {
      say(`git was started by this test file (git-shim):\n${text}`);
      code = 1;
    }
  } catch (error) {
    say(`git-shim: the record could not be read (${error.message})\n`);
    code = 1;
  } finally {
    // Only the directory this process made, by its own absolute path.
    rmSync(shim.dir, { recursive: true, force: true });
  }
  return code;
}

/** For the preload: install now, check at exit; any failure sets exit code 1. */
export function enableGitShim(env, testFile) {
  let shim;
  try {
    shim = installGitShim(env, testFile);
  } catch (error) {
    say(`git-shim: could not place the shim (${error.message})\n`);
    process.exitCode = 1;
    process.once("exit", () => {
      process.exitCode = 1;
    });
    return;
  }
  process.once("exit", () => {
    const code = finishGitShim(shim);
    if (code !== 0) process.exitCode = code;
  });
}
