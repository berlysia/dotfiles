#!/usr/bin/env node
// Entrypoint: formal-check <formal.json> [--json] [--explore]
//             formal-check <formal.json> --inspect [--json]
//             formal-check <formal.json> --expect-digest <sha256> [--json] [--explore]
// Every import is relative to this file, so a copy of the scripts/ dir runs
// wherever it lands.
import { performance } from "node:perf_hooks";
import { MANIFEST, PRE_RUN, RUN } from "./lib/codes.mjs";
import { ADAPTERS } from "./lib/adapters/index.mjs";
import { computeDigest, moduleErrors } from "./lib/hash.mjs";
import { buildInspect } from "./lib/inspect.mjs";
import { loadManifest } from "./lib/manifest.mjs";
import { shutdown } from "./lib/proc.mjs";
import {
  buildReport,
  renderInspectTable,
  renderTable,
  serializeJson,
} from "./lib/report.mjs";
import { checkAvailability, resolveRuntime } from "./lib/runtime.mjs";
import { sanitize } from "./lib/sanitize.mjs";
import { computeSync } from "./lib/sync.mjs";
import { computeWarnings, isPass, judge } from "./lib/verdict.mjs";

const USAGE =
  "usage: run.mjs <formal.json> [--json] [--explore] [--expect-digest <sha256>]\n" +
  "       run.mjs <formal.json> --inspect [--json]";

// Children get SIGKILL on their whole group before we leave, and temp dirs are
// removed, so an interrupted run leaves neither model processes nor files.
function onSignal() {
  shutdown();
  process.exit(2);
}
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
process.on("SIGHUP", onSignal);

function parseArgv(argv) {
  const options = {
    json: false,
    explore: false,
    inspect: false,
    expectDigest: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--explore") options.explore = true;
    else if (arg === "--inspect") options.inspect = true;
    else if (arg === "--expect-digest") {
      const value = argv[++i];
      if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) {
        return {
          ok: false,
          message: "--expect-digest needs a 64-digit lowercase hex value",
        };
      }
      options.expectDigest = value;
    } else if (arg.startsWith("--"))
      return { ok: false, message: `unknown flag ${arg}` };
    else positional.push(arg);
  }
  if (positional.length !== 1) {
    return {
      ok: false,
      message: `expected exactly one manifest path, got ${positional.length}`,
    };
  }
  if (options.inspect && (options.explore || options.expectDigest !== null)) {
    return { ok: false, message: "--inspect can only be combined with --json" };
  }
  return { ok: true, file: positional[0], options };
}

function emit(text, exitCode) {
  process.stdout.write(text);
  process.exitCode = exitCode;
}

async function runChecks(loaded, explore) {
  const { checks } = loaded.manifest;
  const runtime = resolveRuntime(process.env);
  const availability = await checkAvailability(
    [...new Set(checks.map((c) => c.kind))],
    runtime,
  );
  const results = [];
  for (const check of checks) {
    const sync = computeSync(check);
    const started = performance.now();
    const envelope = await observe(check, availability[check.kind], {
      runtime,
      repoRoot: loaded.repoRoot,
      timeoutMs: check.timeoutSec * 1000,
    });
    const judged = judge(check, envelope);
    results.push({
      check,
      sync,
      judged,
      durationMs: Math.round(performance.now() - started),
      pass: isPass(judged.verdict, check.expect),
    });
  }
  const warnings = computeWarnings(
    results.map(({ check, sync, pass }) => ({ check, sync, result: { pass } })),
  );
  return buildReport({
    checks: results.map(({ check, sync, judged, durationMs, pass }) => ({
      id: check.id,
      kind: check.kind,
      role: check.role,
      expect: check.expect,
      verdict: judged.verdict,
      pass,
      witness: judged.witness,
      error: judged.error
        ? { code: judged.error.code, message: judged.error.message }
        : null,
      recover: judged.error?.recover ?? null,
      durationMs,
      note: check.note,
      sync: {
        commit: check.sync?.commit ?? null,
        state: sync.state,
        files: sync.files,
      },
    })),
    warnings,
    explore,
  });
}

async function observe(check, availability, ctx) {
  if (!availability.ok) {
    const { code, message, recover } = availability;
    return { ok: false, error: { code, message, recover } };
  }
  if (!Object.hasOwn(ADAPTERS, check.kind)) {
    return {
      ok: false,
      error: {
        code: RUN.INTERNAL_ERROR,
        message: `no adapter for kind "${check.kind}"`,
      },
    };
  }
  try {
    return await ADAPTERS[check.kind].run(check, ctx);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: RUN.INTERNAL_ERROR,
        message: `adapter failed: ${error.message}`,
      },
    };
  }
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.ok) {
    if (process.argv.includes("--json")) {
      const report = buildReport({
        manifestErrors: [{ code: PRE_RUN.USAGE, message: parsed.message }],
      });
      emit(serializeJson(report), 2);
    } else {
      process.stderr.write(`${sanitize(parsed.message)}\n${USAGE}\n`);
      process.exitCode = 2;
    }
    return;
  }
  const { file, options } = parsed;
  const loaded = loadManifest(file);

  if (options.inspect) {
    let inspect;
    try {
      inspect = buildInspect(loaded, resolveRuntime(process.env));
    } catch (error) {
      inspect = {
        ...buildInspect({ ok: false, errors: [] }, resolveRuntime(process.env)),
        manifestErrors: [
          { code: MANIFEST.MISSING_FILE, message: error.message },
        ],
      };
    }
    emit(
      options.json ? serializeJson(inspect) : renderInspectTable(inspect),
      inspect.manifestErrors.length > 0 ? 2 : 0,
    );
    return;
  }

  let report;
  // Sibling TLA+ modules are read by TLC, so a bad one (outside the model's
  // dir, a Java binary next to the model) stops the run before any digest is
  // computed or any check starts.
  const preRunErrors = loaded.ok ? moduleErrors(loaded) : [];
  if (!loaded.ok) {
    report = buildReport({
      manifestErrors: loaded.errors,
      explore: options.explore,
    });
  } else if (preRunErrors.length > 0) {
    report = buildReport({
      manifestErrors: preRunErrors,
      explore: options.explore,
    });
  } else if (
    options.expectDigest !== null &&
    !digestMatches(loaded, options.expectDigest)
  ) {
    report = buildReport({
      manifestErrors: [
        {
          code: PRE_RUN.DIGEST_MISMATCH,
          message:
            "the manifest or a declared file changed since the digest was approved; nothing was run",
          recover:
            "run --inspect again, show the result to the user, and ask for approval",
        },
      ],
    });
  } else {
    report = await runChecks(loaded, options.explore);
  }
  emit(
    options.json
      ? serializeJson(report)
      : renderTable(report, { explore: options.explore }),
    report.exitCode,
  );
}

function digestMatches(loaded, expected) {
  try {
    return computeDigest(loaded) === expected;
  } catch {
    return false;
  }
}

await main();
