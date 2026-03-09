---
name: analyze-mistakes
description: "Analyze accumulated quality logs and LLM reflections to discover custom linter rule candidates and agent weakness patterns."
context: inherit
---

# Analyze Mistakes

蓄積された quality ログと LLM リフレクションを分析し、カスタムリンタールール候補とエージェント弱点パターンを発見する。

## Prerequisites

- `~/.claude/logs/quality.jsonl` — quality-loop / completion-gate のエラーログ
- `~/.claude/logs/reflections.jsonl` — stop-reflection による LLM リフレクション結果

## Workflow

### Stage 1: データ集約

1. `~/.claude/logs/reflections.jsonl` + バックアップ（`reflections.jsonl.*`）を Bash で読み込み
2. `preventable_by_lint: true` のリフレクションを抽出
3. `suggested_rule.type` × `suggested_rule.description` で集約し、頻度降順でレポート

```bash
# reflections.jsonl から preventable パターンを抽出
cat ~/.claude/logs/reflections.jsonl ~/.claude/logs/reflections.jsonl.* 2>/dev/null \
  | jq -r 'select(.reflections) | .reflections[] | select(.preventable_by_lint == true) | "\(.suggested_rule.type)\t\(.suggested_rule.description)\t\(.error_summary)"' \
  | sort | uniq -c | sort -rn
```

### Stage 2: ルール候補提案

頻出パターンに対し:

1. **既存 oxlint/biome ルールで対応可能か確認**
   - oxlint ルール一覧: `npx oxlint --rules`
   - biome ルール一覧: `npx biome rage --linter`
2. **対応可能**: 設定ファイル（`oxlintrc.json` / `biome.json`）の変更を提案
3. **対応不可**: `custom-rules.ts` の `CustomRule` テンプレートを提案

`CustomRule` テンプレート:
```typescript
{
  id: "<rule-id>",
  filePattern: /<file-extension-regex>/,
  linePattern: /<人間が最終設計>/,
  message: "<what is wrong>",
  why: "<why this matters>",
  fix: "<how to fix>",
}
```

**重要**: `linePattern: RegExp` は人間が最終的に設計する。スキルはパターンのヒント（`pattern_hint`）までを提案。

### Stage 3: 弱点モニタリング

`quality.jsonl` から quality-loop エラーも集約し、エージェントが繰り返し違反するルールを特定:

```bash
# quality-loop エラーの頻度集計
cat ~/.claude/logs/quality.jsonl ~/.claude/logs/quality.jsonl.* 2>/dev/null \
  | jq -r 'select(.source == "quality-loop") | .lint_tool' \
  | sort | uniq -c | sort -rn
```

繰り返し違反があれば:
- CLAUDE.md / rules への追記を提案
- リンター設定の強化（warn → error 等）を提案

## Output Format

```markdown
## Mistake Pattern Analysis

### Data Summary
- reflections.jsonl: N entries (M days of data)
- quality.jsonl: N entries
- Sessions analyzed: N

### Preventable Patterns (from reflections)
1. [type] description — N occurrences
   Pattern hint: ...
   Recommendation: ...

### Agent Weakness Patterns (from quality-loop)
1. [lint_tool] rule — N violations across M sessions
   Recommendation: ...

### Proposed Rules
1. Rule ID: ...
   ...
```
