# ADR Template

New ADRs should be created with this structure. Replace `NNN` with the zero-padded number and `{title}` with the decision title.

Filename: `docs/decisions/adr-NNN-{slug}.md`

```markdown
---
status: Proposed
---
# ADR-NNN: {title}

## コンテキスト

[Why is this decision needed? What problem are we solving?]

## 決定

[What did we decide? Be specific and actionable.]

## 影響

### ポジティブ

- [Benefit 1]

### ネガティブ

- [Tradeoff 1]

## 参考

- [Links, references, related ADRs]
```

## Optional Sections

Add these sections when relevant:

- `## 検討した選択肢` — Alternatives considered with pros/cons
- `## 実装計画` — Link to plan file: `[実装計画](../plans/plan-{slug}.md)`
- `## マイグレーション` — Migration steps if replacing existing behavior
