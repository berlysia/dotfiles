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

`plan-review-automation` フックが plan.md 編集時に自動トリガーされ、コンテンツベースでレビュアーを選定:

- **常時必須レビュアー4名**（並列実行）:
  - **logic-validator**: 論理整合性・仮定・矛盾の検証
  - **scope-justification-reviewer**: 各変更のエビデンス検証・scope coherence・近未来必要性（守備範囲: plan に書かれている変更）
  - **decision-quality-reviewer**: dominant-axis misalignment 検出
  - **greenfield-perspective-reviewer**: 白紙設計案を独自再構築し現計画との野心ギャップ検出（守備範囲: plan に書かれていない改善）
- **追加レビュアー**: plan.md のキーワードに応じて最大3つ自動選定（英語・日本語対応）
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
