---
name: task-handoff
description: Identify current session's task list and generate commands to start a new Claude session sharing the same tasks. Use when "handing off", "continuing later", "resuming tasks", or preparing work for next session.
context: inherit
---

# Task Handoff

現在のセッションのタスクリストを特定し、次のClaudeセッションで同じタスクを引き継ぐためのコマンドを生成します。

## 前提

- タスクは `~/.claude/tasks/<task-list-id>/<num>.json` に保存される
- `cat <file> | jq '.subject'` でタスクの件名、`.description` で詳細を確認可能
- `CLAUDE_CODE_TASK_LIST_ID` 環境変数でタスクリストIDを指定すると、新規セッションで同じタスクリストを共有できる（Claude Code内部で最優先参照される）

## ワークフロー

### Step 1: 現在のタスクリストを取得

TaskList ツールを呼び出し、現在のセッションにタスクがあるか確認する。

タスクがない場合は「タスクリストが空です。先に `/decomposition` でタスクを作成するか、TaskCreate でタスクを追加してください。」と案内して終了する。

### Step 2: タスクリストIDを特定

タスクリストID（= `~/.claude/tasks/` 配下のディレクトリ名）を特定する。

`$CLAUDE_TASK_LIST_ID` が設定済みならそれを使用。未設定なら `claude-task-list-id` スクリプトで検索する。

1. TaskGet で最初のタスクの subject を読み取る
2. 以下を実行:

```bash
echo ${CLAUDE_TASK_LIST_ID:-$(claude-task-list-id "<TaskGetで取得した最初のタスクのsubject>")}
```

出力されたディレクトリ名が TASK_LIST_ID となる。

**見つからない場合**: `~/.claude/tasks/` にまだ書き込まれていない可能性がある。ユーザーに「タスクが未保存の可能性があります」と通知する。

**注意**: `TASK_LIST_ID` はタスクファイルの格納ディレクトリ名であり、通常はセッションIDと一致するが、`CLAUDE_CODE_TASK_LIST_ID` 環境変数で別セッションのタスクリストを使用している場合は異なる。`--resume` に渡すセッションIDとは区別すること。

### Step 3: タスクサマリーを表示

以下の形式で現在のタスク状況を表示する:

```markdown
## タスクリスト状況

**タスクリストID**: `<task-list-id>`
**タスクディレクトリ**: `~/.claude/tasks/<task-list-id>/`

| # | Status | Subject |
|---|--------|---------|
| 1 | ✅ completed | タスク件名... |
| 2 | 🔄 in_progress | タスク件名... |
| 3 | ⏳ pending | タスク件名... |

**集計**: ✅ N completed / 🔄 N in_progress / ⏳ N pending
```

### Step 4: タスクの自己完結性を簡易評価

各 pending/in_progress タスクの description を確認し、以下の基準で簡易評価する:

- **What**: 何をするか明確か
- **Where**: 対象ファイル/場所が特定されているか
- **How**: 実装方法の手がかりがあるか

3つすべてを満たすタスクは ✅、不足があるタスクは ⚠️ マーク付きで表示する。

⚠️ が1つ以上ある場合は、以下のメッセージを追加:
```
> ⚠️ 一部のタスクに文脈が不足しています。`/task-enrich` で説明を拡充してからハンドオフすることを推奨します。
```

### Step 5: ハンドオフコマンドを生成

Step 4 の評価結果に応じて、`claude "<prompt>"` 形式のコマンドを生成する。プロンプトには**確認手順・関連ドキュメント・推奨フロー**を含め、次セッションが自律的に作業を再開できるようにする。

#### ⚠️ タスクに文脈不足がある場合

```markdown
## ハンドオフコマンド

\`\`\`bash
CLAUDE_CODE_TASK_LIST_ID=<task-list-id> claude "タスクを引き継ぎます。以下の手順で進めてください:
1. TaskList でタスク一覧を確認
2. /task-enrich でタスク説明を検証・拡充（一部のタスクに文脈が不足しています）
3. 拡充完了後、/execute-plan でタスクを順番に実装（ビルド・テスト検証付き）
CLAUDE.md にプロジェクト固有のルールがあれば従ってください。"
\`\`\`
```

#### ✅ タスクが自己完結している場合

```markdown
## ハンドオフコマンド

\`\`\`bash
CLAUDE_CODE_TASK_LIST_ID=<task-list-id> claude "タスクを引き継ぎます。以下の手順で進めてください:
1. TaskList でタスク一覧と各タスクの状態を確認
2. /execute-plan でタスクを順番に実装（ビルド・テスト検証付き）
CLAUDE.md にプロジェクト固有のルールがあれば従ってください。"
\`\`\`
```

**注意**: タスクの description が自己完結していることが前提です。会話コンテキストは新セッションに引き継がれないため、description に必要な文脈がすべて含まれている必要があります。

### Step 6: 推奨フローの案内

最後に推奨ワークフローを案内する:

```markdown
## 推奨ハンドオフフロー

### ハンドオフ前（このセッション）
1. `/task-enrich` でタスク説明を検証・拡充（⚠️ がある場合は必須）
2. 必要に応じて `/session-memo` でセッションの文脈を保存

### 新セッション開始後
1. 上記コマンドで次のセッションを開始（プロンプトに手順が含まれています）
2. `TaskList` でタスク一覧を確認
3. `/execute-plan` で自動実行、または手動で1タスクずつ実装

### 利用可能なスキル
| スキル | 役割 |
|--------|------|
| `/task-enrich` | タスク説明の検証・拡充 |
| `/execute-plan` | タスクの順次自動実行 |
| `/session-memo` | セッション文脈の保存・参照 |
| `/decompose` | 複雑タスクの分解 |
```

## 連携スキル

| スキル | 役割 | タイミング |
|--------|------|-----------|
| `/task-enrich` | タスク説明の検証・拡充 | ハンドオフ前に実行推奨 |
| `/session-memo` | セッション文脈の保存 | ハンドオフ前（任意） |
| `/execute-plan` | タスクの順次自動実行 | 新セッションで使用 |
| `/decompose` | 複雑タスクの分解 | タスク作成時 |
| `/task-handoff` (このスキル) | 次セッション引き継ぎ | セッション終了時 |
