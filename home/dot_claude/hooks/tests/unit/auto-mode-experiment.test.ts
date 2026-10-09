#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEPLOYED_AT_ERE,
  type ExperimentState,
  experimentDir,
  experimentNotices,
  GUARD_COMMAND_FRAGMENT,
  isGuardRegistered,
  localMidnight,
  readExperimentState,
  REPORT_COMMAND,
} from "../../lib/auto-mode-experiment.ts";

const at = (iso: string): number => new Date(iso).getTime();
const deployed = localMidnight("2026-10-10") + 60_000;

function state(over: Partial<ExperimentState> = {}): ExperimentState {
  return {
    guardRegistered: true,
    deployedAt: { kind: "ok", at: deployed },
    summary: null,
    ...over,
  };
}
const summaryAt = (
  ms: number,
  accepted: number | null,
  rejected: number | null,
) => ({
  generatedAtMs: ms,
  reportDate: "2026-10-12",
  accepted,
  rejected,
});

describe("experimentNotices", () => {
  it("is silent while the guard is not registered", () => {
    deepStrictEqual(
      experimentNotices(
        localMidnight("2026-10-30"),
        state({ guardRegistered: false }),
      ),
      [],
    );
  });

  it("is silent before the first scheduled date", () => {
    deepStrictEqual(
      experimentNotices(localMidnight("2026-10-12") - 1, state()),
      [],
    );
  });

  it("asks for a report from the scheduled date on, every time, until one exists", () => {
    for (const now of [
      localMidnight("2026-10-12"),
      localMidnight("2026-10-16"),
    ]) {
      const notices = experimentNotices(now, state());
      strictEqual(notices.length, 1);
      ok(notices[0]?.includes("2026-10-12"));
      ok(notices[0]?.includes(REPORT_COMMAND));
    }
  });

  it("stops asking once a report was generated at or after the scheduled date", () => {
    const summary = summaryAt(localMidnight("2026-10-12") + 1, 0, 3);
    const notices = experimentNotices(
      localMidnight("2026-10-13"),
      state({ summary }),
    );
    strictEqual(notices.length, 1);
    ok(notices[0]?.includes("executed: 0"));
    ok(notices[0]?.includes("blocked: 3"));
    strictEqual(notices[0]?.startsWith("要確認"), false);
  });

  it("asks again when a later scheduled date passes without a newer report", () => {
    const summary = summaryAt(localMidnight("2026-10-12") + 1, 0, 0);
    const notices = experimentNotices(
      localMidnight("2026-10-17"),
      state({ summary }),
    );
    strictEqual(notices.length, 2);
    ok(notices[0]?.includes("2026-10-17"));
  });

  it("marks the report line and adds the rollback step when a would-deny call was executed", () => {
    const summary = summaryAt(localMidnight("2026-10-12") + 1, 2, 0);
    const [line] = experimentNotices(
      localMidnight("2026-10-13"),
      state({ summary }),
    );
    ok(line?.startsWith("要確認"));
    ok(line?.includes("chezmoi apply"));
  });

  it("does not show a report generated before the current deployment", () => {
    const summary = summaryAt(deployed - 1, 5, 5);
    deepStrictEqual(
      experimentNotices(localMidnight("2026-10-11"), state({ summary })),
      [],
    );
  });

  it("omits counts that failed validation but still shows the report", () => {
    const summary = summaryAt(localMidnight("2026-10-12") + 1, null, null);
    const [line] = experimentNotices(
      localMidnight("2026-10-13"),
      state({ summary }),
    );
    strictEqual(line?.includes("executed:"), false);
    ok(line?.includes("report-2026-10-12.md"));
  });

  it("does not count scheduled dates before the deployment", () => {
    const late = state({
      deployedAt: { kind: "ok", at: localMidnight("2026-10-13") },
    });
    deepStrictEqual(experimentNotices(localMidnight("2026-10-14"), late), []);
    ok(
      experimentNotices(localMidnight("2026-10-17"), late)[0]?.includes(
        "2026-10-17",
      ),
    );
  });

  it("shows the deadline notice from 2026-10-25 00:00 local, not before", () => {
    const summary = summaryAt(localMidnight("2026-10-24") + 1, 0, 0);
    const before = experimentNotices(
      localMidnight("2026-10-25") - 1,
      state({ summary }),
    );
    const after = experimentNotices(
      localMidnight("2026-10-25"),
      state({ summary }),
    );
    strictEqual(
      before.some((n) => n.includes("deadline")),
      false,
    );
    strictEqual(
      after.some((n) => n.includes("deadline") && n.includes("chezmoi apply")),
      true,
    );
  });

  it("says the deployment time is unreadable instead of guessing", () => {
    for (const deployedAt of [
      { kind: "missing" },
      { kind: "invalid" },
    ] as const) {
      const notices = experimentNotices(
        localMidnight("2026-10-13"),
        state({ deployedAt }),
      );
      strictEqual(notices.length, 1);
      ok(notices[0]?.includes("cannot read the deployment time"));
    }
  });
});

describe("isGuardRegistered", () => {
  const settings = (command: string) => ({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }],
    },
  });
  it("finds the guard inside a hook-timer wrapped command", () => {
    strictEqual(
      isGuardRegistered(
        settings(
          `sh '/h/.claude/hooks/hook-timer.sh' 'PreToolUse' 0 'sh /h/.claude/hooks/run-guard.sh /h/.claude/hooks/${GUARD_COMMAND_FRAGMENT} || exit 2' || exit 2`,
        ),
      ),
      true,
    );
  });
  it("is false for other hooks and for malformed settings", () => {
    strictEqual(
      isGuardRegistered(
        settings("bun /h/.claude/hooks/implementations/auto-approve.ts"),
      ),
      false,
    );
    for (const bad of [
      null,
      1,
      "x",
      {},
      { hooks: 1 },
      { hooks: { PreToolUse: "x" } },
    ])
      strictEqual(isGuardRegistered(bad), false);
  });
});

describe("readExperimentState", () => {
  function withHome(fn: (home: string, dir: string) => void): void {
    const home = mkdtempSync(join(tmpdir(), "auto-mode-experiment-test-"));
    try {
      mkdirSync(experimentDir(home), { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      fn(home, experimentDir(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  const guardSettings = JSON.stringify({
    hooks: {
      PreToolUse: [{ hooks: [{ command: `sh x ${GUARD_COMMAND_FRAGMENT}` }] }],
    },
  });
  const now = at("2026-10-13T00:00:00Z");

  it("reads a valid deployed-at and summary", () =>
    withHome((home, dir) => {
      writeFileSync(join(home, ".claude", "settings.json"), guardSettings);
      writeFileSync(join(dir, "deployed-at"), "2026-10-10T01:00:00Z\n");
      writeFileSync(
        join(dir, "summary.json"),
        JSON.stringify({
          generatedAt: "2026-10-12T03:00:00.000Z",
          reportDate: "2026-10-12",
          wouldDenyAccepted: 1,
          wouldDenyRejected: 2,
        }),
      );
      const read = readExperimentState({ home, now });
      strictEqual(read.guardRegistered, true);
      deepStrictEqual(read.deployedAt, {
        kind: "ok",
        at: at("2026-10-10T01:00:00Z"),
      });
      strictEqual(read.summary?.accepted, 1);
      strictEqual(read.summary?.rejected, 2);
      strictEqual(read.summary?.reportDate, "2026-10-12");
    }));

  it("accepts every deployed-at the bash side accepts, and nothing it rewrites", () =>
    withHome((home, dir) => {
      const file = join(dir, "deployed-at");
      // Matches the pattern and is in the past as text: bash keeps it, so the reader must too.
      writeFileSync(file, "2026-02-31T00:00:00Z\n");
      strictEqual(readExperimentState({ home, now }).deployedAt.kind, "ok");
      // Earlier than now as text, later than now once the fields roll over: the
      // decision follows the text, as in bash, and `at` never exceeds now.
      writeFileSync(file, "2026-09-99T99:99:99Z\n");
      const rolled = readExperimentState({ home, now }).deployedAt;
      strictEqual(rolled.kind, "ok");
      ok(rolled.kind === "ok" && rolled.at <= now);
      // Later than now as text (now is 2026-10-13T00:00:00Z).
      writeFileSync(file, "2026-10-13T00:00:01Z\n");
      deepStrictEqual(readExperimentState({ home, now }).deployedAt, {
        kind: "invalid",
      });
      // CRLF fails the bash pattern (it does not trim), so the reader rejects it as well.
      writeFileSync(file, "2026-10-10T01:00:00Z\r\n");
      deepStrictEqual(readExperimentState({ home, now }).deployedAt, {
        kind: "invalid",
      });
    }));

  it("treats unreadable settings as not registered", () =>
    withHome((home) => {
      writeFileSync(join(home, ".claude", "settings.json"), "{not json");
      strictEqual(readExperimentState({ home, now }).guardRegistered, false);
    }));

  it("rejects a deployed-at that is malformed, in the future, too long on its first line, or a symlink", () =>
    withHome((home, dir) => {
      const file = join(dir, "deployed-at");
      for (const body of [
        "yesterday\n",
        "2026-10-14T00:00:00Z\n",
        "",
        `2026-10-10T01:00:00Z${"x".repeat(100)}\n`,
      ]) {
        writeFileSync(file, body);
        deepStrictEqual(readExperimentState({ home, now }).deployedAt, {
          kind: "invalid",
        });
      }
      // Bash reads the first 64 bytes and drops NUL bytes; the reader must agree.
      for (const body of [
        `2026-10-10T01:00:00Z\n${"x".repeat(70_000)}`,
        "2026-10-10T01:00:00Z",
        "2026-10-10T01:00:00Z\0\n",
      ]) {
        writeFileSync(file, body);
        deepStrictEqual(readExperimentState({ home, now }).deployedAt, {
          kind: "ok",
          at: at("2026-10-10T01:00:00Z"),
        });
      }
      rmSync(file);
      deepStrictEqual(readExperimentState({ home, now }).deployedAt, {
        kind: "missing",
      });
      writeFileSync(join(dir, "real"), "2026-10-10T01:00:00Z\n");
      symlinkSync(join(dir, "real"), file);
      deepStrictEqual(readExperimentState({ home, now }).deployedAt, {
        kind: "invalid",
      });
    }));

  it("drops counts that are not safe non-negative integers, and a summary with a bad or future time", () =>
    withHome((home, dir) => {
      const file = join(dir, "summary.json");
      writeFileSync(
        file,
        JSON.stringify({
          generatedAt: "2026-10-12T03:00:00Z",
          reportDate: "2026-10-12",
          wouldDenyAccepted: -1,
          wouldDenyRejected: "2",
        }),
      );
      const read = readExperimentState({ home, now }).summary;
      strictEqual(read?.accepted, null);
      strictEqual(read?.rejected, null);
      for (const generatedAt of ["soon", "2026-10-14T00:00:00Z"]) {
        writeFileSync(
          file,
          JSON.stringify({
            generatedAt,
            reportDate: "2026-10-12",
            wouldDenyAccepted: 0,
            wouldDenyRejected: 0,
          }),
        );
        strictEqual(readExperimentState({ home, now }).summary, null);
      }
      for (const reportDate of [
        "../../etc",
        "2026-10-12.md",
        20261012,
        undefined,
      ]) {
        writeFileSync(
          file,
          JSON.stringify({
            generatedAt: "2026-10-12T03:00:00Z",
            reportDate,
            wouldDenyAccepted: 0,
            wouldDenyRejected: 0,
          }),
        );
        strictEqual(readExperimentState({ home, now }).summary, null);
      }
    }));
});

it("keeps the deployed-at pattern usable as a JavaScript regular expression", () => {
  ok(new RegExp(DEPLOYED_AT_ERE).test("2026-10-10T01:00:00Z"));
  strictEqual(new RegExp(DEPLOYED_AT_ERE).test("2026-10-10 01:00:00"), false);
});
