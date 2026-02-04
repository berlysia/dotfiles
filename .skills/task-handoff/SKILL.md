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

**手順**:
1. TaskList でタスク一覧を取得
2. TaskGet で最初のタスクの subject を読み取る
3. Bash で `~/.claude/tasks/` 配下のディレクトリを最新順に走査
4. 各ディレクトリの `1.json` の `.subject` を `jq -r '.subject'` で読み取り、一致するディレクトリ名を TASK_LIST_ID として確定

```bash
FIRST_SUBJECT="<TaskGetで取得した最初のタスクのsubject>"
for dir in $(ls -t ~/.claude/tasks/); do
  if [ -f ~/.claude/tasks/$dir/1.json ]; then
    subject=$(cat ~/.claude/tasks/$dir/1.json | jq -r '.subject')
    if [ "$subject" = "$FIRST_SUBJECT" ]; then
      echo "TASK_LIST_ID=$dir"
      break
    fi
  fi
done
```

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

以下の形式でコマンドを提示する:

```markdown
## ハンドオフコマンド

\`\`\`bash
CLAUDE_CODE_TASK_LIST_ID=<task-list-id> claude
\`\`\`

新しいセッションで同じタスクリストを共有します。
会話履歴は引き継がず、タスクリストのみを維持して前に進めます。

**確認方法**: 新セッションで `TaskList` を実行すると、同じタスク一覧が表示されます。
```

**注意**: タスクの description が自己完結していることが前提です。会話コンテキストは新セッションに引き継がれないため、description に必要な文脈がすべて含まれている必要があります。

### Step 6: 推奨フローの案内

最後に推奨ワークフローを案内する:

```markdown
## 推奨ハンドオフフロー

1. `/task-enrich` でタスク説明を検証・拡充（まだ実行していない場合）
2. 上記コマンドで次のセッションを開始
3. 新セッションで `TaskList` を確認して作業を再開
```

## 連携スキル

| スキル | 役割 | タイミング |
|--------|------|-----------|
| `/task-enrich` | タスク説明の検証・拡充 | ハンドオフ前に実行推奨 |
| `/decomposition` | 複雑タスクの分解 | タスク作成時 |
| `/task-handoff` (このスキル) | 次セッション引き継ぎ | セッション終了時 |
