// Collects what a human needs to approve a manifest, without running any
// model. Nothing here imports or executes the files it lists.
import { computeDigest, sha256File } from "./hash.mjs";
import { computeSync } from "./sync.mjs";
import { HARNESS_VERSION } from "./version.mjs";

const entry = (file) => ({ path: file.rel, sha256: sha256File(file.abs) });

export function buildInspect(loaded) {
  if (!loaded.ok) {
    return {
      schemaVersion: 1,
      harnessVersion: HARNESS_VERSION,
      manifestErrors: loaded.errors,
      digest: null,
      checks: [],
    };
  }
  return {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    manifestErrors: [],
    digest: computeDigest(loaded),
    checks: loaded.manifest.checks.map((check) => ({
      id: check.id,
      kind: check.kind,
      role: check.role,
      model: entry(check.model),
      cfg: check.cfg ? entry(check.cfg) : null,
      imports: check.imports.map(entry),
      // Filled in by the next plan (TLA+ module closure); not judged yet.
      modules: [],
      usesIo: null,
      covers: computeSync(check).files.map(
        ({ path, recorded, current, state }) => ({
          path,
          recorded,
          current,
          state,
        }),
      ),
    })),
  };
}
