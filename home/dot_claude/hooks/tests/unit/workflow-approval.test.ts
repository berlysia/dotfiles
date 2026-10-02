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
  isApprovalShapedPrompt,
  parseApprovalUtterance,
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

describe("parseApprovalUtterance (spec K7)", () => {
  it("accepts the bare word, document names and a trailing mark", () => {
    assert.deepEqual(parseApprovalUtterance("承認"), { docs: [] });
    assert.deepEqual(parseApprovalUtterance("  Approve!  "), { docs: [] });
    assert.deepEqual(parseApprovalUtterance("承認 plan-2.md spec.md。"), {
      docs: ["plan-2.md", "spec.md"],
    });
    assert.deepEqual(parseApprovalUtterance("承認 plan-2.md plan-2.md"), {
      docs: ["plan-2.md"],
    });
  });

  it("ignores anything else", () => {
    for (const prompt of [
      "承認します",
      "承認、ただし T3 は直して",
      "approve this?",
      "plan.md 承認",
      "承認 notes.md",
      "承認 PLAN.MD",
      "/execute-plan 承認",
      "承認\n追記",
      "ok",
    ]) {
      assert.equal(
        parseApprovalUtterance(prompt),
        null,
        JSON.stringify(prompt),
      );
    }
  });
});

describe("isApprovalShapedPrompt (issue J: scheduled prompts)", () => {
  it("is true for what the recorder accepts, in any surrounding whitespace", () => {
    for (const prompt of [
      "承認",
      "承認 plan-99.md",
      "  Approve!  ",
      "承認\u3000spec.md。",
      "承認\n",
      "承認！",
      "\uFEFF承認",
      "\u00A0承認\u2028",
    ]) {
      assert.equal(
        isApprovalShapedPrompt(prompt),
        true,
        JSON.stringify(prompt),
      );
    }
  });

  it("is also true when NFKC and format-character removal make it an approval", () => {
    // The recorder would not record these as typed, but a front-end that
    // normalizes a fired prompt could turn them into one.
    assert.equal(isApprovalShapedPrompt("承\u200B認"), true);
    assert.equal(isApprovalShapedPrompt("ＡＰＰＲＯＶＥ"), true);
  });

  it("is false for anything else, including non-strings", () => {
    for (const prompt of [
      "承認します、ただし…",
      "J-probe",
      "承認\nfoo",
      "",
      123,
      null,
      undefined,
      { prompt: "承認" },
    ]) {
      assert.equal(
        isApprovalShapedPrompt(prompt),
        false,
        JSON.stringify(prompt),
      );
    }
  });
});
