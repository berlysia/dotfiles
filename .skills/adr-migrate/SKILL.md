---
name: adr-migrate
description: "Migrate existing ADRs to YAML frontmatter format. Scans docs/decisions/ for ADRs without frontmatter, infers status from body text, shows dry-run for approval. Trigger: /adr-migrate"
context: inherit
---

# ADR Migrate

既存の ADR ファイルに YAML frontmatter を追加するマイグレーションスキル。

## Workflow

### Step 1: Scan ADR files

```
Glob: docs/decisions/adr-*.md
```

If no files found: "ADR ファイルが見つかりません。" → Stop.

Classify each file:
- **Has frontmatter** (starts with `---`): Skip (already migrated)
- **No frontmatter**: Candidate for migration

If all files already have frontmatter: "すべての ADR に frontmatter が設定済みです。" → Stop.

### Step 2: Infer status for each candidate

Read the full content of each candidate file and apply these rules:

#### Status inference

Search for a `## Status` or `## ステータス` section. Extract the text content of that section.

Keyword matching (case-insensitive):

| Keywords | Inferred Status |
|----------|----------------|
| `complete`, `done`, `implemented`, `実装完了`, `完了` | Complete |
| `in progress`, `in-progress`, `implementing`, `実装中`, `進行中` | InProgress |
| `proposed`, `draft`, `提案`, `ドラフト` | Proposed |
| No status section or no keyword match | Accepted (default) |

#### Plan detection

Search for links matching `plan-*.md` pattern in the body text.
If found, extract the filename for the `plan` field.

#### Deps detection (informational only)

Search for `ADR-NNN` patterns in the body text.
Record as potential dependencies but do NOT auto-set in frontmatter.
Report as notes in the dry-run output for the user to review.

### Step 3: Show dry-run report

Display the migration plan before applying:

```
## ADR Migration Dry-Run

| File | Inferred Status | Plan | Potential Deps | Notes |
|------|----------------|------|---------------|-------|
| adr-001-auth.md | Complete | - | - | Status section: "Implemented" |
| adr-002-api.md | Accepted | plan-api.md | ADR-001 | No status section (default) |
| adr-003-db.md | InProgress | - | ADR-001, ADR-002 | Status section: "In progress" |

### Skipped (already have frontmatter)
- adr-004-cache.md

### Notes
- `deps` フィールドは自動設定されません。上記の "Potential Deps" を確認し、必要に応じて手動で追加してください。
- Status の推定が正しくない場合は、適用前にお知らせください。

この内容で frontmatter を追加してよろしいですか？
```

Wait for user approval before proceeding.

### Step 4: Apply migration

After user approval, for each candidate file:

1. Use Edit tool to insert frontmatter at the beginning of the file:

```yaml
---
status: {inferred_status}
plan: {plan_filename}  # only if detected
---
```

2. If a `plan` was detected, include it. If not, omit the field entirely (don't include empty fields).

3. Do NOT auto-add `deps` — leave for manual review.

### Step 5: Handle redundant status sections

After adding frontmatter, ask the user about redundant `## Status` / `## ステータス` sections:

```
以下のファイルに `## Status` セクションが残っています。
frontmatter に status が移行されたため、冗長になっている可能性があります。

- adr-001-auth.md (line 15-17)
- adr-003-db.md (line 20-22)

これらのセクションを削除しますか？（各ファイル個別に確認することもできます）
```

Only remove if the user approves.

## Edge Cases

| Case | Behavior |
|------|----------|
| File already has frontmatter | Skip, report in "Skipped" section |
| No status section found | Default to `Accepted`, add warning note |
| Multiple status keywords match | Use the first match, note ambiguity |
| File is empty or malformed | Skip with warning |
| `docs/decisions/` doesn't exist | Report and stop |

## Related

- [adr-schema.md](../adr-session/references/adr-schema.md): Frontmatter schema definition
- `/adr-session`: Post-migration, use this to manage ADR sessions
