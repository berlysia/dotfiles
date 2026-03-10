# Session Context

## User Prompts

### Prompt 1

refine-skillのスキルを https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf の流儀でさらに洗練させて。まず隅々まで読んで書いてあることをまとめ、反映計画を立てる。

### Prompt 2

Base directory for this skill: /Users/berlysia/.claude/skills/execute-plan

# Execute Plan

計画ファイルまたは分解済みタスクリストを入力として、順次実装・検証・コミットする。
`/decompose` でタスク分解した後の実装フェーズで使用する。

## 前提条件

以下のいずれかが存在すること:

- 計画ファイル（Markdown、ADRなど）のパス
- TaskCreate で作成済みのタスクリスト
- ユーザーが直接指定する...

### Prompt 3

自己検証した？

### Prompt 4

コミットして，アプライもして

