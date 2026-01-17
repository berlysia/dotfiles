# Skill Quality Checklist

スキルの品質確認用チェックリスト。各項目を確認し、問題があれば修正する。

## 1. Metadata

### Name
- [ ] 小文字、数字、ハイフンのみ
- [ ] 64文字以下
- [ ] ディレクトリ名と一致
- [ ] 動名詞形推奨: `processing-pdfs`, `analyzing-data`
- [ ] 禁止語なし: "anthropic", "claude"

### Description
- [ ] 1024文字以下
- [ ] **What**: 何をするか明記
- [ ] **When**: いつ使うか明記
- [ ] **Triggers**: ユーザーが言いそうなキーワード含む
- [ ] 三人称: "Processes files" not "I can help"
- [ ] 曖昧語なし: "helps with documents" ✗

```yaml
# Good
description: Extract text from PDFs, fill forms, merge documents. Use when working with PDF files or when user mentions "PDF", "forms", "document extraction".

# Bad
description: Helps with documents
```

## 2. Structure

### File Size
- [ ] SKILL.md: 500行以下
- [ ] 超過時は参照ファイルに分割

### References
- [ ] 1階層のみ（SKILL.md → 参照ファイル）
- [ ] ネスト禁止（A → B → C）
- [ ] 100行超のファイルは目次付き

### Paths
- [ ] 全て前方スラッシュ: `scripts/helper.py`
- [ ] バックスラッシュ禁止: `scripts\helper.py` ✗

## 3. Content

### Conciseness
- [ ] Claude既知の情報を含まない
- [ ] 基本概念の説明なし
- [ ] 冗長な導入なし
- [ ] 各情報に「Claudeに必要か？」を問う

### Clarity
- [ ] 具体例あり（抽象例なし）
- [ ] 一貫した用語
- [ ] 曖昧表現なし: "適切に", "良い"

### Freedom Level
- [ ] **High**: 複数アプローチ可、ヒューリスティクスで誘導
- [ ] **Medium**: 推奨パターンあり、多少の変動可
- [ ] **Low**: 厳密な手順、逸脱不可

タスクの脆弱性に応じて選択。

## 4. Workflows

### Multi-step Operations
- [ ] ステップ数: 3-5推奨
- [ ] 進捗チェックリスト付き
- [ ] 各ステップ明確

### Feedback Loops
- [ ] 品質重要な操作に検証ステップ
- [ ] 「実行 → 確認 → 修正」パターン
- [ ] 成功基準明確

## 5. Scripts (if applicable)

- [ ] エラーハンドリング明示的
- [ ] マジックナンバー説明済み
- [ ] 依存パッケージ記載
- [ ] 実行意図明確: "Run" vs "See"

## 6. Testing

- [ ] 3+シナリオで評価済み
- [ ] 対象モデルでテスト済み（Haiku/Sonnet/Opus）
- [ ] トリガー動作確認済み
- [ ] ワークフロー正常動作確認済み

## Quick Review

最低限確認すべき項目:

```
□ description: what + when + triggers
□ SKILL.md: 500行以下
□ 参照: 1階層
□ 例: 具体的
□ Claude不要の情報: 削除済み
```

## Severity Levels

| Level | 基準 | 対応 |
|-------|------|------|
| Critical | トリガー不能、機能不全 | 即時修正 |
| High | 500行超、曖昧な説明 | 優先修正 |
| Medium | 冗長な説明、深い参照 | 改善推奨 |
| Low | 軽微な一貫性問題 | 任意 |
