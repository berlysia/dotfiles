# Update Auto-Approve Command

決定ログを分析してauto-approve設定を最適化するコマンドです。

## 実行方法

```bash
# 基本実行 - インタラクティブレビュー
bun run dot_claude/scripts/update-auto-approve.ts

# ドライラン - 変更内容のプレビューのみ
bun run dot_claude/scripts/update-auto-approve.ts --dry-run

# 自動承認 - 低リスクパターンのみ自動追加
bun run dot_claude/scripts/update-auto-approve.ts --auto-approve-safe

# 期間指定 - 直近7日間のログのみ分析
bun run dot_claude/scripts/update-auto-approve.ts --since 7d
```

## 動作概要

このスクリプトは以下を行います：

1. **決定ログ分析**: `~/.claude/logs/decisions.jsonl`を解析
2. **パターン抽出**: 頻繁に出現する許可/拒否候補を識別
3. **インタラクティブレビュー**: 各候補の安全性とリスクスコアを提示
4. **設定更新**: 承認されたパターンを`~/.claude/settings.json`に追加

## 私の分析サポート

スクリプト実行後、以下の観点で結果分析とアドバイスを提供します：

### 📊 パターン分析
- 検出されたパターンの妥当性評価
- リスクスコアの妥当性チェック
- 既存設定との整合性確認

### 🔒 セキュリティ評価  
- 新規許可パターンの安全性検証
- 見落とされた危険パターンの指摘
- セキュリティポリシーとの整合性確認

### 🎯 最適化提案
- より効果的なパターンの提案
- 設定の簡素化・統合の可能性
- プロジェクト固有 vs グローバル設定の使い分け

## 使用手順

1. `bun run dot_claude/scripts/update-auto-approve.ts --dry-run` でプレビュー
2. 結果を共有してください - 私がパターンを分析します
3. 推奨事項を確認後、本実行で設定を更新
4. 必要に応じて追加の最適化提案を実施

この仕組みにより、技術的な分析と人間の判断を効果的に組み合わせた許可設定管理が可能になります。