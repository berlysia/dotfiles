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

| Risk | Impact | Mitigation |
|------|--------|------------|
| {risk} | {impact} | {mitigation} |

## 検証方法

- [ ] {verification step}
- [ ] Tests pass
- [ ] Build succeeds
```

## Notes

- Do NOT include `<!-- validated -->` in the template. This marker is added only after successful validation by `/validate-plan` or logic-validator.
- The plan `{slug}` should match the corresponding ADR slug for easy cross-referencing.
