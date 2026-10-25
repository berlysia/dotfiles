// Parent side of the model child: starts model-child.mjs under the import
// guard and turns whatever comes back into an adapter envelope.
import { fileURLToPath } from "node:url";
import { ALL_CODES, RUN } from "./codes.mjs";
import { runChild } from "./proc.mjs";

const scriptsDir = fileURLToPath(new URL("../", import.meta.url));
const GUARD = `${scriptsDir}import-guard.mjs`;
const CHILD = `${scriptsDir}model-child.mjs`;

const failure = (code, message) => ({ ok: false, error: { code, message } });

// The model and its imports are passed as arguments, not environment
// variables: the environment is deliberately emptied, and the guard needs the
// same list before any model code runs.
export async function runModelChild({
  kind,
  model,
  imports,
  extraArgs = [],
  timeoutMs,
}) {
  const args = [
    "--import",
    GUARD,
    CHILD,
    "--kind",
    kind,
    "--model",
    model,
    ...imports.flatMap((path) => ["--import", path]),
    ...extraArgs,
  ];
  const result = await runChild({ command: process.execPath, args, timeoutMs });
  if (!result.ok) return result;
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().slice(-300);
    return failure(
      RUN.CHILD_EXIT_NONZERO,
      `model process exited with ${result.exitCode ?? result.signal}${tail ? `: ${tail}` : ""}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return failure(
      RUN.CHILD_OUTPUT_INVALID,
      "the model process did not write exactly one JSON value to stdout",
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    return failure(
      RUN.CHILD_OUTPUT_INVALID,
      "the model process wrote JSON that is not an object",
    );
  }
  if (Object.hasOwn(parsed, "error")) {
    const { code, message } = parsed.error ?? {};
    // Codes are a closed set; an unknown one means the child is not our child.
    if (!ALL_CODES.has(code) || typeof message !== "string") {
      return failure(
        RUN.CHILD_OUTPUT_INVALID,
        "the model process reported an error in an unknown shape",
      );
    }
    return failure(code, message);
  }
  if (!Object.hasOwn(parsed, "observation")) {
    return failure(
      RUN.CHILD_OUTPUT_INVALID,
      "the model process wrote neither observation nor error",
    );
  }
  return { ok: true, observation: parsed.observation };
}
