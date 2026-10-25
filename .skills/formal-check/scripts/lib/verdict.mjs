// Maps checker observations to verdicts and builds warnings. Everything here
// is pure: no I/O and no imports beyond the two constant leaf modules, so the
// mapping table can be tested with recorded checker output and nothing else.
import { OBSERVATION as O, RUN, WARNING as W } from "./codes.mjs";
import { TLC_VERSION_PREFIX } from "./version.mjs";

const failure = (code, message, recover) => ({
  verdict: "error",
  witness: null,
  error: recover === undefined ? { code, message } : { code, message, recover },
});
const hold = (witness = null) => ({ verdict: "hold", witness, error: null });
const violate = (witness = null) => ({
  verdict: "violate",
  witness,
  error: null,
});

// An error never passes, so a broken run cannot satisfy `expect`.
export function isPass(verdict, expect) {
  return verdict !== "error" && verdict === expect;
}

const EXIT_INVARIANT_VIOLATED = 12;
const EXIT_DEADLOCK = 11;
const EXIT_LIVENESS_VIOLATED = 13;

// Adapters wrap every outcome as {ok, observation} or {ok: false, error}, so
// that a missing runtime, a crashed child and a timeout all reach this table
// the same way.
export function judge(check, envelope) {
  if (!envelope.ok) {
    const { code, message, recover } = envelope.error;
    return failure(code, message, recover);
  }
  const observation = envelope.observation;
  switch (check.kind) {
    case "enumerate":
      return judgeEnumerate(observation);
    case "z3":
      return judgeZ3(observation);
    case "tla":
      return judgeTla(check, observation);
    default:
      return failure(
        RUN.INTERNAL_ERROR,
        `no verdict mapping for kind "${check.kind}"`,
      );
  }
}

function judgeEnumerate(o) {
  if (Object.hasOwn(o, "nonBoolean")) {
    return failure(
      O.NON_BOOLEAN,
      `property returned something other than true / false (input #${String(o.nonBoolean)} of the domain, 1-based)`,
    );
  }
  if (Object.hasOwn(o, "firstFalse")) return violate(o.firstFalse);
  if (!(o.cases > 0))
    return failure(
      O.EMPTY_DOMAIN,
      "domain() returned no inputs (an empty domain is an error, not a vacuous pass)",
    );
  return hold();
}

function judgeZ3(o) {
  if (o.notBool)
    return failure(O.NOT_BOOL_EXPR, "property is not a Bool expression");
  const unknown = () =>
    failure(O.SOLVER_UNKNOWN, "the solver returned unknown");
  if (o.quantifier === "exists") {
    if (o.main === "sat") return hold(o.model ?? null);
    if (o.main === "unsat") return violate();
    return unknown();
  }
  if (o.assumptions === "unsat") {
    return failure(
      O.VACUOUS_ASSUMPTIONS,
      "assumptions are unsatisfiable, so the property was not checked against anything",
    );
  }
  if (o.assumptions === "unknown") return unknown();
  if (o.main === "unsat") return hold();
  if (o.main === "sat") return violate(o.model ?? null);
  return unknown();
}

function judgeTla(check, o) {
  const { exitCode, stdout, cfgText, checkDeadlock } = o;
  const head = stdout.split("\n").slice(0, 5);
  // A JDK warning can push the version line down, but not by a whole screen.
  if (!head.some((line) => line.startsWith(TLC_VERSION_PREFIX))) {
    return failure(
      O.TLC_VERSION_MISMATCH,
      `the TLC version line (${TLC_VERSION_PREFIX}) is not in the first 5 lines of the output; the exit-code mapping is only verified for that version`,
    );
  }
  const declared = parseCfgDeclarations(cfgText);
  const deadlockCheck = checkDeadlock === true && check.property === "Deadlock";

  if (exitCode === 0) {
    const completed = stdout.includes(
      "Model checking completed. No error has been found.",
    );
    const states = /(\d+) distinct states? found/.exec(stdout);
    const hasStates = states !== null && Number(states[1]) > 0;
    const isDeclared = [
      ...declared.invariants,
      ...declared.properties,
    ].includes(check.property);
    if (!completed || !hasStates || !(deadlockCheck || isDeclared)) {
      return failure(
        O.TLC_VACUOUS,
        `TLC exited 0 but there is no evidence that ${check.property} was checked` +
          `${completed ? "" : " (no success line)"}${hasStates ? "" : " (0 distinct states)"}` +
          `${deadlockCheck || isDeclared ? "" : " (not declared in the cfg INVARIANT / PROPERTY)"}`,
      );
    }
    return hold();
  }
  if (exitCode === EXIT_INVARIANT_VIOLATED) {
    const names = [
      ...stdout.matchAll(/^Error: Invariant (\S+) is violated\./gm),
    ].map((m) => m[1]);
    if (names.includes(check.property)) return violate(traceFrom(stdout));
    return failure(
      O.TLC_PROPERTY_MISMATCH,
      `TLC exited 12, but the violated invariant (${names.join(", ") || "no name"}) does not match property ${check.property}`,
    );
  }
  if (exitCode === EXIT_LIVENESS_VIOLATED) {
    // The liveness output does not name the property, so only a cfg with
    // exactly one PROPERTY identifies it.
    if (
      declared.properties.length === 1 &&
      declared.properties[0] === check.property
    ) {
      return violate(traceFrom(stdout));
    }
    return failure(
      O.TLC_PROPERTY_MISMATCH,
      `TLC exited 13 (temporal property violated), but the cfg PROPERTY is not exactly ${check.property}, so the violated property cannot be identified`,
    );
  }
  if (exitCode === EXIT_DEADLOCK) {
    if (deadlockCheck) return violate(traceFrom(stdout));
    if (checkDeadlock === true) {
      return failure(
        O.DEADLOCK_FOUND,
        'a deadlock was found. Check deadlocks in a separate check with property "Deadlock"',
      );
    }
  }
  return failure(
    O.TLC_EXIT_UNEXPECTED,
    `TLC exit code ${exitCode} has no mapping for this check`,
  );
}

function traceFrom(stdout) {
  const at = stdout.search(/^Error: /m);
  return at === -1 ? stdout : stdout.slice(at);
}

// Reads INVARIANT(S) and PROPERTY/PROPERTIES names out of a TLC cfg. Comments
// are removed by a scanner rather than regexes: (* *) nests, and a "\*" inside
// a block comment must not end it early.
const CFG_KEYWORDS = new Set([
  "INIT",
  "NEXT",
  "SPECIFICATION",
  "CONSTANT",
  "CONSTANTS",
  "INVARIANT",
  "INVARIANTS",
  "PROPERTY",
  "PROPERTIES",
  "SYMMETRY",
  "VIEW",
  "CONSTRAINT",
  "CONSTRAINTS",
  "ACTION_CONSTRAINT",
  "ACTION_CONSTRAINTS",
  "ALIAS",
  "POSTCONDITION",
  "CHECK_DEADLOCK",
  "TERMINAL",
]);

export function parseCfgDeclarations(cfgText) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < cfgText.length; i++) {
    const two = cfgText.slice(i, i + 2);
    if (two === "(*") {
      depth++;
      i++;
    } else if (depth > 0 && two === "*)") {
      depth--;
      i++;
    } else if (depth === 0 && two === "\\*") {
      while (i < cfgText.length && cfgText[i] !== "\n") i++;
      out.push("\n");
    } else if (depth === 0) {
      out.push(cfgText[i]);
    }
  }
  const invariants = [];
  const properties = [];
  let target = null;
  for (const token of out.join("").split(/\s+/).filter(Boolean)) {
    if (CFG_KEYWORDS.has(token)) {
      target = token.startsWith("INVARIANT")
        ? invariants
        : token.startsWith("PROPERT")
          ? properties
          : null;
    } else if (target) {
      target.push(token);
    }
  }
  return { invariants, properties };
}

// entries: [{check, result: {pass}, sync: {state, files}}] in manifest order.
export function computeWarnings(entries) {
  const byId = new Map(entries.map((e) => [e.check.id, e]));
  const warnings = [];
  for (const { check, sync } of entries) {
    if (check.role === "contract") {
      if (!check.brokenBy) {
        warnings.push({
          code: W.NO_BROKEN_VARIANT,
          checkId: check.id,
          message: `contract ${check.id} has no brokenBy; nothing shows that the check turns red on a broken model`,
        });
      } else {
        const target = byId.get(check.brokenBy);
        const problem = brokenVariantProblem(check, target);
        if (problem) {
          warnings.push({
            code: W.BROKEN_VARIANT_MISMATCH,
            checkId: check.id,
            message: `brokenBy ${check.brokenBy} is not usable: ${problem}`,
          });
        }
      }
    }
    for (const f of sync.files) {
      if (f.state === "changed") {
        const diff = check.sync?.commit
          ? ` Start from: git diff ${check.sync.commit} -- '${f.path}'`
          : "";
        warnings.push({
          code: W.STALE_MODEL,
          checkId: check.id,
          message:
            `covered file ${f.path} changed since the model was last checked; re-read the model. ${diff}`.trim(),
        });
      } else if (f.state === "missing") {
        warnings.push({
          code: W.COVERS_MISSING,
          checkId: check.id,
          message: `covered file ${f.path} is missing (deleted or renamed); this is not the same as unchanged`,
          recover:
            "find where it was renamed to, re-read the model, and rewrite covers",
        });
      } else if (f.state === "unrecorded") {
        warnings.push({
          code: W.SYNC_UNRECORDED,
          checkId: check.id,
          message: `covered file ${f.path} has no recorded sha256`,
          recover: "copy the current value from --inspect into covers",
        });
      }
    }
  }
  return warnings;
}

function brokenVariantProblem(check, target) {
  if (!target) return "no check has that id";
  if (target.check.role !== "broken-variant")
    return "its role is not broken-variant";
  if (target.check.kind !== check.kind) return "its kind differs";
  if (target.check.property !== check.property) return "its property differs";
  if (!target.result.pass)
    return "the broken variant did not violate as expected";
  return null;
}
