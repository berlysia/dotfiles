import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import {
  FORECAST_FUTURE_SKEW_SECONDS,
  FORECAST_MAX_AGE_MINUTES,
  FORECAST_MAX_BYTES,
  FORECAST_MAX_FILES,
  FORECAST_MAX_OBSERVED_HOURS,
  FORECAST_MAX_RATE,
  FORECAST_RESETS_TOLERANCE_HOURS,
  LOOKAHEAD_MIN_OBSERVED_HOURS,
} from "./constants.ts";

/**
 * Reads the forecast files that the usage-line mod writes. The files are
 * written by another program, so only an enum and two numbers leave this
 * module: no file name, path or string from inside a file.
 */
export type ForecastReason =
  | "no-dir"
  | "no-file"
  | "stale"
  | "mismatch"
  | "no-rate"
  | "short";
export type ForecastRead =
  | { ok: true; ratePerHour: number; observedHours: number }
  | { ok: false; reason: ForecastReason };

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const SESSION_FILE = /^[A-Za-z0-9-]{1,128}\.json$/;
// Same rule as mods/usage-line/hooks/line-file.ts (a mod cannot be imported
// from here; tests/delegation-pace-route.test.mjs compares the two).
const MACOS_USER_TMP = "/var/folders/";
// Later reasons say more about why the forecast is unusable.
const REASON_RANK: Record<ForecastReason, number> = {
  "no-dir": 0,
  "no-file": 1,
  stale: 2,
  mismatch: 3,
  "no-rate": 4,
  short: 5,
};

function usableDir(value: string | undefined): string | null {
  if (value === undefined || value === "" || !value.startsWith("/"))
    return null;
  if (value.split("/").includes("..")) return null;
  const trimmed = value.replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

export function forecastDir(
  env: Record<string, string | undefined>,
): string | null {
  // Test seam: the value is the usage-line directory itself. Production does
  // not set it, which is the same level of risk as DELEGATION_AI_USAGE_BIN.
  if (env.DELEGATION_USAGE_LINE_DIR !== undefined) {
    return usableDir(env.DELEGATION_USAGE_LINE_DIR);
  }
  const runtime = usableDir(env.XDG_RUNTIME_DIR);
  if (runtime !== null) return `${runtime}/usage-line`;
  const tmp = usableDir(env.TMPDIR);
  if (tmp !== null && tmp.startsWith(MACOS_USER_TMP)) {
    return `${tmp}/usage-line`;
  }
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

type Candidate =
  | { ok: true; at: number; ratePerHour: number; observedHours: number }
  | { ok: false; reason: ForecastReason };
const fail = (reason: ForecastReason): Candidate => ({ ok: false, reason });

function checkContent(
  text: string,
  now: Date,
  claudeWeekResetsAtMs: number | null,
): Candidate {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return fail("no-rate");
  }
  if (!isObject(root) || root.v !== 1) return fail("no-rate");
  const windows = root.windows;
  if (!isObject(windows)) return fail("no-rate");
  const sevenDay = windows.seven_day;
  if (!isObject(sevenDay)) return fail("no-rate");
  const forecast = sevenDay.forecast;
  if (!isObject(forecast)) return fail("no-rate");

  const at = root.at;
  if (!isFiniteNumber(at)) return fail("stale");
  const age = now.getTime() - at;
  if (
    age < -FORECAST_FUTURE_SKEW_SECONDS * 1000 ||
    age > FORECAST_MAX_AGE_MINUTES * MIN_MS
  ) {
    return fail("stale");
  }

  const resetsAt = sevenDay.resetsAt;
  if (!isFiniteNumber(resetsAt) || claudeWeekResetsAtMs === null) {
    return fail("mismatch");
  }
  if (
    Math.abs(resetsAt * 1000 - claudeWeekResetsAtMs) >
    FORECAST_RESETS_TOLERANCE_HOURS * HOUR_MS
  ) {
    return fail("mismatch");
  }

  const rate = forecast.ratePerHour;
  if (!isFiniteNumber(rate) || rate < 0 || rate > FORECAST_MAX_RATE) {
    return fail("no-rate");
  }
  const observedMs = forecast.observedMs;
  if (!isFiniteNumber(observedMs)) return fail("no-rate");
  const observedHours = observedMs / HOUR_MS;
  if (observedMs < LOOKAHEAD_MIN_OBSERVED_HOURS * HOUR_MS) return fail("short");
  if (observedMs > FORECAST_MAX_OBSERVED_HOURS * HOUR_MS) {
    return fail("no-rate");
  }
  return { ok: true, at, ratePerHour: rate, observedHours };
}

function isOwnSmallFile(
  st: { isFile(): boolean; uid: number; size: number },
  uid: number,
): boolean {
  return st.isFile() && st.uid === uid && st.size <= FORECAST_MAX_BYTES;
}

/** Reads up to MAX + 1 bytes from the fd; null when the file is larger than MAX. */
function readBounded(fd: number): string | null {
  const buf = Buffer.alloc(FORECAST_MAX_BYTES + 1);
  let total = 0;
  for (;;) {
    const n = readSync(fd, buf, total, buf.length - total, null);
    if (n === 0) break;
    total += n;
    if (total > FORECAST_MAX_BYTES) return null;
  }
  return buf.toString("utf8", 0, total);
}

function inspectFile(
  path: string,
  now: Date,
  claudeWeekResetsAtMs: number | null,
  uid: number | undefined,
  beforeOpen: ((path: string) => void) | undefined,
): Candidate {
  if (uid === undefined) return fail("no-file");
  let fd: number | null = null;
  try {
    if (!isOwnSmallFile(lstatSync(path), uid)) return fail("no-file");
    beforeOpen?.(path);
    fd = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    // The path may have been swapped since lstat; the fd is what is read.
    const st = fstatSync(fd);
    if (!isOwnSmallFile(st, uid)) return fail("no-file");
    if (now.getTime() - st.mtimeMs > FORECAST_MAX_AGE_MINUTES * MIN_MS) {
      return fail("stale");
    }
    const text = readBounded(fd);
    if (text === null) return fail("no-file");
    return checkContent(text, now, claudeWeekResetsAtMs);
  } catch {
    return fail("no-file");
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to recover: the fd is gone either way.
      }
    }
  }
}

export function readForecast(
  dir: string | null,
  now: Date,
  claudeWeekResetsAtMs: number | null,
  // Test seams only: production passes nothing.
  opts?: { uid?: number; beforeOpen?: (path: string) => void },
): ForecastRead {
  if (dir === null) return { ok: false, reason: "no-dir" };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "no-file" : "no-dir" };
  }
  try {
    const uid =
      opts?.uid ??
      (typeof process.getuid === "function" ? process.getuid() : undefined);
    const picked = names
      .filter((n) => SESSION_FILE.test(n))
      .sort()
      .slice(0, FORECAST_MAX_FILES);
    let best: Extract<Candidate, { ok: true }> | null = null;
    let worst: ForecastReason = "no-file";
    for (const name of picked) {
      const c = inspectFile(
        `${dir}/${name}`,
        now,
        claudeWeekResetsAtMs,
        uid,
        opts?.beforeOpen,
      );
      if (c.ok) {
        // Names are ascending, so a strict > keeps the first of equal `at`.
        if (best === null || c.at > best.at) best = c;
      } else if (REASON_RANK[c.reason] > REASON_RANK[worst]) {
        worst = c.reason;
      }
    }
    if (best !== null) {
      return {
        ok: true,
        ratePerHour: best.ratePerHour,
        observedHours: best.observedHours,
      };
    }
    return { ok: false, reason: worst };
  } catch {
    return { ok: false, reason: "no-file" };
  }
}
