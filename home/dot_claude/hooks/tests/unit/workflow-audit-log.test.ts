#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendOffPlanLog } from "../../lib/workflow-audit-log.ts";

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
});
