# Session Context

## User Prompts

### Prompt 1

独自のadd-skillコマンドとロックファイルもどきを、 https://github.com/vercel-labs/skills で置き換える事を検討して、どうするか提案して

### Prompt 2

.skill-lock.jsonの形式を確認して宣言的管理の移行に足るか検証して判断　Cベースということ

### Prompt 3

その方向で、Document Workflowに則ろうか

### Prompt 4

Base directory for this skill: /Users/berlysia/.claude/skills/execute-plan

# Execute Plan

計画ファイルまたは分解済みタスクリストを入力として、順次実装・検証・コミットする。
`/decompose` でタスク分解した後の実装フェーズで使用する。

## 前提条件

以下のいずれかが存在すること:

- 計画ファイル（Markdown、ADRなど）のパス
- TaskCreate で作成済みのタスクリスト
- ユーザーが直接指定する...

