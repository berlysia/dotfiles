---
name: docs-audit
description: "Comprehensive documentation audit and refresh. Checks code-documentation drift, generates prioritized report, then updates with approval. Use for: 'ドキュメント監査', 'docs audit', 'ドキュメント棚卸し', 'README全体見直し', 'documentation health check'."
context: inherit
---

# Documentation Audit

ドキュメント全体を監査し、コードとの乖離を特定・修正する。

## Workflow

### Phase 1: 監査（自動）

Task tool (Explore agent) でコード-ドキュメント間の乖離を調査。

**対象**: README.md, CLAUDE.md, docs/**/*.md, 設定ファイル

**チェック内容**:
- API/コマンド/設定の不一致（削除済み・未記載項目）
- 存在しないファイル参照
- 構造・依存関係の変化

**出力**: 優先度別分類（Critical/High/Medium/Low）+ ファイル:行番号

### Phase 2: レポート

監査結果を優先度別に提示し、推奨アクションを示す。

### Phase 3: 更新（承認後）

承認された問題をTask tool (general-purpose) で修正。

## Variants

| 引数例 | 動作 |
|--------|------|
| 「レポートだけ」 | Phase 2で停止 |
| 「READMEだけ」 | スコープ限定 |
| 「設定との乖離だけ」 | 特定カテゴリのみ |

## vs update-docs

| スキル | 用途 |
|--------|------|
| update-docs | コード変更に追従（コミット後） |
| docs-audit | 全体の健全性チェック（定期メンテ） |
