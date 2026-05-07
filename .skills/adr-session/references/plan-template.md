# Plan Template

Plan files accompany ADRs to detail implementation steps. Create in `docs/plans/plan-{slug}.md`.

```markdown
# {title}

## 概要

関連 ADR: [ADR-NNN](../decisions/adr-NNN-{slug}.md)

[Brief summary of what this plan implements and why.]

## 前提知識

- [Key concepts, technologies, or patterns needed to understand this plan]

## 実装計画

### Step 1: {description}

- [ ] {task}
- [ ] {task}

### Step 2: {description}

- [ ] {task}
- [ ] {task}

## リスクと軽減策

| Risk   | Impact   | Mitigation   |
| ------ | -------- | ------------ |
| {risk} | {impact} | {mitigation} |

## テスト計画 (ISO 25010)

変更内容に関連する品質特性を選択し、各特性に対するテスト/検証方法を記載する。
全特性を毎回記載する必要はない — 変更の性質に応じて該当する特性を選ぶ。

### 該当する品質特性

| 品質特性 | 副特性 | テスト/検証方法 | 判定基準 |
|----------|--------|----------------|----------|
| {characteristic} | {sub-characteristic} | {method} | {criteria} |

<details>
<summary>ISO 25010 品質特性リファレンス（該当するものを選択）</summary>

- **機能適合性**: 機能完全性、機能正確性、機能適切性
- **性能効率性**: 時間効率性、資源効率性、容量
- **互換性**: 共存性、相互運用性
- **使用性**: 適切度認識性、習得性、運用操作性、ユーザーエラー防止性、アクセシビリティ
- **信頼性**: 成熟性、可用性、障害許容性、回復性
- **セキュリティ**: 機密性、完全性、否認防止性、責任追跡性、真正性
- **保守性**: モジュール性、再利用性、解析性、修正性、試験性
- **移植性**: 適応性、設置性、置換性

</details>

### 対象外とした品質特性

- {characteristic}: {reason}
```

## Notes

- Plans are automatically reviewed by `plan-review-automation` when edited. Human approval is required before implementation.
- The plan `{slug}` should match the corresponding ADR slug for easy cross-referencing.
