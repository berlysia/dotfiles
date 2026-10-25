// Every code the harness can emit lives here and nowhere else. Other modules
// refer to these constants instead of repeating string literals, so a typo
// cannot produce a code that no test and no reader knows about.

// Group constants are keyed by the upper-snake form of the code.
const group = (codes) =>
  Object.freeze(
    Object.fromEntries(
      codes.map((c) => [c.toUpperCase().replaceAll("-", "_"), c]),
    ),
  );

export const MANIFEST = group([
  "invalid-json",
  "missing-schema-version",
  "unsupported-schema-version",
  "unknown-key",
  "key-not-allowed",
  "missing-field",
  "invalid-type",
  "invalid-format",
  "invalid-enum",
  "out-of-range",
  "duplicate-id",
  "duplicate-path",
  "role-expect-mismatch",
  "unknown-broken-by",
  "empty-covers-without-note",
  "empty-covers-on-finding",
  "import-not-covered",
  "covers-not-file",
  "missing-file",
  "path-escape",
  "invalid-path-chars",
  "no-repo-root",
  "manifest-at-repo-root",
  "deadlock-property-without-check",
  "unexpected-binary",
]);

// Errors that stop the run before any check starts.
export const PRE_RUN = group(["usage", "digest-mismatch"]);

export const RUN = group([
  "runtime-missing",
  "runtime-stale",
  "java-missing",
  "child-exit-nonzero",
  "child-output-invalid",
  "child-output-too-large",
  "timeout",
  "internal-error",
  "interrupted",
]);

export const OBSERVATION = group([
  "empty-domain",
  "non-boolean",
  "model-threw",
  "undeclared-import",
  "vacuous-assumptions",
  "solver-unknown",
  "not-bool-expr",
  "tlc-vacuous",
  "tlc-property-mismatch",
  "tlc-exit-unexpected",
  "tlc-version-mismatch",
  "deadlock-found",
  "invalid-model-export",
]);

export const WARNING = group([
  "no-broken-variant",
  "broken-variant-mismatch",
  "stale-model",
  "covers-missing",
  "sync-unrecorded",
]);

export const CODE_CATEGORIES = Object.freeze({
  manifest: MANIFEST,
  preRun: PRE_RUN,
  run: RUN,
  observation: OBSERVATION,
  warning: WARNING,
});

export const ALL_CODES = new Set(
  Object.values(CODE_CATEGORIES).flatMap((g) => Object.values(g)),
);
