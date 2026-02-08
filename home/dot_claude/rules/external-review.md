# External Review & Validation

Leverage multiple validation tools for logic verification, external perspective, and comprehensive code review.

## Available Tools

### Logic Validation
- **logic-validator agent**: Task tool with `subagent_type: logic-validator`

### External Review
- **Codex Review CLI**: `/codex-review` skill for read-only analysis
- **Codex Review MCP**: Conversational interface for deeper exploration
- **Self-Review**: `/self-review` skill for comprehensive multi-perspective review

## When to Use

| Situation | Recommended Tool | Purpose |
|-----------|-----------------|---------|
| **Plan mode complete** | logic-validator agent | Validate consistency before ExitPlanMode |
| **Quick logic check** | logic-validator agent | Fast validation of reasoning/decisions |
| **Approach change mid-task** | logic-validator agent | Verify reasoning before switching strategies |
| **Assumption-based reasoning** | logic-validator agent | Verify you're not drawing conclusions without evidence |
| **Stuck on problem** | Codex Review | Get fresh perspective, alternative approaches |
| **Architecture decision** | Codex Review | Compare options, evaluate tradeoffs |
| **Debug blocked** | Codex Review | Discuss symptoms, brainstorm solutions |
| **User explicit request** | `/codex-review` or `/self-review` | Read-only analysis or comprehensive review |
| **Pre-deployment review** | `/self-review` | Multi-stakeholder perspective (security, UX, DevOps, etc.) |

## Best Practices

1. **Provide sufficient context**: Background, constraints, what you've tried
2. **Ask specific questions**: "Any oversights?", "Simpler approach?", "Edge cases?"
3. **Validate feedback**: Treat suggestions as reference, make final judgment yourself
4. **Protect sensitive data**: Don't send confidential code or credentials

## Plan Mode Self-Review Procedure

Before executing `ExitPlanMode`:

### 1. Logic Validation (Required)

**Use logic-validator agent**:
- Use Task tool with `subagent_type: logic-validator`
- Verifies plan consistency, identifies assumptions, checks edge cases

### 2. External Perspective Review (Optional)

**When to use**:
- Complex architectural decisions
- Novel technical approaches
- Stuck on implementation strategy

**How to use**:
- `/codex-review` - Read-only analysis of current state
- `/self-review` - Comprehensive review from multiple perspectives
- Codex MCP conversational interface - For interactive exploration

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
/codex-review

or

/self-review
```

### Interactive Exploration (Codex MCP)
Use when you need conversational back-and-forth to explore complex problems.
