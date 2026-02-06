---
name: decompose
description: "Decompose complex tasks into detailed, actionable todos. Each todo has a rich description that is executable from the description alone."
context: inherit
---

# Task Decomposition (Context-Protected)

タスク分解の重い処理（コードベース探索・質問・todo作成）をサブエージェントに委任し、メインコンテキストを保護しつつ後続指示への継続性を確保する。

## 手順

### 1. サブエージェントにタスク分解を委任

Task tool (general-purpose agent) を起動し、以下のプロンプトを渡す:

```
以下のファイルを読み、その手順に従ってユーザーのタスクを分解してください。

方法論ファイル（いずれかを読む）:
- ~/.claude/skills/decompose/references/methodology.md
- 見つからない場合は Glob で **/decompose/references/methodology.md を検索

分解対象のタスク:
[ユーザーの現在のタスク/要求をここに記述]

重要:
- methodology.md の全ステップに従うこと
- 不明点は AskUserQuestion で質問すること
- 分解結果は TaskCreate に書き出すこと
- 最後に簡潔なサマリーを返すこと
```

### 2. 後続処理

サブエージェントから結果を受け取った後:
- 分解サマリーをユーザーに提示する
- **ユーザーの後続指示があれば、それに従って続行する**（実装開始、優先順位変更など）
- 後続指示がなければ、次のアクション候補を提案する

## 注意

- 元の `/decomposition`（マーケットプレイス版）は `context: fork` のため後続指示が途切れる
- この `/decompose` は `context: inherit` + Task tool で同等の保護を実現しつつ継続性を確保
