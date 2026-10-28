// The other providers' usage (`ai-usage --summary`), shared by every session.
// The mod builds the file and decides when to fetch; statusline.ts turns the
// file into the line's tail. Both load this module, so it must import neither
// `node:*` nor `$` (as line-file.ts).

export type ExternalWindow = { used: number; resetsAt: number | null };
export type ExternalProvider = {
  ok: boolean;
  fiveHour: ExternalWindow | null;
  weekly: ExternalWindow | null;
  /** Refused with no window at 100%: such a refusal carries no reset time. */
  refused: boolean;
};
export type ExternalFile = {
  v: 1;
  /** When the mod wrote it, not ai-usage's own `fetchedAt`: one clock decides staleness. */
  fetchedAt: number;
  providers: Partial<Record<"codex" | "opencode" | "cursor", ExternalProvider>>;
};

// A fixed list, not Object.keys: a key in the file never becomes a label.
const PROVIDERS = ["codex", "opencode", "cursor"] as const;
const LABELS = { codex: "cx", opencode: "oc", cursor: "cu" };
const MAX_STDOUT_BYTES = 64 * 1024;
const FETCH_INTERVAL_MS = 300_000;
// Five failed fetches in a row: past this the numbers are not shown as current.
const MAX_AGE_MS = 30 * 60_000;
const MAX_FUTURE_MS = 60_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function summaryWindow(value: unknown): ExternalWindow | null {
  if (!record(value) || !finite(value.usedPercent) || value.usedPercent < 0)
    return null;
  const reset =
    typeof value.resetsAt === "string" ? Date.parse(value.resetsAt) : NaN;
  return {
    used: value.usedPercent,
    resetsAt: Number.isFinite(reset) ? reset : null,
  };
}

export function buildExternalFile(
  stdout: string,
  now: number,
): ExternalFile | null {
  if (new TextEncoder().encode(stdout).length > MAX_STDOUT_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!record(data) || !record(data.providers)) return null;
  const providers: ExternalFile["providers"] = {};
  for (const name of PROVIDERS) {
    const raw = data.providers[name];
    if (!record(raw) || (raw.ok !== true && raw.ok !== false)) continue;
    const fiveHour = summaryWindow(raw.fiveHour);
    const weekly = summaryWindow(raw.weekly);
    const full = [fiveHour, weekly].some((w) => w !== null && w.used >= 100);
    providers[name] = {
      ok: raw.ok,
      fiveHour,
      weekly,
      refused: raw.exhausted === true && !full,
    };
  }
  return { v: 1, fetchedAt: now, providers };
}

/**
 * Only a recent attempt in the past holds a fetch back. A future, missing or
 * broken `attemptAt` (a clock set back, a damaged store) would otherwise stop
 * every session from fetching for good.
 */
export function externalFetchDue(value: unknown, now: number): boolean {
  return !(
    record(value) &&
    finite(value.attemptAt) &&
    value.attemptAt <= now &&
    now - value.attemptAt < FETCH_INTERVAL_MS
  );
}

// A window past its reset no longer says anything: dropping it keeps a stale ✗ off the line.
function activeWindow(value: unknown, now: number): ExternalWindow | null {
  if (!record(value) || !finite(value.used) || value.used < 0) return null;
  const resetsAt = finite(value.resetsAt) ? value.resetsAt : null;
  if (resetsAt !== null && resetsAt <= now) return null;
  return { used: value.used, resetsAt };
}

// Truncated, as format.ts: 100 only once the window is used up.
function percent(window: ExternalWindow | null): string {
  return window === null ? "-" : String(Math.floor(Math.min(100, window.used)));
}

/** The line's tail (`cx 4/21 oc 0/2 cu 15`), or null when there is nothing current to show. */
export function formatExternal(value: unknown, now: number): string | null {
  if (
    !record(value) ||
    value.v !== 1 ||
    !finite(value.fetchedAt) ||
    value.fetchedAt < now - MAX_AGE_MS ||
    value.fetchedAt > now + MAX_FUTURE_MS ||
    !record(value.providers)
  )
    return null;
  const segments: string[] = [];
  for (const name of PROVIDERS) {
    const provider = value.providers[name];
    if (!record(provider) || (provider.ok !== true && provider.ok !== false))
      continue;
    const label = LABELS[name];
    if (provider.ok === false) {
      segments.push(`${label} ?`);
      continue;
    }
    const fiveHour = activeWindow(provider.fiveHour, now);
    const weekly = activeWindow(provider.weekly, now);
    if (
      provider.refused === true ||
      [fiveHour, weekly].some((w) => w !== null && w.used >= 100)
    ) {
      segments.push(`${label} ✗`);
    } else if (name === "cursor") {
      // Cursor has one weekly window only, so one number.
      if (weekly !== null) segments.push(`${label} ${percent(weekly)}`);
    } else if (fiveHour !== null || weekly !== null) {
      segments.push(`${label} ${percent(fiveHour)}/${percent(weekly)}`);
    }
  }
  return segments.length === 0 ? null : segments.join(" ");
}
