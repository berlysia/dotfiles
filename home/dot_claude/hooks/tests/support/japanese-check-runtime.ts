// Where the tests find the analyzer runtime (lindera and the UniDic
// dictionary). Several tests start the checker with a temporary HOME, which
// would hide ~/.config/japanese-check, so the directory is fixed once, when
// this module loads, before any test changes HOME.
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createAnalyzer } from "../../../japanese-check/adapter-lindera-unidic.ts";
import { makeTokenizer } from "../../../japanese-check/contract.ts";
import {
  resolveRuntimeDir,
  runtimeDirState,
} from "../../../japanese-check/deps.ts";

// Resolved by the production function, so the tests and the checker cannot
// disagree about where the runtime is.
export const RUNTIME_DIR = resolveRuntimeDir();

function runtimePresent(): boolean {
  try {
    return (
      runtimeDirState(RUNTIME_DIR) === "ok" &&
      existsSync(join(RUNTIME_DIR, "node_modules/lindera/index.js")) &&
      readdirSync(join(RUNTIME_DIR, "unidic")).length > 0
    );
  } catch {
    return false;
  }
}

/** Decided once, when this module loads (before a test changes HOME). */
export const RUNTIME_PRESENT = runtimePresent();

const ABSENT_MESSAGE =
  "the japanese-check runtime (lindera and the UniDic dictionary) is missing: " +
  "run `chezmoi apply` or point JAPANESE_CHECK_RUNTIME_DIR at a built runtime " +
  "(scripts/fetch-japanese-check-dictionary.sh)";

const IN_CI = process.env.CI === "true";

if (!RUNTIME_PRESENT && IN_CI) {
  // Why not skip in CI: a skipped test is green, and CI must never go green
  // without these checks. The affected tests are left unskipped (they fail on
  // their own with ENOENT), and this one names the cause once per test file.
  test("japanese-check runtime is present in CI", () => {
    throw new Error(ABSENT_MESSAGE);
  });
}

/**
 * node:test options for a test or describe that needs the real runtime.
 * Absent runtime: skipped with a reason locally, left to fail in CI (above).
 */
export const needsRuntime: { skip?: string } =
  RUNTIME_PRESENT || IN_CI ? {} : { skip: ABSENT_MESSAGE };

/** The environment entry that points a child process at the runtime. */
export function runtimeEnv(): { JAPANESE_CHECK_RUNTIME_DIR: string } {
  return { JAPANESE_CHECK_RUNTIME_DIR: RUNTIME_DIR };
}

/** The entry file of lindera in a runtime, as deps.ts resolves it. */
export function linderaEntry(runtimeDir: string = RUNTIME_DIR): string {
  return realpathSync(join(runtimeDir, "node_modules/lindera/index.js"));
}

/** The real analyzer, wrapped the way cli.ts wraps it. */
export function createTestTokenizer() {
  if (!RUNTIME_PRESENT) {
    // describe() runs its body even when skipped, so this must not throw there.
    // The rejection is marked handled; a test that awaits it still sees it.
    const absent = Promise.reject(new Error(ABSENT_MESSAGE));
    absent.catch(() => {});
    return absent as Promise<ReturnType<typeof makeTokenizer>>;
  }
  return createAnalyzer(linderaEntry(), RUNTIME_DIR).then(makeTokenizer);
}

/**
 * Copies the dictionary files of the runtime into `dest`, as hard links when the
 * file system allows (the files are never written through the link) and as
 * copies otherwise. A test that rewrites a file uses cpSync instead.
 */
export function placeDictionary(dest: string): void {
  const from = join(RUNTIME_DIR, "unidic");
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(from)) {
    try {
      linkSync(join(from, name), join(dest, name));
    } catch {
      cpSync(join(from, name), join(dest, name));
    }
  }
}
