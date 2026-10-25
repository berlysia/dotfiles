import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  SCRIPTS_DIR,
  HAS_PROC,
  enumerateModel,
  isGone,
  killQuietly,
  makeRepo,
  makeTempDir,
  removeTempDirs,
  readPid,
  runCli,
  startCli,
  waitFor,
  readFixture,
  writeFiles,
  writeManifest,
} from "./formal-check/helpers.mjs";

after(removeTempDirs);

const lib = (name) => `${SCRIPTS_DIR}lib/${name}`;
const load = (name) => import(lib(name));

// Every code seen in any output of this file; checked against codes.mjs by the
// last test, so a code that escapes the registry cannot go unnoticed.
const EMITTED = new Set();

// ---------------------------------------------------------------- T0

test("T0: codes.mjs and version.mjs are leaf modules without imports", () => {
  for (const name of ["codes.mjs", "version.mjs"]) {
    const src = readFileSync(lib(name), "utf8");
    assert.doesNotMatch(src, /^\s*import\s/m, `${name} has a static import`);
    assert.doesNotMatch(src, /\bimport\s*\(/, `${name} has a dynamic import`);
  }
});

test("T0: codes are unique across categories", async () => {
  const codes = await load("codes.mjs");
  const seen = new Map();
  for (const [category, group] of Object.entries(codes.CODE_CATEGORIES)) {
    for (const code of Object.values(group)) {
      assert.ok(
        !seen.has(code),
        `${code} in ${category} and ${seen.get(code)}`,
      );
      seen.set(code, category);
    }
  }
  assert.equal(codes.ALL_CODES.size, seen.size);
  for (const code of seen.keys()) assert.ok(codes.ALL_CODES.has(code));
  assert.ok(codes.ALL_CODES.has("invalid-json"));
  assert.ok(codes.ALL_CODES.has("stale-model"));
});

// ---------------------------------------------------------------- T1

const { loadManifest } = await load("manifest.mjs");

const MODEL = enumerateModel();

function baseManifest() {
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

const tlaCheck = (extra = {}) => ({
  id: "t1",
  kind: "tla",
  model: "spec.tla",
  cfg: "spec.cfg",
  property: "Inv",
  expect: "hold",
  role: "contract",
  brokenBy: "b1",
  note: "toy",
  sync: { covers: [] },
  ...extra,
});

function setup(mutate, { files = {}, raw } = {}) {
  const root = makeRepo();
  writeFiles(root, {
    "formal/m.mjs": MODEL,
    "formal/b.mjs": MODEL,
    "formal/spec.tla": "---- MODULE spec ----\n====\n",
    "formal/spec.cfg": "INIT Init\n",
    "formal/helper.mjs": "export {};\n",
    "impl/a.mjs": "export const a = 1;\n",
    "impl/b.mjs": "export const b = 1;\n",
    ...files,
  });
  const manifest = baseManifest();
  mutate?.(manifest, root);
  const file = writeManifest(
    join(root, "formal"),
    raw === undefined ? manifest : raw,
  );
  const result = loadManifest(file);
  if (!result.ok) for (const e of result.errors) EMITTED.add(e.code);
  return { root, file, result };
}

const codesOf = (result) => (result.ok ? [] : result.errors.map((e) => e.code));

function expectErrors(mutate, expected, options) {
  const { result } = setup(mutate, options);
  assert.equal(result.ok, false, "expected manifest errors");
  for (const code of expected) {
    assert.ok(codesOf(result).includes(code), `${code} in ${codesOf(result)}`);
  }
  return result;
}

test("T1: a clean manifest loads with rel and abs for every path", () => {
  const { root, result } = setup((m) => {
    m.checks[0].imports = ["impl/a.mjs"];
    m.checks[0].sync = { covers: [{ path: "impl/a.mjs", sha256: null }] };
    delete m.checks[0].note;
  });
  assert.deepEqual(codesOf(result), []);
  assert.equal(result.ok, true);
  assert.equal(result.repoRoot, root);
  assert.equal(result.manifestDir, join(root, "formal"));
  assert.deepEqual(result.manifestPath, {
    rel: "formal/formal.json",
    abs: join(root, "formal", "formal.json"),
  });
  const [c1, b1] = result.manifest.checks;
  assert.deepEqual(c1.model, {
    rel: "formal/m.mjs",
    abs: join(root, "formal/m.mjs"),
  });
  assert.deepEqual(c1.imports, [
    { rel: "impl/a.mjs", abs: join(root, "impl/a.mjs") },
  ]);
  assert.equal(c1.sync.covers[0].rel, "impl/a.mjs");
  assert.equal(c1.timeoutSec, 60);
  assert.equal(b1.sync, null);
  assert.equal(b1.role, "broken-variant");
});

test("T1: broken JSON yields exactly invalid-json", () => {
  const { result } = setup(undefined, { raw: "{ not json" });
  assert.deepEqual(codesOf(result), ["invalid-json"]);
});

test("T1: schemaVersion problems stop further validation", () => {
  const missing = setup((m) => {
    delete m.schemaVersion;
    m.checks[0].bogus = 1;
  });
  assert.deepEqual(codesOf(missing.result), ["missing-schema-version"]);
  const unsupported = setup((m) => {
    m.schemaVersion = 2;
    m.checks[0].bogus = 1;
  });
  assert.deepEqual(codesOf(unsupported.result), ["unsupported-schema-version"]);
});

test("T1: unknown keys are rejected everywhere, including __proto__", () => {
  expectErrors((m) => (m.extra = 1), ["unknown-key"]);
  expectErrors((m) => (m.checks[0].extra = 1), ["unknown-key"]);
  expectErrors((m) => (m.checks[0].sync.extra = 1), ["unknown-key"]);
  expectErrors(
    (m) =>
      (m.checks[0].sync.covers = [
        { path: "impl/a.mjs", sha256: null, extra: 1 },
      ]),
    ["unknown-key"],
  );
  const raw = JSON.stringify(baseManifest()).replace(
    '"schemaVersion":1',
    '"schemaVersion":1,"__proto__":{"x":1}',
  );
  const { result } = setup(undefined, { raw });
  assert.ok(codesOf(result).includes("unknown-key"), codesOf(result).join());
});

test("T1: keys outside the kind or role are key-not-allowed", () => {
  expectErrors(
    (m) => (m.checks[0] = tlaCheck({ imports: ["impl/a.mjs"] })),
    ["key-not-allowed"],
  );
  expectErrors((m) => (m.checks[0].cfg = "spec.cfg"), ["key-not-allowed"]);
  expectErrors((m) => (m.checks[0].checkDeadlock = true), ["key-not-allowed"]);
  expectErrors((m) => (m.checks[1].brokenBy = "b1"), ["key-not-allowed"]);
  expectErrors((m) => (m.checks[0].question = "q1"), ["key-not-allowed"]);
});

test("T1: duplicate ids and enum violations", () => {
  expectErrors((m) => (m.checks[1].id = "c1"), ["duplicate-id"]);
  expectErrors((m) => (m.checks[0].kind = "alloy"), ["invalid-enum"]);
  expectErrors((m) => (m.checks[0].expect = "maybe"), ["invalid-enum"]);
  expectErrors((m) => (m.checks[0].role = "other"), ["invalid-enum"]);
});

test("T1: role and expect must agree", () => {
  expectErrors((m) => (m.checks[1].expect = "hold"), ["role-expect-mismatch"]);
  expectErrors(
    (m) => (m.checks[0].expect = "violate"),
    ["role-expect-mismatch"],
  );
  expectErrors(
    (m) => {
      m.checks[1].role = "finding";
      m.checks[1].expect = "hold";
      m.checks[1].question = "q1";
      m.checks[1].sync = { covers: [{ path: "impl/a.mjs", sha256: null }] };
    },
    ["role-expect-mismatch"],
  );
});

test("T1: brokenBy must name an existing check", () => {
  expectErrors((m) => (m.checks[0].brokenBy = "nope"), ["unknown-broken-by"]);
});

test("T1: required fields", () => {
  const findingWith = (extra) => ({
    id: "f1",
    kind: "enumerate",
    model: "b.mjs",
    property: "P",
    expect: "violate",
    role: "finding",
    question: "q1",
    sync: { covers: [{ path: "impl/a.mjs", sha256: null }] },
    ...extra,
  });
  expectErrors(
    (m) => {
      m.checks.push(findingWith({}));
      delete m.checks[2].question;
    },
    ["missing-field"],
  );
  expectErrors((m) => delete m.checks[0].sync, ["missing-field"]);
  expectErrors(
    (m) => {
      m.checks.push(findingWith({}));
      delete m.checks[2].sync;
    },
    ["missing-field"],
  );
  expectErrors(
    (m) => (m.checks[0] = tlaCheck({ cfg: undefined })),
    ["missing-field"],
  );
  expectErrors((m) => (m.checks[0].property = ""), ["missing-field"]);
  expectErrors((m) => delete m.checks[0].model, ["missing-field"]);
});

test("T1: contract with covers [] needs a note", () => {
  expectErrors((m) => delete m.checks[0].note, ["empty-covers-without-note"]);
  const { result } = setup();
  assert.equal(result.ok, true);
});

test("T1: finding with covers [] is rejected", () => {
  expectErrors(
    (m) => {
      Object.assign(m.checks[1], {
        id: "f1",
        role: "finding",
        question: "q1",
        sync: { covers: [] },
      });
      m.checks[0].brokenBy = "f1";
    },
    ["empty-covers-on-finding"],
  );
});

test("T1: imports outside the manifest dir must be covered, except for broken variants", () => {
  expectErrors(
    (m) => (m.checks[0].imports = ["impl/a.mjs"]),
    ["import-not-covered"],
  );
  const { result } = setup((m) => (m.checks[1].imports = ["impl/a.mjs"]));
  assert.deepEqual(codesOf(result), []);
  const covered = setup((m) => {
    m.checks[0].imports = ["impl/a.mjs", "formal/helper.mjs"];
    m.checks[0].sync = { covers: [{ path: "impl/a.mjs", sha256: null }] };
    delete m.checks[0].note;
  });
  assert.deepEqual(codesOf(covered.result), []);
});

test("T1: sha256 and commit formats", () => {
  const withCover = (sha256, commit) => (m) => {
    m.checks[0].sync = {
      ...(commit === undefined ? {} : { commit }),
      covers: [{ path: "impl/a.mjs", sha256 }],
    };
    delete m.checks[0].note;
  };
  expectErrors(withCover("a".repeat(63)), ["invalid-format"]);
  expectErrors(withCover("A".repeat(64)), ["invalid-format"]);
  expectErrors(withCover(null, "a".repeat(39)), ["invalid-format"]);
  expectErrors(withCover(null, "A".repeat(40)), ["invalid-format"]);
  assert.deepEqual(codesOf(setup(withCover(null)).result), []);
  assert.deepEqual(
    codesOf(setup(withCover("a".repeat(64), "b".repeat(40))).result),
    [],
  );
  assert.deepEqual(codesOf(setup(withCover(null, "b".repeat(64))).result), []);
});

test("T1: timeoutSec bounds", () => {
  for (const v of [0, -1, 1.5, 601]) {
    expectErrors((m) => (m.checks[0].timeoutSec = v), ["out-of-range"]);
  }
  expectErrors((m) => (m.checks[0].timeoutSec = "60"), ["invalid-type"]);
  assert.deepEqual(
    codesOf(setup((m) => (m.checks[0].timeoutSec = 600)).result),
    [],
  );
  assert.deepEqual(
    codesOf(setup((m) => (m.checks[0].timeoutSec = 1)).result),
    [],
  );
});

test("T1: covers must be regular files and unique", () => {
  expectErrors(
    (m) => {
      m.checks[0].sync = { covers: [{ path: "impl", sha256: null }] };
      delete m.checks[0].note;
    },
    ["covers-not-file"],
  );
  expectErrors(
    (m) => {
      m.checks[0].sync = {
        covers: [
          { path: "impl/a.mjs", sha256: null },
          { path: "impl/a.mjs", sha256: null },
        ],
      };
      delete m.checks[0].note;
    },
    ["duplicate-path"],
  );
});

test("T1: path fields reject escapes and odd characters", () => {
  for (const bad of [
    "../x.mjs",
    "/etc/passwd",
    "a/../b.mjs",
    "a//b.mjs",
    ".",
    "",
    "-x.mjs",
  ]) {
    const { result } = setup((m) => (m.checks[0].model = bad));
    assert.ok(
      codesOf(result).includes("path-escape"),
      `${JSON.stringify(bad)}: ${codesOf(result)}`,
    );
  }
  expectErrors(
    (m) => (m.checks[0].model = "my model.mjs"),
    ["invalid-path-chars"],
  );
  expectErrors(
    (m) => (m.checks[0].model = "m$(x).mjs"),
    ["invalid-path-chars"],
  );
});

test("T1: symlinks pointing outside the base dir are path-escape", () => {
  const outside = makeTempDir("out");
  writeFileSync(join(outside, "x.mjs"), MODEL);
  const link = (root, rel) => {
    mkdirSync(join(root, "formal"), { recursive: true });
    symlinkSync(join(outside, "x.mjs"), join(root, rel));
  };
  const cases = [
    [
      "model",
      "formal/link-model.mjs",
      (m) => (m.checks[0].model = "link-model.mjs"),
    ],
    [
      "cfg",
      "formal/link.cfg",
      (m) => (m.checks[0] = tlaCheck({ cfg: "link.cfg" })),
    ],
    [
      "imports",
      "impl/link.mjs",
      (m) => (m.checks[1].imports = ["impl/link.mjs"]),
    ],
    [
      "covers",
      "impl/linkc.mjs",
      (m) => {
        m.checks[0].sync = {
          covers: [{ path: "impl/linkc.mjs", sha256: null }],
        };
        delete m.checks[0].note;
      },
    ],
  ];
  for (const [label, rel, mutate] of cases) {
    const root = makeRepo();
    writeFiles(root, {
      "formal/m.mjs": MODEL,
      "formal/b.mjs": MODEL,
      "formal/spec.tla": "",
      "impl/a.mjs": "",
    });
    link(root, rel);
    const manifest = baseManifest();
    mutate(manifest);
    const result = loadManifest(writeManifest(join(root, "formal"), manifest));
    assert.ok(
      codesOf(result).includes("path-escape"),
      `${label}: ${codesOf(result)}`,
    );
    for (const e of result.errors ?? []) EMITTED.add(e.code);
  }
});

test("T1: a nonexistent covers file is not a manifest error", () => {
  const { result } = setup((m) => {
    m.checks[0].sync = { covers: [{ path: "impl/gone.mjs", sha256: null }] };
    delete m.checks[0].note;
  });
  assert.deepEqual(codesOf(result), []);
});

test("T1: containment compares with a separator (sibling dir)", () => {
  const files = {
    "a-evil/x.mjs": "export {};\n",
    "a/m.mjs": MODEL,
    "a/b.mjs": MODEL,
  };
  const make = (mutate) => {
    const root = makeRepo();
    writeFiles(root, files);
    const manifest = baseManifest();
    mutate(manifest);
    return loadManifest(writeManifest(join(root, "a"), manifest));
  };
  const imports = make((m) => (m.checks[1].imports = ["a-evil/x.mjs"]));
  assert.deepEqual(codesOf(imports), []);
  const model = make((m) => (m.checks[0].model = "../a-evil/x.mjs"));
  assert.ok(codesOf(model).includes("path-escape"));
  // The sibling is reachable through a symlink inside the manifest dir.
  const root = makeRepo();
  writeFiles(root, files);
  symlinkSync(join(root, "a-evil", "x.mjs"), join(root, "a", "sib.mjs"));
  const m = baseManifest();
  m.checks[0].model = "sib.mjs";
  const viaLink = loadManifest(writeManifest(join(root, "a"), m));
  assert.ok(codesOf(viaLink).includes("path-escape"));
});

test("T1: nonexistent model, cfg and imports are missing-file", () => {
  expectErrors((m) => (m.checks[0].model = "nope.mjs"), ["missing-file"]);
  expectErrors(
    (m) => (m.checks[0] = tlaCheck({ cfg: "nope.cfg" })),
    ["missing-file"],
  );
  expectErrors(
    (m) => (m.checks[1].imports = ["impl/nope.mjs"]),
    ["missing-file"],
  );
});

test("T1: Deadlock property needs checkDeadlock", () => {
  expectErrors(
    (m) =>
      (m.checks[0] = tlaCheck({ property: "Deadlock", checkDeadlock: false })),
    ["deadlock-property-without-check"],
  );
  expectErrors(
    (m) => (m.checks[0] = tlaCheck({ property: "Deadlock" })),
    ["deadlock-property-without-check"],
  );
  assert.deepEqual(
    codesOf(
      setup(
        (m) =>
          (m.checks[0] = tlaCheck({
            property: "Deadlock",
            checkDeadlock: true,
          })),
      ).result,
    ),
    [],
  );
});

test("T1: repository root discovery", () => {
  const bare = makeTempDir("bare");
  writeFiles(bare, { "formal/m.mjs": MODEL, "formal/b.mjs": MODEL });
  const noRoot = loadManifest(
    writeManifest(join(bare, "formal"), baseManifest()),
  );
  assert.deepEqual(codesOf(noRoot), ["no-repo-root"]);
  EMITTED.add("no-repo-root");

  const root = makeRepo();
  writeFiles(root, { "m.mjs": MODEL, "b.mjs": MODEL });
  const atRoot = loadManifest(writeManifest(root, baseManifest()));
  assert.ok(codesOf(atRoot).includes("manifest-at-repo-root"));
  EMITTED.add("manifest-at-repo-root");

  // A worktree has `.git` as a file.
  const wt = makeTempDir("wt");
  writeFiles(wt, {
    ".git": "gitdir: /elsewhere\n",
    "formal/m.mjs": MODEL,
    "formal/b.mjs": MODEL,
  });
  const viaFile = loadManifest(
    writeManifest(join(wt, "formal"), baseManifest()),
  );
  assert.deepEqual(codesOf(viaFile), []);
  assert.equal(viaFile.repoRoot, wt);
});

test("T1: a symlinked formal.json resolves the manifest dir by realpath", () => {
  const root = makeRepo();
  writeFiles(root, { "real/m.mjs": MODEL, "real/b.mjs": MODEL });
  writeManifest(join(root, "real"), baseManifest());
  mkdirSync(join(root, "alias"));
  symlinkSync(
    join(root, "real", "formal.json"),
    join(root, "alias", "formal.json"),
  );
  const result = loadManifest(join(root, "alias", "formal.json"));
  assert.deepEqual(codesOf(result), []);
  assert.equal(result.manifestDir, join(root, "real"));
  assert.equal(result.manifestPath.rel, "real/formal.json");
});

test("T1: all violations are collected in document order with positions", () => {
  const { result } = setup((m) => {
    m.checks[0].timeoutSec = 0;
    m.checks.push({ ...m.checks[1], id: "b2", model: "b.mjs" });
    m.checks[2].model = "../escape.mjs";
    m.checks[2].expect = "hold";
  });
  assert.equal(result.errors.length, 3, JSON.stringify(result.errors));
  assert.ok(result.errors[0].message.includes("checks[0]"));
  assert.ok(result.errors[1].message.includes("checks[2]"));
  assert.ok(result.errors[2].message.includes("checks[2]"));
  assert.deepEqual(
    result.errors.map((e) => e.code),
    ["out-of-range", "path-escape", "role-expect-mismatch"],
  );
});

// ---------------------------------------------------------------- T2

const verdictLib = await load("verdict.mjs");
const { judge, isPass, parseCfgDeclarations, computeWarnings } = verdictLib;

const ok = (observation) => ({ ok: true, observation });
const judged = (check, envelope) => {
  const r = judge(check, envelope);
  if (r.error) EMITTED.add(r.error.code);
  return r;
};

test("T2: verdict.mjs imports only the constant leaf modules", () => {
  const src = readFileSync(lib("verdict.mjs"), "utf8");
  const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(specifiers.sort(), ["./codes.mjs", "./version.mjs"]);
  assert.doesNotMatch(src, /\bimport\s*\(/);
});

test("T2: enumerate observations map to verdicts", () => {
  const check = { kind: "enumerate", property: "P" };
  assert.equal(judged(check, ok({ cases: 3 })).verdict, "hold");
  assert.equal(judged(check, ok({ cases: 0 })).error.code, "empty-domain");
  const violated = judged(check, ok({ cases: 3, firstFalse: { x: 2 } }));
  assert.equal(violated.verdict, "violate");
  assert.deepEqual(violated.witness, { x: 2 });
  // A falsy counterexample input must still count as a violation.
  assert.equal(
    judged(check, ok({ cases: 1, firstFalse: 0 })).verdict,
    "violate",
  );
  assert.equal(
    judged(check, ok({ cases: 3, nonBoolean: 1 })).error.code,
    "non-boolean",
  );
  const timedOut = judged(check, {
    ok: false,
    error: { code: "timeout", message: "t" },
  });
  assert.equal(timedOut.verdict, "error");
  assert.equal(timedOut.error.code, "timeout");
});

test("T2: z3 observations map to verdicts", () => {
  const check = { kind: "z3", property: "P" };
  const z3 = (o) => judged(check, ok(o));
  assert.equal(
    z3({ quantifier: "forall", assumptions: "sat", main: "unsat" }).verdict,
    "hold",
  );
  const violated = z3({
    quantifier: "forall",
    assumptions: null,
    main: "sat",
    model: "x = 1",
  });
  assert.equal(violated.verdict, "violate");
  assert.equal(violated.witness, "x = 1");
  assert.equal(
    z3({ quantifier: "forall", assumptions: "unsat", main: "unsat" }).error
      .code,
    "vacuous-assumptions",
  );
  assert.equal(
    z3({ quantifier: "forall", assumptions: "unknown", main: "unsat" }).error
      .code,
    "solver-unknown",
  );
  assert.equal(
    z3({ quantifier: "forall", assumptions: "sat", main: "unknown" }).error
      .code,
    "solver-unknown",
  );
  const exists = z3({
    quantifier: "exists",
    assumptions: null,
    main: "sat",
    model: "y = 2",
  });
  assert.equal(exists.verdict, "hold");
  assert.equal(exists.witness, "y = 2");
  assert.equal(
    z3({ quantifier: "exists", assumptions: null, main: "unsat" }).verdict,
    "violate",
  );
  assert.equal(
    z3({ quantifier: "exists", assumptions: null, main: "unknown" }).error.code,
    "solver-unknown",
  );
  assert.equal(z3({ notBool: true }).error.code, "not-bool-expr");
});

const HOLD = readFixture("tlc-hold.txt");
const VIOLATE = readFixture("tlc-violate-invariant.txt");
const NO_INVARIANT = readFixture("tlc-no-invariant.txt");
const PARSE_ERROR = readFixture("tlc-parse-error.txt");
// Synthetic: the real hold output with a JDK warning line put before the
// version line, which is how the version line ends up on line 2.
const WARNING_FIRST = readFixture("tlc-warning-first-line.txt");

const tla = ({
  property = "NeverOverCap",
  exitCode = 0,
  stdout = HOLD,
  cfgText = "INVARIANT NeverOverCap\n",
  checkDeadlock = false,
} = {}) =>
  judged(
    { kind: "tla", property },
    ok({ exitCode, stdout, cfgText, checkDeadlock }),
  );

test("T2: tla hold needs a declared property, the success line and states", () => {
  assert.equal(tla().verdict, "hold");
  assert.equal(
    tla({ stdout: NO_INVARIANT, cfgText: "INIT Init\nNEXT Next\n" }).error.code,
    "tlc-vacuous",
  );
  // Declared, but under another name than the check's property.
  assert.equal(tla({ cfgText: "INVARIANT Other\n" }).error.code, "tlc-vacuous");
  // Exit 0 without the success line.
  assert.equal(
    tla({ stdout: HOLD.replace("No error has been found", "Something else") })
      .error.code,
    "tlc-vacuous",
  );
  // Zero distinct states.
  assert.equal(
    tla({
      stdout: HOLD.replace(
        "13 distinct states found",
        "0 distinct states found",
      ),
    }).error.code,
    "tlc-vacuous",
  );
});

test("T2: tla invariant violations need a matching name", () => {
  const violated = tla({ exitCode: 12, stdout: VIOLATE });
  assert.equal(violated.verdict, "violate");
  assert.match(violated.witness, /Invariant NeverOverCap is violated/);
  assert.equal(
    tla({
      exitCode: 12,
      stdout: VIOLATE,
      property: "Other",
      cfgText: "INVARIANT Other\n",
    }).error.code,
    "tlc-property-mismatch",
  );
});

test("T2: tla liveness violations need exactly one PROPERTY", () => {
  const stdout = VIOLATE.replace(
    "Invariant NeverOverCap is violated",
    "Temporal properties were violated",
  );
  assert.equal(
    tla({ exitCode: 13, stdout, property: "Live", cfgText: "PROPERTY Live\n" })
      .verdict,
    "violate",
  );
  assert.equal(
    tla({
      exitCode: 13,
      stdout,
      property: "Live",
      cfgText: "PROPERTY Live\nPROPERTY Other\n",
    }).error.code,
    "tlc-property-mismatch",
  );
  assert.equal(
    tla({
      exitCode: 13,
      stdout,
      property: "Live",
      cfgText: "PROPERTIES Live Other\n",
    }).error.code,
    "tlc-property-mismatch",
  );
});

test("T2: tla deadlock handling", () => {
  assert.equal(
    tla({ exitCode: 11, checkDeadlock: false }).error.code,
    "tlc-exit-unexpected",
  );
  assert.equal(
    tla({
      exitCode: 11,
      checkDeadlock: true,
      property: "Deadlock",
      cfgText: "",
    }).verdict,
    "violate",
  );
  assert.equal(
    tla({ exitCode: 0, checkDeadlock: true, property: "Deadlock", cfgText: "" })
      .verdict,
    "hold",
  );
  const other = tla({ exitCode: 11, checkDeadlock: true });
  assert.equal(other.error.code, "deadlock-found");
  assert.match(other.error.message, /separate check with property "Deadlock"/);
});

test("T2: tla unexpected exit codes and the version line (tlc-warning-first-line.txt is synthetic: a JDK warning line prepended to the real hold output)", () => {
  assert.equal(
    tla({ stdout: PARSE_ERROR, exitCode: 150 }).error.code,
    "tlc-exit-unexpected",
  );
  assert.equal(
    tla({ stdout: PARSE_ERROR, exitCode: 255 }).error.code,
    "tlc-exit-unexpected",
  );
  for (const exitCode of [10, 14, 75, 76, 77, 151, 152, 153, 1]) {
    assert.equal(
      tla({ exitCode }).error.code,
      "tlc-exit-unexpected",
      `exit ${exitCode}`,
    );
  }
  const wrongVersion = HOLD.replace(
    "TLC2 Version 2.19 of 08 August 2024",
    "TLC2 Version 2.20",
  );
  assert.equal(
    tla({ stdout: wrongVersion }).error.code,
    "tlc-version-mismatch",
  );
  assert.equal(
    tla({ stdout: "no version line at all\n" }).error.code,
    "tlc-version-mismatch",
  );
  // The version line may be pushed down by a JDK warning, but only so far.
  assert.equal(tla({ stdout: WARNING_FIRST }).verdict, "hold");
  const pushedTooFar = "w\n".repeat(5) + HOLD;
  assert.equal(
    tla({ stdout: pushedTooFar }).error.code,
    "tlc-version-mismatch",
  );
});

test("T2: cfg declarations ignore comments and read plural forms", () => {
  assert.deepEqual(
    parseCfgDeclarations("INVARIANTS A B \\* comment\n(* PROPERTY C *)\n"),
    {
      invariants: ["A", "B"],
      properties: [],
    },
  );
  assert.deepEqual(
    parseCfgDeclarations(
      "INIT Init\nINVARIANT A\nINVARIANTS\n  B\n  C\nPROPERTIES D E\nPROPERTY F\nCONSTANT Cap = 1\n",
    ),
    { invariants: ["A", "B", "C"], properties: ["D", "E", "F"] },
  );
  assert.deepEqual(
    parseCfgDeclarations(
      "(* outer (* nested INVARIANT X *) INVARIANT Y *)\nINVARIANT Z\n",
    ),
    {
      invariants: ["Z"],
      properties: [],
    },
  );
});

test("T2: unknown observation shapes are errors, never a verdict", () => {
  assert.equal(
    judged({ kind: "nope", property: "P" }, ok({})).verdict,
    "error",
  );
  assert.equal(
    judged({ kind: "nope", property: "P" }, ok({})).error.code,
    "internal-error",
  );
});

test("T2: pass is verdict equal to expect, and errors never pass", () => {
  assert.equal(isPass("hold", "hold"), true);
  assert.equal(isPass("violate", "violate"), true);
  assert.equal(isPass("violate", "hold"), false);
  assert.equal(isPass("error", "violate"), false);
  assert.equal(isPass("error", "hold"), false);
});

// Entries for computeWarnings: {check, result, sync}
const entry = (check, { pass = true, sync } = {}) => ({
  check: {
    property: "P",
    kind: "enumerate",
    sync: null,
    brokenBy: null,
    ...check,
  },
  result: { pass },
  sync: sync ?? { state: "none", files: [] },
});
const file = (state, path = "impl/a.mjs") => ({
  path,
  state,
  recorded: null,
  current: null,
});
const warn = (entries) => {
  const w = computeWarnings(entries);
  for (const x of w) EMITTED.add(x.code);
  return w;
};

test("T2: contracts without a broken variant warn", () => {
  const w = warn([entry({ id: "c1", role: "contract" })]);
  assert.deepEqual(
    w.map((x) => x.code),
    ["no-broken-variant"],
  );
  assert.equal(w[0].checkId, "c1");
});

test("T2: brokenBy must point at a passing broken variant on the same property and kind", () => {
  const broken = { id: "b1", role: "broken-variant" };
  const contract = { id: "c1", role: "contract", brokenBy: "b1" };
  assert.deepEqual(warn([entry(contract), entry(broken)]), []);
  const codes = (entries) => warn(entries).map((x) => x.code);
  assert.deepEqual(
    codes([entry(contract), entry({ ...broken, property: "Q" })]),
    ["broken-variant-mismatch"],
  );
  assert.deepEqual(codes([entry(contract), entry({ ...broken, kind: "z3" })]), [
    "broken-variant-mismatch",
  ]);
  assert.deepEqual(codes([entry(contract), entry(broken, { pass: false })]), [
    "broken-variant-mismatch",
  ]);
  assert.deepEqual(
    codes([entry(contract), entry({ id: "b1", role: "finding" })]),
    ["broken-variant-mismatch"],
  );
});

test("T2: several contracts may share one broken variant", () => {
  const w = warn([
    entry({ id: "c1", role: "contract", brokenBy: "b1" }),
    entry({ id: "c2", role: "contract", brokenBy: "b1" }),
    entry({ id: "b1", role: "broken-variant" }),
  ]);
  assert.deepEqual(w, []);
});

test("T2: sync states become warnings per file", () => {
  const base = { id: "c1", role: "contract", brokenBy: "b1" };
  const broken = entry({ id: "b1", role: "broken-variant" });
  const withSync = (sync, check = {}) =>
    warn([entry({ ...base, ...check }, { sync }), broken]);

  const commit = "a".repeat(40);
  const stale = withSync(
    { state: "changed", files: [file("changed")] },
    { sync: { commit } },
  );
  assert.deepEqual(
    stale.map((x) => x.code),
    ["stale-model"],
  );
  assert.ok(
    stale[0].message.includes(`git diff ${commit} -- 'impl/a.mjs'`),
    stale[0].message,
  );

  const noCommit = withSync(
    { state: "changed", files: [file("changed")] },
    { sync: { commit: null } },
  );
  assert.ok(!noCommit[0].message.includes("git diff"));

  const missing = withSync({ state: "missing", files: [file("missing")] });
  assert.deepEqual(
    missing.map((x) => x.code),
    ["covers-missing"],
  );
  assert.match(missing[0].recover, /renamed/);

  const unrecorded = withSync({
    state: "unrecorded",
    files: [file("unrecorded")],
  });
  assert.deepEqual(
    unrecorded.map((x) => x.code),
    ["sync-unrecorded"],
  );

  const two = withSync({
    state: "changed",
    files: [
      file("changed", "impl/a.mjs"),
      file("changed", "impl/b.mjs"),
      file("clean", "impl/c.mjs"),
    ],
  });
  assert.deepEqual(
    two.map((x) => x.code),
    ["stale-model", "stale-model"],
  );

  assert.deepEqual(withSync({ state: "none", files: [] }), []);
  assert.deepEqual(withSync({ state: "empty", files: [] }), []);
  assert.deepEqual(withSync({ state: "clean", files: [file("clean")] }), []);
});

// ---------------------------------------------------------------- T5

const { resolveRuntime, checkAvailability } = await load("runtime.mjs");

test("T5: FORMAL_CHECK_HOME wins when absolute and present", () => {
  const dir = makeRepo();
  assert.deepEqual(
    resolveRuntime({ FORMAL_CHECK_HOME: dir, HOME: "/nonexistent-home" }),
    {
      dir,
      jarPath: join(dir, "tla2tools.jar"),
    },
  );
});

test("T5: a relative FORMAL_CHECK_HOME is ignored in favour of the default", () => {
  const home = makeRepo();
  mkdirSync(join(home, ".config", "formal-check"), { recursive: true });
  const resolved = resolveRuntime({
    FORMAL_CHECK_HOME: "relative",
    HOME: home,
  });
  assert.equal(resolved.dir, join(home, ".config", "formal-check"));
});

test("T5: a missing explicit FORMAL_CHECK_HOME does not fall back to the default", () => {
  const home = makeRepo();
  mkdirSync(join(home, ".config", "formal-check"), { recursive: true });
  assert.deepEqual(
    resolveRuntime({
      FORMAL_CHECK_HOME: join(home, "does-not-exist"),
      HOME: home,
    }),
    { dir: null, jarPath: null },
  );
});

test("T5: no default dir resolves to null", () => {
  assert.deepEqual(resolveRuntime({ HOME: makeRepo() }), {
    dir: null,
    jarPath: null,
  });
});

test("T5: only enumerate is available in this plan", () => {
  const runtime = { dir: null, jarPath: null };
  assert.deepEqual(checkAvailability(["enumerate"], runtime), {
    enumerate: { ok: true },
  });
  const both = checkAvailability(["enumerate", "tla"], runtime);
  assert.equal(both.enumerate.ok, true);
  assert.equal(both.tla.ok, false);
  assert.equal(both.tla.code, "runtime-not-implemented");
  assert.equal(typeof both.tla.recover, "string");
});

// ---------------------------------------------------------------- T4

const { sha256Bytes, sha256File, computeDigest } = await load("hash.mjs");
const { computeSync } = await load("sync.mjs");
const { createHash } = await import("node:crypto");

const sha = (text) => createHash("sha256").update(text).digest("hex");

function syncRepo() {
  const root = makeRepo();
  writeFiles(root, {
    "impl/a.mjs": "export const a = 1;\n",
    "impl/b.mjs": "export const b = 1;\n",
  });
  const cover = (name, sha256) => ({
    rel: `impl/${name}`,
    abs: join(root, "impl", name),
    sha256,
  });
  const check = (...covers) => ({ id: "c", sync: { commit: null, covers } });
  return { root, cover, check };
}

test("T4: sha256File hashes raw bytes and reports unreadable files as null", () => {
  const { root } = syncRepo();
  assert.equal(
    sha256File(join(root, "impl/a.mjs")),
    sha("export const a = 1;\n"),
  );
  assert.equal(sha256File(join(root, "impl/none.mjs")), null);
  assert.equal(sha256Bytes(Buffer.from("x")), sha("x"));
});

test("T4: sync file states", () => {
  const { root, cover, check } = syncRepo();
  const aHash = sha("export const a = 1;\n");

  const clean = computeSync(check(cover("a.mjs", aHash)));
  assert.equal(clean.state, "clean");
  assert.deepEqual(clean.files, [
    { path: "impl/a.mjs", state: "clean", recorded: aHash, current: aHash },
  ]);

  writeFileSync(join(root, "impl/a.mjs"), "export const a = 2;\n");
  const changed = computeSync(check(cover("a.mjs", aHash)));
  assert.equal(changed.state, "changed");
  assert.equal(changed.files[0].current, sha("export const a = 2;\n"));
  assert.equal(changed.files[0].recorded, aHash);

  // Only the line ending differs.
  writeFileSync(join(root, "impl/b.mjs"), "export const b = 1;\r\n");
  assert.equal(
    computeSync(check(cover("b.mjs", sha("export const b = 1;\n")))).state,
    "changed",
  );

  const gone = computeSync(check(cover("gone.mjs", aHash)));
  assert.equal(gone.state, "missing");
  assert.equal(gone.files[0].current, null);
  assert.equal(computeSync(check(cover("gone.mjs", null))).state, "missing");

  const unrecorded = computeSync(check(cover("b.mjs", null)));
  assert.equal(unrecorded.state, "unrecorded");
  assert.equal(unrecorded.files[0].recorded, null);
  assert.equal(unrecorded.files[0].current, sha("export const b = 1;\r\n"));
});

test("T4: sync aggregates by priority missing > changed > unrecorded > clean", () => {
  const { root, cover, check } = syncRepo();
  writeFileSync(join(root, "impl/a.mjs"), "A\n");
  writeFileSync(join(root, "impl/b.mjs"), "B\n");
  const okA = cover("a.mjs", sha("A\n"));
  const badA = cover("a.mjs", sha("old\n"));
  const nullB = cover("b.mjs", null);
  const gone = cover("gone.mjs", sha("x"));
  assert.equal(computeSync(check(badA, gone)).state, "missing");
  assert.equal(computeSync(check(badA, nullB)).state, "changed");
  assert.equal(computeSync(check(nullB, okA)).state, "unrecorded");
  assert.equal(
    computeSync(check(okA, cover("b.mjs", sha("B\n")))).state,
    "clean",
  );
});

test("T4: sync states for covers [] and an omitted sync", () => {
  const { check } = syncRepo();
  assert.deepEqual(computeSync(check()), { state: "empty", files: [] });
  assert.deepEqual(computeSync({ id: "b", sync: null }), {
    state: "none",
    files: [],
  });
});

test("T4: sync follows a symlink to the target's content", () => {
  const { root, cover, check } = syncRepo();
  symlinkSync(join(root, "impl/a.mjs"), join(root, "impl/link.mjs"));
  const aHash = sha("export const a = 1;\n");
  const result = computeSync(
    check({ ...cover("link.mjs", aHash), abs: join(root, "impl/link.mjs") }),
  );
  assert.equal(result.state, "clean");
});

// The digest is the value a human approves and run.mjs re-checks, so its
// layout is pinned by a hand-assembled string and by a golden constant that
// was computed outside this code base (see the report of this change).
const DIGEST_MANIFEST_BODY = {
  schemaVersion: 1,
  checks: [
    {
      id: "c1",
      kind: "enumerate",
      model: "m.mjs",
      imports: ["impl/a.mjs"],
      property: "P",
      expect: "hold",
      role: "contract",
      brokenBy: "b1",
      sync: { covers: [{ path: "impl/a.mjs", sha256: null }] },
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
const DIGEST_MANIFEST_TEXT = `${JSON.stringify(DIGEST_MANIFEST_BODY, null, 2)}\n`;
const DIGEST_FILES = {
  "formal/m.mjs":
    "export const domain = () => [1];\nexport const property = () => true;\n",
  "formal/b.mjs":
    "export const domain = () => [1];\nexport const property = () => false;\n",
  "impl/a.mjs": "export const a = 1;\n",
};
const GOLDEN_DIGEST =
  "cadaf9395c8d864b65bad45cbe99ed28c37e3c3c2bb1898cce0a9a365c7172ee";

function digestOf(
  mutate,
  {
    manifestText = DIGEST_MANIFEST_TEXT,
    files = DIGEST_FILES,
    version = "test-0",
  } = {},
) {
  const root = makeRepo();
  writeFiles(root, files);
  const manifestFile = writeManifest(join(root, "formal"), manifestText);
  mutate?.({ root, manifestFile });
  const loaded = loadManifest(manifestFile);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  return { digest: computeDigest(loaded, version), loaded };
}

test("T4: digest layout matches the specified line format", () => {
  const { digest } = digestOf();
  const lines = [
    "harness\ttest-0",
    `manifest\t${sha(DIGEST_MANIFEST_TEXT)}`,
    `formal/b.mjs\t${sha(DIGEST_FILES["formal/b.mjs"])}`,
    `formal/m.mjs\t${sha(DIGEST_FILES["formal/m.mjs"])}`,
    `impl/a.mjs\t${sha(DIGEST_FILES["impl/a.mjs"])}`,
  ];
  assert.equal(digest, sha(`${lines.join("\n")}\n`));
  assert.equal(digest, GOLDEN_DIGEST);
});

test("T4: digest is stable and defaults to the harness version", async () => {
  assert.equal(digestOf().digest, digestOf().digest);
  const { HARNESS_VERSION } = await load("version.mjs");
  const { loaded } = digestOf();
  assert.equal(computeDigest(loaded), computeDigest(loaded, HARNESS_VERSION));
  assert.notEqual(
    computeDigest(loaded, "test-1"),
    computeDigest(loaded, "test-0"),
  );
});

test("T4: digest changes when anything it covers changes", () => {
  const base = digestOf().digest;
  const withTimeout = JSON.parse(DIGEST_MANIFEST_TEXT);
  withTimeout.checks[0].timeoutSec = 61;
  assert.notEqual(
    digestOf(undefined, { manifestText: JSON.stringify(withTimeout) }).digest,
    base,
  );
  assert.notEqual(
    digestOf(undefined, {
      files: { ...DIGEST_FILES, "impl/a.mjs": "export const a = 2;\n" },
    }).digest,
    base,
  );
  assert.notEqual(
    digestOf(undefined, {
      files: {
        ...DIGEST_FILES,
        "formal/m.mjs": `${DIGEST_FILES["formal/m.mjs"]} `,
      },
    }).digest,
    base,
  );
});

test("T4: digest covers cfg and imports, and file names, not only contents", () => {
  const tlaManifest = (cfg) =>
    JSON.stringify({
      schemaVersion: 1,
      checks: [
        {
          id: "t1",
          kind: "tla",
          model: "s.tla",
          cfg,
          property: "P",
          expect: "violate",
          role: "broken-variant",
        },
      ],
    });
  const files = (cfgText, cfgName) => ({
    "formal/s.tla": "T\n",
    [`formal/${cfgName}`]: cfgText,
  });
  const one = digestOf(undefined, {
    manifestText: tlaManifest("s.cfg"),
    files: files("INVARIANT A\n", "s.cfg"),
  }).digest;
  const changedCfg = digestOf(undefined, {
    manifestText: tlaManifest("s.cfg"),
    files: files("INVARIANT B\n", "s.cfg"),
  }).digest;
  assert.notEqual(one, changedCfg);
  // Same bytes everywhere, only the file name differs (manifest follows).
  const renamed = digestOf(undefined, {
    manifestText: tlaManifest("t.cfg"),
    files: files("INVARIANT A\n", "t.cfg"),
  }).digest;
  assert.notEqual(one, renamed);
});

test("T4: shared imports count once", () => {
  const manifest = (checks) => JSON.stringify({ schemaVersion: 1, checks });
  const check = (id) => ({
    id,
    kind: "enumerate",
    model: "b.mjs",
    imports: ["impl/a.mjs"],
    property: "P",
    expect: "violate",
    role: "broken-variant",
  });
  const files = { "formal/b.mjs": "B\n", "impl/a.mjs": "A\n" };
  const lines = (digest) => digest;
  const single = digestOf(undefined, {
    manifestText: manifest([check("x1")]),
    files,
  }).digest;
  const doubled = digestOf(undefined, {
    manifestText: manifest([check("x1"), check("x2")]),
    files,
  }).digest;
  // The manifest line differs; compare the file part by rebuilding it.
  assert.notEqual(lines(single), lines(doubled));
  const { loaded } = digestOf(undefined, {
    manifestText: manifest([check("x1"), check("x2")]),
    files,
  });
  const manifestText = readFileSync(loaded.manifestPath.abs);
  const expected = sha(
    [
      "harness\ttest-0",
      `manifest\t${sha(manifestText)}`,
      `formal/b.mjs\t${sha("B\n")}`,
      `impl/a.mjs\t${sha("A\n")}`,
    ]
      .join("\n")
      .concat("\n"),
  );
  assert.equal(computeDigest(loaded, "test-0"), expected);
});

// ---------------------------------------------------------------- T3

const { ADAPTERS } = await load("adapters/index.mjs");
const proc = await load("proc.mjs");
const { cpSync } = await import("node:fs");

const OK_EXPORTS =
  "export const domain = () => [0];\nexport const property = () => true;\n";
const NO_RUNTIME = { dir: null, jarPath: null };

// Runs a model through the enumerate adapter in a throwaway repository.
// `imports` are repository-relative paths of files in `files`.
async function runModel(
  source,
  {
    imports = [],
    files = {},
    timeoutMs = 20_000,
    api = ADAPTERS,
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
  if (!envelope.ok) EMITTED.add(envelope.error.code);
  return { envelope, root };
}

const errorCode = ({ envelope }) => (envelope.ok ? null : envelope.error.code);

async function expectGone(pid, label, timeoutMs = 3000) {
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

test("T3: enumerate evaluator counts cases and finds the first false input", async () => {
  const all = await runModel(
    "export const domain = () => Array.from({length: 10}, (_, i) => i);\nexport const property = () => true;\n",
  );
  assert.deepEqual(all.envelope, { ok: true, observation: { cases: 10 } });
  const seven = await runModel(
    "export const domain = () => Array.from({length: 10}, (_, i) => i);\nexport const property = (x) => x !== 7;\n",
  );
  assert.deepEqual(seven.envelope.observation, { cases: 8, firstFalse: 7 });
  const nonBool = await runModel(
    "export const domain = () => [1, 2];\nexport const property = (x) => (x === 2 ? 1 : true);\n",
  );
  assert.deepEqual(nonBool.envelope.observation, { cases: 2, nonBoolean: 2 });
  const generator = await runModel(
    "export function* domain() { yield { a: 1 }; yield { a: 2 }; }\nexport const property = (x) => x.a < 2;\n",
  );
  assert.deepEqual(generator.envelope.observation, {
    cases: 2,
    firstFalse: { a: 2 },
  });
  const falsy = await runModel(
    "export const domain = () => [0];\nexport const property = () => false;\n",
  );
  assert.deepEqual(falsy.envelope.observation, { cases: 1, firstFalse: 0 });
  const empty = await runModel(
    "export const domain = () => [];\nexport const property = () => true;\n",
  );
  assert.deepEqual(empty.envelope.observation, { cases: 0 });
});

test("T3: a model that throws is model-threw", async () => {
  const r = await runModel("throw new Error('boom');\n");
  assert.equal(errorCode(r), "model-threw");
  assert.match(r.envelope.error.message, /boom/);
  assert.equal(
    errorCode(
      await runModel(
        "export const domain = 1;\nexport const property = () => true;\n",
      ),
    ),
    "model-threw",
  );
});

test(
  "T3: timeout stops the child",
  { skip: !HAS_PROC && "needs /proc" },
  async () => {
    const root = makeRepo();
    const pidFile = join(root, "child.pid");
    const r = await runModel(
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nfor (;;) {}\n`,
      { timeoutMs: 1000, root },
    );
    assert.equal(errorCode(r), "timeout");
    await expectGone(readPid(pidFile), "timed-out child");
  },
);

test(
  "T3: timeout also stops grandchildren and returns promptly",
  { skip: !HAS_PROC && "needs /proc" },
  async () => {
    const root = makeRepo();
    const pidFile = join(root, "grandchild.pid");
    const started = Date.now();
    const r = await runModel(
      `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\n` +
        `const g = spawn("sleep", ["60"], { stdio: "inherit" });\nwriteFileSync(${JSON.stringify(pidFile)}, String(g.pid));\nfor (;;) {}\n`,
      { timeoutMs: 1000, root },
    );
    assert.equal(errorCode(r), "timeout");
    assert.ok(
      Date.now() - started < 1000 + 3000,
      `returned after ${Date.now() - started} ms`,
    );
    await expectGone(readPid(pidFile), "grandchild");
  },
);

test(
  "T3: a grandchild left behind by a normal result is stopped",
  { skip: !HAS_PROC && "needs /proc" },
  async () => {
    const root = makeRepo();
    const pidFile = join(root, "grandchild.pid");
    const r = await runModel(
      `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\n` +
        `const g = spawn("sleep", ["60"], { stdio: "inherit" });\nwriteFileSync(${JSON.stringify(pidFile)}, String(g.pid));\n${OK_EXPORTS}`,
      { root },
    );
    assert.equal(r.envelope.ok, true);
    await expectGone(readPid(pidFile), "grandchild");
  },
);

test(
  "T3: killAllChildren stops live children",
  { skip: !HAS_PROC && "needs /proc" },
  async () => {
    let pid;
    const running = proc.runChild({
      command: "sleep",
      args: ["60"],
      timeoutMs: 60_000,
      onSpawn: (p) => (pid = p),
    });
    await waitFor(() => pid, "spawn");
    proc.killAllChildren();
    await running;
    await expectGone(pid, "sleep");
  },
);

test("T3: after shutdown no new child is started", async () => {
  const { execFileSync } = await import("node:child_process");
  const script = `
    const proc = await import(${JSON.stringify(lib("proc.mjs"))});
    proc.shutdown();
    const r = await proc.runChild({ command: "sleep", args: ["0"], timeoutMs: 1000 });
    console.log(JSON.stringify(r));
  `;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  const result = JSON.parse(out);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "interrupted");
  EMITTED.add(result.error.code);
});

test("T3: output limits and exit codes", async () => {
  const big = await runModel(
    `process.stdout.write("x".repeat(2 * 1024 * 1024));\n${OK_EXPORTS}`,
  );
  assert.equal(errorCode(big), "child-output-too-large");
  assert.equal(
    errorCode(await runModel("process.exit(3);\n")),
    "child-exit-nonzero",
  );
  assert.equal(
    errorCode(
      await runModel(`process.stdout.write("extra line\\n");\n${OK_EXPORTS}`),
    ),
    "child-output-invalid",
  );
  assert.equal(
    (
      await runModel(
        `console.log("noise");\nconsole.info("more");\n${OK_EXPORTS}`,
      )
    ).envelope.ok,
    true,
  );
});

test("T3: the child sees only PATH and LANG", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    FC_CANARY_TOKEN: "secret",
    NODE_OPTIONS: "--no-warnings",
    FORMAL_CHECK_HOME: "/x",
    LANG: "C.UTF-8",
  });
  try {
    const keys = `export const domain = () => [Object.keys(process.env).sort()];\nexport const property = () => false;\n`;
    assert.deepEqual((await runModel(keys)).envelope.observation.firstFalse, [
      "LANG",
      "PATH",
    ]);
    delete process.env.LANG;
    assert.deepEqual((await runModel(keys)).envelope.observation.firstFalse, [
      "PATH",
    ]);
  } finally {
    for (const k of Object.keys(process.env))
      if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("T3: proc passes only allow-listed extra variables", async () => {
  const r = await proc.runChild({
    command: process.execPath,
    args: [
      "-e",
      "console.log(JSON.stringify(Object.keys(process.env).sort()))",
    ],
    extraEnv: { JAVA_HOME: "/jdk", FOO: "bar", NODE_OPTIONS: "--x" },
    timeoutMs: 10_000,
  });
  assert.equal(r.ok, true);
  const keys = JSON.parse(r.stdout);
  assert.ok(keys.includes("JAVA_HOME"));
  for (const bad of ["FOO", "NODE_OPTIONS"])
    assert.ok(!keys.includes(bad), bad);
});

test("T3: guard blocks undeclared imports, including same-dir helpers", async () => {
  const marker = (root) => join(root, "executed.marker");
  const root = makeRepo();
  const helper = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker(root))}, "ran");\nexport const h = 1;\n`;
  const r = await runModel(`import "./helper.mjs";\n${OK_EXPORTS}`, {
    files: { "formal/helper.mjs": helper },
    root,
  });
  assert.equal(errorCode(r), "undeclared-import");
  assert.match(r.envelope.error.message, /undeclared import/);
  assert.ok(r.envelope.error.message.includes("helper.mjs"));
  assert.equal(existsSync(marker(root)), false);

  const declared = makeRepo();
  const ok = await runModel(`import "./helper.mjs";\n${OK_EXPORTS}`, {
    files: {
      "formal/helper.mjs": helper.replace(marker(root), marker(declared)),
    },
    imports: ["formal/helper.mjs"],
    root: declared,
  });
  assert.equal(ok.envelope.ok, true, JSON.stringify(ok.envelope));
  assert.equal(existsSync(marker(declared)), true);
});

test("T3: guard blocks harness files, missing files, data: URLs and builtins stay allowed", async () => {
  assert.equal(
    errorCode(
      await runModel(
        `import ${JSON.stringify(lib("proc.mjs"))};\n${OK_EXPORTS}`,
      ),
    ),
    "undeclared-import",
  );
  const missing = await runModel(`import "./nope.mjs";\n${OK_EXPORTS}`);
  assert.equal(missing.envelope.ok, false);
  assert.equal(
    errorCode(
      await runModel(
        `await import("data:text/javascript,export default 1");\n${OK_EXPORTS}`,
      ),
    ),
    "undeclared-import",
  );
  assert.equal(
    (
      await runModel(
        `import fs from "node:fs";\nimport "node:path";\n${OK_EXPORTS}`,
      )
    ).envelope.ok,
    true,
  );
});

test("T3: guard follows the closure of declared files", async () => {
  const files = {
    "impl/impl.mjs": 'import "./dep.mjs";\nexport const v = 1;\n',
    "impl/dep.mjs": 'import "./dep2.mjs";\n',
    "impl/dep2.mjs": "export const d = 2;\n",
  };
  const chain = await runModel(`import "../impl/impl.mjs";\n${OK_EXPORTS}`, {
    files,
    imports: ["impl/impl.mjs"],
  });
  assert.equal(chain.envelope.ok, true, JSON.stringify(chain.envelope));

  // The closure is looked up through the importing parent, not the target.
  const nm = {
    "impl/impl.mjs": 'import "./node_modules/x/index.mjs";\n',
    "impl/node_modules/x/index.mjs": "export const x = 1;\n",
  };
  const viaImpl = await runModel(`import "../impl/impl.mjs";\n${OK_EXPORTS}`, {
    files: nm,
    imports: ["impl/impl.mjs"],
  });
  assert.equal(viaImpl.envelope.ok, true, JSON.stringify(viaImpl.envelope));
  const direct = await runModel(
    `import "../impl/impl.mjs";\nimport "../impl/node_modules/x/index.mjs";\n${OK_EXPORTS}`,
    {
      files: nm,
      imports: ["impl/impl.mjs"],
    },
  );
  assert.equal(errorCode(direct), "undeclared-import");

  // Accepted range: a declared implementation may pull in an undeclared helper
  // from the model's own dir.
  const accepted = await runModel(`import "../impl/impl.mjs";\n${OK_EXPORTS}`, {
    files: {
      "impl/impl.mjs": 'import "../formal/helper2.mjs";\n',
      "formal/helper2.mjs": "export const h = 2;\n",
    },
    imports: ["impl/impl.mjs"],
  });
  assert.equal(accepted.envelope.ok, true, JSON.stringify(accepted.envelope));

  // Accepted range: the closure may also reach files outside the repository.
  const outside = makeRepo();
  writeFiles(outside, { "outside.mjs": "export const o = 1;\n" });
  const reaches = await runModel(`import "../impl/impl.mjs";\n${OK_EXPORTS}`, {
    files: {
      "impl/impl.mjs": `import ${JSON.stringify(join(outside, "outside.mjs"))};\n`,
    },
    imports: ["impl/impl.mjs"],
  });
  assert.equal(reaches.envelope.ok, true, JSON.stringify(reaches.envelope));
});

test("T3: dynamic imports are checked every time", async () => {
  const root = makeRepo();
  const helper = join(root, "formal/helper.mjs");
  const r = await runModel(
    `try { await import(${JSON.stringify(helper)}); } catch {}\nawait import(${JSON.stringify(helper)});\n${OK_EXPORTS}`,
    { files: { "formal/helper.mjs": "export const h = 1;\n" }, root },
  );
  assert.equal(errorCode(r), "undeclared-import");
  const once = await runModel(
    `await import(${JSON.stringify(helper)});\n${OK_EXPORTS}`,
    {
      files: { "formal/helper.mjs": "export const h = 1;\n" },
      root,
    },
  );
  assert.equal(errorCode(once), "undeclared-import");
});

test("T3: a declared symlink matches the real file the model imports", async () => {
  const root = makeRepo();
  writeFiles(root, { "impl/real.mjs": "export const r = 1;\n" });
  symlinkSync(join(root, "impl/real.mjs"), join(root, "impl/link.mjs"));
  const r = await runModel(`import "../impl/real.mjs";\n${OK_EXPORTS}`, {
    imports: ["impl/link.mjs"],
    root,
  });
  assert.equal(r.envelope.ok, true, JSON.stringify(r.envelope));
});

test("T3: the harness dir check is separator-aware", async () => {
  const copy = makeTempDir("copy");
  cpSync(SCRIPTS_DIR, join(copy, "scripts"), { recursive: true });
  const marker = join(copy, "evil.marker");
  mkdirSync(join(copy, "scripts/lib/evaluators-evil"));
  writeFileSync(
    join(copy, "scripts/lib/evaluators-evil/a.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
  const api = (await import(join(copy, "scripts/lib/adapters/index.mjs")))
    .ADAPTERS;
  const evil = join(copy, "scripts/lib/evaluators-evil/a.mjs");
  const r = await runModel(`import ${JSON.stringify(evil)};\n${OK_EXPORTS}`, {
    api,
  });
  assert.equal(errorCode(r), "undeclared-import");
  assert.equal(existsSync(marker), false);
  // Sanity: the copied harness runs a clean model.
  assert.equal((await runModel(OK_EXPORTS, { api })).envelope.ok, true);
});

// ---------------------------------------------------------------- T6 (and the --inspect cases of T4)

const BREAKS_AT_2 =
  "export const domain = () => [0, 1, 2];\nexport const property = (x) => x < 2;\n";
const HOLDS =
  "export const domain = () => [0, 1, 2];\nexport const property = () => true;\n";

// A repository with the base manifest (contract + broken variant).
function cliRepo({ mutate, files = {}, manifest } = {}) {
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

function recordCodes(stdout) {
  try {
    const doc = JSON.parse(stdout);
    for (const e of doc.manifestErrors ?? []) EMITTED.add(e.code);
    for (const c of doc.checks ?? []) if (c.error) EMITTED.add(c.error.code);
    for (const w of doc.warnings ?? []) EMITTED.add(w.code);
  } catch {
    // table output or inspect
  }
}

async function cli(args, options) {
  const result = await runCli(args, options);
  recordCodes(result.stdout);
  return result;
}

const json = (result) => JSON.parse(result.stdout);

test("T6: a contract and its broken variant, both as expected, exit 0", async () => {
  const { file } = cliRepo();
  const r = await cli([file, "--json"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const doc = json(r);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.status, "pass");
  assert.equal(doc.exitCode, 0);
  assert.equal(typeof doc.harnessVersion, "string");
  assert.deepEqual(doc.manifestErrors, []);
  assert.deepEqual(doc.warnings, []);
  const [c1, b1] = doc.checks;
  assert.deepEqual(Object.keys(c1).sort(), [
    "durationMs",
    "error",
    "expect",
    "id",
    "kind",
    "note",
    "pass",
    "recover",
    "role",
    "sync",
    "verdict",
    "witness",
  ]);
  assert.deepEqual(
    [c1.id, c1.kind, c1.role, c1.expect, c1.verdict, c1.pass],
    ["c1", "enumerate", "contract", "hold", "hold", true],
  );
  assert.equal(c1.error, null);
  assert.equal(typeof c1.durationMs, "number");
  assert.deepEqual(b1.witness, 2);
  assert.equal(b1.verdict, "violate");
  assert.deepEqual(b1.sync, { commit: null, state: "none", files: [] });
});

test("T6: a missing brokenBy fails by default and passes with --explore", async () => {
  const { file } = cliRepo({ mutate: (m) => delete m.checks[0].brokenBy });
  const strict = await cli([file, "--json"]);
  assert.equal(strict.code, 1);
  assert.equal(json(strict).status, "fail");
  assert.equal(json(strict).exitCode, 1);
  const warning = json(strict).warnings[0];
  assert.equal(warning.code, "no-broken-variant");
  assert.equal(warning.checkId, "c1");
  assert.equal(typeof warning.message, "string");
  const explore = await cli([file, "--json", "--explore"]);
  assert.equal(explore.code, 0);
  assert.equal(json(explore).status, "pass");
  assert.equal(json(explore).warnings.length, 1);
});

test("T6: a failing contract exits 1 even with --explore", async () => {
  const { file } = cliRepo({ files: { "formal/m.mjs": BREAKS_AT_2 } });
  assert.equal((await cli([file, "--json"])).code, 1);
  const explore = await cli([file, "--json", "--explore"]);
  assert.equal(explore.code, 1);
  assert.equal(json(explore).status, "fail");
});

test("T6: an error beats a mismatch, with or without --explore", async () => {
  const { file } = cliRepo({
    files: {
      "formal/m.mjs": BREAKS_AT_2,
      "formal/b.mjs":
        "export const domain = () => [];\nexport const property = () => true;\n",
    },
  });
  for (const extra of [[], ["--explore"]]) {
    const r = await cli([file, "--json", ...extra]);
    assert.equal(r.code, 2);
    assert.equal(json(r).status, "error");
    assert.equal(json(r).checks[1].error.code, "empty-domain");
  }
});

test("T6: a broken manifest exits 2 with no checks", async () => {
  const { file } = cliRepo({ mutate: (m) => (m.checks[0].kind = "alloy") });
  const r = await cli([file, "--json"]);
  assert.equal(r.code, 2);
  assert.deepEqual(json(r).checks, []);
  assert.equal(json(r).manifestErrors[0].code, "invalid-enum");
});

test("T6: covers [] shows as empty, with the note, in JSON and in the table", async () => {
  const { file } = cliRepo();
  const doc = json(await cli([file, "--json"]));
  assert.equal(doc.checks[0].sync.state, "empty");
  const table = (await cli([file])).stdout;
  assert.match(table, /no covers/);
  assert.match(table, /toy model without an implementation/);
});

test("T6: stale covers warn per file and fail by default", async () => {
  const { file } = cliRepo({
    mutate: (m) => {
      delete m.checks[0].note;
      m.checks[0].sync = {
        covers: [
          { path: "impl/a.mjs", sha256: "0".repeat(64) },
          { path: "impl/gone.mjs", sha256: null },
        ],
      };
    },
  });
  const r = await cli([file, "--json"]);
  assert.equal(r.code, 1);
  assert.deepEqual(
    json(r)
      .warnings.map((w) => w.code)
      .sort(),
    ["covers-missing", "stale-model"],
  );
  assert.equal(json(r).checks[0].sync.state, "missing");
});

const USAGE_CASES = [
  ["--inspect with --explore", (f) => [f, "--inspect", "--explore"]],
  [
    "--inspect with --expect-digest",
    (f) => [f, "--inspect", "--expect-digest", "a".repeat(64)],
  ],
  ["unknown flag", (f) => [f, "--bogus"]],
  ["no positional", () => []],
  ["two positionals", (f) => [f, f]],
  ["--expect-digest without a value", (f) => [f, "--expect-digest"]],
  [
    "--expect-digest with 63 digits",
    (f) => [f, "--expect-digest", "a".repeat(63)],
  ],
  [
    "--expect-digest with uppercase",
    (f) => [f, "--expect-digest", "A".repeat(64)],
  ],
];

test("T6: usage errors exit 2 and run nothing", async () => {
  const marker = "ran.marker";
  const { root, file } = cliRepo();
  writeFileSync(
    join(root, "formal/m.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, marker))}, "x");\n${HOLDS}`,
  );
  for (const [label, build] of USAGE_CASES) {
    const bare = await cli(build(file));
    assert.equal(bare.code, 2, label);
    assert.match(bare.stderr, /usage/i, label);
    const asJson = await cli([...build(file), "--json"]);
    assert.equal(asJson.code, 2, label);
    assert.equal(json(asJson).manifestErrors[0].code, "usage", label);
    assert.deepEqual(json(asJson).checks, [], label);
    assert.equal(json(asJson).status, "error", label);
  }
  assert.equal(existsSync(join(root, marker)), false);
});

test("T6: --json with an unknown flag prints a usage JSON on stdout only", async () => {
  const { file } = cliRepo();
  const r = await cli([file, "--json", "--nope"]);
  assert.equal(r.code, 2);
  assert.equal(json(r).manifestErrors[0].code, "usage");
  assert.equal(r.stderr, "");
});

test("T6: --inspect --json reports the files and hashes without running the model", async () => {
  const root = makeRepo();
  const marker = join(root, "ran.marker");
  writeFiles(root, {
    "formal/m.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n${HOLDS}`,
    "formal/b.mjs": BREAKS_AT_2,
    "formal/spec.tla": "---- MODULE spec ----\n====\n",
    "formal/spec.cfg": "INVARIANT Inv\n",
    "impl/a.mjs": "export const a = 1;\n",
  });
  const doc = baseManifest();
  doc.checks[0].imports = ["impl/a.mjs"];
  doc.checks[0].sync = {
    covers: [
      { path: "impl/a.mjs", sha256: "1".repeat(64) },
      { path: "impl/gone.mjs", sha256: "2".repeat(64) },
      { path: "impl/b.mjs", sha256: null },
    ],
  };
  writeFiles(root, { "impl/b.mjs": "b\n" });
  delete doc.checks[0].note;
  doc.checks.push({
    id: "t1",
    kind: "tla",
    model: "spec.tla",
    cfg: "spec.cfg",
    property: "Inv",
    expect: "violate",
    role: "broken-variant",
  });
  const file = writeManifest(join(root, "formal"), doc);

  const r = await cli([file, "--inspect", "--json"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(existsSync(marker), false, "--inspect must not run the model");
  const out = json(r);
  assert.equal(out.schemaVersion, 1);
  assert.equal(typeof out.harnessVersion, "string");
  assert.deepEqual(out.manifestErrors, []);
  assert.match(out.digest, /^[0-9a-f]{64}$/);
  const [c1, , t1] = out.checks;
  assert.deepEqual(
    Object.keys(c1).sort(),
    [
      "covers",
      "cfg",
      "id",
      "imports",
      "kind",
      "model",
      "modules",
      "role",
      "usesIo",
    ].sort(),
  );
  assert.deepEqual(c1.model, {
    path: "formal/m.mjs",
    sha256: sha(readFileSync(join(root, "formal/m.mjs"))),
  });
  assert.equal(c1.cfg, null);
  assert.deepEqual(c1.imports, [
    { path: "impl/a.mjs", sha256: sha("export const a = 1;\n") },
  ]);
  assert.deepEqual(c1.modules, []);
  assert.equal(c1.usesIo, null);
  assert.deepEqual(c1.covers[0], {
    path: "impl/a.mjs",
    recorded: "1".repeat(64),
    current: sha("export const a = 1;\n"),
    state: "changed",
  });
  assert.deepEqual(c1.covers[1], {
    path: "impl/gone.mjs",
    recorded: "2".repeat(64),
    current: null,
    state: "missing",
  });
  assert.deepEqual(c1.covers[2], {
    path: "impl/b.mjs",
    recorded: null,
    current: sha("b\n"),
    state: "unrecorded",
  });
  assert.equal(t1.cfg.path, "formal/spec.cfg");
  assert.equal(t1.usesIo, null);
});

test("T6: --inspect on a broken manifest exits 2 with a null digest", async () => {
  const { file } = cliRepo({ mutate: (m) => (m.checks[0].kind = "alloy") });
  const r = await cli([file, "--inspect", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(json(r).digest, null);
  assert.ok(json(r).manifestErrors.length > 0);
});

test("T6: --inspect needs no runtime even with a tla check", async () => {
  const { file } = cliRepo({
    files: { "formal/spec.tla": "T\n", "formal/spec.cfg": "C\n" },
    mutate: (m) =>
      m.checks.push({
        id: "t1",
        kind: "tla",
        model: "spec.tla",
        cfg: "spec.cfg",
        property: "Inv",
        expect: "violate",
        role: "broken-variant",
      }),
  });
  const r = await cli([file, "--inspect"], {
    env: { FORMAL_CHECK_HOME: "/does/not/exist" },
  });
  assert.equal(r.code, 0, r.stderr);
});

test("T6: --inspect output is sanitized", async () => {
  const { file } = cliRepo({
    mutate: (m) => (m.checks[0]["\u001b[31mevil"] = 1),
  });
  for (const args of [
    [file, "--inspect", "--json"],
    [file, "--inspect"],
  ]) {
    const r = await cli(args);
    assert.equal(r.code, 2);
    assert.ok(!r.stdout.includes("\u001b"), JSON.stringify(args));
    if (args.includes("--json")) {
      assert.ok(!JSON.stringify(json(r)).includes("\u001b"));
      assert.ok(json(r).manifestErrors[0].message.includes("evil"));
    }
  }
});

test("T6: --expect-digest runs only what was inspected", async () => {
  const { root, file } = cliRepo();
  const marker = join(root, "ran.marker");
  const source = (tail) =>
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n${HOLDS}${tail}`;
  writeFileSync(join(root, "formal/m.mjs"), source(""));
  const { digest } = json(await cli([file, "--inspect", "--json"]));
  const approved = await cli([file, "--json", "--expect-digest", digest]);
  assert.equal(approved.code, 0, approved.stderr + approved.stdout);
  assert.equal(existsSync(marker), true);

  rmSync(marker);
  writeFileSync(
    join(root, "formal/m.mjs"),
    source("// edited after approval\n"),
  );
  const rejected = await cli([file, "--json", "--expect-digest", digest]);
  assert.equal(rejected.code, 2);
  assert.equal(json(rejected).manifestErrors[0].code, "digest-mismatch");
  assert.deepEqual(json(rejected).checks, []);
  assert.equal(
    existsSync(marker),
    false,
    "nothing may run after a digest mismatch",
  );
});

test("T6: changing only `expect` after approval is caught by the digest", async () => {
  const { file } = cliRepo();
  const { digest } = json(await cli([file, "--inspect", "--json"]));
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.checks[1].expect = "violate";
  doc.checks[1].timeoutSec = 5;
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const r = await cli([file, "--json", "--expect-digest", digest]);
  assert.equal(r.code, 2);
  assert.equal(json(r).manifestErrors[0].code, "digest-mismatch");
});

test("T6: a broken manifest with --expect-digest shows the manifest error, not a mismatch", async () => {
  const { file } = cliRepo({ mutate: (m) => (m.checks[0].kind = "alloy") });
  const r = await cli([file, "--json", "--expect-digest", "a".repeat(64)]);
  assert.equal(r.code, 2);
  const codes = json(r).manifestErrors.map((e) => e.code);
  assert.ok(codes.includes("invalid-enum"));
  assert.ok(!codes.includes("digest-mismatch"));
});

// Code points the table and JSON must never contain (tab and newline are fine).
const hasControlChars = (text) =>
  [...text].some((ch) => {
    const c = ch.codePointAt(0);
    return (
      c <= 0x08 ||
      (c >= 0x0b && c <= 0x1f) ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    );
  });

// Built from code points on purpose: formatters rewrite escapes such as
// \u202e into the raw character, which would hide it in the source.
const NASTY = [
  "a",
  "\u001b[31m",
  "b",
  "\u001b]0;title\u0007",
  "c",
  String.fromCharCode(0),
  "d",
  String.fromCharCode(13),
  "e",
  String.fromCharCode(0x9b),
  "f",
  String.fromCharCode(0x202e),
  "g\nh\ti",
].join("");

test("T6: witnesses are sanitized in JSON and in the table", async () => {
  const model = `export const domain = () => [${JSON.stringify(NASTY)}];\nexport const property = () => false;\n`;
  const { file } = cliRepo({
    files: { "formal/m.mjs": model, "formal/b.mjs": model },
  });
  const jsonOut = await cli([file, "--json"]);
  const witness = json(jsonOut).checks[0].witness;
  assert.equal(witness, "abcdefg\nh\ti");
  const table = (await cli([file])).stdout;
  assert.equal(hasControlChars(table), false);
  assert.match(table, /abcdefg/);
});

test("T6: manifest-derived strings in the table are sanitized", async () => {
  const bad = "\u001b[31mred";
  const asId = cliRepo({ mutate: (m) => (m.checks[0].id = bad) });
  const idOut = await cli([asId.file]);
  assert.ok(!idOut.stdout.includes("\u001b"));
  assert.match(idOut.stdout, /red/);
  const asNote = cliRepo({ mutate: (m) => (m.checks[0].note = `n${bad}ote`) });
  const noteOut = await cli([asNote.file]);
  assert.equal(noteOut.code, 0, noteOut.stdout + noteOut.stderr);
  assert.ok(!noteOut.stdout.includes("\u001b"));
});

test("T6: strings are cut at 4000 code points without splitting surrogate pairs", async () => {
  const countPoints = (s) => [...s].length;
  const witnessFor = async (value) => {
    const model = `export const domain = () => [${JSON.stringify(value)}];\nexport const property = () => false;\n`;
    const { file } = cliRepo({
      files: { "formal/m.mjs": model, "formal/b.mjs": model },
    });
    return json(await cli([file, "--json"])).checks[0].witness;
  };
  assert.equal(countPoints(await witnessFor("x".repeat(4000))), 4000);
  assert.equal(countPoints(await witnessFor("x".repeat(4001))), 4000);
  const edge = await witnessFor(`${"x".repeat(3999)}😀tail`);
  assert.equal(countPoints(edge), 4000);
  assert.ok(edge.endsWith("😀"));
  const split = await witnessFor(`${"x".repeat(3999)}😀😀`);
  assert.equal(countPoints(split), 4000);
  assert.doesNotMatch(split, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(
    `T6: ${signal} stops the model child and exits 2`,
    { skip: !HAS_PROC && "needs /proc" },
    async () => {
      const root = makeRepo();
      const pidFile = join(root, "child.pid");
      const loop = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nfor (;;) {}\n`;
      writeFiles(root, { "formal/m.mjs": loop, "formal/b.mjs": BREAKS_AT_2 });
      const file = writeManifest(join(root, "formal"), baseManifest());
      const handle = startCli([file, "--json"]);
      const pid = await waitFor(() => readPid(pidFile), "model child to start");
      handle.child.kill(signal);
      const { code } = await handle.exited;
      assert.equal(code, 2);
      await expectGone(pid, "model child");
    },
  );
}

test("T6: a copied scripts dir runs enumerate manifests without FORMAL_CHECK_HOME", async () => {
  const copy = makeTempDir("portable");
  cpSync(SCRIPTS_DIR, join(copy, "scripts"), { recursive: true });
  const { file } = cliRepo();
  const r = await cli([file, "--json"], { scriptsDir: join(copy, "scripts") });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(json(r).status, "pass");
});

test("T6: a tla check without an implemented runtime errors alone", async () => {
  const { file } = cliRepo({
    files: { "formal/spec.tla": "T\n", "formal/spec.cfg": "C\n" },
    mutate: (m) =>
      m.checks.push({
        id: "t1",
        kind: "tla",
        model: "spec.tla",
        cfg: "spec.cfg",
        property: "Inv",
        expect: "violate",
        role: "broken-variant",
      }),
  });
  const r = await cli([file, "--json"]);
  assert.equal(r.code, 2);
  const [c1, b1, t1] = json(r).checks;
  assert.equal(c1.pass, true);
  assert.equal(b1.pass, true);
  assert.equal(t1.error.code, "runtime-not-implemented");
  assert.equal(typeof t1.recover, "string");
});

test("T6: an adapter that throws becomes internal-error", async () => {
  const copy = makeTempDir("throwing");
  cpSync(SCRIPTS_DIR, join(copy, "scripts"), { recursive: true });
  writeFileSync(
    join(copy, "scripts/lib/adapters/enumerate.mjs"),
    'export function run() { throw new Error("adapter bug"); }\n',
  );
  const { file } = cliRepo();
  const r = await cli([file, "--json"], { scriptsDir: join(copy, "scripts") });
  assert.equal(r.code, 2);
  assert.equal(json(r).checks[0].error.code, "internal-error");
  assert.match(json(r).checks[0].error.message, /adapter bug/);
});

test(
  "T6: --inspect reports an unreadable declared file as missing-file",
  {
    skip: process.getuid?.() === 0 && "root can read mode 000 files",
  },
  async () => {
    const { root, file } = cliRepo();
    chmodSync(join(root, "formal/m.mjs"), 0o000);
    const r = await cli([file, "--inspect", "--json"]);
    assert.equal(r.code, 2);
    assert.equal(json(r).manifestErrors[0].code, "missing-file");
    assert.ok(json(r).manifestErrors[0].message.includes("formal/m.mjs"));
  },
);

test("T6: every code seen in this file belongs to codes.mjs", async () => {
  const { ALL_CODES } = await load("codes.mjs");
  assert.ok(EMITTED.size > 20, `only ${EMITTED.size} codes were observed`);
  for (const code of EMITTED)
    assert.ok(ALL_CODES.has(code), `unregistered code: ${code}`);
});
