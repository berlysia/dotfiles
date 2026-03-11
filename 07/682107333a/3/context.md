# Session Context

## User Prompts

### Prompt 1

apply-harness-practices した場合にユーザーレベルの設定とプロジェクトレベルの設定が競合することがありうるが、究極的にはプロジェクトレベルにあるならそれに従うべきなので、うまく競合回避するような仕組みを考案したい、ないしは両方動いててもいい、みたいな方向でもいい。

### Prompt 2

D

### Prompt 3

Base directory for this skill: /Users/berlysia/.claude/skills/execute-plan

# Execute Plan

計画ファイルまたは分解済みタスクリストを入力として、順次実装・検証・コミットする。
`/decompose` でタスク分解した後の実装フェーズで使用する。

## 前提条件

以下のいずれかが存在すること:

- 計画ファイル（Markdown、ADRなど）のパス
- TaskCreate で作成済みのタスクリスト
- ユーザーが直接指定する...

### Prompt 4

commit apply push

