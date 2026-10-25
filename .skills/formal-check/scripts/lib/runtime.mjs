// Runtime resolution (where z3-solver, the TLC jar and java live) and the check
// that they are present and current.
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { OBSERVATION, RUN } from "./codes.mjs";
import { makeScratchDir, runChild } from "./proc.mjs";
import { TLC_VERSION_PREFIX } from "./version.mjs";

// The one place the installer is named; the installer plan creates a script
// with exactly this name.
export const INSTALLER = "~/.chezmoiscripts/10-install-formal-check-deps.sh";

const TLC_VERSION_TIMEOUT_MS = 30_000;

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// A regular file named `java` that this user may execute. Directories and
// non-executable files are skipped so a stray entry earlier on PATH does not
// hide the real java behind it.
function findJava(pathVariable) {
  for (const entry of (pathVariable ?? "").split(delimiter)) {
    if (entry === "") continue;
    const candidate = join(entry, "java");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not usable; keep looking
    }
  }
  return null;
}

// An explicit FORMAL_CHECK_HOME that points nowhere resolves to a null dir
// instead of falling through to the default: silently using another install
// than the one the caller named would hide the mistake. An empty or relative
// value is not an explicit choice and is ignored.
export function resolveRuntime(env) {
  const javaPath = findJava(env.PATH);
  const explicit = env.FORMAL_CHECK_HOME;
  if (typeof explicit === "string" && explicit !== "" && isAbsolute(explicit)) {
    const dir = isDirectory(explicit) ? explicit : null;
    return {
      dir,
      jarPath: dir === null ? null : join(dir, "tla2tools.jar"),
      javaPath,
      source: "env",
      requested: explicit,
    };
  }
  const fallback = join(env.HOME ?? homedir(), ".config", "formal-check");
  if (!isDirectory(fallback)) {
    return {
      dir: null,
      jarPath: null,
      javaPath,
      source: null,
      requested: null,
    };
  }
  return {
    dir: fallback,
    jarPath: join(fallback, "tla2tools.jar"),
    javaPath,
    source: "default",
    requested: null,
  };
}

const unavailable = (code, message, recover) => ({
  ok: false,
  code,
  message,
  recover,
});

// Recover strings carry no "Recover with:" prefix; report.mjs adds it. An
// explicit FORMAL_CHECK_HOME is not something chezmoi can repair (it only
// installs into the default location), so the advice differs.
function reinstallAdvice(runtime) {
  return runtime.source === "env"
    ? `FORMAL_CHECK_HOME points at ${runtime.requested}; install z3-solver and tla2tools.jar there, or unset FORMAL_CHECK_HOME`
    : `chezmoi apply ~/.config/formal-check ${INSTALLER}`;
}

const sameBytes = (a, b) => {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

// Same rule as the textlint wrapper: the install state is a byte copy of
// package.json (and of bun.lock when there is one) taken after a successful
// install, so any difference means the installed tree is not the declared one.
function checkZ3(runtime) {
  const { dir } = runtime;
  if (
    dir === null ||
    !isFile(join(dir, "node_modules/z3-solver/package.json"))
  ) {
    return unavailable(
      RUN.RUNTIME_MISSING,
      "z3-solver is not installed in the formal-check runtime",
      reinstallAdvice(runtime),
    );
  }
  const stale =
    !sameBytes(join(dir, "package.json"), join(dir, ".install-state")) ||
    (isFile(join(dir, "bun.lock")) &&
      !sameBytes(join(dir, "bun.lock"), join(dir, ".install-state.lock")));
  if (stale) {
    return unavailable(
      RUN.RUNTIME_STALE,
      "the installed z3-solver does not match the declared dependencies",
      reinstallAdvice(runtime),
    );
  }
  return { ok: true };
}

// Runs the jar with no arguments: TLC prints its usage (version line first)
// and exits non-zero, so the exit code carries no information here.
async function checkTla(runtime) {
  if (runtime.jarPath === null || !isFile(runtime.jarPath)) {
    return unavailable(
      RUN.RUNTIME_MISSING,
      "tla2tools.jar is not installed in the formal-check runtime",
      reinstallAdvice(runtime),
    );
  }
  if (runtime.javaPath === null) {
    return unavailable(
      RUN.JAVA_MISSING,
      "no executable java was found on PATH",
      "install a JDK so that java is on PATH",
    );
  }
  const scratch = makeScratchDir("formal-check-tlcver-");
  try {
    const result = await runChild({
      command: runtime.javaPath,
      args: ["-cp", runtime.jarPath, "tlc2.TLC"],
      extraEnv: { JAVA_HOME: process.env.JAVA_HOME },
      timeoutMs: TLC_VERSION_TIMEOUT_MS,
      cwd: scratch.dir,
    });
    const head = result.ok ? result.stdout.split("\n").slice(0, 5) : [];
    if (result.ok && head.some((l) => l.startsWith(TLC_VERSION_PREFIX))) {
      return { ok: true };
    }
    return unavailable(
      OBSERVATION.TLC_VERSION_MISMATCH,
      result.ok
        ? `the jar did not print "${TLC_VERSION_PREFIX}" in its first lines`
        : `could not run the jar to read its version: ${result.error.message}`,
      `the jar at ${runtime.jarPath} is not TLC 2.19 (tla2tools v1.7.4); reinstall it`,
    );
  } finally {
    scratch.dispose();
  }
}

// kinds -> {kind: {ok: true} | {ok: false, code, message, recover}}. The TLC
// version is read at most once per call, however many tla checks there are.
export async function checkAvailability(kinds, runtime) {
  const result = {};
  for (const kind of kinds) {
    if (kind === "z3") result.z3 = checkZ3(runtime);
    else if (kind === "tla") result.tla = await checkTla(runtime);
    else result[kind] = { ok: true };
  }
  return result;
}
