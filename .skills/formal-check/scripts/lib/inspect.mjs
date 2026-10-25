// Collects what a human needs to approve a manifest, without running any
// model. Nothing here imports or executes the files it lists.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeDigest, modulesOf, moduleErrors, sha256File } from "./hash.mjs";
import { computeSync } from "./sync.mjs";
import { HARNESS_VERSION } from "./version.mjs";

const entry = (file) => ({ path: file.rel, sha256: sha256File(file.abs) });

// Where the runtime came from and what is in it. None of this is in the digest
// (the runtime is outside what a manifest approves), so the approval screen is
// the only place to see it.
function describeRuntime(runtime) {
  const described = {
    source: runtime?.source ?? null,
    dir: runtime?.dir ?? null,
  };
  const jarSha256 = runtime?.jarPath ? sha256File(runtime.jarPath) : null;
  if (jarSha256 !== null) described.jarSha256 = jarSha256;
  if (runtime?.dir) {
    try {
      const { version } = JSON.parse(
        readFileSync(
          join(runtime.dir, "node_modules/z3-solver/package.json"),
          "utf8",
        ),
      );
      if (typeof version === "string") described.z3Version = version;
    } catch {
      // not installed or not readable: leave the field out
    }
  }
  return described;
}

const failed = (manifestErrors, runtime) => ({
  schemaVersion: 1,
  harnessVersion: HARNESS_VERSION,
  manifestErrors,
  digest: null,
  runtime: describeRuntime(runtime),
  checks: [],
});

export function buildInspect(loaded, runtime) {
  if (!loaded.ok) return failed(loaded.errors, runtime);
  const errors = moduleErrors(loaded);
  if (errors.length > 0) return failed(errors, runtime);
  return {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    manifestErrors: [],
    digest: computeDigest(loaded),
    runtime: describeRuntime(runtime),
    checks: loaded.manifest.checks.map((check) => {
      const { modules, usesIo } = modulesOf(check, loaded.repoRoot);
      return {
        id: check.id,
        kind: check.kind,
        role: check.role,
        model: entry(check.model),
        cfg: check.cfg ? entry(check.cfg) : null,
        imports: check.imports.map(entry),
        modules: modules.map(entry),
        usesIo,
        covers: computeSync(check).files.map(
          ({ path, recorded, current, state }) => ({
            path,
            recorded,
            current,
            state,
          }),
        ),
      };
    }),
  };
}
