#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  APPROVALS_LOG,
  appendApproval,
  readLatestApprovals,
} from "../../lib/workflow-approval.ts";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

describe("workflow-approval (spec K8)", () => {
  it("appends one JSON line per approval", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendApproval(wf, {
      doc: "plan.md",
      hash: H1,
      session: "s1",
      at: "2026-10-02T00:00:00.000Z",
    });
    assert.equal(
      readFileSync(join(wf, APPROVALS_LOG), "utf-8"),
      `${JSON.stringify({ v: 1, doc: "plan.md", hash: H1, session: "s1", at: "2026-10-02T00:00:00.000Z" })}\n`,
    );
  });

  it("uses only the last line for each document, so a revert does not revive an old approval", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendApproval(wf, { doc: "plan.md", hash: H1, session: "s", at: "t1" });
    appendApproval(wf, { doc: "plan.md", hash: H2, session: "s", at: "t2" });
    appendApproval(wf, { doc: "spec.md", hash: H1, session: "s", at: "t3" });
    const r = readLatestApprovals(wf);
    assert.equal(r.latest.get("plan.md")?.hash, H2);
    assert.equal(r.latest.get("spec.md")?.hash, H1);
    assert.equal(r.ignoredLines, 0);
    assert.equal(r.readError, undefined);
  });

  it("skips malformed lines and other versions, and counts them", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendFileSync(
      join(wf, APPROVALS_LOG),
      [
        "not json",
        JSON.stringify({
          v: 2,
          doc: "plan.md",
          hash: H1,
          session: "s",
          at: "t",
        }),
        JSON.stringify({
          v: 1,
          doc: "plan.md",
          hash: "short",
          session: "s",
          at: "t",
        }),
        JSON.stringify({
          v: 1,
          doc: "plan.md",
          hash: H2,
          session: "s",
          at: "t",
        }),
        "",
      ].join("\n"),
    );
    const r = readLatestApprovals(wf);
    assert.equal(r.latest.get("plan.md")?.hash, H2);
    assert.equal(r.ignoredLines, 3);
  });

  it("reads an absent log as no approvals", () => {
    const r = readLatestApprovals(mkdtempSync(join(tmpdir(), "approvals-")));
    assert.equal(r.latest.size, 0);
    assert.equal(r.ignoredLines, 0);
    assert.equal(r.readError, undefined);
  });

  it("refuses to append through a symlink at the ledger's name", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    const outside = join(wf, "..", `outside-${Date.now()}.txt`);
    writeFileSync(outside, "keep");
    symlinkSync(outside, join(wf, APPROVALS_LOG));
    assert.throws(
      () =>
        appendApproval(wf, { doc: "plan.md", hash: H1, session: "s", at: "t" }),
      /ELOOP|EMLINK/,
    );
    assert.equal(readFileSync(outside, "utf-8"), "keep");
  });

  it("reports an unreadable log instead of throwing", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    mkdirSync(join(wf, APPROVALS_LOG));
    const r = readLatestApprovals(wf);
    assert.equal(r.latest.size, 0);
    assert.match(r.readError ?? "", /EISDIR/);
  });
});
