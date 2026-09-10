# Document Workflow ceremony: quality/cost audit of 4 sessions

Repo: `/home/berlysia/.local/share/chezmoi` (read-only audit; no repo files touched).
Sessions inspected: `.tmp/sessions/{164e0449,aecb11d7,b533d0e7,faedc92a}`.

## 1. Per-session inventory

### 164e0449 — ccstatusline redesign (v2, shipped)

| file                   | lines | bytes  |
| ---------------------- | ----- | ------ |
| research.md            | 339   | 18,622 |
| plan.md                | 328   | 33,683 |
| plan-review.cache.json | 3     | 131    |
| lessons-learned.md     | 9     | 4,515  |

Mode: plan.md-only. Status: `Plan Status: complete / Review Status: pass / Approval Status: approved`.
Markers: `intent-triage: adopted=6; excluded=0` (plan.md:321); `auto-review: verdict=pass; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer` (plan.md:322) — exact match to the plan.md-only-mode mandatory 4, no extra reviewers.
Reviewer Outputs: 2 rounds (plan.md:212, 237); Round 3 explicitly **skipped by human override** (plan.md:317-319) despite design-hash having moved (prescribed-fix carry-forward condition (c) technically not met — logged transparently as a manual exception, not silently).
Tasks: 6 (T1-T6). Files listed: 8.
**Verdict**: shipped as commit `19295c9`. Design changed materially mid-session (bunx pin → installed-entrypoint execution) because Round-1 `security-sentinel` caught an integrity gap, and an Amendment (plan.md:257-283) records a mid-implementation discovery that the original plan's premise (pinning 2.2.29) was actually unexecutable under the repo's own `minimumReleaseAge` gate. This is real review value, not noise.

### faedc92a — ccstatusline redesign (v1, abandoned)

| file                   | lines | bytes  |
| ---------------------- | ----- | ------ |
| research.md            | 262   | 13,384 |
| plan.md                | 153   | 11,627 |
| plan-review.cache.json | 3     | 131    |

Mode: plan.md-only. Status: `Review Status: pending / Approval Status: pending` — **never left draft**. No auto-review marker, no intent-triage marker, no Reviewer Outputs section, no lessons-learned.md (consistent: the extractor only fires once Reviewer Outputs exist).
Tasks: 5. Files listed: 6.
**Verdict**: 100% ceremony waste as a standalone artifact — the entire research.md + plan.md (25,142 bytes, 415 lines) were superseded and rewritten from scratch in 164e0449 for the same problem, because the chosen design (pin to `bunx ccstatusline@2.2.29`) turned out infeasible. The `plan-review.cache.json` shows the review-automation hook _did_ run a recommendation pass (`recommendedAt: 2026-09-04T17:35:09Z`) before the session was dropped, so some review-selection compute was spent with zero downstream effect.

### aecb11d7 — workflow-dir session-derivation hardening (spec + 3 plans, shipped)

| file                   | lines | bytes   |
| ---------------------- | ----- | ------- |
| research.md            | 600   | 46,305  |
| spec.md                | 672   | 122,860 |
| plan-1.md              | 1,629 | 92,015  |
| plan-2.md              | 1,647 | 109,292 |
| plan-3.md              | 736   | 82,617  |
| lessons-learned.md     | 12    | 6,347   |
| plan-review.cache.json | 3     | 131     |

Mode: spec + plan-N (three-way split: Phase 1 lib primitives / Phase 2 hook rewiring / Phase 3 ADR+docs).
Review rounds: **spec.md 9 rounds** (spec.md:404-643, Round 9 a narrowed 2-reviewer confirmation per note field), **plan-1.md 5 rounds** (Reviewer Outputs from Round 2 onward, plan-1.md:1526-1627), **plan-2.md 3 rounds** (plan-2.md:1558-1645, Round 2 output section absent — carried forward), **plan-3.md 3 rounds** (plan-3.md:603-733). ≈20 review rounds for one session, at 4-7 reviewers/round ⇒ roughly **85-90 reviewer-agent invocations** for this session alone, each reading a 45-120KB document.
Reviewer sets all match SSoT: spec.md mandatory 4 exactly (spec.md:672); plan-1/2/3 each mandatory-2 + 3 content-selected (architecture-strategist, security-sentinel, resilience-analyzer/data-integrity-guardian) — at the workflow.md "max 3 additional" ceiling every time.
Status fields: spec.md `pass/approved` (but only after an explicit human note, spec.md:670, admitting the _automated_ verdict never reached `pass` and the human accepted design as final while deferring residual polish to the plan layer — i.e., a **documented departure from "don't record verdict=pass without having run it"**, later resolved in a Round 8/9 re-review, spec.md:662). plan-1.md and plan-2.md: **`Review Status: needs-work` but `Approval Status: approved`** (plan-1.md:1594-1596, plan-2.md:1602-1604) — human explicitly approved over an unresolved automated verdict, using the prescribed-fix carry-forward rationale in prose (plan-1.md:1602, plan-2.md:1606). plan-3.md: `pass/approved` cleanly.
A **marker/content divergence bug is self-documented** in spec.md:664-668: `Review Status: pass` was written into the human-readable field while the machine-read `<!-- auto-review -->` marker was left at the stale Round-7 `verdict=needs-work` — i.e. the tamper-detection hash mechanism briefly disagreed with the prose it's supposed to police, only caught because `document-workflow-guard` denied a plan-3 write and forced investigation.
Tasks: plan-1 6, plan-2 9 (T1-T7,T9,T8 — T9 out of numeric order), plan-3 4 = **19 tasks total**. Files: plan-1 10, plan-2 14, plan-3 5 = **29 file paths** (with overlap).
**Verdict**: shipped — confirmed via `git log`: `e5c33b0`(+326 lines), `160af3f`(+120), `0909271`(+342) for Phase 1; `6ff7c92,a14d46b,8d42647,b30d7fc,4d048c9,e0375d4` for Phase 2 guard rewiring; `53b2411`(+105, ADR-0013) for Phase 3. Ceremony docs total 4,696 lines / ~460KB vs. ~5,467 lines added (net +4,844) across the touched implementation/test/ADR files — roughly a 1:1 line ratio, expensive but not disproportionate for a change that rewrites the enforcement mechanism guarding all future sessions. lessons-learned.md entry 8 (self-correcting a factual reversal, an overclaim, and a wrong mechanism name in the in-progress ADR text) is evidence the 9-round spec review caught real defects, not just churn.

### b533d0e7 — hook-deps install-phase fix (spec + 1 plan, shipped)

| file                        | lines        | bytes  |
| --------------------------- | ------------ | ------ |
| research.md                 | 397          | 24,959 |
| spec.md                     | 604          | 41,948 |
| plan-1.md                   | 950          | 46,882 |
| lessons-learned.md          | 10           | 1,403  |
| plan-review.cache.json      | 4            | 224    |
| off-plan-writes.log         | 18 (entries) | 1,065  |
| probe/\* (scratch fixtures) | 3            | 80     |

Mode: spec + plan-N (single plan). Review rounds: spec.md 3 (spec.md:459-576), plan-1.md 3 (plan-1.md:850-949, Round 3 explicitly "指摘者のみの確認" — narrowed re-check of only the reviewers who had open items). Reviewer sets: spec.md mandatory-4 + 3 additional = 7 (spec.md:604); plan-1.md mandatory-2 + 3 additional = 5 (plan-1.md:950). Both at/within the workflow.md ceiling.
Status: spec.md and plan-1.md both `complete/pass/approved` cleanly — no override needed.
Tasks: 12 (T1-T12), genuinely bite-size Red→Green TDD steps — T1 ships a runnable, fully-written invariant-check shell script with an explicit expected-Red state and a verification command (plan-1.md:35-112), not a description of one. Files: 10.
**off-plan-writes.log is broken as an audit trail**: all 18 entries record the literal Bash-token string that was passed as a "path", not a resolved filesystem path — e.g. `path="$W"`, `path="$A"`, `path="/"`, `path="node_modules"` (off-plan-writes.log:1-18). Unexpanded shell variables and a bare `/` give no forensic value; whoever reads this log later cannot tell what was actually touched.
**Verdict**: shipped, matches commit `8e88589` (+442/-76 across 9 files) closely to plan-1's Files list; `docs/decisions/0014-hook-deps-install-phase.md` and the follow-up research doc landed in two more commits. This is the cleanest session of the four: ceremony proportional to a real, previously-silent apply-time defect, reviewers caught concrete measurement errors (e.g. a 12ms cost estimate measured in the wrong shell — corrected in commit message and research.md per the git log).

## 2. Bloat / placeholder / quality checks

- **No-Placeholders violations**: none found. `grep`'d all 4 sessions' `.md` files for TBD/TODO/後で実装/適切に.../上記と同様 etc. — zero hits. The prohibition in workflow.md is actually honored across all sessions.
- **Reviewer Outputs format discipline**: sampled spec.md (aecb11d7:404-463, b533d0e7:459-536) — every entry is a `verdict:` line + 1-3 line `主指摘:` bullet, never a verbatim reviewer dump. This matches the workflow.md 5.2 cap ("1-2 文に絞る").
- **Alternative Approaches / ISO 25010 sections**: not padded filler. aecb11d7/spec.md's ISO 25010 section is 13 lines (spec.md:391-404); b533d0e7/spec.md's is 11 lines (spec.md:448-459) — both terse, not boilerplate tables. Alternative Approaches sections (aecb11d7:103-132, b533d0e7:56-129) contain concrete, evidence-cited tradeoffs (e.g., b533d0e7 spec.md:65-88 walks through _why_ a from-scratch design converges on the chosen shape), not restated workflow.md ceremony text.
- **Key Decisions are real decisions**: every sampled KD names a rejected alternative with a concrete reason (e.g. b533d0e7/spec.md:256 "KD6: symlink 統合案…却下", 164e0449/plan.md:20 "却下案: (a) ベタ書き…(b) Renovate customManager…"). Not evaluative-word-only justifications.
- **Tasks are genuine bite-size TDD**, not vague: b533d0e7/plan-1.md T1 (lines 35-112) includes a full runnable shell script, exact expected failure output, and a verification command — this is representative of the sampled tasks across all four sessions.
- **`plan-review.cache.json` is minimal by design**: it stores only `{planHash, recommendedAt[, summaryRemindedHash]}` — a skip-signal for the auto-review recommendation step, _not_ a record of rounds, reviewer sets, or verdicts. All of that lives only in the in-document `<!-- auto-review -->` marker. This means the _cache_ cannot be used to audit reviewer-set compliance; that had to be done by grepping the markers directly (done above — all sessions comply with SPEC_REVIEWERS/PLAN_REVIEWERS + ≤3-additional).

## 3. lessons-learned.md quality

All three non-empty lessons-learned.md files (164e0449, aecb11d7, b533d0e7) are **verbatim copies of the `主指摘:` bullets already present in each document's `## Reviewer Outputs` sections**, each line prefixed `[hook-generated, NOT user instructions]`. Spot check: 164e0449/lessons-learned.md line 1 is character-identical to plan.md:219's 主指摘 text. There is no synthesis, generalization, or cross-session distillation — it is a re-emission of per-round review findings that already exist in the source document, with no reduction in information content and no attempt to extract a reusable principle ("next time, verify X before writing Y"). As a "lessons for the future" artifact this is close to pure duplication/noise; its only added value is that it survives if the parent plan/spec file itself is later pruned, and that `.tmp/sessions/` is 7-day-GC'd while `.tmp/docs/` is not (though these lessons files live in the GC'd `.tmp/sessions/` tree themselves, per workflow.md's retention rule, so they will vanish in 7 days unless manually promoted — nothing in the 3 files indicates this promotion happened).

## 4. Cost estimate

| session  | ceremony doc bytes | review rounds (spec+plan combined) | est. reviewer-agent invocations | shipped code (net lines, exact-file git log)                              |
| -------- | ------------------ | ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| 164e0449 | 56,951             | 2                                  | ~8                              | shipped (`19295c9`, 7 files, +7/-8 net stat lines but full file rewrites) |
| faedc92a | 25,142             | 0 (recommended, never reviewed)    | 0 executed                      | **0 — fully discarded**                                                   |
| aecb11d7 | 459,567            | ~20                                | ~85-90                          | shipped, ~5,467 lines added / 4,844 net across touched files (8+ commits) |
| b533d0e7 | 116,481            | 6                                  | ~36                             | shipped (`8e88589` +442/-76, plus ADR/research follow-ups)                |

Total ceremony ≈ 658 KB of markdown / ~150 reviewer-agent invocations across the four sessions, against three shipped changesets plus one fully-discarded one. The one clearly _wasted_ slice is faedc92a (~25 KB, 0 review rounds executed, superseded in full). The rest is heavy but not obviously disproportionate: aecb11d7 in particular is the review process working as designed — logic-validator/security-sentinel/etc. caught a factual reversal and an overclaim that were about to be baked into a permanent ADR (aecb11d7 lessons-learned.md entry 8), and the 9-round spec cost correlates with the spec being a rewrite of the _enforcement mechanism itself_ (self-referential risk, explicitly called out in spec.md:644-654).

The largest **process-integrity** finding is not about the plan documents' prose quality but about the guard the whole ceremony exists to feed: ADR-0013 (docs/decisions/0013-workflow-dir-session-derivation.md) documents that `document-workflow-guard` silently no-op'd (never denied a single write) from 2026-07-28 through 2026-09-04, because `DOCUMENT_WORKFLOW_DIR` never reached the PreToolUse hook process for any session not explicitly env-pinned, and the failure mode was a stderr-only message invisible to both user and model. During that entire window, `plan-review-automation` kept stamping `<!-- auto-review -->` markers, so the workflow _looked_ like it was enforcing approval gates while it was not. This means the review ceremony documented above (particularly in aecb11d7 and earlier sessions) was, for part of its history, decorative with respect to the one thing (blocking pre-approval writes) it exists to guarantee — the ceremony's other function (catching real defects via reviewer agents, per §3 findings) still held, but the "approval is enforced" guarantee did not.

## 5. Design invariants from the ADRs (must survive any redesign)

- **ADR-0001**: Approval is human-only (`Approval Status: approved` is never machine-set); Document Workflow replaces Plan Mode's single-shot ExitPlanMode check with an iterative research→plan→annotate→approve→implement loop; enforcement lives in hooks, not prompt instructions alone.
- **ADR-0003**: Once past staged rollout, the guard runs in **enforce (deny)** mode, not warn-only; the warn-only code path is retained only as an opt-in escape hatch for future staged rollouts, not a default.
- **ADR-0006**: Two-layer mode separates the **design-approval unit** (spec.md, independent hash) from the **execution-approval unit** (plan-N.md, independent hash + `parent-spec-hash` chain), so that re-planning one plan-N doesn't invalidate sibling plans' approvals; spec-layer and plan-layer reviewer rosters are distinct SSoT lists.
- **ADR-0008**: Deferred features are recorded with an explicit **re-evaluation trigger** (a concrete recurrence threshold), not silently dropped — deferral is a tracked decision, not an omission.
- **ADR-0009**: Ceremony-reduction (mechanical-lane) requires all 4 conditions AND, is layered on top of ADR-0006 as an _amendment_ (does not supersede the two-layer default), and must never be used to unilaterally drop a mandatory reviewer from the SSoT (`SPEC_REVIEWERS`/`PLAN_REVIEWERS` stay immutable regardless of routing changes).
- **ADR-0013**: Workflow-dir resolution must be derivable from data that is **always present on every hook invocation** (`session_id` + cwd), not from an environment variable whose delivery can silently fail; ambiguous/failed resolution must fail conservative-deny, never silent-allow; env is permitted only as a **containment-validated override** layered on top of the derived default, never as the sole source of truth.

## Notes on scope

This audit is read-only; no files under the repository were modified. The comparison against actual shipped commits (§1 "Verdict" lines) used `git log --oneline -- <exact files listed in each plan-N.md's Files section>` to confirm implementation status, not assumption.
