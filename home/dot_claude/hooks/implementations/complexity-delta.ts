#!/usr/bin/env -S bun run --silent

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { logComplexity } from "../lib/centralized-logging.ts";
import {
  type Baseline,
  type Report,
  diffReports,
  formatNotice,
  hashNotice,
  isUsableCccc,
  listCcccCandidates,
  parseCcccOutput,
  shownFindings,
  toBaseline,
} from "../lib/complexity-delta.ts";
import { getHomeDir } from "../lib/path-utils.ts";
import { pruneStaleBaselines } from "../lib/working-tree-fingerprint.ts";

/**
 * Tells the user, at the end of a turn, which functions became markedly more
 * complex during it. Measures the whole repository with cccc at the prompt and
 * again at the stop, and compares the two in memory.
 *
 * Never blocks and never adds to the model's context: the notice goes out as a
 * systemMessage only. Paths and function names belong to the opened repository,
 * so they must not become model input on every turn.
 */

const DEFAULT_CCCC_TIMEOUT_MS = 1000;
const CCCC_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 2000;
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_TIMEOUTS = 2;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RECOVERY_NOT_FOUND =
  "Put a real cccc binary on PATH (with mise: `mise install`). mise shims are not used.";

type HookEnv = {
  stateDir: string;
  pathEnv: string | undefined;
  ccccTimeoutMs: number;
};

type DisabledReason = "timeout" | "schema";

/** Belongs to one repository root. A different root starts from a fresh state. */
type State = {
  version: 1;
  root: string;
  baseline: Baseline | null;
  /** SHA-256 of the notice already shown this turn, so a re-fired Stop does not repeat it. */
  shown: string | null;
  timeouts: number;
  disabled?: DisabledReason;
};

type Outcome =
  | { kind: "ok"; report: Report; binary: string }
  | { kind: "not-found" }
  | { kind: "timeout" | "schema" | "failed"; binary: string };

type Failure = Exclude<Outcome, { kind: "ok" }>;

type ComplexityLogFields = Parameters<typeof logComplexity>[0];

function defaultEnv(): HookEnv {
  return {
    stateDir: join(getHomeDir(), ".claude", "state", "complexity-delta"),
    pathEnv: process.env.PATH,
    ccccTimeoutMs: DEFAULT_CCCC_TIMEOUT_MS,
  };
}

function freshState(root: string): State {
  return { version: 1, root, baseline: null, shown: null, timeouts: 0 };
}

function isBaseline(value: unknown): value is Baseline {
  if (typeof value !== "object" || value === null) return false;
  const { functions, parseErrorFiles } = value as Record<string, unknown>;
  if (
    typeof functions !== "object" ||
    functions === null ||
    Array.isArray(functions)
  ) {
    return false;
  }
  if (!Array.isArray(parseErrorFiles)) return false;
  if (!parseErrorFiles.every((path) => typeof path === "string")) return false;
  return Object.values(functions).every(
    (values) =>
      Array.isArray(values) && values.every((n) => typeof n === "number"),
  );
}

function isState(value: unknown): value is State {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    typeof state.root === "string" &&
    (state.baseline === null || isBaseline(state.baseline)) &&
    (state.shown === null || typeof state.shown === "string") &&
    typeof state.timeouts === "number" &&
    Number.isInteger(state.timeouts) &&
    state.timeouts >= 0 &&
    (state.disabled === undefined ||
      state.disabled === "timeout" ||
      state.disabled === "schema")
  );
}

type ReadResult =
  | { kind: "ok"; state: State }
  | { kind: "missing" }
  | { kind: "invalid" };

function readState(statePath: string): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isState(parsed)
      ? { kind: "ok", state: parsed }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function writeState(statePath: string, state: State): void {
  const stateDir = dirname(statePath);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmpPath = `${statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    // rename replaces a symlink at statePath instead of writing through it.
    renameSync(tmpPath, statePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // nothing to clean up
    }
    throw error;
  }
}

function resolveRoot(cwd: string): string | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return root === "" ? null : root;
  } catch {
    return null;
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function resolveCccc(env: HookEnv, root: string, cwd: string): string | null {
  const excludedRoots = [root, cwd]
    .map(realpathOrNull)
    .filter((path): path is string => path !== null);
  for (const candidate of listCcccCandidates(env.pathEnv)) {
    const realPath = realpathOrNull(candidate);
    if (realPath !== null && isUsableCccc(realPath, excludedRoots))
      return realPath;
  }
  return null;
}

function measure(env: HookEnv, root: string, cwd: string): Outcome {
  const binary = resolveCccc(env, root, cwd);
  if (binary === null) return { kind: "not-found" };
  let stdout: string;
  try {
    stdout = execFileSync(
      binary,
      ["--no-config", "--exclude", ".git/**", "."],
      {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: env.ccccTimeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: CCCC_MAX_BUFFER,
      },
    );
  } catch (error) {
    const timedOut = (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return { kind: timedOut ? "timeout" : "failed", binary };
  }
  const report = parseCcccOutput(stdout);
  return report === null
    ? { kind: "schema", binary }
    : { kind: "ok", report, binary };
}

/** Anything thrown between measuring and comparing counts as a failed measurement. */
function attempt<T>(compute: () => T): T | null {
  try {
    return compute();
  } catch {
    return null;
  }
}

type Call = {
  env: HookEnv;
  root: string;
  cwd: string;
  statePath: string;
  sessionId: string;
};

type Step = { state: State; logs: ComplexityLogFields[]; message?: string };

/**
 * What a measurement that produced no report does to the state, what to log,
 * and what to say. Pure: the caller writes the state first and logs afterwards,
 * so a failed write never leaves a "turned off" record with nothing behind it.
 */
function planFailure(state: State, failure: Failure, call: Call): Step {
  const { root } = state;
  const { statePath } = call;
  if (failure.kind === "not-found") {
    return {
      state: { ...state, timeouts: 0 },
      logs: [
        {
          kind: "skip",
          root,
          reason: "cccc-not-found",
          recovery: RECOVERY_NOT_FOUND,
        },
      ],
    };
  }
  const { binary } = failure;
  const skip: ComplexityLogFields = {
    kind: "skip",
    root,
    reason: failure.kind,
    binary,
  };
  if (failure.kind === "failed") {
    return { state: { ...state, timeouts: 0 }, logs: [skip] };
  }
  if (failure.kind === "schema") {
    return {
      state: { ...state, timeouts: 0, disabled: "schema" },
      logs: [
        skip,
        {
          kind: "disabled",
          root,
          reason: "schema",
          binary,
          recovery: statePath,
        },
      ],
      message: `[complexity-delta] cccc output did not match the expected shape (binary: ${binary}). Complexity checks are off for this repository in this session. State file: ${statePath}`,
    };
  }
  const timeouts = state.timeouts + 1;
  if (timeouts < MAX_CONSECUTIVE_TIMEOUTS) {
    return { state: { ...state, timeouts }, logs: [skip] };
  }
  return {
    state: { ...state, timeouts, disabled: "timeout" },
    logs: [
      skip,
      {
        kind: "disabled",
        root,
        reason: "timeout",
        binary,
        recovery: statePath,
      },
    ],
    message: `[complexity-delta] cccc exceeded ${call.env.ccccTimeoutMs}ms twice in a row. Complexity checks are off for this repository in this session. State file: ${statePath}`,
  };
}

function commit(step: Step, call: Call): string | undefined {
  writeState(call.statePath, step.state);
  for (const fields of step.logs) logComplexity(fields, call.sessionId);
  return step.message;
}

function onPrompt(call: Call): string | undefined {
  const { env, root, cwd, statePath, sessionId } = call;
  const read = readState(statePath);
  if (read.kind === "invalid") {
    logComplexity({ kind: "skip", root, reason: "state" }, sessionId);
  }
  const state =
    read.kind === "ok" && read.state.root === root
      ? read.state
      : freshState(root);
  if (state.disabled !== undefined) return undefined;

  pruneStaleBaselines(env.stateDir, STATE_MAX_AGE_MS);

  const turnStart: State = { ...state, shown: null };
  const outcome = measure(env, root, cwd);
  if (outcome.kind === "ok") {
    const baseline = attempt(() => toBaseline(outcome.report));
    if (baseline !== null) {
      return commit(
        { state: { ...turnStart, baseline, timeouts: 0 }, logs: [] },
        call,
      );
    }
  }
  const failure: Failure =
    outcome.kind === "ok"
      ? { kind: "failed", binary: outcome.binary }
      : outcome;
  // A stale baseline would turn several turns of change into this turn's finding.
  return commit(
    planFailure({ ...turnStart, baseline: null }, failure, call),
    call,
  );
}

function onStop(call: Call): string | undefined {
  const { env, root, cwd, statePath, sessionId } = call;
  const read = readState(statePath);
  if (read.kind === "invalid") {
    logComplexity({ kind: "skip", root, reason: "state" }, sessionId);
  }
  if (read.kind !== "ok") return undefined;
  const { state } = read;
  const { baseline } = state;
  if (
    state.root !== root ||
    state.disabled !== undefined ||
    baseline === null
  ) {
    return undefined;
  }

  const outcome = measure(env, root, cwd);
  const notice =
    outcome.kind === "ok"
      ? attempt(() => {
          const findings = diffReports(baseline, outcome.report);
          return { findings, text: formatNotice(findings) };
        })
      : null;
  if (outcome.kind !== "ok" || notice === null) {
    const failure: Failure =
      outcome.kind === "ok"
        ? { kind: "failed", binary: outcome.binary }
        : outcome;
    return commit(planFailure(state, failure, call), call);
  }

  const { findings, text } = notice;
  if (findings.length === 0) {
    return commit(
      { state: { ...state, timeouts: 0, shown: null }, logs: [] },
      call,
    );
  }
  const digest = hashNotice(text);
  if (digest === state.shown) {
    return commit({ state: { ...state, timeouts: 0 }, logs: [] }, call);
  }
  return commit(
    {
      state: { ...state, timeouts: 0, shown: digest },
      logs: [{ kind: "notice", root, findings: shownFindings(findings) }],
      message: text,
    },
    call,
  );
}

export function createHook(getEnv: () => HookEnv = defaultEnv) {
  return defineHook({
    trigger: { Stop: true, UserPromptSubmit: true },
    run: (context) => {
      try {
        const { cwd, session_id: sessionId } = context.input;
        if (!SESSION_ID_PATTERN.test(sessionId)) return context.success({});
        const root = resolveRoot(cwd);
        if (root === null) return context.success({});

        const env = getEnv();
        const call: Call = {
          env,
          root,
          cwd,
          statePath: join(env.stateDir, `${sessionId}.json`),
          sessionId,
        };
        // context.json's `event` is only type-checked against the trigger; it is
        // not tied to the runtime event, so branch on the input explicitly.
        if (context.input.hook_event_name === "UserPromptSubmit") {
          const message = onPrompt(call);
          return message === undefined
            ? context.success({})
            : context.json({
                event: "UserPromptSubmit",
                output: { systemMessage: message },
              });
        }
        const message = onStop(call);
        return message === undefined
          ? context.success({})
          : context.json({ event: "Stop", output: { systemMessage: message } });
      } catch (error) {
        console.error(`[complexity-delta] Error: ${error}`);
        return context.success({});
      }
    },
  });
}

const hook = createHook();

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
