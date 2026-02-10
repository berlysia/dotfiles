---
name: execute-plan
description: "Execute a pre-existing plan file by implementing tasks sequentially with test verification after each step. Use when plan/tasks are already decomposed and ready for implementation."
---

# Execute Plan

計画ファイルまたは分解済みタスクリストを入力として、順次実装・検証・コミットする。
`/decompose` でタスク分解した後の実装フェーズで使用する。

## 前提条件

以下のいずれかが存在すること:
- 計画ファイル（Markdown、ADRなど）のパス
- TaskCreate で作成済みのタスクリスト
- ユーザーが直接指定するタスク一覧

## ワークフロー

### 1. 計画の読み込み

- 指定されたパスの計画ファイルを Read で読む
- TaskList で既存タスクを確認する
- 計画にタスク一覧がない場合、計画から実装タスクを抽出して TaskCreate で登録する

### 2. 順次実装ループ

各タスクについて以下を実行:

```
for each task:
  1. TaskUpdate → in_progress
  2. 実装（Edit/Write で変更）
  3. ビルド実行（プロジェクトの build コマンド）
     - 失敗 → 修正して再ビルド（最大3回）
  4. テスト実行（プロジェクトの test コマンド）
     - 失敗 → 修正して再テスト（最大3回）
  5. lint/type-check 実行
  6. TaskUpdate → completed
```

### 3. 検証とコミット

- 全タスク完了後、全テストスイートを再実行
- 成功したら変更内容のサマリーをユーザーに提示
- ユーザーの指示に従ってコミット

## 制約

- **計画からの逸脱禁止**: 計画にない変更が必要な場合、ユーザーに確認してから実行する
- **タスク間の依存**: 前のタスクのテストが通らない場合、次のタスクに進まない
- **ビルド/テスト3回失敗**: 自動修正を諦め、失敗状況をユーザーに報告して判断を仰ぐ
- **コミットはユーザー指示で**: 自動コミットしない — サマリー提示後にユーザーが判断する
