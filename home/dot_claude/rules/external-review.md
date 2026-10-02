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

手順は `~/.claude/rules/workflow.md` の共通フロー 5 に従う。層ごとの常駐レビュアーと守備範囲:

#### spec 層（spec.md、単層の plan.md）

<!-- ssot:spec-reviewers:start -->

- **logic-validator**: 論理整合性・仮定・矛盾の検証
- **scope-justification-reviewer**: 各変更のエビデンス検証・scope coherence・近未来必要性（守備範囲: plan/spec に書かれている変更）
- **decision-quality-reviewer**: dominant-axis misalignment 検出
- **greenfield-perspective-reviewer**: 白紙設計案を独自再構築し現計画との野心ギャップ検出（守備範囲: plan/spec に書かれていない改善）

<!-- ssot:spec-reviewers:end -->

#### plan 層（二層モードの plan-N.md）

<!-- ssot:plan-reviewers:start -->

- **logic-validator**: 実行手順の論理整合性
- **scope-justification-reviewer**: 各タスクのエビデンス検証・scope coherence

<!-- ssot:plan-reviewers:end -->

plan 層では設計判断が spec 層で決着している前提なので、`decision-quality-reviewer` / `greenfield-perspective-reviewer` は常駐させず、内容に応じて再選定する。追加レビュアー（最大 3 名）は hook が本文のキーワードから選んで推奨する。再レビューを省略できる条件は `/document-workflow-reference`「prescribed-fix carry-forward」にある。

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
