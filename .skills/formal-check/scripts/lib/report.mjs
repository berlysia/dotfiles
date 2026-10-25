// Turns results into the exit code, the --json document and the human table.
import { sanitize, sanitizeDeep } from "./sanitize.mjs";
import { HARNESS_VERSION } from "./version.mjs";

// 2 (manifest error or a check error) > 1 (mismatch, or a warning outside
// --explore) > 0. --explore only relaxes warnings: a mismatch is still a
// finding, and an error still means the run proved nothing.
export function exitCodeOf({ manifestErrors, checks, warnings, explore }) {
  if (manifestErrors.length > 0 || checks.some((c) => c.verdict === "error"))
    return 2;
  if (checks.some((c) => !c.pass) || (!explore && warnings.length > 0))
    return 1;
  return 0;
}

const STATUS = ["pass", "fail", "error"];

export function buildReport({
  manifestErrors = [],
  checks = [],
  warnings = [],
  explore = false,
}) {
  const exitCode = exitCodeOf({ manifestErrors, checks, warnings, explore });
  return {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    status: STATUS[exitCode],
    exitCode,
    manifestErrors,
    checks,
    warnings,
  };
}

export function serializeJson(document) {
  return `${JSON.stringify(sanitizeDeep(document), null, 2)}\n`;
}

const s = sanitize;

function witnessText(witness) {
  return typeof witness === "string" ? witness : JSON.stringify(witness);
}

export function renderTable(report, { explore = false } = {}) {
  const lines = [];
  for (const error of report.manifestErrors) {
    lines.push(`manifest error [${s(error.code)}]: ${s(error.message)}`);
    if (error.recover) lines.push(`  Recover with: ${s(error.recover)}`);
  }
  for (const check of report.checks) {
    const label = check.error ? "ERROR" : check.pass ? "PASS " : "FAIL ";
    lines.push(
      `${label} ${s(check.id)}  ${s(check.kind)}/${s(check.role)}  expect=${s(check.expect)} verdict=${s(check.verdict)}  (${check.durationMs} ms)`,
    );
    if (check.error)
      lines.push(
        `      error [${s(check.error.code)}]: ${s(check.error.message)}`,
      );
    if (check.recover) lines.push(`      Recover with: ${s(check.recover)}`);
    if (check.witness !== null && check.witness !== undefined) {
      lines.push(`      witness: ${s(witnessText(check.witness))}`);
    }
    if (check.sync.state === "empty") {
      lines.push(
        `      sync: no covers${check.note ? ` (note: ${s(check.note)})` : ""}`,
      );
    } else if (check.sync.state !== "none" && check.sync.state !== "clean") {
      const detail = check.sync.files
        .filter((f) => f.state !== "clean")
        .map((f) => `${s(f.path)}: ${f.state}`)
        .join(", ");
      lines.push(`      sync: ${check.sync.state} (${detail})`);
    }
  }
  for (const warning of report.warnings) {
    lines.push(
      `warning [${s(warning.code)}] ${s(warning.checkId)}: ${s(warning.message)}`,
    );
    if (warning.recover) lines.push(`  Recover with: ${s(warning.recover)}`);
  }
  lines.push(
    `status: ${report.status} (exit ${report.exitCode})${explore && report.warnings.length > 0 ? " - warnings do not affect the exit code under --explore" : ""}`,
  );
  return `${lines.join("\n")}\n`;
}

export function renderInspectTable(inspect) {
  const lines = [];
  for (const error of inspect.manifestErrors) {
    lines.push(`manifest error [${s(error.code)}]: ${s(error.message)}`);
  }
  if (inspect.digest) lines.push(`digest: ${inspect.digest}`);
  for (const check of inspect.checks) {
    lines.push(`${s(check.id)}  ${s(check.kind)}/${s(check.role)}`);
    lines.push(
      `  model: ${s(check.model.path)}  ${check.model.sha256 ?? "unreadable"}`,
    );
    if (check.cfg)
      lines.push(
        `  cfg: ${s(check.cfg.path)}  ${check.cfg.sha256 ?? "unreadable"}`,
      );
    for (const file of check.imports) {
      lines.push(`  import: ${s(file.path)}  ${file.sha256 ?? "unreadable"}`);
    }
    for (const cover of check.covers) {
      lines.push(
        `  covers: ${s(cover.path)}  ${cover.state}  recorded=${cover.recorded ?? "null"} current=${cover.current ?? "null"}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
