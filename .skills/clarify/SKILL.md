---
name: clarify
description: "Create detailed specifications by iteratively clarifying unclear points for Plan mode. Use when: After completing a plan when detailed requirements need clarification before implementation."
context: inherit
---

# Clarify Specification (Context-Protected)

仕様明確化の重い処理（コードベース探索・反復質問・仕様文書作成）をサブエージェントに委任し、メインコンテキストを保護しつつ後続指示への継続性を確保する。

## 手順

### 1. サブエージェントに仕様明確化を委任

Task tool (general-purpose agent) を起動し、以下のプロンプトを渡す:

```
以下のファイルを読み、その手順に従ってユーザーの仕様を明確化してください。

方法論ファイル（いずれかを読む）:
- ~/.claude/skills/clarify/references/methodology.md
- 見つからない場合は Glob で **/clarify/references/methodology.md を検索

明確化対象:
[ユーザーの現在のタスク/要求/計画をここに記述]

重要:
- methodology.md の全フェーズに従うこと
- 不明点は AskUserQuestion で質問すること（1回2-4問、具体的選択肢付き）
- 全ての不明点が解消されるまで反復すること
- 最終仕様を簡潔なサマリーとして返すこと
```

### 2. 後続処理

サブエージェントから結果を受け取った後:
- 明確化された仕様サマリーをユーザーに提示する
- **ユーザーの後続指示があれば、それに従って続行する**（実装開始、計画修正など）
- 後続指示がなければ、次のアクション候補を提案する

## 注意

- 元の `/clarify:clarify`（マーケットプレイス版）は `context: fork` のため後続指示が途切れる
- この `/clarify` は `context: inherit` + Task tool で同等の保護を実現しつつ継続性を確保
