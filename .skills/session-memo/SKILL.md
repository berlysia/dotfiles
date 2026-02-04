---
name: session-memo
description: Save current session's problem context as a memo file for cross-session reference. Uses sub-agent to minimize context consumption. Supports two modes - summarize current session or read a past session by ID.
context: fork
---

# Session Memo

セッションの問題意識を軽量にメモ化し、別セッションから参照可能にする。

## モード

引数に応じて動作モードを切り替える:

- **引数なし** (`/session-memo`): 現在のセッションを要約してメモファイルに保存
- **フォーカス指定** (`/session-memo 認証周りの設計判断について`): 指定トピックに焦点を当てて要約
- **セッションID指定** (`/session-memo <session-id>`): 指定セッションのJSONLを読んで要約を返す
- **セッションID + フォーカス** (`/session-memo <session-id> パフォーマンスの議論`): 過去セッションを特定トピックで要約
- **`list`** (`/session-memo list`): 保存済みメモの一覧を表示

### 引数の判別ルール

1. `list` → Mode 3
2. UUID形式（8文字以上の hex + ハイフン）で始まる → Mode 2（残りがあればフォーカス指示）
3. それ以外のテキスト → Mode 1 + フォーカス指示

## Mode 1: 現在のセッションを要約保存（引数なし）

### Step 1: セッションIDを特定

```bash
# sessions-index.jsonから現在のプロジェクトの最新セッションを取得
PROJECT_DIR=$(pwd | sed 's|/|-|g; s|^-||')
INDEX="$HOME/.claude/projects/-${PROJECT_DIR}/sessions-index.json"
SESSION_ID=$(jq -r '.entries[-1].sessionId' "$INDEX")
```

### Step 2: サブエージェントで要約生成

Task ツールで `general-purpose` サブエージェントを起動し、以下のプロンプトを渡す。

**フォーカス指示がある場合**は、プロンプト冒頭に追加する:

```
【フォーカス】: <ユーザーの指示テキスト>
上記のトピックを中心に、関連する議論・決定・未解決事項を重点的にまとめてください。
フォーカス外の内容は、関連がある場合のみ簡潔に触れてください。
```

**ベースプロンプト**:

```
以下のセッションJSONLを読んで、このセッションの要約をまとめてください。

ファイル: ~/.claude/projects/-<project-dir>/sessions-index.json を読んで最新セッションのfullPathを特定し、そのJSONLファイルを読んでください。

出力形式（Markdown）:
---
session_id: <session-id>
project: <project-path>
created: <timestamp>
focus: <フォーカス指示があれば記載、なければ "general">
---

## 問題意識
[このセッションで何を解決しようとしていたか、1-3文]

## 議論の要点
- [重要な決定事項や発見、箇条書き]

## 未解決事項
- [残っている課題やNext Steps]

## 関連ファイル
- [議論で触れた主要ファイルパス]

注意:
- JSONLの各行はJSON。type が "user" または "assistant" の行の message.content を読む
- hook_progress, file-history-snapshot, system-reminder などのノイズは無視する
- コード全文は含めず、何をしたかの要約に留める
- 500行を超えるJSONLの場合は先頭100行と末尾100行を重点的に読む
```

### Step 3: メモファイルを保存

サブエージェントの出力を以下のパスに保存する:

```
.tmp/session-memos/<session-id-short>.md
```

`<session-id-short>` はUUIDの先頭8文字。

保存後、ユーザーに以下を表示:

```
📝 セッションメモを保存しました: .tmp/session-memos/<session-id-short>.md

別セッションでの参照方法:
  「.tmp/session-memos/<session-id-short>.md を読んで、問題意識を理解した上で〇〇をやって」
```

## Mode 2: 過去セッションを読む（セッションID指定）

引数がUUID形式（完全または先頭8文字以上）の場合:

### Step 1: セッションJSONLを特定

```bash
PROJECT_DIR=$(pwd | sed 's|/|-|g; s|^-||')
PROJECT_PATH="$HOME/.claude/projects/-${PROJECT_DIR}"
# 完全UUIDまたは前方一致で検索
ls "$PROJECT_PATH"/*.jsonl | grep "<引数>"
```

他プロジェクトのセッションを参照したい場合（引数に `/` を含む場合）:
```bash
# 全プロジェクトから検索
find "$HOME/.claude/projects/" -name "<引数>*.jsonl"
```

### Step 2: サブエージェントで要約

Mode 1 の Step 2 と同じベースプロンプト + フォーカス指示（あれば）で Task ツール（`general-purpose`）を起動し、特定したJSONLファイルパスを直接指定して読ませる。

### Step 3: 要約を直接表示

メモファイルには保存せず、要約をユーザーに直接表示する。保存が必要ならユーザーが明示的に依頼する。

## Mode 3: 保存済みメモ一覧（`list`）

```bash
ls -lt .tmp/session-memos/*.md 2>/dev/null
```

各ファイルの先頭（YAML frontmatter）から `session_id` と最初の `## 問題意識` セクションを抽出して一覧表示:

```
📋 保存済みセッションメモ:

| File | Session ID | 問題意識（冒頭） |
|------|-----------|-----------------|
| abc12345.md | abc12345-... | Xの実装方針について... |
```

## 重要な設計判断

- **context: fork** を使用: メインセッションのコンテキストを消費しない
- **サブエージェントで読み書き**: JSONLの読み取りと要約生成をサブエージェントに委譲し、メインセッションのトークン消費を最小化
- **保存先は `.tmp/`**: gitignored で一時的、プロジェクトスコープ
