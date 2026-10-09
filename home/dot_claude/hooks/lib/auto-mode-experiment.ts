import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { getHomeDir } from "./path-utils.ts";

// Single home of everything the report script (writer), session.ts (reader)
// and the settings merge script (bash; checked by a drift test) agree on.
export const EXPERIMENT_DIR_FROM_HOME = ".claude/logs/auto-mode-experiment";
export const DEPLOYED_AT_FILE = "deployed-at";
export const SUMMARY_FILE = "summary.json";
export const GUARD_COMMAND_FRAGMENT =
  "implementations/home-destruction-guard.ts";
/** POSIX ERE so that bash `[[ =~ ]]` and `new RegExp` read the same literal. */
export const DEPLOYED_AT_ERE =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$";
export const SCHEDULED_DATES = [
  "2026-10-12",
  "2026-10-17",
  "2026-10-24",
] as const;
/** First local day on which the deadline notice appears. */
export const DEADLINE_NOTICE_FROM = "2026-10-25";
export const REPORT_COMMAND =
  "bun ~/.claude/scripts/auto-mode-experiment-report.ts --write";
export const ROLLBACK_INSTRUCTION =
  "set claude_hooks.auto_approval to true in home/.chezmoidata/claude_hooks.yaml, then run `chezmoi apply` from a terminal";
const MAX_READ_BYTES = 64 * 1024;
const DEPLOYED_AT_READ_BYTES = 64;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ExperimentSummary {
  generatedAt: string;
  /** Date in the report file name, chosen by the writer; the reader does not derive it. */
  reportDate: string;
  wouldDenyAccepted: number;
  wouldDenyRejected: number;
}
export type DeployedAt =
  | { kind: "ok"; at: number }
  | { kind: "missing" }
  | { kind: "invalid" };
export interface ExperimentState {
  guardRegistered: boolean;
  deployedAt: DeployedAt;
  summary: {
    generatedAtMs: number;
    reportDate: string;
    accepted: number | null;
    rejected: number | null;
  } | null;
}

export function experimentDir(home: string = getHomeDir()): string {
  return join(home, EXPERIMENT_DIR_FROM_HOME);
}

export function reportPath(dir: string, date: string): string {
  if (!DATE_PATTERN.test(date)) {
    throw new Error(`invalid report date: ${date}`);
  }
  return join(dir, `report-${date}.md`);
}

export function localMidnight(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(
    y ?? Number.NaN,
    (m ?? Number.NaN) - 1,
    d ?? Number.NaN,
  ).getTime();
}

export function localDate(ms: number): string {
  const date = new Date(ms);
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function isGuardRegistered(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (typeof hooks !== "object" || hooks === null) return false;
  const preToolUse = (hooks as { PreToolUse?: unknown }).PreToolUse;
  if (!Array.isArray(preToolUse)) return false;
  return preToolUse.some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const inner = (entry as { hooks?: unknown }).hooks;
    if (!Array.isArray(inner)) return false;
    return inner.some((hook: unknown) => {
      if (typeof hook !== "object" || hook === null) return false;
      const command = (hook as { command?: unknown }).command;
      return (
        typeof command === "string" && command.includes(GUARD_COMMAND_FRAGMENT)
      );
    });
  });
}

function isRegularFile(path: string): { size: number } | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? { size: stat.size } : null;
  } catch {
    return null;
  }
}

function readDeployedAt(file: string, now: number): DeployedAt {
  try {
    lstatSync(file);
  } catch {
    return { kind: "missing" };
  }
  if (isRegularFile(file) === null) return { kind: "invalid" };
  try {
    const fd = openSync(file, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(DEPLOYED_AT_READ_BYTES);
      const length = readSync(fd, buffer, 0, DEPLOYED_AT_READ_BYTES, 0);
      text = Buffer.from(
        buffer.subarray(0, length).filter((byte) => byte !== 0),
      ).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const line = text.split("\n")[0] ?? "";
    const match = new RegExp(DEPLOYED_AT_ERE).exec(line);
    if (match === null) return { kind: "invalid" };
    const nowIso = `${new Date(now).toISOString().slice(0, 19)}Z`;
    if (line > nowIso) return { kind: "invalid" };
    const [year, month, day, hour, minute, second] = line
      .split(/[-T:Z]/)
      .map(Number);
    const at = Math.min(
      Date.UTC(
        year ?? Number.NaN,
        (month ?? Number.NaN) - 1,
        day ?? Number.NaN,
        hour ?? Number.NaN,
        minute ?? Number.NaN,
        second ?? Number.NaN,
      ),
      now,
    );
    return Number.isFinite(at) ? { kind: "ok", at } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function toCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function readSummary(file: string, now: number): ExperimentState["summary"] {
  const info = isRegularFile(file);
  if (info === null || info.size > MAX_READ_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const generatedAt = record["generatedAt"];
    const reportDate = record["reportDate"];
    if (typeof generatedAt !== "string") return null;
    const generatedAtMs = Date.parse(generatedAt);
    if (!Number.isFinite(generatedAtMs) || generatedAtMs > now) return null;
    if (typeof reportDate !== "string" || !DATE_PATTERN.test(reportDate))
      return null;
    return {
      generatedAtMs,
      reportDate,
      accepted: toCount(record["wouldDenyAccepted"]),
      rejected: toCount(record["wouldDenyRejected"]),
    };
  } catch {
    return null;
  }
}

export function readExperimentState(
  opts: { home?: string; now?: number } = {},
): ExperimentState {
  const home = opts.home ?? getHomeDir();
  const now = opts.now ?? Date.now();
  const dir = experimentDir(home);

  let guardRegistered = false;
  try {
    guardRegistered = isGuardRegistered(
      JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")),
    );
  } catch {
    guardRegistered = false;
  }

  return {
    guardRegistered,
    deployedAt: readDeployedAt(join(dir, DEPLOYED_AT_FILE), now),
    summary: readSummary(join(dir, SUMMARY_FILE), now),
  };
}

export function experimentNotices(
  now: number,
  state: ExperimentState,
): string[] {
  if (!state.guardRegistered) return [];

  const notices: string[] = [];
  const deadlineNotice =
    now >= localMidnight(DEADLINE_NOTICE_FROM)
      ? `[auto-mode experiment] the deadline (2026-10-24) has passed. To roll back: ${ROLLBACK_INSTRUCTION}`
      : null;

  if (state.deployedAt.kind !== "ok") {
    notices.push(
      "[auto-mode experiment] cannot read the deployment time. Run `chezmoi apply` to re-create it; if apply prints a WARNING about deployed-at, follow it.",
    );
    if (deadlineNotice !== null) notices.push(deadlineNotice);
    return notices;
  }

  const deployedAtMs = state.deployedAt.at;
  const due = SCHEDULED_DATES.filter(
    (d) => localMidnight(d) > deployedAtMs && now >= localMidnight(d),
  );
  const shown =
    state.summary !== null && state.summary.generatedAtMs > deployedAtMs
      ? state.summary
      : null;
  const lastDue = due[due.length - 1];

  if (
    lastDue !== undefined &&
    (shown === null || shown.generatedAtMs < localMidnight(lastDue))
  ) {
    notices.push(
      `[auto-mode experiment] report not produced for the scheduled date ${lastDue}. Run: ${REPORT_COMMAND}`,
    );
  }

  if (shown !== null) {
    let line = `[auto-mode experiment] report ${reportPath(experimentDir(), shown.reportDate)} (${shown.reportDate})`;
    if (shown.accepted !== null && shown.rejected !== null) {
      line += ` — hook-would-deny calls executed: ${shown.accepted}, blocked: ${shown.rejected}`;
    }
    if (shown.accepted !== null && shown.accepted >= 1) {
      line = `要確認: ${line}. To roll back: ${ROLLBACK_INSTRUCTION}`;
    }
    notices.push(line);
  }

  if (deadlineNotice !== null) notices.push(deadlineNotice);
  return notices;
}
