import {
  forecastUsage,
  type LineInput,
  type RateLimitSample,
} from "./forecast";
import { latestUsage } from "./samples";

/** Builds the displayed latest value and the forecast from one merged series. */
export function buildLineInput(
  merged: RateLimitSample[],
  contextPercent: number | null,
  now: number,
): LineInput {
  return {
    contextPercent,
    windows: {
      five_hour: {
        latest: latestUsage(merged, "five_hour", now),
        forecast: forecastUsage(merged, "five_hour", now),
      },
      seven_day: {
        latest: latestUsage(merged, "seven_day", now),
        forecast: forecastUsage(merged, "seven_day", now),
      },
    },
  };
}
