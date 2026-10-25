// Child side: imports the model, asks the evaluator for the kind, and writes
// exactly one JSON value to stdout. Runs under import-guard.mjs, so it may only
// import files the guard allows: lib/evaluators/, lib/codes.mjs, lib/version.mjs.
import { Console } from "node:console";
import { pathToFileURL } from "node:url";
import { OBSERVATION, RUN } from "./lib/codes.mjs";
import { EVALUATORS } from "./lib/evaluators/index.mjs";

// Stdout carries the result, so a model's console.log must not reach it.
globalThis.console = new Console(process.stderr, process.stderr);

function parseArgs(argv) {
  const parsed = {
    kind: null,
    model: null,
    imports: [],
    runtimeDir: null,
    deadline: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--kind") parsed.kind = value;
    else if (flag === "--model") parsed.model = value;
    else if (flag === "--import") parsed.imports.push(value);
    else if (flag === "--runtime-dir") parsed.runtimeDir = value;
    else if (flag === "--deadline") parsed.deadline = Number(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  return parsed;
}

const REPORTABLE = new Set([
  RUN.INTERNAL_ERROR,
  OBSERVATION.INVALID_MODEL_EXPORT,
]);

const bigintSafe = (_key, value) =>
  typeof value === "bigint" ? value.toString() : value;

async function main() {
  const { kind, model, runtimeDir, deadline } = parseArgs(
    process.argv.slice(2),
  );
  try {
    // The kind selects an entry of a fixed table; it is never joined into a path.
    if (!Object.hasOwn(EVALUATORS, kind))
      throw new Error(`no evaluator for kind "${kind}"`);
    const namespace = await import(pathToFileURL(model).href);
    const observation = await EVALUATORS[kind](namespace, {
      runtimeDir,
      deadline,
    });
    return JSON.stringify({ observation }, bigintSafe);
  } catch (error) {
    const message = String(error?.message ?? error);
    // An evaluator names its own faults with a code; everything else the model
    // threw is the model's.
    const code = REPORTABLE.has(error?.code)
      ? error.code
      : message.startsWith("undeclared import:")
        ? OBSERVATION.UNDECLARED_IMPORT
        : OBSERVATION.MODEL_THREW;
    return JSON.stringify({ error: { code, message } });
  }
}

let output;
try {
  output = await main();
} catch (error) {
  // Bad arguments or an unserialisable result: harness-level, not a verdict.
  output = JSON.stringify({
    error: {
      code: OBSERVATION.MODEL_THREW,
      message: String(error?.message ?? error),
    },
  });
}
// Exit explicitly: a model that left timers or sockets open must not keep the
// child alive until the timeout.
process.stdout.write(output, () => process.exit(0));
