import {
  MAX_OBSERVATION_AGE_MS,
  type LineInput,
  type RateLimitSample,
  type RateLimitWindow,
  type WindowLine,
} from "./forecast";

const SEPARATOR = " │ ";
const WINDOWS: RateLimitWindow[] = ["five_hour", "seven_day"];
const LABELS: Record<RateLimitWindow, string> = {
  five_hour: "5h",
  seven_day: "週",
};
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// Local fields, no Intl: the mod's runtime is not promised to carry time zone data.
function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Truncated, not rounded: 99.96 must not read as a full 100.0 before the window is exhausted.
// The epsilon keeps a computed 69.99999999999999 (binary error) from reading as 69.9.
function formatPercent(percent: number): string {
  return `${(Math.floor(percent * 10 + 1e-9) / 10).toFixed(1)}%`;
}

function formatWindowTime(window: RateLimitWindow, ms: number): string {
  const clock = formatClock(ms);
  return window === "seven_day"
    ? `${WEEKDAYS[new Date(ms).getDay()]} ${clock}`
    : clock;
}

function formatWindow(
  window: RateLimitWindow,
  latest: RateLimitSample,
  line: WindowLine,
): string {
  const resetsAtMs = latest.resetsAt * 1000;
  const { forecast } = line;
  const used = formatPercent(latest.usedPercent);
  const reset = `(reset ${formatWindowTime(window, resetsAtMs)})`;
  const label = LABELS[window];
  switch (forecast.status) {
    case "runs_out":
      return `${label} ${used} 100%→${formatWindowTime(window, forecast.exhaustionAt ?? resetsAtMs)} ${reset}`;
    case "spare":
      return `${label} ${used} 予想 ${formatPercent(forecast.projectedUsedPercent ?? latest.usedPercent)} ${reset}`;
    case "exhausted":
    case "unknown":
      return `${label} ${used} ${reset}`;
  }
}

export function formatLine(input: LineInput, now: number): string | undefined {
  const parts: string[] = [];
  if (input.contextPercent !== null)
    parts.push(`ctx ${formatPercent(input.contextPercent)}`);

  let newestShown: number | null = null;
  let shownAny = false;
  for (const window of WINDOWS) {
    const line = input.windows[window];
    const { latest } = line;
    if (latest === null || line.forecast.reason === "expired") continue;
    parts.push(formatWindow(window, latest, line));
    shownAny = true;
    newestShown =
      newestShown === null
        ? latest.sampledAt
        : Math.max(newestShown, latest.sampledAt);
  }
  if (
    shownAny &&
    newestShown !== null &&
    now - newestShown > MAX_OBSERVATION_AGE_MS
  ) {
    parts.push(`${formatClock(newestShown)} 時点`);
  }
  return parts.length === 0 ? undefined : parts.join(SEPARATOR);
}
