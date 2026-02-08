---
name: update-docs
description: "Update documentation to match code changes. Triggered by: 'update docs', 'sync documentation', 'README outdated', 'docs更新', 'ドキュメント直して'. Delegates to subagent to protect context."
context: inherit
---

# Update Documentation

コード変更に伴うドキュメント更新をサブエージェントに委任。

## 実行

Task tool (general-purpose) で以下を委任:

```
ドキュメントを更新してください。

対象: [ユーザー指定 or 最近の変更]

手順:
1. git diff/log で変更内容を把握
2. 関連ドキュメント（README, docs/, CLAUDE.md）を探索
3. 品質基準に従って評価・更新
4. サマリーを返す（更新ファイル、主な変更、要確認箇所）

品質基準:
- 正確性: コードと記述の一致
- 発見可能性: 目次反映、クロスリファレンス、検索キーワード
- 一貫性: 用語・フォーマット・文体の統一
- メンテナンス性: コンセプト優先、陳腐化しやすい情報を避ける

注意:
- 既存の文体・フォーマットを維持
- 大規模変更は提案のみ（実行前に確認）
```

## 結果報告

サブエージェントのサマリーをユーザーに提示。

## バリエーション

- **スコープ限定**: 「src/ のドキュメントだけ更新して」
- **報告のみ**: 「更新せず、何を直すべきか教えて」
