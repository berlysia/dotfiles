// Runs the formal-check examples and a few extra models against the real z3
// and TLC. CI has neither, so without them these tests skip with the reason the
// harness itself gives (code and recover). Set FORMAL_CHECK_REQUIRE_RUNTIME=1 on
// a machine that is supposed to have the runtime, so a broken install fails
// here instead of turning into skips.
import assert from "node:assert/strict";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  SCRIPTS_DIR,
  makeRepo,
  makeTempDir,
  removeTempDirs,
  runCli,
  writeFiles,
  writeManifest,
} from "../formal-check/helpers.mjs";

after(removeTempDirs);

const { resolveRuntime, checkAvailability } = await import(
  `${SCRIPTS_DIR}lib/runtime.mjs`
);
const EXAMPLES = new URL(
  "../../.skills/formal-check/examples/",
  import.meta.url,
).pathname;

const runtime = resolveRuntime(process.env);
const availability = await checkAvailability(["z3", "tla"], runtime);

// null: run. {skip}: skip with the reason. {fail}: the runtime is required and
// absent. Kept as a pure function so the gate itself can be tested.
export function gate(entry, requireRuntime) {
  if (entry.ok) return null;
  const reason = `${entry.code}: ${entry.message} (Recover with: ${entry.recover})`;
  return requireRuntime ? { fail: reason } : { skip: reason };
}

const REQUIRE = process.env.FORMAL_CHECK_REQUIRE_RUNTIME === "1";

// A test that needs the real runtime of `kind`.
function runtimeTest(kind, name, body) {
  const decision = gate(availability[kind], REQUIRE);
  if (decision?.skip) return test(name, { skip: decision.skip }, body);
  if (decision?.fail) {
    return test(name, () => assert.fail(`runtime required: ${decision.fail}`));
  }
  return test(name, body);
}

const cliEnv = { FORMAL_CHECK_HOME: runtime.dir ?? makeTempDir("no-runtime") };

// Examples are copied under a throwaway repo root: the manifest dir itself may
// not be the repository root, and a deployed copy has no .git above it.
function copyExample(name) {
  const root = makeRepo();
  cpSync(join(EXAMPLES, name), join(root, name), { recursive: true });
  return join(root, name, "formal.json");
}

async function runJson(file, args = []) {
  const result = await runCli([file, "--json", ...args], { env: cliEnv });
  return { ...result, doc: JSON.parse(result.stdout) };
}

function assertPair(doc, contractId, brokenId) {
  const byId = Object.fromEntries(doc.checks.map((c) => [c.id, c]));
  assert.equal(byId[contractId].verdict, "hold", JSON.stringify(doc));
  assert.equal(byId[brokenId].verdict, "violate", JSON.stringify(doc));
}

// One contract check over files written into a throwaway repo.
async function runModel({
  kind,
  files,
  expect = "hold",
  extra = {},
  args = [],
}) {
  const root = makeRepo();
  writeFiles(
    root,
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [`formal/${k}`, v]),
    ),
  );
  const check = {
    id: "c1",
    kind,
    model: "m.mjs",
    property: "P",
    expect,
    role: expect === "hold" ? "contract" : "broken-variant",
    ...(expect === "hold" ? { note: "test", sync: { covers: [] } } : {}),
    ...extra,
  };
  const file = writeManifest(join(root, "formal"), {
    schemaVersion: 1,
    checks: [check],
  });
  return runJson(file, ["--explore", ...args]);
}

test("example enumerate-cap: the contract holds and the broken variant violates", async () => {
  const r = await runJson(copyExample("enumerate-cap"));
  assert.equal(r.code, 0, r.stdout);
  assertPair(r.doc, "cap-never-exceeded", "cap-never-exceeded-broken");
});

runtimeTest(
  "z3",
  "example z3-window: the contract holds and the broken variant violates",
  async () => {
    const r = await runJson(copyExample("z3-window"));
    assert.equal(r.code, 0, r.stdout);
    assertPair(
      r.doc,
      "window-overlaps-itself",
      "window-overlaps-itself-broken",
    );
  },
);

runtimeTest(
  "tla",
  "example tla-race: Atomic holds and Racy violates NeverOverCap",
  async () => {
    const r = await runJson(copyExample("tla-race"));
    assert.equal(r.code, 0, r.stdout);
    assertPair(r.doc, "atomic-never-over-cap", "racy-over-cap");
  },
);

runtimeTest(
  "z3",
  "z3 forall with unsatisfiable assumptions is vacuous-assumptions",
  async () => {
    const r = await runModel({
      kind: "z3",
      files: {
        "m.mjs": `export const assumptions = (ctx) => ctx.And(ctx.Int.const("x").gt(1), ctx.Int.const("x").lt(0));
export const property = (ctx) => ctx.Int.const("x").gt(5);
`,
      },
    });
    assert.equal(r.code, 2);
    assert.equal(r.doc.checks[0].error.code, "vacuous-assumptions");
  },
);

runtimeTest(
  "z3",
  "z3 exists with a satisfiable property holds and carries the model",
  async () => {
    const r = await runModel({
      kind: "z3",
      files: {
        "m.mjs": `export const quantifier = "exists";
export const property = (ctx) => ctx.And(ctx.Int.const("x").gt(3), ctx.Int.const("x").lt(5));
`,
      },
    });
    assert.equal(r.doc.checks[0].verdict, "hold", r.stdout);
    assert.equal(typeof r.doc.checks[0].witness, "string");
    assert.match(r.doc.checks[0].witness, /define-fun x/);
  },
);

runtimeTest(
  "z3",
  "z3 property that is not a Bool is not-bool-expr",
  async () => {
    const r = await runModel({
      kind: "z3",
      files: {
        "m.mjs": `export const property = (ctx) => ctx.Int.const("x");\n`,
      },
    });
    assert.equal(r.code, 2);
    assert.equal(r.doc.checks[0].error.code, "not-bool-expr");
  },
);

runtimeTest(
  "z3",
  "z3 gives up with solver-unknown before the check's timeout",
  async () => {
    const r = await runModel({
      kind: "z3",
      files: {
        "m.mjs": `export const property = (ctx) => {
  const { Int, And, Not } = ctx;
  const [a, b, c] = ["a", "b", "c"].map((n) => Int.const(n));
  const cubes = a.mul(a).mul(a).add(b.mul(b).mul(b)).eq(c.mul(c).mul(c).add(Int.val(1)));
  return Not(And(cubes, a.gt(1000), b.gt(1000), c.gt(1000)));
};
`,
      },
      extra: { timeoutSec: 4 },
    });
    assert.equal(r.doc.checks[0].error?.code, "solver-unknown", r.stdout);
  },
);

function copyTlaRace() {
  const root = makeRepo();
  cpSync(join(EXAMPLES, "tla-race"), join(root, "tla-race"), {
    recursive: true,
  });
  return { root, dir: join(root, "tla-race") };
}

runtimeTest(
  "tla",
  "tla with the INVARIANT removed from the cfg is tlc-vacuous",
  async () => {
    const { dir } = copyTlaRace();
    writeFileSync(
      join(dir, "Atomic.cfg"),
      "INIT Init\nNEXT Next\nCONSTANT Cap = 1\n",
    );
    const r = await runJson(join(dir, "formal.json"), ["--explore"]);
    const atomic = r.doc.checks.find((c) => c.id === "atomic-never-over-cap");
    assert.equal(atomic.error.code, "tlc-vacuous", r.stdout);
  },
);

runtimeTest(
  "tla",
  "a syntax error registered as expect violate is an error, not a pass",
  async () => {
    const r = await runModel({
      kind: "tla",
      expect: "violate",
      files: {
        "Bad.tla": "---- MODULE Bad ----\nx == \n====\n",
        "Bad.cfg": "INIT Init\nNEXT Next\nINVARIANT P\n",
      },
      extra: { model: "Bad.tla", cfg: "Bad.cfg" },
    });
    assert.equal(r.code, 2);
    assert.equal(r.doc.checks[0].pass, false);
    assert.equal(r.doc.checks[0].error.code, "tlc-exit-unexpected");
  },
);

test("an empty FORMAL_CHECK_HOME makes a tla example runtime-missing without launching java", async () => {
  const file = copyExample("tla-race");
  const empty = makeTempDir("empty-home");
  const result = await runCli([file, "--json"], {
    env: { FORMAL_CHECK_HOME: empty },
  });
  assert.equal(result.code, 2);
  const doc = JSON.parse(result.stdout);
  assert.deepEqual(
    doc.checks.map((c) => c.error?.code),
    ["runtime-missing", "runtime-missing"],
  );
});

test("the runtime gate skips with the code and recover, and fails when the runtime is required", () => {
  const missing = {
    ok: false,
    code: "runtime-missing",
    message: "z3-solver is not installed",
    recover: "chezmoi apply ~/.config/formal-check",
  };
  assert.equal(gate({ ok: true }, true), null);
  const skipped = gate(missing, false);
  assert.match(skipped.skip, /runtime-missing/);
  assert.match(skipped.skip, /Recover with: chezmoi apply/);
  assert.equal(Object.hasOwn(skipped, "fail"), false);
  assert.match(gate(missing, true).fail, /runtime-missing/);
});
