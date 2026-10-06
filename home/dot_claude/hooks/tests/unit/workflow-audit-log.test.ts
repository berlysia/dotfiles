#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendOffPlanLog,
  DELEGATION_USES_LOG,
  recordDelegatedOffPlanWrite,
  recordDelegationUse,
} from "../../lib/workflow-audit-log.ts";

describe("workflow-audit-log: appendOffPlanLog raw-token handling (K9a)", () => {
  it("records a plain path target as path=<JSON>", () => {
    const wf = mkdtempSync(join(tmpdir(), "audit-log-"));
    appendOffPlanLog(wf, "Write", "src/a.ts");
    const content = readFileSync(join(wf, "off-plan-writes.log"), "utf-8");
    assert.match(content, /path="src\/a\.ts"/);
    assert.doesNotMatch(content, /raw-token:/);
  });

  it("records a target containing an unexpanded $ token as raw-token:<JSON>", () => {
    const wf = mkdtempSync(join(tmpdir(), "audit-log-"));
    appendOffPlanLog(wf, "Bash", "$HOME/scratch/out.ts");
    const content = readFileSync(join(wf, "off-plan-writes.log"), "utf-8");
    assert.match(content, /path=raw-token:"\$HOME\/scratch\/out\.ts"/);
  });

  it("recordDelegationUse reports the first use of a plan version under a spec version once", () => {
    const wf = mkdtempSync(join(tmpdir(), "audit-log-"));
    const use = {
      planName: "plan-1.md",
      planHash: "a".repeat(64),
      specHash: "b".repeat(64),
    };
    assert.deepEqual(recordDelegationUse(wf, use), {
      first: true,
      written: true,
    });
    assert.deepEqual(recordDelegationUse(wf, use), {
      first: false,
      written: true,
    });
    assert.equal(
      recordDelegationUse(wf, { ...use, planHash: "c".repeat(64) }).first,
      true,
    );
    assert.equal(
      recordDelegationUse(wf, { ...use, specHash: "d".repeat(64) }).first,
      true,
    );
    const content = readFileSync(join(wf, DELEGATION_USES_LOG), "utf-8");
    assert.equal(content.trimEnd().split("\n").length, 3);
    assert.match(
      content,
      /\tplan="plan-1\.md"\tplan-hash=a{64}\tspec-hash=b{64}\trevoke="[^"]+"\n/,
    );
  });

  it("recordDelegatedOffPlanWrite reports a target once per spec version", () => {
    const wf = mkdtempSync(join(tmpdir(), "audit-log-"));
    const write = { target: "/repo/src/b.ts", specHash: "b".repeat(64) };
    assert.deepEqual(recordDelegatedOffPlanWrite(wf, write), {
      first: true,
      written: true,
    });
    assert.deepEqual(recordDelegatedOffPlanWrite(wf, write), {
      first: false,
      written: true,
    });
    assert.equal(
      recordDelegatedOffPlanWrite(wf, { ...write, target: "/repo/lib/b.ts" })
        .first,
      true,
    );
    assert.equal(
      recordDelegatedOffPlanWrite(wf, { ...write, specHash: "d".repeat(64) })
        .first,
      true,
    );
    assert.match(
      readFileSync(join(wf, DELEGATION_USES_LOG), "utf-8"),
      /\toff-plan="\/repo\/src\/b\.ts"\tspec-hash=b{64}\trevoke="[^"]+"\n/,
    );
  });

  it("recordDelegationUse says so when the log cannot be written", () => {
    const wf = mkdtempSync(join(tmpdir(), "audit-log-"));
    mkdirSync(join(wf, DELEGATION_USES_LOG));
    const use = {
      planName: "plan-1.md",
      planHash: "a".repeat(64),
      specHash: "b".repeat(64),
    };
    assert.deepEqual(recordDelegationUse(wf, use), {
      first: true,
      written: false,
    });
    assert.deepEqual(recordDelegationUse(wf, use), {
      first: true,
      written: false,
    });
  });
});
