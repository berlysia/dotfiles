#!/usr/bin/env node --test

import { deepStrictEqual, equal, strictEqual } from "node:assert";
import { test } from "node:test";
import {
  LENIENT_STATUS_LINE,
  parseLatestAutoReviewMarker,
  STRICT_APPROVAL_STATUS,
  STRICT_PLAN_STATUS,
  STRICT_REVIEW_STATUS,
} from "../../lib/workflow-marker.ts";

test("parseLatestAutoReviewMarker takes the last marker and splits hyphenated keys", () => {
  const content = [
    "<!-- auto-review: verdict=needs-work; hash=111; design-hash=aaa -->",
    "<!-- auto-review: verdict=pass; hash=222; design-hash=bbb; parent-spec-hash=ccc; at=2026-02-19T00:00:00.000Z -->",
  ].join("\n");
  deepStrictEqual(parseLatestAutoReviewMarker(content), {
    verdict: "pass",
    hash: "222",
    designHash: "bbb",
    parentSpecHash: "ccc",
  });
});

test("parseLatestAutoReviewMarker returns null without a verdict/hash", () => {
  strictEqual(parseLatestAutoReviewMarker("no marker here"), null);
  strictEqual(
    parseLatestAutoReviewMarker("<!-- auto-review: at=2026 -->"),
    null,
  );
});

test("parseLatestAutoReviewMarker keeps design-hash and parent-spec-hash distinct from hash", () => {
  const m = parseLatestAutoReviewMarker(
    "<!-- auto-review: verdict=pass; hash=H; design-hash=D; parent-spec-hash=P -->",
  );
  strictEqual(m?.hash, "H");
  strictEqual(m?.designHash, "D");
  strictEqual(m?.parentSpecHash, "P");
});

test("strict status regexes require the hyphen and reject annotations", () => {
  equal(STRICT_REVIEW_STATUS.test("- Review Status: pass"), true);
  equal(STRICT_REVIEW_STATUS.test("Review Status: pass"), false);
  equal(STRICT_REVIEW_STATUS.test("- Review Status: pass (note)"), false);
  equal(STRICT_PLAN_STATUS.test("- Plan Status: complete"), true);
  equal(STRICT_APPROVAL_STATUS.test("- Approval Status: approved"), true);
});

test("lenient status line matches hyphen-less and annotated forms for display", () => {
  const doc = [
    "- Plan Status: complete",
    "Review Status: pass",
    "- Approval Status: approved (per goal)",
  ].join("\n");
  const found = doc.match(LENIENT_STATUS_LINE) ?? [];
  strictEqual(found.length, 3);
});
