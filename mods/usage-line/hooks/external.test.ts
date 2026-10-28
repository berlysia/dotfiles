import { expect, test } from "claude-code/testing";
import {
  buildExternalFile,
  externalFetchDue,
  formatExternal,
} from "./external";

const NOW = Date.parse("2026-10-28T00:00:00Z");
const RESET = "2026-11-03T05:01:32.690Z";
function summary() {
  const window = (usedPercent: number) => ({ usedPercent, resetsAt: RESET });
  return {
    fetchedAt: "ignored",
    providers: {
      codex: {
        ok: true,
        fiveHour: window(4),
        weekly: window(21),
        exhausted: false,
      },
      opencode: {
        ok: true,
        fiveHour: window(0),
        weekly: window(2),
        exhausted: false,
      },
      cursor: {
        ok: true,
        fiveHour: null,
        weekly: window(15.27),
        exhausted: false,
      },
    },
  };
}
function file() {
  const window = (used: number) => ({ used, resetsAt: Date.parse(RESET) });
  return {
    v: 1,
    fetchedAt: NOW,
    providers: {
      codex: {
        ok: true,
        fiveHour: window(4),
        weekly: window(21),
        refused: false,
      },
      opencode: {
        ok: true,
        fiveHour: window(0),
        weekly: window(2),
        refused: false,
      },
      cursor: {
        ok: true,
        fiveHour: null,
        weekly: window(15.27),
        refused: false,
      },
    },
  };
}
test("summary conversion stamps mod time, converts ISO resets and refusal", async () => {
  expect(buildExternalFile(JSON.stringify(summary()), NOW)).toEqual(file());
  const data = summary();
  data.providers.codex.exhausted = true;
  expect(
    buildExternalFile(JSON.stringify(data), NOW)?.providers.codex?.refused,
  ).toBe(true);
  data.providers.codex.weekly.usedPercent = 100;
  expect(
    buildExternalFile(JSON.stringify(data), NOW)?.providers.codex?.refused,
  ).toBe(false);
});
test("summary rejects invalid shapes, oversized bytes and invalid windows", async () => {
  for (const text of [
    "not json",
    '{"providers":[]}',
    JSON.stringify({ providers: {}, pad: "x".repeat(65 * 1024) }),
    JSON.stringify({ providers: {}, pad: "あ".repeat(24 * 1024) }),
  ])
    expect(buildExternalFile(text, NOW)).toBeNull();
  const padded = JSON.stringify({ providers: {}, pad: "" });
  expect(
    buildExternalFile(
      JSON.stringify({
        providers: {},
        pad: "x".repeat(64 * 1024 - padded.length),
      }),
      NOW,
    ),
  ).not.toBeNull();
  const overflow = JSON.stringify(summary()).replace(
    '"usedPercent":4',
    '"usedPercent":1e999',
  );
  expect(
    buildExternalFile(overflow, NOW)?.providers.codex?.fiveHour,
  ).toBeNull();
  for (const resetsAt of ["abc", null]) {
    const data = summary();
    expect(
      buildExternalFile(
        JSON.stringify({
          providers: {
            codex: {
              ...data.providers.codex,
              weekly: { usedPercent: 21, resetsAt },
            },
          },
        }),
        NOW,
      )?.providers.codex?.weekly?.resetsAt,
    ).toBeNull();
  }
  for (const usedPercent of ["4", -5, Infinity]) {
    expect(
      buildExternalFile(
        JSON.stringify({
          providers: { codex: { ok: true, fiveHour: { usedPercent } } },
        }),
        NOW,
      )?.providers.codex?.fiveHour,
    ).toBeNull();
  }
});
test("attempt timestamp throttles only finite recent past attempts", async () => {
  for (const value of [
    undefined,
    { attemptAt: "x" },
    { attemptAt: NOW + 3600000 },
    { attemptAt: NOW - 360000 },
    { attemptAt: Infinity },
  ])
    expect(externalFetchDue(value, NOW)).toBe(true);
  expect(externalFetchDue({ attemptAt: NOW - 240000 }, NOW)).toBe(false);
  expect(externalFetchDue({ attemptAt: NOW - 299000 }, NOW)).toBe(false);
  expect(externalFetchDue({ attemptAt: NOW - 300000 }, NOW)).toBe(true);
});
test("fixed order, failure priority, refusal and reset expiration", async () => {
  expect(formatExternal(file(), NOW)).toBe("cx 4/21 oc 0/2 cu 15");
  const data = file();
  data.providers.codex.ok = false;
  expect(formatExternal(data, NOW)).toBe("cx ? oc 0/2 cu 15");
  data.providers.codex.refused = true;
  expect(formatExternal(data, NOW)).toBe("cx ? oc 0/2 cu 15");
  data.providers.codex.ok = true;
  expect(formatExternal(data, NOW)).toBe("cx ✗ oc 0/2 cu 15");
  data.providers.codex.refused = false;
  data.providers.codex.weekly.used = 100;
  expect(formatExternal(data, NOW)).toBe("cx ✗ oc 0/2 cu 15");
  data.providers.codex.weekly.resetsAt = NOW;
  expect(formatExternal(data, NOW)).toBe("cx 4/- oc 0/2 cu 15");
  data.providers.codex.weekly.resetsAt = NOW - 1;
  expect(formatExternal(data, NOW)).toBe("cx 4/- oc 0/2 cu 15");
  expect(
    formatExternal(
      {
        ...file(),
        providers: {
          cursor: {
            ...file().providers.cursor,
            weekly: { used: 120, resetsAt: null },
          },
        },
      },
      NOW,
    ),
  ).toBe("cu ✗");
});
test("floors percentages, handles missing windows and rejects unsafe values", async () => {
  const base = file();
  for (const [used, expected] of [
    [99.9, "99"],
    [1e21, "✗"],
    ["\u001b]0;x\u0007", "-"],
    [-5, "-"],
    ["NaN", "-"],
    [Infinity, "-"],
  ] as const) {
    const data = {
      ...base,
      providers: {
        codex: { ...base.providers.codex, fiveHour: { used, resetsAt: null } },
      },
    };
    const out = formatExternal(data, NOW);
    expect(out).toBe(expected === "✗" ? "cx ✗" : `cx ${expected}/21`);
    expect(/^[a-z ?✗/0-9-]*$/.test(out ?? "")).toBe(true);
    expect(
      [...(out ?? "")].some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ),
    ).toBe(false);
  }
  expect(
    formatExternal(
      {
        ...base,
        providers: { codex: { ...base.providers.codex, fiveHour: null } },
      },
      NOW,
    ),
  ).toBe("cx -/21");
  expect(
    formatExternal(
      {
        ...base,
        providers: {
          ...base.providers,
          cursor: { ...base.providers.cursor, weekly: null },
        },
      },
      NOW,
    ),
  ).toBe("cx 4/21 oc 0/2");
  expect(
    formatExternal(
      {
        ...base,
        providers: {
          codex: {
            ...base.providers.codex,
            weekly: { used: 21, resetsAt: "x" },
          },
        },
      },
      NOW,
    ),
  ).toBe("cx 4/21");
  expect(
    formatExternal(
      {
        ...base,
        providers: {
          ...base.providers,
          codex: { ...base.providers.codex, ok: "yes" },
          zz: base.providers.codex,
        },
      },
      NOW,
    ),
  ).toBe("oc 0/2 cu 15");
  const infinity = JSON.parse(
    JSON.stringify(base).replace('"used":4', '"used":1e999'),
  );
  expect(formatExternal(infinity, NOW)).toBe("cx -/21 oc 0/2 cu 15");
});
test("file version and age validation", async () => {
  for (const data of [
    null,
    [],
    { ...file(), providers: {} },
    { ...file(), v: 2 },
    { ...file(), fetchedAt: "x" },
    { ...file(), fetchedAt: NOW - 31 * 60000 },
    { ...file(), fetchedAt: NOW + 2 * 60000 },
  ])
    expect(formatExternal(data, NOW)).toBeNull();
  for (const fetchedAt of [NOW - 30 * 60000, NOW + 60000])
    expect(formatExternal({ ...file(), fetchedAt }, NOW)).toBe(
      "cx 4/21 oc 0/2 cu 15",
    );
});
