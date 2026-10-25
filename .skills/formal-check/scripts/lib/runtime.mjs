// Runtime resolution (where z3-solver and the TLC jar live) and, later, the
// check that they are present and current.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { RUN } from "./codes.mjs";

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// An explicit FORMAL_CHECK_HOME that points nowhere resolves to null instead
// of falling through to the default: silently using another install than the
// one the caller named would hide the mistake.
export function resolveRuntime(env) {
  const explicit = env.FORMAL_CHECK_HOME;
  const dir =
    explicit !== undefined && isAbsolute(explicit)
      ? explicit
      : join(env.HOME ?? homedir(), ".config", "formal-check");
  if (!isDirectory(dir)) return { dir: null, jarPath: null };
  return { dir, jarPath: join(dir, "tla2tools.jar") };
}

// Interim: z3 and tla adapters do not exist yet. The next plan replaces the
// body (not the shape) with the real presence and staleness checks.
export function checkAvailability(kinds, _runtime) {
  const result = {};
  for (const kind of kinds) {
    result[kind] =
      kind === "enumerate"
        ? { ok: true }
        : {
            ok: false,
            code: RUN.RUNTIME_NOT_IMPLEMENTED,
            message: `kind "${kind}" is not implemented in this harness version`,
            recover:
              "use only enumerate checks, or a harness version that supports z3 / tla",
          };
  }
  return result;
}
