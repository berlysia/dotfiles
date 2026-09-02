import { relative as pathRelative, resolve } from "node:path";
import { expandTilde } from "./path-utils.ts";
import { isStrictlyUnderProjectSubdir } from "./workflow-fs.ts";
import {
  deriveDefaultWorkflowDir,
  isValidSessionId,
  SESSIONS_ROOT,
} from "./workflow-paths.ts";

/**
 * Which premise failed, when `source` is `unresolvable`.
 *
 * Carried as a field rather than left to the consumer to guess: the startup
 * summary exists to tell the user why the guard is not armed, and a single
 * `unresolvable` value forces it either to stay silent about the cause or to
 * assert one -- and asserting one is worse, because the assertion is wrong
 * most of the time.
 *
 * `containment-unverifiable` names the check that failed, not a cause: the
 * check is "the derived dir is a strict descendant of a sessions root that
 * resolves to itself", and the predicate returns a boolean, so a redirected
 * base, a redirected leaf, a dangling leaf and a filesystem that could not
 * answer all arrive here indistinguishable. Any message built from this value
 * must name the check, never one of those causes.
 */
export type WorkflowDirUnresolvableReason =
  | "invalid-session-id"
  | "containment-unverifiable";

/**
 * A discriminated union rather than one shape with nullable fields, so that
 * `source !== "unresolvable"` narrows `dir` to `string` for the five hooks
 * that consume it. With a single interface it does not, and each consumer has
 * to re-check or assert -- redistributing to five call sites the "decide once,
 * display the same thing" property K1 exists to establish.
 *
 * It also makes the invalid combinations unrepresentable: a `reason` on a
 * resolved dir, or a `dir` on an unresolvable one.
 */
export type WorkflowDirResolution =
  | {
      source: "env" | "derived" | "env-rejected";
      dir: string;
      relative: string;
    }
  | {
      source: "unresolvable";
      dir: null;
      relative: null;
      reason: WorkflowDirUnresolvableReason;
    };

/**
 * Resolve the workflow dir from facts the hook already receives.
 *
 * Session id validity is checked first. A malformed id discards even a valid
 * pin, because `env-rejected` is defined as falling back to the derived value
 * and there is no derived value to fall back to.
 *
 * `relative` is always derived from the resolved absolute path, never from the
 * raw env string. It is the value hooks interpolate into deny reasons, so
 * letting it carry an unnormalized input would rebuild the display/decision
 * divergence spec K1 exists to remove.
 *
 * `unresolvable` is defined by an invariant, not by a list of causes: it is
 * returned whenever the derived dir `<cwd>/.tmp/sessions/<sid8>` is not a
 * strict descendant of a sessions root that resolves to itself. A malformed
 * session id, a redirected sessions root, a derived dir that is itself a
 * symlink out of the project, and a cwd that cannot be resolved all fail that
 * invariant. Enumerating them in a comment is how the list goes stale; the
 * `reason` field carries what the code actually distinguished.
 *
 * When it is returned no fs check runs at all and the workflow is treated as
 * inactive -- so a transient fs failure on any of these paths turns the gate
 * off for that one tool call, without raising an exception for K10 to report.
 * See spec K11 for why that residual is accepted.
 *
 * Note the asymmetry between what is checked and what is returned: containment
 * is decided on realpaths, but `dir` is the lexical path. Consumers compare
 * paths lexically (`isSpecPath` and friends use `startsWith(wfDir + "/")`), so
 * returning a realpath here would break them wherever the project is reached
 * through a symlink. Do not mix the two.
 */
export function resolveWorkflowDir(input: {
  cwd: string;
  sessionId: string;
}): WorkflowDirResolution {
  const { cwd, sessionId } = input;
  if (!isValidSessionId(sessionId)) {
    return {
      source: "unresolvable",
      dir: null,
      relative: null,
      reason: "invalid-session-id",
    };
  }

  // The sessions root is the basis for both branches below, so it is checked
  // once, before either. If it has been redirected, `env-rejected` cannot mean
  // what it is defined to mean -- "fall back to the derived value" -- because
  // the derived value would land under the same redirected base.
  const derivedRelative = deriveDefaultWorkflowDir(sessionId);
  const derivedAbsolute = resolve(cwd, derivedRelative);
  if (!isStrictlyUnderProjectSubdir(cwd, SESSIONS_ROOT, derivedAbsolute)) {
    return {
      source: "unresolvable",
      dir: null,
      relative: null,
      reason: "containment-unverifiable",
    };
  }
  const derived: WorkflowDirResolution = {
    source: "derived",
    dir: derivedAbsolute,
    relative: derivedRelative,
  };

  const envDir = process.env.DOCUMENT_WORKFLOW_DIR?.trim();
  if (!envDir) {
    return derived;
  }

  const envAbsolute = resolve(cwd, expandTilde(envDir));
  if (!isStrictlyUnderProjectSubdir(cwd, SESSIONS_ROOT, envAbsolute)) {
    return { ...derived, source: "env-rejected" };
  }
  // Containment is decided on realpaths, but `dir` goes to consumers that
  // compare lexically. A pin written through a different alias of the project
  // (`~/proj/...` while cwd is `/mnt/data/proj`) passes containment, yet every
  // `startsWith(dir + "/")` downstream then misses -- concrete dir on screen,
  // nothing matching underneath. Require the pin to be spelled the way cwd is.
  // Trailing-slash guard: resolve("/") is "/", so a naive template would build
  // the prefix "//" and reject every pin at the filesystem root.
  const cwdPrefix = `${resolve(cwd).replace(/\/+$/, "")}/`;
  if (!envAbsolute.startsWith(cwdPrefix)) {
    return { ...derived, source: "env-rejected" };
  }
  return {
    source: "env",
    dir: envAbsolute,
    relative: pathRelative(cwd, envAbsolute),
  };
}
