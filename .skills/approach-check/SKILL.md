---
name: approach-check
description: "Ask Claude to state its planned approach before writing code, for user approval. Use for medium-complexity tasks where Plan Mode is too heavy but wrong-approach risk exists."
---

# Approach Check

コードを書く前にアプローチを宣言し、ユーザー承認を得るワークフロー。
Plan Mode ほど重くない中規模タスクで、Wrong Approach を早期に防ぐ。

## 使い分け

| タスク規模 | 推奨 |
|-----------|------|
| 小（1-2ファイル、明確な修正） | 不要 — 直接実装 |
| 中（3-5ファイル、複数の実装戦略あり） | **このスキル** |
| 大（6+ファイル、設計判断を伴う） | Plan Mode + `/decompose` |

## ワークフロー

### 1. アプローチ宣言

コードを書く前に、以下を簡潔に宣言する:

```
## Approach

**Strategy**: [1-2文で方針]
**Libraries/APIs**: [使用するもの]
**Files to modify**: [変更対象ファイル一覧]
**Not doing**: [やらないこと — 誤解されやすい選択肢があれば明示]
```

### 2. ユーザー承認を待つ

- AskUserQuestion で承認を求める
- 選択肢: 「この方針で進める」「修正あり」
- **承認されるまでコードを書かない**

### 3. 実装

- 承認されたアプローチに従って実装する
- 実装中にアプローチの変更が必要になった場合は、再度宣言して承認を得る

## 注意

- アプローチ宣言は短く保つ（10行以内）— 計画書ではなく方針確認
- 「Not doing」は Wrong Approach の主因（間違ったライブラリ選択、間違ったレンダリング戦略等）を防ぐために重要
