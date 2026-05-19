#!/usr/bin/env node --test
import { ok, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  computeDesignHash,
  computeDocumentHash,
  PLAN_NORMALIZERS,
  SPEC_NORMALIZERS,
  stripReviewerOutputsSections,
} from "../../lib/document-hash.ts";
import { canCarryForwardVerdict } from "../../implementations/plan-review-automation.ts";

describe("document-hash shared module — base normalizers", () => {
  it("strips auto-review marker, blanks Approval value, resets checkbox, trimEnd", () => {
    const content = [
      "## Plan",
      "- [x] done",
      "## Approval",
      "- Approval Status: approved",
      "",
      "<!-- auto-review: verdict=pass; hash=abc -->",
      "",
    ].join("\n");
    const expectedSource = [
      "## Plan",
      "- [ ] done",
      "## Approval",
      "- Approval Status:",
    ].join("\n");
    strictEqual(
      computeDocumentHash(content, SPEC_NORMALIZERS),
      computeDocumentHash(expectedSource, SPEC_NORMALIZERS),
    );
  });

  it("PLAN_NORMALIZERS yields identical hash to SPEC_NORMALIZERS for marker/approval/checkbox-only diffs", () => {
    const a = "## Tasks\n- [ ] t\n## Approval\n- Approval Status: pending";
    const b = "## Tasks\n- [x] t\n## Approval\n- Approval Status: approved";
    strictEqual(
      computeDocumentHash(a, PLAN_NORMALIZERS),
      computeDocumentHash(b, PLAN_NORMALIZERS),
    );
  });

  it("hash changes when substantive body content changes", () => {
    ok(
      computeDocumentHash("## Plan\n- A", SPEC_NORMALIZERS) !==
        computeDocumentHash("## Plan\n- A and B", SPEC_NORMALIZERS),
    );
  });
});

describe("R3: Reviewer Outputs section boundary (anchored ^## Reviewer Outputs \\(Round \\d+\\)$)", () => {
  it("(iii) removes ALL numbered Round sections up to next H2", () => {
    const src = [
      "## Key Decisions",
      "- K1",
      "## Reviewer Outputs (Round 1)",
      "### logic-validator",
      "- verdict: pass",
      "## Reviewer Outputs (Round 2)",
      "### logic-validator",
      "- verdict: needs-work",
      "## Approval",
      "- Plan Status: complete",
    ].join("\n");
    strictEqual(
      stripReviewerOutputsSections(src),
      [
        "## Key Decisions",
        "- K1",
        "## Approval",
        "- Plan Status: complete",
      ].join("\n"),
    );
  });

  it("(i) does NOT remove a heading without (Round N)", () => {
    const src = ["## Reviewer Outputs", "- kept", "## Approval"].join("\n");
    strictEqual(stripReviewerOutputsSections(src), src);
  });

  it("(ii) stops at the next ## heading even if section body contains ### subheads", () => {
    const src = [
      "## Reviewer Outputs (Round 1)",
      "### nested",
      "body",
      "## NextSection",
      "preserved",
    ].join("\n");
    strictEqual(
      stripReviewerOutputsSections(src),
      ["## NextSection", "preserved"].join("\n"),
    );
  });

  it("(iv) preserves content after the terminating H2 when Round section is last", () => {
    const src = [
      "## Tasks",
      "- T1",
      "## Reviewer Outputs (Round 3)",
      "### scope-justification-reviewer",
      "- verdict: pass",
    ].join("\n");
    strictEqual(
      stripReviewerOutputsSections(src),
      ["## Tasks", "- T1"].join("\n"),
    );
  });
});

describe("bookkeeping hash-neutralization (摩擦B/C 解消)", () => {
  it("appending Reviewer Outputs section + intent-triage marker does NOT change hash", () => {
    const before = [
      "## Key Decisions",
      "- K1: ceremony proxy",
      "## Approval",
      "- Plan Status: complete",
      "- Review Status: pass",
      "- Approval Status: pending",
    ].join("\n");
    const after = [
      "## Key Decisions",
      "- K1: ceremony proxy",
      "## Reviewer Outputs (Round 1)",
      "### logic-validator",
      "- verdict: needs-work",
      "- 主指摘: baseline 未定義",
      "## Approval",
      "- Plan Status: complete",
      "- Review Status: pass",
      "- Approval Status: pending",
      "",
      "<!-- intent-triage: adopted=3; excluded=0; at=2026-05-20T00:00:00Z -->",
    ].join("\n");
    strictEqual(
      computeDocumentHash(after, SPEC_NORMALIZERS),
      computeDocumentHash(before, SPEC_NORMALIZERS),
    );
  });
});

describe("computeDesignHash — section-scoped (K7 c)", () => {
  const base = [
    "## Key Decisions",
    "- K1: proxy = design-in-motion",
    "## Files",
    "```",
    "src/a.ts",
    "```",
    "## Tasks",
    "- T1",
    "## Risks",
    "- R1: prose that must NOT affect design-hash",
    "## Reviewer Outputs (Round 1)",
    "### logic-validator",
    "- verdict: needs-work",
  ].join("\n");

  it("ignores changes outside design sections (Risks prose, Reviewer Outputs)", () => {
    const proseEdited = base.replace(
      "- R1: prose that must NOT affect design-hash",
      "- R1: COMPLETELY DIFFERENT PROSE",
    );
    strictEqual(computeDesignHash(proseEdited), computeDesignHash(base));
  });

  it("changes when a design section (Key Decisions) is edited by even 1 char", () => {
    const k1Edited = base.replace("K1: proxy", "K1: Proxy");
    ok(computeDesignHash(k1Edited) !== computeDesignHash(base));
  });

  it("changes when Tasks section is edited", () => {
    ok(
      computeDesignHash(base.replace("- T1", "- T1 modified")) !==
        computeDesignHash(base),
    );
  });

  it("returns null when NO design section present (anti fail-open: empty must NOT be a stable hash)", () => {
    strictEqual(
      computeDesignHash(
        "## Risks\n- prose only\n## Reviewer Outputs (Round 1)\n- x",
      ),
      null,
    );
  });
});

describe("parity & design-hash drift (保守性 ISO)", () => {
  // legacy 4-step normalizer = S3 deploy 前の guard inline computePlanHash の正確な再現
  // (document-workflow-guard.ts:721-728 の旧アルゴリズム)。test 内で固定し旧↔新の関係を pin する。
  const legacy4 = (c: string): string =>
    createHash("sha256")
      .update(
        c
          .replace(/<!--\s*auto-review:[^>]*-->/g, "")
          .replace(/^(- Approval Status:)\s*.*$/m, "$1")
          .replace(/^(\s*- )\[x\]/gm, "$1[ ]")
          .trimEnd(),
        "utf-8",
      )
      .digest("hex");

  it("6-step shared hash == legacy 4-step on docs WITHOUT bookkeeping (superset relation)", () => {
    const noBookkeeping =
      "## Key Decisions\n- K1\n## Approval\n- Approval Status: pending";
    strictEqual(
      computeDocumentHash(noBookkeeping, SPEC_NORMALIZERS),
      legacy4(noBookkeeping),
    );
  });

  it("6-step shared hash != legacy 4-step WITH Reviewer Outputs/intent-triage (INTENTIONAL R4 migration boundary)", () => {
    const withBookkeeping = [
      "## Key Decisions",
      "- K1",
      "## Reviewer Outputs (Round 1)",
      "### logic-validator",
      "- verdict: pass",
      "## Approval",
      "- Approval Status: pending",
      "",
      "<!-- intent-triage: adopted=1; excluded=0; at=2026-05-20T00:00:00Z -->",
    ].join("\n");
    ok(
      computeDocumentHash(withBookkeeping, SPEC_NORMALIZERS) !==
        legacy4(withBookkeeping),
    );
  });

  it("design-hash is independent from full-content hash (different functions, different domains)", () => {
    const c = ["## Key Decisions", "- K1", "## Risks", "- R prose only"].join(
      "\n",
    );
    const proseChanged = c.replace("- R prose only", "- R totally changed");
    ok(computeDocumentHash(c) !== computeDocumentHash(proseChanged));
    strictEqual(computeDesignHash(c), computeDesignHash(proseChanged));
  });
});

describe("K7: prescribed-fix carry-forward (design-hash baseline)", () => {
  it("carry-forward when current design-hash equals baseline needs-work design-hash", () => {
    strictEqual(
      canCarryForwardVerdict({
        currentDesignHash: "AAA",
        baselineDesignHash: "AAA",
      }),
      true,
    );
  });
  it("re-review when design-hash differs from baseline (c not satisfied → AND fails)", () => {
    strictEqual(
      canCarryForwardVerdict({
        currentDesignHash: "BBB",
        baselineDesignHash: "AAA",
      }),
      false,
    );
  });
  it("re-review when baseline design-hash is absent (conservative, parent-spec-hash 欠落と同方針)", () => {
    strictEqual(
      canCarryForwardVerdict({
        currentDesignHash: "AAA",
        baselineDesignHash: null,
      }),
      false,
    );
  });
  it("re-review when current design-hash is null (no design sections → never carry-forward)", () => {
    strictEqual(
      canCarryForwardVerdict({
        currentDesignHash: null,
        baselineDesignHash: "AAA",
      }),
      false,
    );
  });
});

describe("S2 doc: prescribed-fix convergence rule presence", () => {
  it("workflow.md states the 3-condition AND and no-skip fallback", () => {
    const wf = readFileSync(
      fileURLToPath(new URL("../../../rules/workflow.md", import.meta.url)),
      "utf-8",
    );
    ok(wf.includes("prescribed-fix"));
    ok(wf.includes("design-hash"));
    ok(
      wf.includes("no-skip") ||
        wf.includes("再レビューは走らせるが省略はしない"),
    );
  });

  it("workflow.md S3 migration runbook includes review-cache invalidation and parity verify", () => {
    const wf = readFileSync(
      fileURLToPath(new URL("../../../rules/workflow.md", import.meta.url)),
      "utf-8",
    );
    ok(wf.includes("plan-review.cache.json"));
    ok(wf.includes("hash parity") || wf.includes("hash 一致を即検証"));
    ok(wf.includes("実装再開前"));
  });
});
