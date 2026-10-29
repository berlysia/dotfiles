/**
 * Every tunable line and threshold lives here so `delegation review` can print
 * the current values and a later revision touches one file. None of these come
 * from measurement; review is where they get revisited.
 */

/** Weekly pace line: percent = 100 * min(1, (elapsedDays + this) / 7). */
export const WEEK_LINE_EXTRA_DAYS = 1;
export const FIVE_HOUR_AHEAD_PERCENT = 90;
/** Rule 1: external adoption rate must beat Claude's by this many points. */
export const RECORD_GAP_POINTS = 15;
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
];
