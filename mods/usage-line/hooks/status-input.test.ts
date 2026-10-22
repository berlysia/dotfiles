import { expect, test } from "claude-code/testing";
import { formatLine } from "./format";
import {
  buildStatusInput,
  isForecastFileReadable,
  parseForecastFile,
} from "./status-input";

const now = new Date(2026, 9, 22, 12, 0, 0).getTime();
const MIN = 60_000;
const R5 = Math.trunc((now + 2 * 60 * MIN) / 1000);
const R7 = Math.trunc((now + 3 * 24 * 60 * MIN) / 1000);
const stdin = {
  context_window: { used_percentage: 9 },
  rate_limits: {
    five_hour: { used_percentage: 3, resets_at: R5 },
    seven_day: { used_percentage: 13, resets_at: R7 },
  },
};
const clock = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function forecast(over: Record<string, unknown> = {}) {
  return {
    status: "spare",
    reason: null,
    averagePeriodMs: 86_400_000,
    observedMs: 3_600_000,
    ratePerHour: 0.1,
    projectedUsedPercent: 20.5,
    exhaustionAt: null,
    ...over,
  };
}
function fileOf(
  window: "five_hour" | "seven_day",
  resetsAt: number,
  fc: unknown,
  at = now - MIN,
) {
  return { v: 1, at, windows: { [window]: { resetsAt, forecast: fc } } };
}
const render = (s: unknown, f: unknown) =>
  formatLine(buildStatusInput(s, f, now), now);

test("stdin only: usage and context, no forecast", async () => {
  expect(render(stdin, undefined)).toBe(
    `ctx 9.0% │ 5h 3.0% 計測中 (reset ${clock(R5 * 1000)}) │ 週 13.0% 計測中 (reset ${WEEKDAYS[new Date(R7 * 1000).getDay()]} ${clock(R7 * 1000)})`,
  );
});

test("a fresh spare forecast for the same reset is used", async () => {
  expect(render(stdin, fileOf("seven_day", R7, forecast()))).toMatch(
    /週 13\.0% 予想 20\.5% \(reset /,
  );
});

test("the file's age: 25 minutes is the limit, 60 s of future is the limit", async () => {
  const at = (ms: number) =>
    render(stdin, fileOf("seven_day", R7, forecast(), ms));
  expect(at(now - 25 * MIN - 1)).not.toMatch(/予想/);
  expect(at(now - 25 * MIN)).toMatch(/予想/);
  expect(at(now + 60_000)).toMatch(/予想/);
  expect(at(now + 60_000 + 1)).not.toMatch(/予想/);
  expect(at(now + 60 * MIN)).not.toMatch(/予想/);
});

test("out-of-range forecast numbers drop that window's forecast", async () => {
  for (const bad of [
    { exhaustionAt: 1e20 },
    { projectedUsedPercent: -1 },
    { ratePerHour: -0.1 },
    { exhaustionAt: now - 2 * 86_400_000 },
  ]) {
    const out = render(stdin, fileOf("seven_day", R7, forecast(bad)));
    expect(out).not.toMatch(/予想|NaN|Invalid/);
  }
  // 1e999 in JSON text parses to Infinity.
  const parsed = JSON.parse(
    `{"v":1,"at":${now - MIN},"windows":{"seven_day":{"resetsAt":${R7},"forecast":{"status":"spare","reason":null,"averagePeriodMs":1,"observedMs":1,"ratePerHour":1,"projectedUsedPercent":20,"exhaustionAt":1e999}}}}`,
  );
  expect(render(stdin, parsed)).not.toMatch(/予想|NaN|Invalid/);
});

test("a runs_out forecast projecting past 100 is used", async () => {
  const runsOut = forecast({
    status: "runs_out",
    projectedUsedPercent: 600,
    exhaustionAt: now + 30 * MIN,
  });
  expect(render(stdin, fileOf("seven_day", R7, runsOut))).toMatch(
    /週 13\.0% 100%→/,
  );
});

test("isForecastFileReadable", async () => {
  expect(
    isForecastFileReadable({ isFile: true, uid: 1000, size: 65_536 }, 1000),
  ).toBe(true);
  expect(
    isForecastFileReadable({ isFile: false, uid: 1000, size: 10 }, 1000),
  ).toBe(false);
  expect(isForecastFileReadable({ isFile: true, uid: 0, size: 10 }, 1000)).toBe(
    false,
  );
  expect(
    isForecastFileReadable({ isFile: true, uid: 1000, size: 65_537 }, 1000),
  ).toBe(false);
});

test("a file written for another reset is not used", async () => {
  expect(render(stdin, fileOf("seven_day", R7 + 1, forecast()))).not.toMatch(
    /予想/,
  );
});

test("bad version, status or exhaustionAt type: not used, no throw", async () => {
  expect(
    render(stdin, { ...fileOf("seven_day", R7, forecast()), v: 2 }),
  ).not.toMatch(/予想/);
  expect(
    render(stdin, fileOf("seven_day", R7, forecast({ status: "bogus" }))),
  ).not.toMatch(/予想|bogus/);
  expect(
    render(stdin, fileOf("seven_day", R7, forecast({ exhaustionAt: "x" }))),
  ).not.toMatch(/予想/);
});

test("missing rate_limits or null context", async () => {
  expect(render({ context_window: { used_percentage: 9 } }, null)).toBe(
    "ctx 9.0%",
  );
  expect(
    render({ ...stdin, context_window: { used_percentage: null } }, null),
  ).not.toMatch(/ctx/);
  expect(render({ context_window: { used_percentage: null } }, null)).toBe(
    undefined,
  );
});

test("out-of-range or mistyped stdin values hide that window", async () => {
  const withFive = (five: unknown) => ({
    rate_limits: { five_hour: five },
  });
  for (const five of [
    { used_percentage: 101, resets_at: R5 },
    { used_percentage: -1, resets_at: R5 },
    { used_percentage: "3", resets_at: R5 },
    { used_percentage: 3, resets_at: "x" },
    { used_percentage: 3, resets_at: 1e20 },
  ])
    expect(render(withFive(five), null)).toBeUndefined();
});

test("non-object stdin gives nothing", async () => {
  for (const bad of ["x", null, []]) expect(render(bad, null)).toBeUndefined();
});

test("a runs_out forecast shows the exhaustion time", async () => {
  const exhaustionAt = now + 30 * MIN;
  expect(
    render(
      stdin,
      fileOf(
        "five_hour",
        R5,
        forecast({
          status: "runs_out",
          projectedUsedPercent: 100,
          exhaustionAt,
        }),
      ),
    ),
  ).toContain(
    `5h 3.0% 100%→${clock(exhaustionAt)} (reset ${clock(R5 * 1000)})`,
  );
});

test("parseForecastFile drops only the malformed window", async () => {
  const file = {
    v: 1,
    at: now,
    windows: {
      five_hour: { resetsAt: R5, forecast: forecast({ status: "x" }) },
      seven_day: { resetsAt: R7, forecast: forecast() },
    },
  };
  const parsed = parseForecastFile(file, now);
  expect(Object.keys(parsed?.windows ?? {})).toEqual(["seven_day"]);
});
