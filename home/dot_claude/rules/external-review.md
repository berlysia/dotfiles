# External Review & Validation

Leverage multiple validation tools for logic verification, external perspective, and comprehensive code review.

## Available Tools

### Logic Validation

- **logic-validator agent**: Task tool with `subagent_type: logic-validator`

### External Review

- **Codex Plugin**: `/codex:review` command for code review, `/codex:adversarial-review` for adversarial analysis (via `codex@openai-codex` plugin)
- **Self-Review**: `/self-review` skill for comprehensive multi-perspective review

## When to Use

| Situation                      | Recommended Tool                  | Purpose                                                    |
| ------------------------------ | --------------------------------- | ---------------------------------------------------------- |
| **Plan mode complete**         | logic-validator agent             | Validate consistency before ExitPlanMode                   |
| **Plan auto-review**           | plan-review-automation (auto)     | Content-based reviewer selection + parallel execution      |
| **Quick logic check**          | logic-validator agent             | Fast validation of reasoning/decisions                     |
| **Approach change mid-task**   | logic-validator agent             | Verify reasoning before switching strategies               |
| **Assumption-based reasoning** | logic-validator agent             | Verify you're not drawing conclusions without evidence     |
| **Stuck on problem**           | Codex Plugin `/codex:review`      | Get fresh perspective, alternative approaches              |
| **Architecture decision**      | Codex Plugin `/codex:review`      | Compare options, evaluate tradeoffs                        |
| **Debug blocked**              | Codex Plugin `/codex:review`      | Discuss symptoms, brainstorm solutions                     |
| **User explicit request**      | `/codex:review` or `/self-review` | Read-only analysis or comprehensive review                 |
| **Pre-deployment review**      | `/self-review`                    | Multi-stakeholder perspective (security, UX, DevOps, etc.) |

## Best Practices

1. **Provide sufficient context**: Background, constraints, what you've tried
2. **Ask specific questions**: "Any oversights?", "Simpler approach?", "Edge cases?"
3. **Validate feedback**: Treat suggestions as reference, make final judgment yourself
4. **Protect sensitive data**: Don't send confidential code or credentials

## Plan Mode Self-Review Procedure

Before executing `ExitPlanMode`:

### 1. Auto-Review via plan-review-automation (Required)

`plan-review-automation` フックが spec.md / plan.md / plan-N.md 編集時に自動トリガーされ、編集対象に応じてレビュアー集合を切り替える:

#### spec 層レビュアー（spec.md 編集時、plan.md-only モード時の plan.md 編集時）

設計層は「何を作るか」「なぜそうするか」の判断を扱うため、設計品質に特化した 4 名を常駐:

<!-- ssot:spec-reviewers:start -->

- **logic-validator**: 論理整合性・仮定・矛盾の検証
- **scope-justification-reviewer**: 各変更のエビデンス検証・scope coherence・近未来必要性（守備範囲: plan/spec に書かれている変更）
- **decision-quality-reviewer**: dominant-axis misalignment 検出
- **greenfield-perspective-reviewer**: 白紙設計案を独自再構築し現計画との野心ギャップ検出（守備範囲: plan/spec に書かれていない改善）

<!-- ssot:spec-reviewers:end -->

#### plan 層レビュアー（二層モードの plan-N.md 編集時）

実行層は設計判断 (spec.md) を前提とした「どう作るか」の手順を扱うため、実行品質に特化した 2 名を常駐 + コンテンツベースで追加選定:

<!-- ssot:plan-reviewers:start -->

- **logic-validator**: 実行手順の論理整合性
- **scope-justification-reviewer**: 各タスクのエビデンス検証・scope coherence

<!-- ssot:plan-reviewers:end -->

`decision-quality-reviewer` / `greenfield-perspective-reviewer` は spec 層で設計判断が決着している前提のため plan 層では常駐させず、必要に応じてコンテンツベースで再選定する。

#### 補足

- SSoT は `plan-review-automation.ts` の `SPEC_REVIEWERS` / `PLAN_REVIEWERS` 定数（ADR-0006 参照）。slug は drift 検知テストで CI レベル同期。責務文（上記日本語）は読み手向け説明として SSoT 化対象外で、表現は手書きで磨いて良い
- `logic-validator` / `scope-justification-reviewer` は両層に出現（守備範囲が層ごとに異なる）。drift detection は各マーカー区間 × 各定数配列の独立 deepStrictEqual で実施するため、重複 slug を許容する（ADR-0005 / ADR-0006）
- **追加レビュアー**: spec.md / plan-N.md のキーワードに応じて最大3つ自動選定（英語・日本語対応）
  - architecture-strategist, security-sentinel, data-integrity-guardian, performance-oracle, resilience-analyzer, test-quality-evaluator, deployment-readiness-evaluator, code-simplicity-reviewer
- フックの推奨に従い、Agent tool で **全レビュアーを並列実行** する

### 2. External Perspective Review (Optional)

**When to use**:

- Complex architectural decisions
- Novel technical approaches
- Stuck on implementation strategy

**How to use**:

- `/codex:review` - Codex plugin による code review
- `/self-review` - Comprehensive review from multiple perspectives

## Usage Examples

### Logic Validation

```
Task tool (subagent_type: logic-validator):
  "以下の実装計画の論理的整合性を検証：
   [計画詳細]

   確認ポイント：
   - 各ステップの論理的根拠は明確か
   - 検証なしに成功を仮定していないか
   - エッジケース・失敗シナリオは考慮されているか"
```

### External Code Review

```
/codex:review

or

/self-review
```
