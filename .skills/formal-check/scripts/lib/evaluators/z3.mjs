// Child-side evaluator for kind "z3". Runs inside the model child under the
// import guard; the only things it imports are node: built-ins and codes.mjs.
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { OBSERVATION, RUN } from "../codes.mjs";

// The model child reports an error with a `code` property as that code; any
// other throw is a model fault (model-threw).
const withCode = (code, message) => Object.assign(new Error(message), { code });

function assertAbsolute(runtimeDir) {
  if (typeof runtimeDir !== "string" || !isAbsolute(runtimeDir)) {
    throw withCode(
      RUN.INTERNAL_ERROR,
      "the z3 runtime dir must be an absolute path",
    );
  }
}

// Loaded by absolute path through a require rooted at the runtime dir: a bare
// "z3-solver" would also search the parents of this script's dir.
function loadZ3(runtimeDir) {
  assertAbsolute(runtimeDir);
  const require = createRequire(join(runtimeDir, "package.json"));
  return require(join(runtimeDir, "node_modules", "z3-solver"));
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// Every check gets the time that is left to the deadline, so the solver gives
// up (unknown) before the parent's timeout kills the whole child. A fresh
// solver per check keeps the first check's constraints out of the second.
async function checkWith(ctx, constraints, deadline) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 1) return { result: "unknown", model: null };
  const solver = new ctx.Solver();
  solver.set("timeout", Math.min(remaining, MAX_TIMEOUT_MS));
  for (const constraint of constraints) solver.add(constraint);
  const result = await solver.check();
  return {
    result,
    model: result === "sat" ? solver.model().sexpr() : null,
  };
}

function exportsOf(namespace) {
  const quantifier = namespace.quantifier ?? "forall";
  if (quantifier !== "forall" && quantifier !== "exists") {
    throw withCode(
      OBSERVATION.INVALID_MODEL_EXPORT,
      `quantifier must be "forall" or "exists", got ${JSON.stringify(quantifier)}`,
    );
  }
  if (typeof namespace.property !== "function") {
    throw withCode(
      OBSERVATION.INVALID_MODEL_EXPORT,
      "the model must export property(ctx)",
    );
  }
  if (
    namespace.assumptions !== undefined &&
    typeof namespace.assumptions !== "function"
  ) {
    throw withCode(
      OBSERVATION.INVALID_MODEL_EXPORT,
      "assumptions must be a function of ctx",
    );
  }
  return quantifier;
}

// assumptions(ctx) may return one Bool expression or an array of them.
const asList = (value) => (Array.isArray(value) ? value : [value]);

export async function evaluate(
  namespace,
  { runtimeDir, deadline, z3 = loadZ3(runtimeDir) },
) {
  assertAbsolute(runtimeDir);
  if (!Number.isFinite(deadline)) {
    throw withCode(RUN.INTERNAL_ERROR, "the z3 deadline is missing or invalid");
  }
  const quantifier = exportsOf(namespace);
  const { Context } = await z3.init();
  const ctx = Context("main");

  const property = await namespace.property(ctx);
  const hasAssumptions = namespace.assumptions !== undefined;
  const assumptions = hasAssumptions
    ? asList(await namespace.assumptions(ctx))
    : [];
  if (![property, ...assumptions].every((e) => ctx.isBool(e))) {
    return { quantifier, assumptions: null, main: "unknown", notBool: true };
  }

  if (quantifier === "exists") {
    const main = await checkWith(ctx, [...assumptions, property], deadline);
    return {
      quantifier,
      assumptions: null,
      main: main.result,
      ...(main.model === null ? {} : { model: main.model }),
    };
  }

  let assumptionsResult = null;
  if (hasAssumptions) {
    assumptionsResult = (await checkWith(ctx, assumptions, deadline)).result;
    if (assumptionsResult === "unsat" || assumptionsResult === "unknown") {
      return {
        quantifier,
        assumptions: assumptionsResult,
        main: "unknown",
      };
    }
  }
  const main = await checkWith(
    ctx,
    [...assumptions, ctx.Not(property)],
    deadline,
  );
  return {
    quantifier,
    assumptions: assumptionsResult,
    main: main.result,
    ...(main.model === null ? {} : { model: main.model }),
  };
}
