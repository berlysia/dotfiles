import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BlockingGit = {
  /** Put first on PATH. */
  binDir: string;
  /** How many calls hit the blocking branch so far. */
  blockedCalls: () => number;
  cleanup: () => void;
};

/**
 * A `git` that blocks when any argument equals `blockOn` and runs the real git
 * otherwise. In block mode `exec sleep` makes the sleep the process the
 * caller's timeout kills, so no sleeper outlives the test. With
 * `delaySeconds`, the matching call sleeps that long and then runs the real
 * git; use it only under a timeout well above the delay, which tells a patient
 * injected timeout apart from the production one.
 *
 * Call it before changing PATH: the real git is resolved here.
 */
export function createBlockingGit(
  blockOn: string,
  options: { delaySeconds?: number } = {},
): BlockingGit {
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const binDir = mkdtempSync(join(tmpdir(), "blocking-git-"));
  const callsFile = join(binDir, "blocked-calls");
  // Values are embedded in single quotes below.
  for (const value of [blockOn, realGit, callsFile]) {
    if (value.includes("'")) {
      throw new Error(`createBlockingGit cannot quote: ${value}`);
    }
  }
  const onMatch =
    options.delaySeconds === undefined
      ? ["    exec sleep 30"]
      : [`    sleep ${options.delaySeconds}`, "    break"];
  const script = [
    "#!/bin/sh",
    'for arg in "$@"; do',
    `  if [ "$arg" = '${blockOn}' ]; then`,
    `    echo blocked >> '${callsFile}'`,
    ...onMatch,
    "  fi",
    "done",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(binDir, "git"), script);
  chmodSync(join(binDir, "git"), 0o755);
  return {
    binDir,
    blockedCalls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8").trim().split("\n").length
        : 0,
    cleanup: () => rmSync(binDir, { recursive: true, force: true }),
  };
}
