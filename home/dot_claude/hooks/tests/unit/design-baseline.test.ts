#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendDesignBaseline,
  type BaselineLookup,
  computeDecisionSectionsHash,
  decideRoundExtension,
  EXTENSION_CAUSES,
  parseDesignBaseline,
  readDesignBaseline,
  type RoundExtensionRequest,
} from "../../lib/design-baseline.ts";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

const docWith = (keyDecisions: string, alternatives = "- alt") =>
  [
    "## Key Decisions",
    keyDecisions,
    "",
    "## Alternative Approaches (Greenfield View)",
    alternatives,
    "",
    "## Approval",
    "- Approval Status: pending",
  ].join("\n");

describe("computeDecisionSectionsHash", () => {
  it("ignores whitespace-only differences (trailing spaces, newline counts)", () => {
    const a = docWith("- K1: x\n- K2: y");
    const b = docWith("- K1:   x   \n\n\n- K2: y  \n");
    assert.equal(
      computeDecisionSectionsHash(a),
      computeDecisionSectionsHash(b),
    );
  });

  it("changes when one word of Alternative Approaches changes", () => {
    assert.notEqual(
      computeDecisionSectionsHash(docWith("- K1", "- alt one")),
      computeDecisionSectionsHash(docWith("- K1", "- alt two")),
    );
  });

  it("returns null when neither section exists", () => {
    assert.equal(
      computeDecisionSectionsHash("## Files\n- a\n\n## Tasks\n- t\n"),
      null,
    );
  });

  it("hashes a document that has only one of the two sections", () => {
    const hash = computeDecisionSectionsHash("## Key Decisions\n- K1\n");
    assert.match(hash ?? "", /^[0-9a-f]{64}$/);
  });
});

describe("parseDesignBaseline", () => {
  const line = (doc: string, round: number, hash: string) =>
    `${doc}\t${round}\t${hash}\n`;

  it("uses the last line of the same doc and ignores other docs", () => {
    const content =
      line("spec.md", 1, H1) +
      line("plan-1.md", 2, H2) +
      line("spec.md", 3, H2);
    assert.deepEqual(parseDesignBaseline(content, "spec.md"), {
      kind: "found",
      hash: H2,
    });
    assert.deepEqual(parseDesignBaseline(content, "plan-1.md"), {
      kind: "found",
      hash: H2,
    });
  });

  it("reports missing when the doc has no line", () => {
    assert.deepEqual(parseDesignBaseline(line("plan-1.md", 1, H1), "spec.md"), {
      kind: "missing",
    });
    assert.deepEqual(parseDesignBaseline("", "spec.md"), { kind: "missing" });
  });

  it("reports unreadable for a line with a single tab", () => {
    assert.deepEqual(parseDesignBaseline("spec.md\tabc\n", "spec.md"), {
      kind: "unreadable",
    });
  });

  it("reports unreadable for a line ending in CRLF", () => {
    assert.deepEqual(parseDesignBaseline(`spec.md\t1\t${H1}\r\n`, "spec.md"), {
      kind: "unreadable",
    });
  });

  it("reports unreadable for a doc name that is not spec.md / plan.md / plan-N.md", () => {
    assert.deepEqual(parseDesignBaseline(`../x.md\t1\t${H1}\n`, "../x.md"), {
      kind: "unreadable",
    });
  });

  it("judges by the last line: a later valid line recovers an earlier broken one", () => {
    const content = `spec.md\tbroken\n${line("spec.md", 2, H1)}`;
    assert.deepEqual(parseDesignBaseline(content, "spec.md"), {
      kind: "found",
      hash: H1,
    });
  });

  it("a broken last line makes the doc unreadable even if an earlier line is valid", () => {
    const content = `${line("spec.md", 2, H1)}spec.md\t3\tnot-a-hash\n`;
    assert.deepEqual(parseDesignBaseline(content, "spec.md"), {
      kind: "unreadable",
    });
  });
});

describe("design-baseline file IO", () => {
  it("appends one line per call and reads the last back", () => {
    const wf = realpathSync(mkdtempSync(join(tmpdir(), "design-baseline-")));
    assert.deepEqual(readDesignBaseline(wf, "spec.md"), { kind: "missing" });
    appendDesignBaseline(wf, "spec.md", 1, H1);
    appendDesignBaseline(wf, "spec.md", 2, H2);
    assert.equal(
      readFileSync(join(wf, ".design-baseline"), "utf-8"),
      `spec.md\t1\t${H1}\nspec.md\t2\t${H2}\n`,
    );
    assert.deepEqual(readDesignBaseline(wf, "spec.md"), {
      kind: "found",
      hash: H2,
    });
  });

  it("throws when the path cannot be appended (a directory in its place)", () => {
    const wf = realpathSync(mkdtempSync(join(tmpdir(), "design-baseline-")));
    mkdirSync(join(wf, ".design-baseline"));
    assert.throws(() => appendDesignBaseline(wf, "spec.md", 1, H1));
  });

  it("refuses a doc name outside the allowed forms", () => {
    const wf = realpathSync(mkdtempSync(join(tmpdir(), "design-baseline-")));
    assert.throws(() => appendDesignBaseline(wf, "../x.md", 1, H1));
    assert.throws(() => appendDesignBaseline(wf, "spec.md", 1, "short"));
  });

  it("treats an unreadable path as unreadable, not missing", () => {
    const wf = realpathSync(mkdtempSync(join(tmpdir(), "design-baseline-")));
    mkdirSync(join(wf, ".design-baseline"));
    assert.deepEqual(readDesignBaseline(wf, "spec.md"), { kind: "unreadable" });
  });

  it("does not write when nothing is appended", () => {
    const wf = realpathSync(mkdtempSync(join(tmpdir(), "design-baseline-")));
    writeFileSync(join(wf, ".design-baseline"), "");
    assert.deepEqual(readDesignBaseline(wf, "spec.md"), { kind: "missing" });
  });
});

const FOUND = (hash: string): BaselineLookup => ({ kind: "found", hash });
const MISSING: BaselineLookup = { kind: "missing" };
const UNREADABLE: BaselineLookup = { kind: "unreadable" };

const request = (
  overrides: Partial<RoundExtensionRequest>,
): RoundExtensionRequest => ({
  documentType: "spec",
  stage: "self-extendable",
  approver: "self",
  cause: "landing",
  full: false,
  latestVerdict: "needs-work",
  baseline: FOUND(H1),
  currentHash: H1,
  ...overrides,
});

describe("decideRoundExtension: round-side contract table", () => {
  type Row = {
    name: string;
    req: Partial<RoundExtensionRequest>;
    expected: "accept" | "reject";
    messageIncludes?: string[];
  };
  const rows: Row[] = [
    {
      name: "within budget, bare round (no approver)",
      req: { stage: "within-budget", approver: null, cause: undefined },
      expected: "accept",
    },
    {
      name: "within budget, --self-extend --cause landing",
      req: { stage: "within-budget", cause: "landing" },
      expected: "accept",
    },
    {
      name: "within budget, --self-extend --cause foo",
      req: { stage: "within-budget", cause: "foo" },
      expected: "reject",
      messageIncludes: ["landing", "kd-changed", "blocker", "not-narrowing"],
    },
    {
      name: "within budget, --self-extend without --cause",
      req: { stage: "within-budget", cause: undefined },
      expected: "reject",
      messageIncludes: ["--cause", "--reason"],
    },
    {
      name: "self stage, landing, needs-work, design sections unchanged",
      req: {},
      expected: "accept",
    },
    {
      name: "self stage, not-narrowing, unchanged",
      req: { cause: "not-narrowing" },
      expected: "accept",
    },
    {
      name: "self stage without --cause",
      req: { cause: undefined },
      expected: "reject",
      messageIncludes: ["--cause", "landing", "not-narrowing"],
    },
    {
      name: "self stage, unknown cause",
      req: { cause: "foo" },
      expected: "reject",
    },
    {
      name: "--extend --cause landing",
      req: { approver: "human", cause: "landing" },
      expected: "reject",
    },
    {
      name: "--reframer-extend --cause landing",
      req: { approver: "reframer", cause: "landing", stage: "beyond" },
      expected: "reject",
    },
    {
      name: "--extend without cause",
      req: { approver: "human", cause: undefined, stage: "beyond" },
      expected: "accept",
    },
    {
      name: "latest blocker, --cause landing",
      req: { latestVerdict: "blocker", cause: "landing" },
      expected: "reject",
      messageIncludes: ["blocker"],
    },
    {
      name: "latest blocker, design changed, --cause kd-changed (blocker wins)",
      req: {
        latestVerdict: "blocker",
        cause: "kd-changed",
        currentHash: H2,
      },
      expected: "reject",
    },
    {
      name: "latest blocker, design changed, --cause blocker --full",
      req: {
        latestVerdict: "blocker",
        cause: "blocker",
        full: true,
        currentHash: H2,
      },
      expected: "accept",
    },
    {
      name: "latest blocker, --cause blocker, design unchanged",
      req: { latestVerdict: "blocker", cause: "blocker" },
      expected: "accept",
    },
    {
      name: "latest needs-work, --cause blocker",
      req: { latestVerdict: "needs-work", cause: "blocker" },
      expected: "reject",
    },
    {
      name: "no marker in the cycle, --cause blocker",
      req: { latestVerdict: null, cause: "blocker" },
      expected: "reject",
    },
    {
      name: "design changed, --cause landing",
      req: { currentHash: H2, cause: "landing" },
      expected: "reject",
      messageIncludes: ["kd-changed"],
    },
    {
      name: "design changed, --cause not-narrowing",
      req: { currentHash: H2, cause: "not-narrowing" },
      expected: "reject",
    },
    {
      name: "design unchanged, --cause kd-changed",
      req: { cause: "kd-changed" },
      expected: "reject",
    },
    {
      name: "design changed, --cause kd-changed --full",
      req: { currentHash: H2, cause: "kd-changed", full: true },
      expected: "accept",
    },
    {
      name: "design unchanged, --cause landing --full",
      req: { cause: "landing", full: true },
      expected: "reject",
      messageIncludes: ["--full"],
    },
    {
      name: "plan-N, --cause landing --full",
      req: {
        documentType: "plan-numbered",
        baseline: MISSING,
        currentHash: null,
        full: true,
      },
      expected: "reject",
    },
    {
      name: "plan-N, --cause kd-changed --full with no baseline line",
      req: {
        documentType: "plan-numbered",
        baseline: MISSING,
        currentHash: null,
        cause: "kd-changed",
        full: true,
      },
      expected: "reject",
    },
    {
      name: "plan-N, --cause kd-changed even without --full",
      req: {
        documentType: "plan-numbered",
        baseline: MISSING,
        currentHash: null,
        cause: "kd-changed",
      },
      expected: "reject",
    },
    {
      name: "baseline missing, --cause kd-changed --full (self-declared)",
      req: { baseline: MISSING, cause: "kd-changed", full: true },
      expected: "accept",
    },
    {
      name: "baseline missing, --cause landing",
      req: { baseline: MISSING, cause: "landing" },
      expected: "accept",
    },
    {
      name: "baseline unreadable, --cause kd-changed",
      req: { baseline: UNREADABLE, cause: "kd-changed" },
      expected: "reject",
      messageIncludes: [".design-baseline"],
    },
    {
      name: "baseline unreadable, --full",
      req: { baseline: UNREADABLE, cause: "landing", full: true },
      expected: "reject",
      messageIncludes: [".design-baseline"],
    },
    {
      name: "baseline unreadable, --cause landing",
      req: { baseline: UNREADABLE, cause: "landing" },
      expected: "accept",
    },
    {
      name: "baseline unreadable, --cause not-narrowing",
      req: { baseline: UNREADABLE, cause: "not-narrowing" },
      expected: "accept",
    },
    {
      name: "baseline unreadable, latest blocker, --cause blocker",
      req: { baseline: UNREADABLE, latestVerdict: "blocker", cause: "blocker" },
      expected: "accept",
    },
    {
      name: "no decision sections in spec.md, --cause kd-changed",
      req: { baseline: MISSING, currentHash: null, cause: "kd-changed" },
      expected: "reject",
    },
    {
      name: "no decision sections in spec.md, --full",
      req: { baseline: MISSING, currentHash: null, full: true },
      expected: "reject",
    },
    {
      name: "plain plan.md behaves like spec.md (changed, kd-changed --full)",
      req: {
        documentType: "plan",
        currentHash: H2,
        cause: "kd-changed",
        full: true,
      },
      expected: "accept",
    },
    {
      name: "within budget, --self-extend --full with unchanged design",
      req: { stage: "within-budget", full: true },
      expected: "reject",
    },
    {
      name: "within budget, --self-extend --full with changed design",
      req: { stage: "within-budget", full: true, currentHash: H2 },
      expected: "accept",
    },
    {
      name: "within budget, blocker cause is not checked against the verdict",
      req: { stage: "within-budget", cause: "blocker", latestVerdict: null },
      expected: "accept",
    },
  ];

  for (const row of rows) {
    it(`${row.name} -> ${row.expected}`, () => {
      const result = decideRoundExtension(request(row.req));
      assert.equal(
        result.ok,
        row.expected === "accept",
        JSON.stringify(result),
      );
      if (!result.ok) {
        for (const needle of row.messageIncludes ?? []) {
          assert.ok(result.message.includes(needle), result.message);
        }
      }
    });
  }

  it("returns the accepted cause for logging", () => {
    const result = decideRoundExtension(request({ cause: "not-narrowing" }));
    assert.deepEqual(result, { ok: true, cause: "not-narrowing" });
    assert.deepEqual(
      decideRoundExtension(request({ approver: "human", cause: undefined })),
      { ok: true, cause: null },
    );
  });

  it("knows exactly four causes", () => {
    assert.deepEqual(
      [...EXTENSION_CAUSES],
      ["landing", "kd-changed", "blocker", "not-narrowing"],
    );
  });
});
