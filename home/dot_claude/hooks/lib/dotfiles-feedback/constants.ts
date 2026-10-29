export const FEEDBACK_REPO = "berlysia/dotfiles-feedback";
export const PUBLIC_REPO = "berlysia/dotfiles";
export const FEEDBACK_OWNER = "berlysia";
export const SCHEMA_VERSION = 1;
export const FEEDBACK_LABEL = "dotfiles-feedback";
export const FEEDBACK_KINDS = ["bug", "improvement", "missing"] as const;
export const FEEDBACK_LABELS = [
  FEEDBACK_LABEL,
  ...FEEDBACK_KINDS.map((kind) => `kind:${kind}`),
  "triaged:issue",
  "triaged:plan",
  "triaged:reject",
] as const;
export const FEEDBACK_AGENTS = [
  "claude",
  "codex",
  "opencode",
  "human",
  "unknown",
] as const;
export const FEEDBACK_ERRORS = [
  "auth",
  "network",
  "not-private",
  "gh-missing",
  "other",
] as const;
export const FIELD_LIMITS = {
  title: 80,
  target: 200,
  body: 8 * 1024,
  reason: 500,
  repoKey: 200,
  host: 100,
} as const;
export const LOCAL_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/;
export const VM_ID_PATTERN = /^vm-[0-9a-f]{24}$/;
export const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const LOCAL_ID_RANDOM_BYTES = 6;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const LAST_FLUSH_MAX_AGE_MS = DAY_MS;
export const FLUSH_LOCK_STALE_MS = 35 * 60 * 1000;
export const RETRY_LOCK_STALE_MS = 30 * 1000;
export const REFRESH_LOCK_STALE_MS = 5 * 60 * 1000;
export const CLAIM_STALE_MS = 10 * 60 * 1000;
export const ITEM_DEADLINE_MS = 3 * 60 * 1000;
export const GH_TIMEOUT_MS = 30 * 1000;
export const MAX_PENDING_PER_ORIGIN = 50;
export const MAX_HELD = 50;
export const MAX_FLUSH_ITEMS = 10;
export const MAX_FLUSH_REACQUIRES = 3;
export const RETRY_BASE_MS = 60 * 1000;
export const RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
export const MAX_RETRY_ATTEMPTS = 20;
export const FAILED_RETENTION_MS = 30 * DAY_MS;
export const MAX_SENT_LINES = 1000;
export const GH_PAGE_SIZE = 100;
export const MAX_VM_OUTBOX_ITEMS = 50;
export const MAX_VM_FILE_BYTES = 16 * 1024;
export const MAX_VM_INGEST_ITEMS = 50;
export const MAX_VM_SCAN_ENTRIES = 200;
export const MAX_VM_FAILED_ITEMS = 100;
export const MAX_VM_DAILY_ITEMS = 100;
export const CACHE_TEMP_RANDOM_BYTES = 6;
export const FLUSH_LOCK_FILE = "state/flush.lock";
export const LABELS_STATE_FILE = "state/labels.json";
export const LABELS_STATE_MAX_BYTES = 4 * 1024;
export const DOTFILES_REPO_KEY = "github.com/berlysia/dotfiles";
export const RECENT_TRIAGE_WINDOW_MS = 7 * DAY_MS;
export const MAX_RECENT_TRIAGE = 20;
export const INBOX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const ERROR_HINTS: Record<string, string> = {
  auth: "gh auth login を実行する",
  network: "ネットワークを確認する",
  "not-private": "宛先のリポジトリが private で berlysia のものか確認する",
  "gh-missing": "gh をインストールする",
  other: "時間をおいて flush を再実行する",
};
