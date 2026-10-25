// The single place that reads files for hashing and assembles the digest.
// sync.mjs, inspect.mjs and the --expect-digest check in run.mjs all go
// through here, so "what was approved" and "what is about to run" cannot be
// computed by two slightly different procedures.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

// Lines are "<name>\t<sha256>\n". The first two names are positional
// (harness, manifest) so a file called "harness" or "manifest" cannot be
// confused with them: file rows start at line 3 and always carry a
// repository-relative path.
export function computeDigest(loaded, harnessVersion = HARNESS_VERSION) {
  const rows = new Map();
  for (const check of loaded.manifest.checks) {
    for (const file of declaredFiles(check)) rows.set(file.rel, file.abs);
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
