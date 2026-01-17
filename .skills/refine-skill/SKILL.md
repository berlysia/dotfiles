---
name: refine-skill
description: Analyze and refine existing Claude Code Skills for conciseness and effectiveness. Use when asked to "review", "refine", "improve", "optimize" Skills, or when the user mentions "skill quality", "skill refinement", or wants to make a Skill more concise.
context: fork
---

# Skill Refinement

既存のClaude Code Skillを分析し、より簡潔で効果的なものに洗練する。

## Core Principle: Concise is Key

スキルの品質指標は**AIにとっての消費しやすさ**。人間向けの教育的説明は削除対象。

```
質問: "Claudeはこの情報を既に知っているか？"
→ Yes: 削除
→ No: 残す
```

## Analysis Workflow

### Step 1: Locate and Read Skill

```bash
# スキルの場所
~/.claude/skills/<name>/SKILL.md     # Personal
.claude/skills/<name>/SKILL.md       # Project
```

対象スキルの全ファイルを読み込む。

### Step 2: Measure Current State

**定量評価:**
- SKILL.md行数（目標: 500行以下）
- description文字数（目標: 1024文字以下）
- 参照ファイル数と深さ（目標: 1階層）

**定性評価:**
- [ ] descriptionにトリガーキーワードがあるか
- [ ] 不必要な説明がないか
- [ ] 具体的な例があるか
- [ ] 適切な自由度が設定されているか

### Step 3: Identify Improvement Areas

よくある問題パターン:

| 問題 | 症状 | 対策 |
|------|------|------|
| 過剰な説明 | 基本概念の解説 | 削除 |
| 曖昧な記述 | "適切に", "良い" | 具体例に置換 |
| 深い参照 | A→B→C | A→B, A→Cにフラット化 |
| 冗長なワークフロー | 10+ステップ | 3-5ステップに統合 |
| トリガー不足 | 起動しない | キーワード追加 |

### Step 4: Apply Refinements

**削除候補:**
- 「〜とは何か」の説明
- 「なぜこれが重要か」の背景説明
- 自明なステップの詳細
- 重複した情報

**追加候補:**
- 具体的なコード例
- トリガーキーワード
- 失敗ケースの対処

**書き換え候補:**
- 曖昧 → 具体的
- 複雑 → シンプル
- 冗長 → 簡潔

### Step 5: Validate Changes

変更後の確認:

```
Refinement Validation:
- [ ] SKILL.md行数が減少した
- [ ] 機能は維持されている
- [ ] トリガーキーワードが明確
- [ ] 例が具体的
```

## Refinement Patterns

### Pattern 1: Description強化

```yaml
# Before - 曖昧
description: Helps with code review and suggestions

# After - 具体的
description: Analyze code for security vulnerabilities, performance issues, and maintainability. Use when asked to "review code", "check for bugs", "security audit", or "code quality".
```

### Pattern 2: 説明の圧縮

````markdown
# Before - 教育的すぎる
## How PDF Processing Works

PDF (Portable Document Format) is a file format developed by Adobe...
When processing PDFs, you first need to understand that...
The pdfplumber library is a Python library that...

## Extracting Text

To extract text, you'll use the following approach...

# After - 実用的
## Extract PDF Text

```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
````

### Pattern 3: ワークフロー簡素化

```markdown
# Before - 10ステップ
Step 1: Understand the requirements...
Step 2: Analyze the current state...
Step 3: Design the approach...
...
Step 10: Document everything...

# After - 3ステップ
1. 分析: 現状を把握
2. 実行: 変更を適用
3. 検証: 結果を確認
```

### Pattern 4: Progressive Disclosure適用

```markdown
# Before - 全て SKILL.md に記載
[500行以上の詳細なドキュメント]

# After - 分割
## Quick Start
[50行の要点]

For details, see:
- [PATTERNS.md](PATTERNS.md) - 詳細パターン
- [EXAMPLES.md](EXAMPLES.md) - 完全な例
```

## Quality Checklist

詳細なチェックリストは [CHECKLIST.md](CHECKLIST.md) を参照。

**最重要項目:**
- Description: what + when + trigger keywords
- SKILL.md: 500行以下
- 参照: 1階層まで
- 例: 具体的、実行可能

## Output Format

```markdown
# Skill Refinement Report: [skill-name]

## Summary
[1-2文の総評]

## Current State
- Lines: X
- Description quality: [Good/Needs work]
- Structure: [Good/Needs work]

## Improvements Applied

### 1. [改善項目]
**Before:**
[変更前]

**After:**
[変更後]

**Rationale:** [理由]

## Validation
- [ ] 行数削減: X → Y
- [ ] 機能維持: 確認済
- [ ] テスト: [結果]
```

## Anti-Patterns

避けるべきパターン:

| Anti-Pattern | 問題 | 代替 |
|--------------|------|------|
| 教育的散文 | AI不要 | 直接的な指示 |
| 無限の選択肢 | 決定不能 | デフォルト + escape hatch |
| Windowsパス | 非互換 | 常に `/` |
| 時間依存情報 | 陳腐化 | バージョン非依存 |
| 深い参照 | コンテキスト消費 | フラット構造 |
