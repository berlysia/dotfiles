import { readFileSync } from "node:fs";
import { RUN } from "../codes.mjs";
import { makeScratchDir, runChild } from "../proc.mjs";

// TLC prints a counterexample trace, which can be long; and the line that says
// a model holds is at the end of the output, so cutting it short would turn a
// verdict into a guess. Over the limit is therefore an error, not a truncation.
const TLC_STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;

const failure = (code, message) => ({ ok: false, error: { code, message } });

// Pure: the whole command line as an array (never a shell string). The first
// element is the java that availability checked, so the one that was verified
// is the one that runs. -deadlock *disables* TLC's deadlock check, which is why
// it is added when the check does not ask for it.
export function buildTlcCommand({
  javaPath,
  jarPath,
  metadir,
  cfgAbs,
  modelAbs,
  checkDeadlock,
}) {
  return [
    javaPath,
    "-Xmx1g",
    "-XX:+UseParallelGC",
    "-cp",
    jarPath,
    "tlc2.TLC",
    "-workers",
    "1",
    "-metadir",
    metadir,
    "-config",
    cfgAbs,
    ...(checkDeadlock ? [] : ["-deadlock"]),
    modelAbs,
  ];
}

// Parent side of kind "tla": run(check, ctx) -> envelope.
export async function run(check, ctx) {
  const { runtime } = ctx;
  if (runtime.jarPath === null) {
    return failure(RUN.RUNTIME_MISSING, "no tla2tools.jar was resolved");
  }
  if (runtime.javaPath === null) {
    return failure(RUN.JAVA_MISSING, "no java was resolved");
  }
  const cfgText = readFileSync(check.cfg.abs, "utf8");
  // cwd and -metadir are the same private temp dir: TLC writes its states there
  // and nowhere in the repository.
  const scratch = makeScratchDir("formal-check-tla-");
  try {
    const [command, ...args] = buildTlcCommand({
      javaPath: runtime.javaPath,
      jarPath: runtime.jarPath,
      metadir: scratch.dir,
      cfgAbs: check.cfg.abs,
      modelAbs: check.model.abs,
      checkDeadlock: check.checkDeadlock === true,
    });
    const result = await runChild({
      command,
      args,
      extraEnv: { JAVA_HOME: process.env.JAVA_HOME },
      timeoutMs: ctx.timeoutMs,
      cwd: scratch.dir,
      stdoutLimitBytes: TLC_STDOUT_LIMIT_BYTES,
    });
    if (!result.ok) return result;
    return {
      ok: true,
      observation: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        cfgText,
        checkDeadlock: check.checkDeadlock === true,
      },
    };
  } finally {
    scratch.dispose();
  }
}
