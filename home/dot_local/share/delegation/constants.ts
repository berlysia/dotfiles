/**
 * Every tunable line and threshold lives here so `delegation review` can print
 * the current values and a later revision touches one file. None of these come
 * from measurement; review is where they get revisited.
 */

/** Weekly pace line: percent = 100 * min(1, (elapsedDays + this) / 7). */
export const WEEK_LINE_EXTRA_DAYS = 1;
export const FIVE_HOUR_AHEAD_PERCENT = 90;
/** Lookahead: the week is ahead when spending at the observed rate for this long crosses the line. */
export const WEEK_LOOKAHEAD_HOURS = 3;
/** Lookahead: a forecast observed for less than this is not trusted. */
export const LOOKAHEAD_MIN_OBSERVED_HOURS = 2;
/** Forecast file: older than this (by its own `at` and its mtime) is stale. */
export const FORECAST_MAX_AGE_MINUTES = 25;
export const FORECAST_FUTURE_SKEW_SECONDS = 60;
/** Forecast file: the resetsAt of its week may differ from ai-usage's by this much. */
export const FORECAST_RESETS_TOLERANCE_HOURS = 1;
/** Forecast file: bounds that keep the printed numbers narrow. */
export const FORECAST_MAX_RATE = 100;
export const FORECAST_MAX_OBSERVED_HOURS = 168;
export const FORECAST_MAX_BYTES = 16 * 1024;
export const FORECAST_MAX_FILES = 256;
/** An external whose week has at least this many points unspent by the reset is worth trying. */
export const SURPLUS_MIN_POINTS = 25;
/** Rule 1: external adoption rate must beat Claude's by this many points. */
export const RECORD_GAP_POINTS = 15;
/**
 * Rule 0: with too few sonnet records to compare against, a free model whose
 * adoption rate is under this percent is dropped. Provisional; `delegation
 * review` is where it gets revisited.
 */
export const FREE_ADOPTION_FLOOR = 70;
/** Below this many records a group shows n<5 instead of a rate. */
export const MIN_RECORDS = 5;
export const LAPSE_RATIO_MAX_PERCENT = 30;
export const EXPLORE_WINDOW_DAYS = 60;
export const EXPLORE_MIN_RECORDS = 5;
export const REVIEW_AFTER_RECORDS = 10;
export const REVIEW_AFTER_DAYS = 14;
export const STALE_PENDING_DAYS = 7;
export const PENDING_LIMIT = 200;
export const DEFAULT_SINCE_DAYS = 60;
/** review: a group past this count meets the auto-rewrite revisit condition. */
export const AUTO_REWRITE_REVISIT_RECORDS = 20;
/** review: rule 1 (records only) must have named the same destination for this many days. */
export const AUTO_REWRITE_STABLE_DAYS = 30;

export const LEDGER_LARGE_BYTES = 5 * 1024 * 1024;
export const ROW_MAX_BYTES = 4096;
export const STDIN_MAX_BYTES = 16 * 1024;
export const NOTE_MAX_BYTES = 1000;
export const NOTE_MAX_CHARS = 500;
export const NOTE_DISPLAY_CHARS = 80;
export const INVOCATION_MAX_WORDS = 8;
export const MAX_DURATION_MS = 86_400_000;
export const MAX_COUNT = 999;

export const LOCK_RETRIES = 25;
export const LOCK_RETRY_DELAY_MS = 20;
export const LOCK_STALE_MS = 10_000;
export const AI_USAGE_TIMEOUT_MS = 30_000;

/**
 * Model names that may appear verbatim in output. Anything else is shown as
 * `m-<sha256 prefix>` so a model string chosen by a caller never reaches the
 * model's context. Add a name here when review lists an `m-` group.
 */
export const KNOWN_MODELS: readonly string[] = [
  "sonnet",
  "opus",
  "haiku",
  "fable",
  "inherit",
  "unknown",
  "gpt-6.1-terra",
  "gpt-6-luna",
  "zai-coding-plan/glm-5.3",
  "sarashina/sarashina3.2-mini-thinking",
  "opencode/deepseek-v4.1-flash-free",
  "opencode/glm-5.3-flash-free",
];

/** Whether a delegation's content may leave the machine. */
export type Exposure = "closed" | "external-ok";
export const EXPOSURES: readonly Exposure[] = ["closed", "external-ok"];
export function isExposure(v: string): v is Exposure {
  return (EXPOSURES as readonly string[]).includes(v);
}

export const OFFLOAD_AGENT_READ = "worktree-read";
export const OFFLOAD_AGENT_EDIT = "worktree-edit";
export function offloadAgentName(write: boolean): string {
  return write ? OFFLOAD_AGENT_EDIT : OFFLOAD_AGENT_READ;
}

/** Directory name under the ledger dir for verified.json and offload.log. */
export const OFFLOAD_DIR_NAME = "offload";
