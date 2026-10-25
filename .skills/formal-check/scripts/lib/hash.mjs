// The single place that reads files for hashing and assembles the digest.
// sync.mjs, inspect.mjs and the --expect-digest check in run.mjs all go
// through here, so "what was approved" and "what is about to run" cannot be
// computed by two slightly different procedures.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MANIFEST } from "./codes.mjs";
import { collectModules } from "./tla-modules.mjs";
import { HARNESS_VERSION } from "./version.mjs";

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// null when the file cannot be read (missing, a directory, no permission).
export function sha256File(abs) {
  try {
    return sha256Bytes(readFileSync(abs));
  } catch {
    return null;
  }
}

// The files a digest covers for one check: model, cfg and imports.
export function declaredFiles(check) {
  return [check.model, check.cfg, ...check.imports].filter(Boolean);
}

// What a check pulls in beyond its declared files: for tla, the sibling modules
// the model reaches. Everything that needs "the files of a check" (the digest,
// --inspect, the pre-run check) goes through here.
export function modulesOf(check, repoRoot) {
  if (check.kind !== "tla") return { modules: [], usesIo: null, errors: [] };
  try {
    return collectModules({ modelAbs: check.model.abs, repoRoot });
  } catch (error) {
    return {
      modules: [],
      usesIo: null,
      errors: [
        {
          code: MANIFEST.MISSING_FILE,
          message: `cannot scan the modules of ${check.id}: ${error.message}`,
        },
      ],
    };
  }
}

// Manifest errors found while collecting modules, for every check. Callers
// stop before computing a digest or running anything when this is not empty.
export function moduleErrors(loaded) {
  return loaded.manifest.checks.flatMap(
    (check) => modulesOf(check, loaded.repoRoot).errors,
  );
}

// Lines are "<name>\t<sha256>\n". The first two names are positional
// (harness, manifest) so a file called "harness" or "manifest" cannot be
// confused with them: file rows start at line 3 and always carry a
// repository-relative path.
export function computeDigest(loaded, harnessVersion = HARNESS_VERSION) {
  const rows = new Map();
  for (const check of loaded.manifest.checks) {
    const { modules, errors } = modulesOf(check, loaded.repoRoot);
    if (errors.length > 0) throw new Error(errors[0].message);
    for (const file of [...declaredFiles(check), ...modules])
      rows.set(file.rel, file.abs);
  }
  const lines = [
    `harness\t${harnessVersion}`,
    `manifest\t${hashOrThrow(loaded.manifestPath.abs, "manifest")}`,
    ...[...rows.keys()]
      .sort()
      .map((rel) => `${rel}\t${hashOrThrow(rows.get(rel), rel)}`),
  ];
  return sha256Bytes(Buffer.from(lines.join("\n") + "\n", "utf8"));
}

function hashOrThrow(abs, label) {
  const hash = sha256File(abs);
  if (hash === null)
    throw new Error(`cannot read ${label} to compute the digest`);
  return hash;
}
