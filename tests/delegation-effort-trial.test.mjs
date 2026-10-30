import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as destinationModule from "../home/dot_local/share/delegation/destinations.ts";
import {
  EXPLORE_MIN_RECORDS,
  EXPLORE_WINDOW_DAYS,
} from "../home/dot_local/share/delegation/constants.ts";
import { buildRoute } from "../home/dot_local/share/delegation/route.ts";
import { buildReview } from "../home/dot_local/share/delegation/review.ts";
import { EFFORTS } from "../home/dot_local/share/delegation/schema.ts";
import { foldLedger } from "../home/dot_local/share/delegation/store.ts";

const { DESTINATIONS } = destinationModule;
const NOW = new Date("2026-10-30T00:00:00.000Z");
let nextId = 1;

function effortTrialDisplay(destination, effort) {
  assert.equal(typeof destinationModule.effortTrialDisplay, "function");
  return destinationModule.effortTrialDisplay(destination, effort);
}

describe("destination effort trials", () => {
  it("declares only lower efforts for the intended destinations", () => {
    assert.deepEqual(DESTINATIONS["codex-luna-max"].effortTrials, [
      "xhigh",
      "high",
    ]);
    assert.deepEqual(DESTINATIONS["codex-terra"].effortTrials, ["medium"]);
    assert.equal(DESTINATIONS.opencode.effortTrials, undefined);
    assert.equal(DESTINATIONS.sarashina.effortTrials, undefined);

    for (const destination of Object.values(DESTINATIONS)) {
      if (destination.effortTrials === undefined) continue;
      assert.notEqual(destination.match.effort, undefined);
      for (const effort of destination.effortTrials) {
        assert.ok(
          EFFORTS.indexOf(effort) < EFFORTS.indexOf(destination.match.effort),
          `${destination.name} ${effort} must be lower than ${destination.match.effort}`,
        );
      }
    }
  });

  it("builds the Luna trial command by changing only effort", () => {
    const destination = DESTINATIONS["codex-luna-max"];
    assert.equal(
      effortTrialDisplay(destination, "high"),
      "codex Luna max (codex exec -m gpt-6-luna -c model_reasoning_effort=high)",
    );
    assert.equal(
      effortTrialDisplay(destination, "high"),
      destination.display.replace(
        "model_reasoning_effort=max",
        "model_reasoning_effort=high",
      ),
    );
  });

  it("builds the Terra trial command from its display", () => {
    const destination = DESTINATIONS["codex-terra"];
    assert.equal(
      effortTrialDisplay(destination, "medium"),
      destination.display.replace(
        "model_reasoning_effort=high",
        "model_reasoning_effort=medium",
      ),
    );
  });

  it("throws when the display has no effort setting", () => {
    assert.equal(typeof destinationModule.effortTrialDisplay, "function");
    assert.throws(() =>
      effortTrialDisplay({ display: "codex exec", match: {} }, "high"),
    );
  });

  it("throws when the display has multiple effort settings", () => {
    assert.equal(typeof destinationModule.effortTrialDisplay, "function");
    assert.throws(() =>
      effortTrialDisplay(
        {
          display:
            "codex exec -c model_reasoning_effort=high -c model_reasoning_effort=max",
          match: {},
        },
        "low",
      ),
    );
  });
});

function delegationRows(
  count,
  {
    harness = "codex-cli",
    model = "gpt-6-luna",
    effort = "xhigh",
    kind = "review",
    size = "M",
    at = NOW.toISOString(),
    adopted = count,
    discarded = 0,
  } = {},
) {
  return Array.from({ length: count }, (_, index) => ({
    v: 1,
    type: "delegation",
    id: `d-${String(nextId++).padStart(12, "0")}`,
    at,
    harness,
    invocation: ["codex", "exec"],
    model,
    effort,
    kind,
    size,
    sessionId: null,
    manual: false,
    durationMs: null,
    endReason: "answer",
    verdict:
      index < adopted
        ? "adopted"
        : index < adopted + discarded
          ? "discarded"
          : "patched",
  }));
}

function lapseRows(count, { model = "gpt-6-luna", effort = "high" } = {}) {
  return Array.from({ length: count }, () => ({
    v: 1,
    type: "lapse",
    id: `d-${String(nextId++).padStart(12, "0")}`,
    at: NOW.toISOString(),
    openedAt: NOW.toISOString(),
    harness: "codex-cli",
    invocation: ["codex", "exec"],
    model,
    effort,
    sessionId: null,
    durationMs: null,
    endReason: "refusal",
  }));
}

function pace({
  fiveHour = "under",
  weekly = "under",
  weeklyLag = 0,
  fiveHourResetsAt = null,
  weeklyResetsAt = null,
} = {}) {
  return {
    fiveHour,
    weekly,
    weeklyLag,
    unmetered: false,
    fiveHourResetsAt,
    weeklyResetsAt,
  };
}

function routeOut({
  rows = [],
  kind = "review",
  size = "M",
  paces = {},
  excluded = new Set(),
  exposure,
  offload,
  isPublicRepo,
} = {}) {
  return buildRoute({
    kind,
    size,
    now: NOW,
    folded: foldLedger(rows),
    paces: {
      claude: pace({ weeklyLag: 0 }),
      codex: pace({ weeklyLag: 20 }),
      opencode: pace({ weeklyLag: -20 }),
      sarashina: pace({ weeklyLag: -30 }),
      ...paces,
    },
    claudeAheadBy: null,
    lookahead: null,
    excluded,
    pendingTotal: 0,
    pendingSession: null,
    skipped: { version: 0, type: 0, broken: 0 },
    ledgerLarge: false,
    due: null,
    windowMinsMissing: false,
    usageMissing: false,
    exposure,
    offload,
    isPublicRepo,
  });
}

const effortLine = (lines) =>
  lines.find((line) => line.startsWith("試す effort:"));

function expectedEffortLine(destinationName, effort, kind, size, count) {
  const destination = DESTINATIONS[destinationName];
  return `試す effort: ${effortTrialDisplay(destination, effort)} ${kind}×${size} の直近 ${EXPLORE_WINDOW_DAYS} 日の記録 ${count}/${EXPLORE_MIN_RECORDS} 件`;
}

function reviewOut(rows, sinceDays = EXPLORE_WINDOW_DAYS) {
  return buildReview({
    now: NOW,
    sinceDays,
    folded: foldLedger(rows),
    skipped: { version: 0, type: 0, broken: 0 },
    ledgerLarge: false,
  });
}

const effortReviewLines = (lines) =>
  lines.filter((line) => line.includes("effort の見直しの条件に当たる:"));

function expectedReviewEffortLine(
  destinationName,
  trialEffort,
  trialCount,
  currentEffort,
  currentCount,
) {
  const label = DESTINATIONS[destinationName].label;
  return `  effort の見直しの条件に当たる: ${label} の ${trialEffort} ${trialCount} 件と ${currentEffort} ${currentCount} 件がどちらも ${EXPLORE_MIN_RECORDS} 件以上。数値は上の組の行を見る`;
}

describe("route effort trials", () => {
  it("prints Luna xhigh when both trial groups have no records", () => {
    const out = routeOut();
    assert.equal(
      effortLine(out),
      expectedEffortLine("codex-luna-max", "xhigh", "review", "M", 0),
    );
  });

  it("breaks an equal record count by the listed effort order", () => {
    const out = routeOut({
      rows: [
        ...delegationRows(4, { effort: "xhigh" }),
        ...delegationRows(4, { effort: "high" }),
      ],
    });
    assert.equal(
      effortLine(out),
      expectedEffortLine("codex-luna-max", "xhigh", "review", "M", 4),
    );
  });

  it("chooses the lower-count trial when the first has five records", () => {
    const out = routeOut({
      rows: [
        ...delegationRows(5, { effort: "xhigh" }),
        ...delegationRows(4, { effort: "high" }),
      ],
    });
    assert.equal(
      effortLine(out),
      expectedEffortLine("codex-luna-max", "high", "review", "M", 4),
    );
  });

  it("omits the line when every trial has five records", () => {
    const out = routeOut({
      rows: [
        ...delegationRows(5, { effort: "xhigh" }),
        ...delegationRows(5, { effort: "high" }),
      ],
    });
    assert.equal(effortLine(out), undefined);
  });

  it("does not count trial records older than sixty days", () => {
    const oldAt = new Date(NOW.getTime() - 61 * 86_400_000).toISOString();
    const out = routeOut({
      rows: delegationRows(4, { effort: "xhigh", at: oldAt }),
    });
    assert.equal(
      effortLine(out),
      expectedEffortLine("codex-luna-max", "xhigh", "review", "M", 0),
    );
  });

  it("counts only records from the requested kind and size", () => {
    const out = routeOut({
      rows: delegationRows(4, { kind: "review", size: "S", effort: "xhigh" }),
      kind: "review",
      size: "M",
    });
    assert.equal(
      effortLine(out),
      expectedEffortLine("codex-luna-max", "xhigh", "review", "M", 0),
    );
  });

  it("offers trials for review at sizes S and L", () => {
    for (const size of ["S", "L"]) {
      const out = routeOut({ kind: "review", size });
      assert.equal(
        effortLine(out),
        expectedEffortLine("codex-luna-max", "xhigh", "review", size, 0),
      );
    }
  });

  it("prints Terra medium for a Terra recommendation", () => {
    const out = routeOut({
      rows: delegationRows(2, {
        model: "gpt-6.1-terra",
        effort: "medium",
      }),
      excluded: new Set(["codex-luna-max"]),
    });
    assert.match(
      out.find((line) => line.startsWith("推奨:")),
      /codex Terra/,
    );
    assert.equal(
      effortLine(out),
      expectedEffortLine("codex-terra", "medium", "review", "M", 2),
    );
  });

  it("offers trials for S but not M outside review", () => {
    const medium = routeOut({ kind: "impl", size: "M" });
    const small = routeOut({ kind: "impl", size: "S" });
    assert.equal(effortLine(medium), undefined);
    assert.equal(
      effortLine(small),
      expectedEffortLine("codex-luna-max", "xhigh", "impl", "S", 0),
    );
  });

  it("matches model as well as harness when counting trials", () => {
    const out = routeOut({
      rows: delegationRows(5, {
        model: "gpt-6.1-terra",
        effort: "xhigh",
      }),
    });
    assert.equal(
      effortLine(out),
      expectedEffortLine("codex-luna-max", "xhigh", "review", "M", 0),
    );
  });

  it("matches harness as well as model when counting trials", () => {
    const out = routeOut({
      rows: delegationRows(5, { harness: "cursor", effort: "xhigh" }),
    });
    assert.equal(
      effortLine(out),
      expectedEffortLine("codex-luna-max", "xhigh", "review", "M", 0),
    );
  });

  it("does not print a trial line for sonnet, OpenCode, or wait", () => {
    const unknown = pace({
      fiveHour: "unknown",
      weekly: "unknown",
      weeklyLag: null,
    });
    const sonnet = routeOut({
      paces: {
        claude: unknown,
        codex: unknown,
        opencode: unknown,
        sarashina: unknown,
      },
    });
    const opencode = routeOut({
      kind: "impl",
      size: "M",
      paces: {
        claude: unknown,
        codex: unknown,
        opencode: pace({ weeklyLag: 20 }),
        sarashina: unknown,
      },
      exposure: "external-ok",
      offload: () => ({ ok: true, models: destinationModule.sendsOutModels() }),
      isPublicRepo: () => true,
    });
    const wait = routeOut({
      paces: {
        claude: pace({
          fiveHour: "ahead",
          weekly: "unknown",
          weeklyLag: null,
          fiveHourResetsAt: new Date(NOW.getTime() + 60_000).toISOString(),
        }),
        codex: unknown,
        opencode: unknown,
        sarashina: unknown,
      },
    });
    assert.match(
      sonnet.find((line) => line.startsWith("推奨:")),
      /sonnet/,
    );
    assert.match(
      opencode.find((line) => line.startsWith("推奨:")),
      /opencode/,
    );
    assert.match(
      wait.find((line) => line.startsWith("推奨:")),
      /待機/,
    );
    assert.equal(effortLine(sonnet), undefined);
    assert.equal(effortLine(opencode), undefined);
    assert.equal(effortLine(wait), undefined);
  });

  it("does not count rejected launches closed as lapse rows", () => {
    const out = routeOut({ rows: lapseRows(3) });
    assert.equal(
      effortLine(out),
      expectedEffortLine("codex-luna-max", "xhigh", "review", "M", 0),
    );
  });

  it("prints the effort line after hold and try-candidate lines without changing other output", () => {
    const input = {
      kind: "impl",
      size: "S",
      rows: [
        ...delegationRows(6, {
          harness: "claude-code-agent",
          model: "sonnet",
          effort: "unknown",
          adopted: 5,
          discarded: 1,
          kind: "impl",
          size: "S",
        }),
        ...delegationRows(6, {
          model: "gpt-6.1-terra",
          effort: "high",
          kind: "impl",
          size: "S",
        }),
        ...delegationRows(2, {
          model: "gpt-6.1-terra",
          effort: "medium",
          kind: "impl",
          size: "S",
        }),
        ...delegationRows(4, {
          effort: "max",
          kind: "impl",
          size: "S",
        }),
        ...delegationRows(5, {
          harness: "opencode",
          model: "zai-coding-plan/glm-5.3",
          effort: "unknown",
          adopted: 0,
          discarded: 5,
          kind: "impl",
          size: "S",
        }),
      ],
      exposure: "external-ok",
      offload: () => ({ ok: true, models: destinationModule.sendsOutModels() }),
      isPublicRepo: () => false,
    };
    const out = routeOut(input);
    const holdIndex = out.findIndex((line) => line.startsWith("保留:"));
    const candidateIndex = out.findIndex((line) =>
      line.startsWith("試す候補:"),
    );
    const effortIndex = out.findIndex((line) =>
      line.startsWith("試す effort:"),
    );
    assert.equal(out[0], "delegation route v1");
    assert.ok(holdIndex >= 0);
    assert.ok(candidateIndex > holdIndex);
    assert.ok(effortIndex > candidateIndex);
    assert.equal(
      out[effortIndex],
      expectedEffortLine("codex-terra", "medium", "impl", "S", 2),
    );

    const terra = DESTINATIONS["codex-terra"];
    const trials = terra.effortTrials;
    try {
      terra.effortTrials = [];
      assert.deepEqual(
        out.filter((line) => !line.startsWith("試す effort:")),
        routeOut(input),
      );
    } finally {
      terra.effortTrials = trials;
    }
  });
});

describe("review effort trials", () => {
  it("prints one signal when current and trial efforts each have five records", () => {
    const out = reviewOut([
      ...delegationRows(5, { effort: "max" }),
      ...delegationRows(5, { effort: "high" }),
    ]);
    assert.equal(out[0], "delegation review v1 (直近 60 日)");
    assert.deepEqual(effortReviewLines(out), [
      expectedReviewEffortLine("codex-luna-max", "high", 5, "max", 5),
    ]);
  });

  it("omits the signal when either group has fewer than five records", () => {
    const currentUnder = reviewOut([
      ...delegationRows(5, { effort: "max" }),
      ...delegationRows(4, { effort: "high" }),
    ]);
    const trialUnder = reviewOut([
      ...delegationRows(4, { effort: "max" }),
      ...delegationRows(5, { effort: "high" }),
    ]);
    assert.deepEqual(effortReviewLines(currentUnder), []);
    assert.deepEqual(effortReviewLines(trialUnder), []);
  });

  it("prints one signal per trial in the destination's listed order", () => {
    const out = reviewOut([
      ...delegationRows(5, { effort: "max" }),
      ...delegationRows(5, { effort: "xhigh" }),
      ...delegationRows(5, { effort: "high" }),
    ]);
    assert.deepEqual(effortReviewLines(out), [
      expectedReviewEffortLine("codex-luna-max", "xhigh", 5, "max", 5),
      expectedReviewEffortLine("codex-luna-max", "high", 5, "max", 5),
    ]);
  });

  it("prints Terra medium when Terra high and medium each have five records", () => {
    const out = reviewOut([
      ...delegationRows(5, {
        model: "gpt-6.1-terra",
        effort: "high",
      }),
      ...delegationRows(5, {
        model: "gpt-6.1-terra",
        effort: "medium",
      }),
    ]);
    assert.deepEqual(effortReviewLines(out), [
      expectedReviewEffortLine("codex-terra", "medium", 5, "high", 5),
    ]);
  });

  it("does not count a different harness or model for either group", () => {
    for (const otherGroup of [
      { harness: "cursor", model: "gpt-6-luna" },
      { harness: "codex-cli", model: "gpt-6.1-terra" },
    ]) {
      const out = reviewOut([
        ...delegationRows(5, { effort: "max" }),
        ...delegationRows(4, { effort: "high" }),
        ...delegationRows(5, { ...otherGroup, effort: "high" }),
      ]);
      assert.deepEqual(effortReviewLines(out), []);
    }
  });

  it("uses the requested since window for both cells and effort signals", () => {
    const thirtyDaysAgo = new Date(
      NOW.getTime() - 30 * 86_400_000,
    ).toISOString();
    const rows = [
      ...delegationRows(5, { effort: "max", at: thirtyDaysAgo }),
      ...delegationRows(5, { effort: "high", at: thirtyDaysAgo }),
    ];
    const short = reviewOut(rows, 7);
    assert.ok(!short.includes("review×M:"));
    assert.deepEqual(effortReviewLines(short), []);

    const standard = reviewOut(rows, EXPLORE_WINDOW_DAYS);
    assert.ok(standard.includes("review×M:"));
    assert.ok(
      standard.some((line) => line.includes("codex-cli/gpt-6-luna/high:")),
    );
    assert.ok(
      standard.some((line) => line.includes("codex-cli/gpt-6-luna/max:")),
    );
    assert.deepEqual(effortReviewLines(standard), [
      expectedReviewEffortLine("codex-luna-max", "high", 5, "max", 5),
    ]);
  });

  it("prints the effort signal after an automatic rewrite revisit signal", () => {
    const thirtyOneDaysAgo = new Date(
      NOW.getTime() - 31 * 86_400_000,
    ).toISOString();
    const out = reviewOut([
      ...delegationRows(21, {
        harness: "claude-code-agent",
        model: "sonnet",
        effort: "unknown",
        adopted: 17,
        discarded: 4,
        at: thirtyOneDaysAgo,
      }),
      ...delegationRows(21, {
        model: "gpt-6.1-terra",
        effort: "high",
        at: thirtyOneDaysAgo,
      }),
      ...delegationRows(5, {
        model: "gpt-6.1-terra",
        effort: "medium",
        at: thirtyOneDaysAgo,
      }),
    ]);
    const revisitIndex = out.findIndex((line) =>
      line.includes("自動書き換えの再検討の条件に当たる"),
    );
    const effortIndex = out.findIndex((line) =>
      line.includes("effort の見直しの条件に当たる:"),
    );
    assert.ok(revisitIndex >= 0);
    assert.ok(effortIndex > revisitIndex);
  });
});
