// Slow formal-check tests: each one starts the CLI and, through it, model
// children or a fake java, so a single test takes 0.5 s to 2.5 s. The unit file
// keeps the entrypoint wiring checks that are fast.
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { makeFakeRuntime, versionJava } from "../formal-check/fake-runtime.mjs";
import {
  BREAKS_AT_2,
  HOLDS,
  cliRepo,
  expectGone,
  json,
  leftovers,
  makeCli,
  makeModelRunner,
  OK_EXPORTS,
  errorCode,
  tlaRun,
} from "../formal-check/cli-fixtures.mjs";
import {
  HAS_PROC,
  SCRIPTS_DIR,
  makeTempDir,
  readFixture,
  makeRepo,
  readPid,
  removeTempDirs,
  waitFor,
  writeFiles,
} from "../formal-check/helpers.mjs";

after(removeTempDirs);

// Codes seen in the outputs of this file; the last test checks them against
// codes.mjs, as the unit file does for its own outputs.
const EMITTED = new Set();
const cli = makeCli((code) => EMITTED.add(code));

const { ADAPTERS } = await import(`${SCRIPTS_DIR}lib/adapters/index.mjs`);
const lib = (name) => `${SCRIPTS_DIR}lib/${name}`;
const runModel = makeModelRunner({
  adapters: ADAPTERS,
  record: (code) => EMITTED.add(code),
});

const HOLD = readFixture("tlc-hold.txt");

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

test("two tla checks read the TLC version once per run", async () => {
  const counter = join(makeTempDir("counter"), "calls");
  const bin = versionJava({ counter, runOutput: HOLD });
  const { file } = cliRepo({
    files: {
      "formal/spec.tla": "T\n",
      "formal/spec.cfg": "C\n",
      "formal/spec2.tla": "T\n",
      "formal/spec2.cfg": "C\n",
    },
    mutate: (m) =>
      m.checks.push(
        {
          id: "t1",
          kind: "tla",
          model: "spec.tla",
          cfg: "spec.cfg",
          property: "Inv",
          expect: "violate",
          role: "broken-variant",
        },
        {
          id: "t2",
          kind: "tla",
          model: "spec2.tla",
          cfg: "spec2.cfg",
          property: "Inv",
          expect: "violate",
          role: "broken-variant",
        },
      ),
  });
  await cli([file, "--json"], {
    env: {
      FORMAL_CHECK_HOME: makeFakeRuntime(),
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  const calls = readFileSync(counter, "utf8").split("\n").filter(Boolean);
  assert.equal(calls.filter((c) => c === "version").length, 1);
});

test("a normal run judges TLC's output and leaves no temp dir", async () => {
  const { file, env, tmp } = tlaRun({ java: versionJava({ runOutput: HOLD }) });
  const r = await cli([file, "--json", "--explore"], { env });
  assert.equal(json(r).checks[0].verdict, "hold", r.stdout);
  assert.deepEqual(leftovers(tmp), []);
});

test("a timeout is an error and leaves no temp dir", async () => {
  const { file, env, tmp } = tlaRun({
    java: versionJava({ runPrefix: "sleep 30" }),
    timeoutSec: 1,
  });
  const r = await cli([file, "--json", "--explore"], { env });
  assert.equal(r.code, 2);
  assert.equal(json(r).checks[0].error.code, "timeout");
  assert.deepEqual(leftovers(tmp), []);
});

test(
  "a java wrapper script's grandchild is stopped on timeout too",
  { skip: !HAS_PROC },
  async () => {
    const pids = join(makeTempDir("pids"), "grandchild");
    const { file, env, tmp } = tlaRun({
      java: versionJava({ runPrefix: `sleep 300 & echo $! > '${pids}'; wait` }),
      timeoutSec: 1,
    });
    const r = await cli([file, "--json", "--explore"], { env });
    assert.equal(json(r).checks[0].error.code, "timeout");
    const pid = await waitFor(() => readPid(pids), "grandchild pid");
    await expectGone(pid, "grandchild");
    assert.deepEqual(leftovers(tmp), []);
  },
);

test("9 MB of TLC output is child-output-too-large, not a truncated verdict", async () => {
  const { file, env } = tlaRun({
    java: versionJava({
      runPrefix: "head -c 9000000 /dev/zero | tr '\\0' a",
    }),
  });
  const r = await cli([file, "--json", "--explore"], { env });
  assert.equal(json(r).checks[0].error.code, "child-output-too-large");
});

test("a contract and its broken variant, both as expected, exit 0", async () => {
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

test("a missing brokenBy fails by default and passes with --explore", async () => {
  const { file } = cliRepo({ mutate: (m) => delete m.checks[0].brokenBy });
  const [strict, explore] = await Promise.all([
    cli([file, "--json"]),
    cli([file, "--json", "--explore"]),
  ]);
  assert.equal(strict.code, 1);
  assert.equal(json(strict).status, "fail");
  assert.equal(json(strict).exitCode, 1);
  const warning = json(strict).warnings[0];
  assert.equal(warning.code, "no-broken-variant");
  assert.equal(warning.checkId, "c1");
  assert.equal(typeof warning.message, "string");
  assert.equal(explore.code, 0);
  assert.equal(json(explore).status, "pass");
  assert.equal(json(explore).warnings.length, 1);
});

test("a failing contract exits 1 even with --explore", async () => {
  const { file } = cliRepo({ files: { "formal/m.mjs": BREAKS_AT_2 } });
  const [strict, explore] = await Promise.all([
    cli([file, "--json"]),
    cli([file, "--json", "--explore"]),
  ]);
  assert.equal(strict.code, 1);
  assert.equal(explore.code, 1);
  assert.equal(json(explore).status, "fail");
});

test("an error beats a mismatch, with or without --explore", async () => {
  const { file } = cliRepo({
    files: {
      "formal/m.mjs": BREAKS_AT_2,
      "formal/b.mjs":
        "export const domain = () => [];\nexport const property = () => true;\n",
    },
  });
  const runs = await Promise.all(
    [[], ["--explore"]].map((extra) => cli([file, "--json", ...extra])),
  );
  for (const r of runs) {
    assert.equal(r.code, 2);
    assert.equal(json(r).status, "error");
    assert.equal(json(r).checks[1].error.code, "empty-domain");
  }
});

test("covers [] shows as empty, with the note, in JSON and in the table", async () => {
  const { file } = cliRepo();
  const [jsonOut, tableOut] = await Promise.all([
    cli([file, "--json"]),
    cli([file]),
  ]);
  assert.equal(json(jsonOut).checks[0].sync.state, "empty");
  const table = tableOut.stdout;
  assert.match(table, /no covers/);
  assert.match(table, /toy model without an implementation/);
});

test("stale covers warn per file and fail by default", async () => {
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

test("usage errors exit 2 and run nothing", async () => {
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

test("--expect-digest runs only what was inspected", async () => {
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

test("witnesses are sanitized in JSON and in the table", async () => {
  const model = `export const domain = () => [${JSON.stringify(NASTY)}];\nexport const property = () => false;\n`;
  const { file } = cliRepo({
    files: { "formal/m.mjs": model, "formal/b.mjs": model },
  });
  const [jsonOut, tableOut] = await Promise.all([
    cli([file, "--json"]),
    cli([file]),
  ]);
  const witness = json(jsonOut).checks[0].witness;
  assert.equal(witness, "abcdefg\nh\ti");
  const table = tableOut.stdout;
  assert.equal(hasControlChars(table), false);
  assert.match(table, /abcdefg/);
});

test("manifest-derived strings in the table are sanitized", async () => {
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

test("strings are cut at 4000 code points without splitting surrogate pairs", async () => {
  const countPoints = (s) => [...s].length;
  const witnessFor = async (value) => {
    const model = `export const domain = () => [${JSON.stringify(value)}];\nexport const property = () => false;\n`;
    const { file } = cliRepo({
      files: { "formal/m.mjs": model, "formal/b.mjs": model },
    });
    return json(await cli([file, "--json"])).checks[0].witness;
  };
  const [exact, over, edge, split] = await Promise.all([
    witnessFor("x".repeat(4000)),
    witnessFor("x".repeat(4001)),
    witnessFor(`${"x".repeat(3999)}😀tail`),
    witnessFor(`${"x".repeat(3999)}😀😀`),
  ]);
  assert.equal(countPoints(exact), 4000);
  assert.equal(countPoints(over), 4000);
  assert.equal(countPoints(edge), 4000);
  assert.ok(edge.endsWith("😀"));
  assert.equal(countPoints(split), 4000);
  assert.doesNotMatch(split, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test("a copied scripts dir runs enumerate manifests without FORMAL_CHECK_HOME", async () => {
  const copy = makeTempDir("portable");
  cpSync(SCRIPTS_DIR, join(copy, "scripts"), { recursive: true });
  const { file } = cliRepo();
  const r = await cli([file, "--json"], { scriptsDir: join(copy, "scripts") });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(json(r).status, "pass");
});

test("a tla check without a runtime errors alone", async () => {
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
  assert.equal(t1.error.code, "runtime-missing");
  assert.equal(typeof t1.recover, "string");
});

test("z3 and tla checks are runtime-missing under an empty FORMAL_CHECK_HOME, enumerate is still judged", async () => {
  const { file } = cliRepo({
    files: {
      "formal/spec.tla": "T\n",
      "formal/spec.cfg": "C\n",
      "formal/z.mjs": "export {};\n",
    },
    mutate: (m) =>
      m.checks.push(
        {
          id: "t1",
          kind: "tla",
          model: "spec.tla",
          cfg: "spec.cfg",
          property: "Inv",
          expect: "violate",
          role: "broken-variant",
        },
        {
          id: "z1",
          kind: "z3",
          model: "z.mjs",
          property: "P",
          expect: "violate",
          role: "broken-variant",
        },
      ),
  });
  const r = await cli([file, "--json"]);
  assert.equal(r.code, 2);
  const [c1, b1, t1, z1] = json(r).checks;
  assert.equal(c1.pass, true);
  assert.equal(b1.pass, true);
  assert.equal(t1.error.code, "runtime-missing");
  assert.equal(z1.error.code, "runtime-missing");
});

test("enumerate evaluator counts cases and finds the first false input", async () => {
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

test("output limits and exit codes", async () => {
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

test("guard blocks harness files, missing files, data: URLs and builtins stay allowed", async () => {
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

test("guard follows the closure of declared files", async () => {
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

test("every code seen in this file belongs to codes.mjs", async () => {
  const { ALL_CODES } = await import(`${SCRIPTS_DIR}lib/codes.mjs`);
  assert.ok(EMITTED.size > 10, `only ${EMITTED.size} codes were observed`);
  for (const code of EMITTED)
    assert.ok(ALL_CODES.has(code), `unregistered code: ${code}`);
});
