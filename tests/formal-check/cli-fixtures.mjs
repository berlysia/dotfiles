// Fixtures shared by the unit and heavy formal-check files: both drive the
// CLI over the same manifests, so the setup lives here once.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { makeFakeRuntime } from "./fake-runtime.mjs";
import {
  isGone,
  killQuietly,
  makeRepo,
  makeTempDir,
  runCli,
  waitFor,
  writeFiles,
  writeManifest,
} from "./helpers.mjs";

export function baseManifest() {
  return {
    schemaVersion: 1,
    checks: [
      {
        id: "c1",
        kind: "enumerate",
        model: "m.mjs",
        property: "P",
        expect: "hold",
        role: "contract",
        brokenBy: "b1",
        note: "toy model without an implementation",
        sync: { covers: [] },
      },
      {
        id: "b1",
        kind: "enumerate",
        model: "b.mjs",
        property: "P",
        expect: "violate",
        role: "broken-variant",
      },
    ],
  };
}

// One contract tla check against a fake java, as a process. `body` options go
// to versionJava; `tmp` is the TMPDIR the run uses so leftovers can be counted.
export function tlaRun({
  java,
  timeoutSec = 30,
  cfg = "INVARIANT NeverOverCap\n",
  expect = "hold",
} = {}) {
  const root = makeRepo();
  writeFiles(root, { "formal/spec.tla": "T\n", "formal/spec.cfg": cfg });
  const file = writeManifest(join(root, "formal"), {
    schemaVersion: 1,
    checks: [
      {
        id: "t1",
        kind: "tla",
        model: "spec.tla",
        cfg: "spec.cfg",
        property: "NeverOverCap",
        expect,
        role: "contract",
        note: "toy",
        sync: { covers: [] },
        timeoutSec,
      },
    ],
  });
  const tmp = makeTempDir("tmpdir");
  const env = {
    FORMAL_CHECK_HOME: makeFakeRuntime(),
    PATH: `${java}:${process.env.PATH}`,
    TMPDIR: tmp,
  };
  return { file, env, tmp, root };
}

export const leftovers = (tmp) => readdirSync(tmp);

export const BREAKS_AT_2 =
  "export const domain = () => [0, 1, 2];\nexport const property = (x) => x < 2;\n";
export const HOLDS =
  "export const domain = () => [0, 1, 2];\nexport const property = () => true;\n";

// A repository with the base manifest (contract + broken variant).
export function cliRepo({ mutate, files = {}, manifest } = {}) {
  const root = makeRepo();
  writeFiles(root, {
    "formal/m.mjs": HOLDS,
    "formal/b.mjs": BREAKS_AT_2,
    "impl/a.mjs": "export const a = 1;\n",
    ...files,
  });
  const doc = manifest ?? baseManifest();
  mutate?.(doc, root);
  const file = writeManifest(join(root, "formal"), doc);
  return { root, file };
}

// Each test file keeps its own set of observed codes and checks it against the
// registry, so the callback decides where a code is recorded.
export function makeCli(record) {
  return async function cli(args, options) {
    const result = await runCli(args, options);
    try {
      const doc = JSON.parse(result.stdout);
      for (const e of doc.manifestErrors ?? []) record(e.code);
      for (const c of doc.checks ?? []) if (c.error) record(c.error.code);
      for (const w of doc.warnings ?? []) record(w.code);
    } catch {
      // table output or inspect
    }
    return result;
  };
}

export const json = (result) => JSON.parse(result.stdout);

export async function expectGone(pid, label, timeoutMs = 3000) {
  try {
    await waitFor(
      () => isGone(pid),
      `${label} (pid ${pid}) to stop`,
      timeoutMs,
    );
  } finally {
    killQuietly(pid);
  }
}

export const OK_EXPORTS =
  "export const domain = () => [0];\nexport const property = () => true;\n";
const NO_RUNTIME = { dir: null, jarPath: null };

export const errorCode = ({ envelope }) =>
  envelope.ok ? null : envelope.error.code;

// Runs a model through the enumerate adapter in a throwaway repository.
// `imports` are repository-relative paths of files in `files`.
export function makeModelRunner({ adapters, record }) {
  return async function runModel(
    source,
    {
      imports = [],
      files = {},
      timeoutMs = 20_000,
      api = adapters,
      root = makeRepo(),
    } = {},
  ) {
    writeFiles(root, { "formal/m.mjs": source, ...files });
    const check = {
      id: "c1",
      kind: "enumerate",
      property: "P",
      model: { rel: "formal/m.mjs", abs: join(root, "formal/m.mjs") },
      imports: imports.map((rel) => ({ rel, abs: join(root, rel) })),
    };
    const envelope = await api.enumerate.run(check, {
      runtime: NO_RUNTIME,
      repoRoot: root,
      timeoutMs,
    });
    if (!envelope.ok) record(envelope.error.code);
    return { envelope, root };
  };
}
